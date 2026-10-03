/**
 * 效果日志（0.2.5）：把插件"每轮注入多长、检索了什么、写入节奏、KV 命中率"
 * 逐事件写进一个 JSONL 文件，供事后聚合。**默认关闭**（`config.logEnabled`）。
 *
 * ## 它回答什么问题（Q1 定案：体积调优 + 缓存观察，不是调试 trace）
 *
 * | 事件 | 回答 |
 * |---|---|
 * | `inject`（每轮） | 本轮注入多少字符、纪律块/两层各占多少、各层档位 |
 * | `search` | 模型在用什么关键词查、命中几条（零命中照记 —— 那是"关键词没写全"的直接证据） |
 * | `add` | 自然小时内的写入节奏（自带该小时当前累计） |
 * | `usage` | 每轮 prompt 侧的 cache 命中率（与设置页"缓存命中 N%"同分母） |
 * | `correct` / `cleanup` / `guard_deny` / `inject_error` / `config_error` | 写入侧完整性的其余拼图 |
 * | `write_alarm` | 写入后第一步 `uncached` 超阈值（守护断言第二层：补丁被覆盖 / 网关语义漂移的运行期兜底） |
 *
 * `memory_list` **不记**（用户定案：五个工具里最无趣的一个，事后 `rg -v` 可过滤，
 * 漏记却补不回来）。
 *
 * ## 格式与落点
 *
 * - 落点 `<全局层目录的上一级>/logs/debug.jsonl`（默认 `~/.dsh/memory-win/logs/`）。
 *   与全局层**平级**：层目录的 `readdir` 只取 `*.md`，所以日志既不进地图、也不被
 *   归档扫描读到；写入守卫只拦宿主的 `write`/`edit` 工具，不拦插件自身 fs。
 * - 每事件一行 JSON（JSONL）：时间序列与计数事后一行脚本可聚合，比人类可读文本强。
 * - 超过 `LOG_MAX_BYTES`（1 MB）轮转成 `debug.prev.jsonl`（只留一份）——
 *   日志自己不能成为"单调恶化"的新缺口。
 * - **追加用 `appendFileSync`，不走 `fs-utils.writeAtomically`**：后者是"读-改-写整文件
 *   重写"（记忆与状态需要），日志每行都重写 1 MB 是 O(文件) 的热路径。追加是单调的、
 *   单进程内天然有序，两条纪律各自适用。
 *
 * ## 三条失效纪律
 *
 * 1. **写失败即停写**（进程内 `stopped`，不再重试）：日志是旁路，绝不能把注入或工具
 *    执行拖垮，也不该每轮刷一遍注定失败的磁盘操作；
 * 2. **所有入口永不抛**：`logInject` 跑在注入回调的 try 里、`logInjectError` 跑在 catch
 *    里 —— 它们若抛错，一个日志故障就会把整个提示词装配带崩；
 * 3. **关闭时零副作用**：`logEnabled() !== true` 时不建目录、不读文件、不进 `session/event`
 *    的任何工作（订阅本身照挂，开关在回调里查 —— 配置改了要重启，进程内开关恒定）。
 *
 * ## usage 的口径（与宿主 UI 同源）
 *
 * - 数据通道：`ctx.on("session/event")` 收 `assistant/message` / `assistant/attempt`，
 *   与宿主 token-meter 同一条总线（实读 app.asar 确认）；
 * - `uncached` 直接取 `usage.inputTokens`（适配器已把 provider 字段折成"未命中输入"，
 *   投影的 `uncachedInputTokens` 同样取它 —— app.asar:1008297）；
 * - `hitRate = cacheRead / (uncached + cacheRead + cacheWrite)`，**与设置页
 *   "缓存命中 N%"同一个分母**（app.asar:395653）；
 * - `attempt`（流末 chunk）与同 `(turn, step)` 的 `message` 是**替换关系**（最终消息替换
 *   同一次尝试的流式用量）：离线聚合时同 (session, turn, step) 优先取 `kind:"message"`，
 *   没有 message 的 attempt（失败/中断）才是该步的唯一记录。
 *
 * @module dsh-memory-win/lib/log
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { configValue } from "./config.js";
import { readTextOrEmpty } from "./fs-utils.js";
import { neutralizePromptVars, scanSecrets } from "./format.js";
import { globalRoot } from "./paths.js";

/** 轮转阈值（字节）。当前文件达到它后，下一次写入前先轮转。 */
export const LOG_MAX_BYTES = 1024 * 1024;

/** 写失败后的进程内停写标记（置位后不再尝试任何写入）。 */
let stopped = false;

/** `inject` 事件的自增序号（usage 行用它回指最近一次注入）。 */
let injectSeq = 0;

/** 最近一次 `inject` 的序号（`null` = 本进程还没注入过）。 */
let lastInjectSeq = null;

/** 自然小时 → 本进程已记录的 add 累计（种子从日志文件回读，见 `nextHourCount`）。 */
const hourCounts = new Map();

/** 写入待验标记：写入事件置位、下一条 usage 判读后复位（进程内状态，重启即清）。 */
let pendingWrite = false;

/** 写入步告警阈值：`uncached` 超过它即落 `write_alarm`（Q21/Q18 定案：10K）。 */
export const WRITE_ALARM_UNCACHED = 10000;

/**
 * 日志目录（绝对路径）：全局层目录的上一级加 `logs`。
 *
 * 默认全局层是 `~/.dsh/memory-win/global` ⇒ 日志在 `~/.dsh/memory-win/logs`。
 *
 * @returns {string} 目录绝对路径。
 */
export function logDir() {
  return join(dirname(globalRoot()), "logs");
}

/**
 * 当前日志文件。
 *
 * @returns {string} 绝对路径（`…/logs/debug.jsonl`）。
 */
export function logFilePath() {
  return join(logDir(), "debug.jsonl");
}

/**
 * 轮转后的上一代日志文件。
 *
 * @returns {string} 绝对路径（`…/logs/debug.prev.jsonl`）。
 */
function prevFilePath() {
  return join(logDir(), "debug.prev.jsonl");
}

/**
 * 日志开关（**所有入口的第一道闸**）。
 *
 * 读不到配置（理论上不该发生）时按"关"处理：拿不准就不写。
 *
 * @returns {boolean} `config.logEnabled === true`。
 */
export function logEnabled() {
  try {
    return configValue("logEnabled") === true;
  } catch {
    return false;
  }
}

/**
 * 本地时间戳 `YYYY-MM-DDTHH:mm:ss.sss`（**不带时区后缀**）。
 *
 * 日志是本机体检数据，本地时间让 `slice(0, 13)` 直接就是"自然小时"桶，
 * 与 Q6 定案（本地时区）一致；跨时区的严谨性由文件本身的修改时间兜底。
 *
 * @param {Date} [now] - 时刻。
 * @returns {string} 时间戳。
 */
function localStamp(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}.${p(now.getMilliseconds(), 3)}`
  );
}

/**
 * 追加一行（**不检查开关** —— 调用方负责；永不抛）。
 *
 * 顺序：建目录 → 超阈值先轮转 → 追加。任一步失败即置 `stopped`：
 * 写失败静默停写（Q11 定案），绝不冒泡成注入/工具错误。
 *
 * @param {object} fields - 事件字段（会被 JSON 序列化）。
 * @returns {void}
 */
function writeLine(fields) {
  if (stopped) return;
  try {
    const file = logFilePath();
    mkdirSync(dirname(file), { recursive: true });
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0; // 文件还不存在
    }
    if (size >= LOG_MAX_BYTES) renameSync(file, prevFilePath());
    appendFileSync(file, `${JSON.stringify({ at: localStamp(), ...fields })}\n`, { encoding: "utf8" });
  } catch {
    stopped = true;
  }
}

/**
 * 记一条事件（**永不抛**）。开关关闭或已停写时零副作用。
 *
 * @param {object} fields - 事件字段；`ev` 是事件名，`at` 会自动补（字段里自带 `at` 时以它为准）。
 * @returns {void}
 */
export function logEvent(fields) {
  try {
    if (!logEnabled()) return;
    writeLine(fields);
  } catch {
    /* 构造字段失败不写也不停：日志不能影响调用方 */
  }
}

/**
 * 记一轮注入（Q4 定案口径）。
 *
 * @param {{chars:number, parts:object, modes:object, cwd?:string}} stats -
 *   `renderMapWithStats()` 的 `stats`（分项 + 档位 + 总长）。
 * @returns {void}
 */
export function logInject(stats) {
  try {
    if (!logEnabled() || stopped) return;
    injectSeq += 1;
    lastInjectSeq = injectSeq;
    writeLine({
      ev: "inject",
      seq: injectSeq,
      chars: Number(stats?.chars) || 0,
      parts: stats?.parts ?? {},
      modes: stats?.modes ?? {},
      ...(typeof stats?.cwd === "string" && stats.cwd !== "" ? { cwd: stats.cwd } : {}),
    });
  } catch {
    /* 见模块头：注入回调里绝不抛 */
  }
}

/**
 * 记一次注入渲染失败（Q12：catch 分支是天然的高价值事件）。
 *
 * 错误消息先过 `{{` 中和与凭据扫描 —— 日志不能变成凭据的第二份拷贝。
 *
 * @param {*} error - 被 catch 到的错误。
 * @returns {void}
 */
export function logInjectError(error) {
  try {
    if (!logEnabled() || stopped) return;
    writeLine({ ev: "inject_error", message: safeMessage(error) });
  } catch {
    /* 同上：这个函数跑在 catch 里，抛错会让降级文案都到不了 */
  }
}

/**
 * 记一次配置校验失败（Q7 覆盖面）。
 *
 * 配置非法时 `initConfig` 已经抛了、生效配置仍是旧值 —— 所以**开关判定看原始
 * `config:` 段**：只有调用方明确写着 `logEnabled: true` 才写这一行。
 *
 * @param {*} error - `normalizeConfig` 抛出的错误。
 * @param {object|undefined} rawConfig - profile 传来的原始 `config:` 段。
 * @returns {void}
 */
export function logConfigError(error, rawConfig) {
  try {
    if (rawConfig?.logEnabled !== true || stopped) return;
    writeLine({ ev: "config_error", message: safeMessage(error) });
  } catch {
    /* 见上 */
  }
}

/**
 * 记一次守卫拒绝（Q7：安全事件不该沉默）。
 *
 * 判定（`directWriteDenial`）保持纯函数，日志挂在包装层 —— 判定与 I/O 分离。
 *
 * @param {object|undefined} execution - 被拒绝的工具执行上下文。
 * @returns {void}
 */
export function logGuardDenial(execution) {
  try {
    if (!logEnabled() || stopped) return;
    const target = execution?.arguments?.file_path;
    writeLine({
      ev: "guard_deny",
      tool: String(execution?.name ?? ""),
      ...(typeof target === "string" && target.trim() !== "" ? { path: target } : {}),
    });
  } catch {
    /* 同上 */
  }
}

/**
 * 记一次工具调用的结果（Q8：注册循环包装 `execute` 后的单点埋入）。
 *
 * 只在 `execute` **正常返回**后调用 —— 被校验拒绝（抛错）的调用不产生事件，
 * 也不计入小时计数。`memory_list` 返回 `undefined`（不记，Q22）。
 *
 * @param {string} name - 工具名。
 * @param {object} args - 原始参数。
 * @param {*} result - `execute` 的返回值。
 * @param {{cwd?:string, session?:string}} [info] - 调用上下文（cwd / 会话 id）。
 * @returns {void}
 */
export function logToolCall(name, args, result, info = {}) {
  try {
    if (!logEnabled() || stopped) return;
    const fields = toolFields(name, args, result, info);
    if (fields === undefined) return;
    if (armsWriteCheck(fields)) pendingWrite = true;
    writeLine(fields);
  } catch {
    /* 日志构造失败绝不能影响工具返回值 */
  }
}

/**
 * 记一条 usage（Q13/Q14/Q16/Q17）：当轮 token 四元组 + 与 UI 同分母的命中率。
 *
 * 订阅在启动时就挂着、开关在回调里查（Q15 定案 A：配置改了要重启，进程内恒定）。
 * 多会话的事件**全记**并带 `session`；`seqRef` 回指本进程最近一次注入 —— 注入侧
 * 拿不到会话 id，因此这个回指是"时间相邻"级的关联，不是强绑定（诚实声明）。
 *
 * @param {object|undefined} session - 宿主会话对象（取 `session.id`）。
 * @param {object|undefined} event - `session/event` 事件。
 * @returns {void}
 */
export function logUsage(session, event) {
  try {
    if (!logEnabled() || stopped) return;
    if (event?.type !== "assistant/message" && event?.type !== "assistant/attempt") return;
    const usage = usageOf(event);
    if (usage === undefined || usage === null) return;

    const tokens = {
      uncached: toCount(usage.inputTokens),
      cacheRead: toCount(usage.cacheReadTokens),
      cacheWrite: toCount(usage.cacheWriteTokens),
      output: toCount(usage.outputTokens),
    };
    const data = event.data ?? {};
    const fields = {
      ev: "usage",
      kind: event.type === "assistant/message" ? "message" : "attempt",
      tokens,
      hitRate: cacheHitRate(tokens),
    };
    const sid = typeof session?.id === "string" ? session.id : "";
    if (sid !== "") fields.session = sid;
    if (Number.isInteger(data.turn)) fields.turn = data.turn;
    if (Number.isInteger(data.step)) fields.step = data.step;
    if (lastInjectSeq !== null) fields.seqRef = lastInjectSeq;
    writeLine(fields);
    if (pendingWrite) evaluateWriteStep(tokens, fields);
  } catch {
    /* usage 形状不符就跳过这一条：一条坏事件不值得停写 */
  }
}

/**
 * prompt 侧缓存命中率，**与宿主 UI 同一公式**：
 * `cacheRead / (uncached + cacheRead + cacheWrite)`。
 *
 * 分母为 0（纯空请求）返回 `null` —— 表示"不可算"，而不是伪造一个 0%。
 *
 * @param {{uncached:number, cacheRead:number, cacheWrite:number}} tokens - token 数。
 * @returns {number|null} 0..1 的比率（保留 4 位小数），或 `null`。
 */
export function cacheHitRate({ uncached, cacheRead, cacheWrite }) {
  const parts = [Number(uncached), Number(cacheRead), Number(cacheWrite)];
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const denominator = parts[0] + parts[1] + parts[2];
  if (denominator <= 0) return null;
  return Math.round((parts[1] / denominator) * 10000) / 10000;
}

/**
 * 测试用：清空进程内日志状态（停写标记、序号、小时计数）。
 *
 * 与 `state.resetStateCache()` 同构 —— 生产路径不需要它。
 *
 * @returns {void}
 */
export function resetLogForTests() {
  stopped = false;
  injectSeq = 0;
  lastInjectSeq = null;
  pendingWrite = false;
  hourCounts.clear();
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

/**
 * 该事件是否**真的改变了注入字节**（决定要不要置位"写入待验"）。
 *
 * `add` 带 `duplicate` 的是无写入的重复命中；`cleanup` 空跑（`ran=false`，或 ran
 * 但没归档/移除任何东西）不落文件改动 —— 都不该触发下一步的 usage 判读。
 * `correct` 正常返回即改写（找不到目标会抛错、不产生事件，见 `logToolCall` 契约）。
 *
 * @param {object} fields - 已构造好的事件字段。
 * @returns {boolean} 是否置位。
 */
function armsWriteCheck(fields) {
  if (fields.ev === "add") return fields.duplicate !== true;
  if (fields.ev === "correct") return true;
  if (fields.ev === "cleanup") {
    return fields.ran === true && (Number(fields.archived) > 0 || Number(fields.removedShards) > 0);
  }
  return false;
}

/**
 * 写入后**第一条** usage 的判读：超阈值落 `write_alarm`，然后无条件复位。
 *
 * 告警与 `seqRef` 同为"时间相邻"级关联（写入发生在工具步，usage 属于其后第一个
 * 完成的请求；多会话里先完成的那条同样携带受写入影响的新地图，判读等效）。
 * 未超阈值静默复位：告警是一次性核验，不是持续监控。
 *
 * @param {{uncached:number, cacheRead:number, cacheWrite:number}} tokens - 本步 token 四元组。
 * @param {object} usageFields - 刚写入的 usage 行字段（复用 session/seqRef）。
 * @returns {void}
 */
function evaluateWriteStep(tokens, usageFields) {
  pendingWrite = false;
  if (Number(tokens.uncached) <= WRITE_ALARM_UNCACHED) return;
  const extra = {};
  if (usageFields.session !== undefined) extra.session = usageFields.session;
  if (usageFields.seqRef !== undefined) extra.seqRef = usageFields.seqRef;
  writeLine({
    ev: "write_alarm",
    uncached: Number(tokens.uncached),
    threshold: WRITE_ALARM_UNCACHED,
    ...extra,
    hint: "写入步重算超阈值：our-free-model 的 in-history 补丁疑似未生效（重放链见 patches/）或网关缓存语义变化",
  });
}

/**
 * 按工具名构造事件字段；返回 `undefined` 表示"这个工具不记"。
 *
 * @param {string} name - 工具名。
 * @param {object} args - 原始参数。
 * @param {*} result - 返回值。
 * @param {{cwd?:string, session?:string}} info - 调用上下文。
 * @returns {object|undefined} 事件字段。
 */
function toolFields(name, args, result, info) {
  const base = {};
  if (typeof info?.session === "string" && info.session !== "") base.session = info.session;
  if (typeof info?.cwd === "string" && info.cwd !== "") base.cwd = info.cwd;

  if (name === "memory_search") {
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    // 分片名带层前缀：两层各有一个同名分片时不歧义。
    const shards = [...new Set(hits.map((h) => `${h?.target ?? "?"}/${h?.shard ?? "?"}`))];
    return { ev: "search", query: String(result?.query ?? args?.query ?? ""), hits: hits.length, shards, ...base };
  }

  if (name === "memory_add") {
    // `at` 与 `hour` 取同一时刻，避免整点边界上两者差出一小时。
    const stamp = localStamp();
    const hour = stamp.slice(0, 13);
    const fields = { at: stamp, ev: "add", hour, hourCount: nextHourCount(hour) };
    if (typeof result?.target === "string") fields.target = result.target;
    if (typeof result?.shard === "string") fields.shard = result.shard;
    if (result?.duplicate === true) fields.duplicate = true;
    if (typeof result?.reason === "string") fields.reason = result.reason;
    return { ...fields, ...base };
  }

  if (name === "memory_correct") {
    const fields = { ev: "correct" };
    fields.target = typeof result?.target === "string" ? result.target : String(args?.target ?? "");
    if (typeof result?.shard === "string") fields.shard = result.shard;
    fields.reason = String(args?.reason ?? "");
    if (typeof args?.id === "string" && args.id !== "") fields.id = args.id;
    return { ...fields, ...base };
  }

  if (name === "memory_cleanup") {
    const layers = Array.isArray(result?.layers) ? result.layers : [];
    let entries = 0;
    for (const layer of layers) {
      if (!Array.isArray(layer?.archived)) continue;
      for (const group of layer.archived) entries += Number(group?.count) || 0;
    }
    const fields = {
      ev: "cleanup",
      ran: result?.ran === true,
      archived: typeof result?.archived === "number" ? result.archived : 0,
      entries,
      removedShards: typeof result?.removedShards === "number" ? result.removedShards : 0,
    };
    if (typeof result?.reason === "string") fields.reason = result.reason;
    return { ...fields, ...base };
  }

  return undefined; // memory_list（Q22）与未知工具：不记
}

/**
 * 下一条 add 事件的"该小时当前累计"。
 *
 * 本进程内第一次碰到某个自然小时时，**从日志文件回读当小时的 add 行做种子** ——
 * 跨重启不丢计数，且不需要往 `.state.json` 里加任何字段（Q9 定案：JSONL 就是正本）。
 *
 * @param {string} hour - `YYYY-MM-DDTHH`（本地自然小时）。
 * @returns {number} 含即将写入这条在内的累计数。
 */
function nextHourCount(hour) {
  let count = hourCounts.get(hour);
  if (count === undefined) {
    count = seedHourCount(hour);
  }
  count += 1;
  hourCounts.set(hour, count);
  return count;
}

/**
 * 从日志文件回读某小时已有的 add 行数（当前文件 + 轮转掉的上一代）。
 *
 * @param {string} hour - `YYYY-MM-DDTHH`。
 * @returns {number} 已有条数。
 */
function seedHourCount(hour) {
  let count = 0;
  for (const file of [logFilePath(), join(logDir(), "debug.prev.jsonl")]) {
    const text = readTextOrEmpty(file);
    if (text === "") continue;
    for (const line of text.split("\n")) {
      if (!line.includes('"ev":"add"')) continue; // 廉价预过滤，避免逐行 JSON.parse
      try {
        const record = JSON.parse(line);
        if (record?.ev === "add" && record.hour === hour) count += 1;
      } catch {
        /* 轮转边界上的半行/坏行跳过即可 */
      }
    }
  }
  return count;
}

/**
 * 从事件里取 usage —— **与宿主 `usageOf` 同构**（app.asar:1008339）。
 *
 * `assistant/message` 优先用 `data.usage`；`assistant/attempt` 没有它，
 * usage 埋在流的最后一个 `type:"usage"` chunk 里（流是记录数组，反向扫到即止）。
 *
 * @param {object} event - 事件。
 * @returns {object|undefined} usage 对象。
 */
function usageOf(event) {
  const data = event?.data;
  if (data === undefined || data === null) return undefined;
  if (event.type === "assistant/message" && data.usage !== undefined) return data.usage;
  const stream = data.stream;
  if (Array.isArray(stream)) {
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      const record = stream[i];
      if (record?.type === "chunk" && record?.chunk?.type === "usage" && record.chunk.usage !== undefined) {
        return record.chunk.usage;
      }
    }
  }
  return undefined;
}

/**
 * token 数规整：非有限或负数一律按 0（provider 字段缺失是常态，不是错误）。
 *
 * @param {*} value - 原始值。
 * @returns {number} 计数。
 */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * 把一个错误变成**可安全写日志**的单行消息：
 * `{{` 中和 + 凭据扫描（命中则只留模式名，正文丢弃）+ 长度截断。
 *
 * @param {*} error - 错误。
 * @returns {string} 安全消息。
 */
function safeMessage(error) {
  const raw = `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
  const hits = scanSecrets(raw);
  if (hits.length > 0) {
    const names = [...new Set(hits.map((h) => h.pattern))].join(" / ");
    return `（消息含疑似凭据：${names}，正文已省略）`;
  }
  return neutralizePromptVars(raw).slice(0, 500);
}
