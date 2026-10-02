/**
 * 存储层：分片扫描、按需检索、原子追加。
 *
 * 与参考插件的关键差异：
 *
 * 1. **零 shell、零外部进程。** 没有 `spawnSync('git', ...)`、没有 `/bin/zsh`、
 *    没有 `sh -c`。因此在 Windows 上不存在"探针失败静默回落"的路径 —— 那类
 *    "活着但不动"的失效模式（evolve 的分支隔离静默失效、dsh-memory 的钩子抛穿）
 *    在本项目里没有对应的代码可以失败。
 * 2. **根目录每次现算。** 所有 `*Root()` 都在调用时求值，改 `DSH_HOME` 立即生效。
 * 3. **写入前重读。** 并发安全靠"串行化 + 写前重读"而不是锁文件：DSH 插件跑在
 *    宿主进程内，同进程内的并发用 promise 链串行化即可；写前重读保证读-改-写
 *    不丢更新。跨进程并发写是**已声明的限制**（见 README），不做锁文件是因为
 *    evolve 的 pid 存活探测锁在 Windows 上语义不可靠。
 *
 * @module dsh-memory-win/lib/engine
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  SHARD_EXT,
  displayPath,
  globalRoot,
  projectRoot,
  shardPath,
} from "./paths.js";
import {
  FIX_REASONS,
  entryId,
  findSameFactOtherDate,
  isBeforeToday,
  isTailDuplicate,
  latestDate,
  markSuperseded,
  parseEntries,
  parseHeader,
  renderEntry,
  renderFixMeta,
  scanSecrets,
  validateFactBody,
  validEntryDate,
} from "./format.js";

/** 单个分片的默认条目内联阈值：条数不超过它时，地图里直接列出条目。 */
export const INLINE_MAX_ENTRIES = 8;

/**
 * 每文件的写入串行链。key = 规范化后的绝对路径。
 * @type {Map<string, Promise<unknown>>}
 */
const writeChains = new Map();

/**
 * 把一次写操作排到该文件的串行链尾。
 *
 * @template T
 * @param {string} file - 目标文件绝对路径。
 * @param {() => Promise<T>} op - 写操作。
 * @returns {Promise<T>} 操作结果。
 */
function serializeWrite(file, op) {
  const key = file.toLowerCase();
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(op, op);
  // 链上只保留"已settle"的表示，避免失败把后续写入永久卡住。
  writeChains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * 安全读文本：文件不存在或不可读返回空串。
 *
 * @param {string} file - 绝对路径。
 * @returns {string} 正文。
 */
function readTextOrEmpty(file) {
  try {
    if (!existsSync(file)) return "";
    if (!statSync(file).isFile()) return "";
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * 原子写：同目录临时文件 → rename 覆盖。
 *
 * 同目录是必须的 —— 跨卷 rename 会失败。临时名带 pid 与随机数，避免同目录并发
 * 冲突（evolve 的 `prompts.json` 用固定 `.tmp` 就是个真实缺陷）。
 *
 * @param {string} file - 目标绝对路径。
 * @param {string} content - 完整正文。
 */
function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, file); // Windows 上也允许覆盖已存在的目标
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不影响原文件 */
    }
    throw error;
  }
}

/**
 * 解析一个作用域到具体目录。
 *
 * @param {"global"|"project"} target - 作用域。
 * @param {string} [cwd] - 项目作用域所需的会话工作目录。
 * @returns {{target:string, dir:string, cwd:string|undefined}} 解析结果。
 * @throws {Error} 项目作用域缺少 cwd 时抛出（失败关闭，不回落到全局层）。
 */
export function resolveScope(target, cwd) {
  const t = target === "project" ? "project" : "global";
  if (t === "project") {
    const dir = projectRoot(cwd);
    if (dir === undefined) {
      throw new Error("project 作用域需要一个工作目录，但当前会话没有 cwd；改用 target:\"global\"");
    }
    return { target: t, dir, cwd };
  }
  return { target: t, dir: globalRoot(), cwd };
}

/**
 * 列出某目录下的分片文件（不含临时文件）。
 *
 * @param {string} dir - 目录绝对路径。
 * @returns {string[]} 绝对文件路径列表，按名称排序。
 */
function listShardFiles(dir) {
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(SHARD_EXT) && !n.includes(".tmp-"))
    .sort()
    .map((n) => join(dir, n));
}

/**
 * 读取并描述一个分片：条目、关键词、最新日期。
 *
 * @param {string} file - 分片绝对路径。
 * @param {string} [cwd] - 用于把绝对路径渲染成展示路径。
 * @returns {{name:string, path:string, entries:object[], keywords:string, title:string, latest:string}} 描述。
 */
export function describeShard(file, cwd) {
  const text = readTextOrEmpty(file);
  const lines = text.split("\n");
  const header = parseHeader(lines[0] ?? "");
  const entries = parseEntries(text);
  return {
    name: basename(file, SHARD_EXT),
    path: displayPath(file, cwd),
    absPath: file,
    entries,
    keywords: header.keywords,
    title: header.title,
    latest: latestDate(entries),
  };
}

/**
 * 列出一层的全部分片描述。
 *
 * @param {"global"|"project"} target - 作用域。
 * @param {string} [cwd] - 会话工作目录。
 * @returns {{target:string, dir:string, dirPath:string, shards:object[], total:number}} 层视图。
 */
export function listLayer(target, cwd) {
  const scope = resolveScope(target, cwd);
  const shards = listShardFiles(scope.dir).map((f) => describeShard(f, cwd));
  return {
    target: scope.target,
    dir: scope.dir,
    dirPath: displayPath(scope.dir, cwd),
    shards,
    total: shards.reduce((n, s) => n + s.entries.length, 0),
  };
}

/**
 * 列出某一层（或某一分片）的**全部条目**，带 id 与行号。
 *
 * 为什么需要它：`memory_search` 只返回**命中关键词**的条目，于是"检索不到的记忆
 * 拿不到自己的 id" ⇒ **无法被 memory_correct 修正**。地图档下模型也看不到条目 id。
 * 这个函数就是那条兜底路径：先浏览、拿到 id、再修正。
 *
 * @param {{target?:string, cwd?:string, shard?:string, limit?:number}} [options] - 浏览参数。
 * @returns {{layers:object[], total:number, truncated:boolean}} 条目清单。
 */
export function listEntries(options = {}) {
  const targets = options.target === "global" || options.target === "project" ? [options.target] : ["global", "project"];
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 200) : 50;
  const layers = [];
  let seen = 0;
  let truncated = false;

  for (const target of targets) {
    let layer;
    try {
      layer = listLayer(target, options.cwd);
    } catch {
      continue; // 无 cwd 时跳过项目层
    }
    const entries = [];
    for (const shard of layer.shards) {
      if (options.shard !== undefined && shard.name !== options.shard) continue;
      for (const entry of shard.entries) {
        if (seen >= limit) {
          truncated = true;
          break;
        }
        seen += 1;
        entries.push({
          id: entry.id,
          date: entry.date,
          text: entry.text,
          shard: shard.name,
          path: shard.path,
          line: entry.line,
        });
      }
      if (truncated) break;
    }
    if (entries.length > 0) layers.push({ target, dir: layer.dirPath, entries });
    if (truncated) break;
  }

  return { layers, total: seen, truncated };
}

/**
 * 跨分片检索记忆。纯字符串匹配，**不调用任何模型**，因此零额外成本。
 *
 * 支持空格分隔的多词：每个词都要命中同一条目（AND 语义），分数为该条目命中的
 * 词数，命中多词者优先。中文无需分词 —— 子串匹配对 CJK 天然可用，这也是
 * "不引入向量检索"这一取舍能成立的原因。
 *
 * @param {string} query - 检索词。
 * @param {{target?:string, cwd?:string, limit?:number, shard?:string}} [options] - 检索参数。
 * @returns {{query:string, hits:object[], scanned:number}} 命中结果（按分数降序）。
 */
export function searchMemory(query, options = {}) {
  const q = String(query ?? "").trim();
  if (q === "") throw new Error("query 不能为空");
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 50) : 20;
  const targets = options.target === "global" || options.target === "project" ? [options.target] : ["global", "project"];
  const hits = [];
  let scanned = 0;

  for (const target of targets) {
    let layer;
    try {
      layer = listLayer(target, options.cwd);
    } catch {
      continue; // project 层无 cwd 时跳过，而不是让整个检索失败
    }
    for (const shard of layer.shards) {
      if (options.shard !== undefined && shard.name !== options.shard) continue;
      for (const entry of shard.entries) {
        scanned += 1;
        const hay = `${entry.text} ${shard.keywords} ${shard.title}`.toLowerCase();
        let score = 0;
        for (const t of terms) if (hay.includes(t)) score += 1;
        if (score === 0) continue;
        hits.push({
          score,
          id: entry.id,
          target,
          shard: shard.name,
          path: shard.path,
          line: entry.line,
          date: entry.date,
          text: entry.text,
        });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { query: q, hits: hits.slice(0, limit), scanned, truncated: hits.length > limit };
}

/**
 * 追加一条记忆。
 *
 * 校验顺序是刻意的：先凭据、再正文、再日期 —— 凭据检查放最前，任何情况下都不
 * 会写入；且拒绝原因只报模式名与行号，不回显匹配值。
 *
 * @param {{target?:string, cwd?:string, shard?:string, fact?:string, date?:string, confirm?:boolean}} input - 写入参数。
 * @returns {Promise<object>} 写入结果。`ok:false` + `reason:"same-fact-other-date"` 表示
 *   同一事实已存在于另一日期，调用方需要显式传 `confirm:true` 才会再次写入。
 * @throws {Error} 校验失败或写入失败时抛出，消息面向模型可执行。
 */
export async function appendMemory(input) {
  const scope = resolveScope(input.target, input.cwd);
  const shardName = input.shard === undefined || String(input.shard).trim() === "" ? "default" : String(input.shard);
  const file = shardPath(scope.dir, shardName);
  const fact = String(input.fact ?? "");

  const secretHits = scanSecrets(fact);
  if (secretHits.length > 0) {
    const detail = secretHits.map((h) => `${h.pattern}（第 ${h.line} 行）`).join("、");
    throw new Error(`拒绝写入：疑似凭据 —— ${detail}。请改为记录"配置项位置"而不是值本身。`);
  }

  const bodyIssue = validateFactBody(fact);
  if (bodyIssue !== undefined) throw new Error(`拒绝写入：${bodyIssue}`);

  const date = input.date === undefined || String(input.date).trim() === "" ? undefined : String(input.date).trim();
  if (date !== undefined && !validEntryDate(date)) {
    throw new Error(`拒绝写入：日期非法或晚于今天（收到 "${date}"），格式必须是 YYYY-MM-DD`);
  }

  return serializeWrite(file, async () => {
    const existing = readTextOrEmpty(file);
    const day = date ?? todayLocalDate();
    const entry = renderEntry(day, fact);

    // 完全重复（日期 + 正文都相同）→ 不写第二次。
    if (isTailDuplicate(existing, entry)) {
      return { ok: true, duplicate: true, path: displayPath(file, input.cwd), shard: shardName, target: scope.target };
    }

    // 正文相同、日期不同：默认**拒绝**，除非调用方显式 confirm。
    //
    // 为什么是拒绝而不是照写：同一事实的多个日期副本会在注入的地图里重复出现，
    // 使提示词开销随"重申次数"增长 —— 这正是本插件要避免的成本形态。
    // 但"该结论在某天仍然成立"本身是有价值的信息，所以给一个显式的 confirm 出口，
    // 而不是把它彻底禁掉。
    const sameFactDate = findSameFactOtherDate(existing, day, fact);
    if (sameFactDate !== undefined && input.confirm !== true) {
      return {
        ok: false,
        duplicate: true,
        reason: "same-fact-other-date",
        sameFactOtherDate: sameFactDate,
        path: displayPath(file, input.cwd),
        shard: shardName,
        target: scope.target,
      };
    }

    mkdirSync(scope.dir, { recursive: true });

    let next;
    if (existing.trim() === "") {
      // 新分片：首行关键词头（可被后续编辑补充），便于地图给出检索线索。
      const header = `<!-- ${shardName} ·  -->\n`;
      next = `${header}\n${entry}\n`;
    } else {
      const sep = existing.endsWith("\n") ? "" : "\n";
      next = `${existing}${sep}${entry}\n`;
    }

    atomicWrite(file, next);
    const after = parseEntries(next);
    const line = after.length > 0 ? after[after.length - 1].line : 0;
    return {
      ok: true,
      duplicate: false,
      target: scope.target,
      shard: shardName,
      path: displayPath(file, input.cwd),
      line,
      entry,
      totalEntries: after.length,
      ...(sameFactDate === undefined ? {} : { sameFactOtherDate: sameFactDate }),
    };
  });
}

/**
 * 修正（取代）一条既有记忆。
 *
 * 语义是**取代而非删除**：旧条目就地包成 `<!-- - [日期] 正文 -->` 注释，于是
 * ① 历史保留、可回滚；② `parseEntries` 会跳过它，所以旧结论**不再进地图、也不再被
 * 检索命中** —— 这一点是"结论被推翻"必须可见的关键，否则模型仍会读到旧结论。
 *
 * 因为是**单行替换**，其余条目的行号不变。新条目追加在文件末尾，带
 * `[fix:<类型> of #<旧 id>]` 后缀，形成显式的因果链接。
 *
 * @param {{target?:string, cwd?:string, shard?:string, id?:string, reason?:string, replacement?:string, date?:string}} input - 修正参数。
 * @returns {Promise<object>} 修正结果（含旧条目位置与新条目行号）。
 * @throws {Error} 条目找不到、类型非法、正文非法时抛出，消息面向模型可执行。
 */
export async function correctMemory(input) {
  const scope = resolveScope(input.target, input.cwd);
  const id = String(input.id ?? "").trim();
  if (id === "") throw new Error("拒绝修正：缺少 id。先用 memory_search 找到条目，它会给出每条记忆的 id");

  const reason = String(input.reason ?? "").trim();
  if (reason === "") throw new Error(`拒绝修正：缺少 reason，只能是 ${FIX_REASONS.join(" / ")}`);
  if (!FIX_REASONS.includes(reason)) {
    throw new Error(`拒绝修正：reason "${reason}" 非法，只能是 ${FIX_REASONS.join(" / ")}`);
  }

  const rawReplacement = input.replacement === undefined ? undefined : String(input.replacement);
  let replacement;
  if (rawReplacement !== undefined) {
    if (reason === "retract") {
      throw new Error("拒绝修正：reason=retract 表示纯撤回，不应再给 replacement（旧条目仅被标记为失效）");
    }
    const issue = validateFactBody(rawReplacement);
    if (issue !== undefined) throw new Error(`拒绝修正：${issue}`);
    const secretHits = scanSecrets(rawReplacement);
    if (secretHits.length > 0) {
      const detail = secretHits.map((h) => `${h.pattern}（第 ${h.line} 行）`).join("、");
      throw new Error(`拒绝修正：疑似凭据 —— ${detail}。请改为记录"配置项位置"而不是值本身。`);
    }
    replacement = rawReplacement.trim();
  } else if (reason !== "retract") {
    throw new Error(`拒绝修正：reason=${reason} 必须给出 replacement（新结论）；若只是撤回请用 reason=retract`);
  }

  const day = input.date === undefined || String(input.date).trim() === "" ? todayLocalDate() : String(input.date).trim();
  if (!validEntryDate(day)) {
    throw new Error(`拒绝修正：日期非法或晚于今天（收到 "${day}"），格式必须是 YYYY-MM-DD`);
  }

  const shardName = input.shard === undefined || String(input.shard).trim() === "" ? undefined : String(input.shard);
  const dir = scope.dir;
  const files = shardName === undefined ? listShardFiles(dir) : [shardPath(dir, shardName)];

  return serializeWrite(`${dir}::correct`, async () => {
    for (const file of files) {
      const text = readTextOrEmpty(file);
      if (text === "") continue;
      const entries = parseEntries(text);
      const target = entries.find((e) => e.id === id);
      if (target === undefined) continue;

      // 取代语法要求新条目严格晚于被取代者，否则时间线会被写乱。
      if (!isBeforeToday(target.date)) {
        throw new Error(
          `拒绝修正：#${id} 的日期是 ${target.date}，不早于今天（${day}），无法被"更晚的结论"取代。` +
            `若确需改这条，请直接编辑文件（但请保留条目格式）。`,
        );
      }

      const lines = text.split("\n");
      const oldLine = lines[target.line - 1];
      lines[target.line - 1] = markSuperseded(oldLine);

      const newHead = replacement === undefined
        ? undefined
        : renderEntry(day, replacement + renderFixMeta(reason, id));

      let next = lines.join("\n");
      if (newHead !== undefined) {
        next = next.endsWith("\n") ? `${next}${newHead}\n` : `${next}\n${newHead}\n`;
      }

      atomicWrite(file, next);

      const after = parseEntries(next);
      return {
        ok: true,
        reason,
        superseded: { id, date: target.date, text: target.text, line: target.line },
        shard: basename(file, SHARD_EXT),
        path: displayPath(file, input.cwd),
        target: scope.target,
        ...(newHead === undefined
          ? { retracted: true }
          : {
              newEntry: newHead,
              newId: entryId(day, replacement),
              newLine: after.length > 0 ? after[after.length - 1].line : 0,
            }),
        totalEntries: after.length,
      };
    }

    const where = shardName === undefined ? "全部已存在分片" : `分片 ${shardName}`;
    throw new Error(
      `拒绝修正：在${where}里找不到 id 为 #${id} 的条目。` +
        `请先用 memory_search 重新确认（记忆可能已被修改），不要凭记忆猜 id。`,
    );
  });
}

/**
 * 本地日历日（放在此处而非直接 import，是为了让 engine 的依赖面清晰）。
 *
 * @returns {string} `YYYY-MM-DD`。
 */
function todayLocalDate() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 供测试使用的写入链长度（确认没有无限累积）。 */
export function writeChainSize() {
  return writeChains.size;
}
