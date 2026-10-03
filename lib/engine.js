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

import { rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { CONFIG_DEFAULTS, configNum, configValue } from "./config.js";
import { listFileNames, readTextOrEmpty, writeAtomically, writeChainSize, writeTextSerialized } from "./fs-utils.js";
import {
  SHARD_EXT,
  archiveRoot,
  displayPath,
  dshHome,
  globalRoot,
  projectRoot,
  shardPath,
} from "./paths.js";
import {
  FIX_REASONS,
  SUPERSEDED_RE,
  entryId,
  findSameFactOtherDate,
  inlineTruncationWarning,
  isTailDuplicate,
  latestDate,
  markSuperseded,
  parseEntries,
  parseHeader,
  renderEntry,
  renderFixMeta,
  renderHeader,
  scanSecrets,
  shiftDays,
  today,
  validateFactBody,
  validateKeywords,
  validEntryDate,
} from "./format.js";
import {
  archivableLines,
  archivedFileNames,
  cleanupDoneToday,
  markCleanup,
  stateOf,
} from "./state.js";

/**
 * 单个分片的**默认**条目内联阈值：条数不超过它时，地图里直接列出条目。
 *
 * 真正取值出口是 `config.inlineThreshold`（解析层）与 `config.inlineMaxEntries`
 * 的读取点 `inlineThreshold()`；这里保留常量只为让默认值一眼可见。
 */
export const INLINE_MAX_ENTRIES = CONFIG_DEFAULTS.inlineThreshold;

/**
 * 生效的内联档阈值。
 *
 * @returns {number} 某层条目数不超过它时走内联档。
 */
export function inlineThreshold() {
  return configNum("inlineThreshold");
}

/**
 * 供测试使用的写入链长度（确认没有无限累积）。
 *
 * 写入链已迁到 `lib/fs-utils.js`（分片与 `.state.json` 共用一套），这里原样再导出
 * 一次是为了**不改动既有回归用例的 import 面** —— 那个用例断言的是"链槽位会复用、
 * 不会无限增长"这个行为，与它住在哪个文件无关。
 */
export { writeChainSize };


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
  return listFileNames(dir)
    .filter((n) => n.endsWith(SHARD_EXT) && !n.includes(".tmp-"))
    .sort()
    .map((n) => join(dir, n));
}

/**
 * 读取并描述一个分片：条目、关键词、最新日期。
 *
 * @param {string} file - 分片绝对路径。
 * @param {string} [cwd] - 用于把绝对路径渲染成展示路径。
 * @returns {{name:string, path:string, absPath:string, text:string, entries:object[], keywords:string, title:string, latest:string}} 描述。
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
    // 原文一并给出：容量策略要按**原始行**搬运失效条目（`parseEntries` 恰好会跳过它们）。
    text,
    entries,
    keywords: header.keywords,
    title: header.title,
    latest: latestDate(entries),
  };
}

/**
 * 列出一层的全部分片描述。
 *
 * **展示路径以「层目录」为基准相对化**（P2a）。原先是相对**会话 cwd** 算的，于是全局层
 * （在 `~/.dsh/` 下、永远不在 cwd 里）每片都要写一整条绝对路径 —— 实测在地图档下
 * 分片行**占整段注入 67%，其中 63% 是路径**，12 片就有 828 字符纯属重复。
 *
 * 改成层内相对后，片路径就是 `${name}.md`，而层标题行已经给出
 * `细分片路径 <层目录>`，模型完全能拼回绝对路径；且 `memory_search` 命中时返回的
 * 仍是绝对路径（见 `searchMemory`），所以 `read` 取原文这条链路不受影响。
 *
 * @param {"global"|"project"} target - 作用域。
 * @param {string} [cwd] - 会话工作目录（仅用于渲染层目录本身的展示路径）。
 * @returns {{target:string, dir:string, dirPath:string, shards:object[], total:number}} 层视图。
 */
export function listLayer(target, cwd) {
  const scope = resolveScope(target, cwd);
  // 以层目录为基准相对化片路径；层目录本身仍相对会话 cwd（项目层因此显示为 .agent-memory）
  const shards = listShardFiles(scope.dir).map((f) => describeShard(f, scope.dir));
  // 归档**不进注入的片列表**（它不该占地图），只在脚注里报个数与去处。
  // 这里多一次目录读：归档目录不存在时 `listFileNames` 直接返回空数组，不报错。
  const archived = archivedFileNames(scope.dir).length;
  return {
    target: scope.target,
    dir: scope.dir,
    dirPath: displayPath(scope.dir, cwd),
    archiveDir: displayPath(archiveRoot(scope.dir), cwd),
    archived,
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
  /** 被本次调用真正取回的条目（用于记录命中；见 `recordAccess`）。 */
  const access = [];
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
    let stopped = false;
    for (const shard of layer.shards) {
      if (options.shard !== undefined && shard.name !== options.shard) continue;
      for (const entry of shard.entries) {
        if (seen >= limit) {
          truncated = true;
          stopped = true;
          break;
        }
        seen += 1;
        entries.push({
          id: entry.id,
          date: entry.date,
          text: entry.text,
          shard: shard.name,
          // 与检索一致：涉及"拿路径去 read"的场合一律给绝对路径
          path: shard.absPath,
          line: entry.line,
        });
        // 只记**真正返回给调用方**的条目：被 limit 截掉的那些并没有进上下文，
        // 把它们算成"被取回过"会让归档的减档条件失真。
        access.push({ layerDir: layer.dir, shard: shard.name, id: entry.id });
      }
      if (stopped) break;
    }
    if (entries.length > 0) layers.push({ target, dir: layer.dirPath, entries });
    if (truncated) break;
  }

  return { layers, total: seen, truncated, access };
}

/**
 * 把一批"被取回的条目"聚合成分片级的命中写入计划。
 *
 * `memory_search` / `memory_list` 是**读操作**，它们不该因为"要记一笔命中"而变慢或
 * 变脆。所以判定与 I/O 分开：engine 只产出这份计划（纯数据），由 `lib/tools.js`
 * 在返回结果之后异步落盘，且失败被吞掉。
 *
 * @param {{layerDir:string, shard:string, id:string}[]} items - 展平的命中清单。
 * @returns {{layerDir:string, shard:string, entries:{id:string}[]}[]} 按「层+分片」聚合。
 */
export function groupAccess(items) {
  const byKey = new Map();
  for (const item of items ?? []) {
    const key = `${item.layerDir}\u0000${item.shard}`;
    const hit = byKey.get(key);
    if (hit === undefined) byKey.set(key, { layerDir: item.layerDir, shard: item.shard, entries: [{ id: item.id }] });
    else hit.entries.push({ id: item.id });
  }
  return [...byKey.values()];
}

/**
 * 解析某作用域的层目录（给"记录命中"这类只关心目录的调用方用）。
 *
 * @param {"global"|"project"} target - 作用域。
 * @param {string} [cwd] - 会话工作目录。
 * @returns {string|undefined} 层目录；项目层无 cwd 时 `undefined`。
 */
export function layerDirOf(target, cwd) {
  try {
    return resolveScope(target, cwd).dir;
  } catch {
    return undefined;
  }
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
          // 必须用**绝对**路径（P2a 配套）：命中结果是要直接喂给 `read` 的，
          // 层内相对路径（`foo.md`）会被解析到会话 cwd 下，读不到文件。
          path: shard.absPath,
          line: entry.line,
          date: entry.date,
          text: entry.text,
        });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const top = hits.slice(0, limit);
  // 只有**返回给调用方**的命中才算"被取回过"（被 limit 截掉的那些没有进上下文）。
  const access = top.map((h) => ({ layerDir: layerDirOf(h.target, options.cwd) ?? "", shard: h.shard, id: h.id }))
    .filter((item) => item.layerDir !== "");
  return { query: q, hits: top, scanned, truncated: hits.length > limit, access };
}

/**
 * 追加一条记忆。
 *
 * 校验顺序是刻意的：先凭据、再正文、再日期 —— 凭据检查放最前，任何情况下都不
 * 会写入；且拒绝原因只报模式名与行号，不回显匹配值。
 *
 * @param {{target?:string, cwd?:string, shard?:string, fact?:string, date?:string, confirm?:boolean, keywords?:string}} input - 写入参数。
 *   `keywords` 只在**新建分片**时生效（写入首行的关键词头）；对已存在的分片传它会抛错。
 * @returns {Promise<object>} 写入结果。`ok:false` + `reason:"same-fact-other-date"` 表示
 *   同一事实已存在于另一日期，调用方需要显式传 `confirm:true` 才会再次写入。
 *   新建分片但未给 `keywords` 时，结果会带 `warning` 字段（不阻断写入）。
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

  // 关键词（P2b）：只在**新建分片**时允许设置，且越早校验越好（早于任何落盘）。
  const wantsKeywords = input.keywords !== undefined && String(input.keywords).trim() !== "";
  if (wantsKeywords) {
    const kwIssue = validateKeywords(input.keywords);
    if (kwIssue !== undefined) throw new Error(`拒绝写入：${kwIssue}`);
  }

  // 读-改-写必须**整个**包在同一个 op 里：既保证"写前重读"，也避免对同一文件
  // 套两层串行链（那样会自死锁 —— 见 `lib/fs-utils.js` 的 `writeAtomically` 注释）。
  return writeAtomically(file, async () => {
    const existing = readTextOrEmpty(file);
    // 用「**有没有条目**」判断是不是新建，而不是「文件是否为空」：
    // 只有关键词头、尚无条目的文件（人工预建的分片）语义上仍是新建，
    // 此时允许补上 keywords，也避免追加时再写一行重复的头。
    const priorEntries = parseEntries(existing);
    const isNewShard = priorEntries.length === 0;
    const day = date ?? today();
    const entry = renderEntry(day, fact);

    // 已存在的分片不许改关键词：关键词头是首行，而 `memory_add` 只追加、不重写正文。
    // 允许它会让"追加一条"意外改写别人（或模型早先）写好的路由线索，
    // 而且需要读-改-写整个首行 —— 那是 `memory_correct` 的活，不是这里的。
    if (wantsKeywords && !isNewShard) {
      throw new Error(
        `拒绝写入：分片 "${shardName}" 已存在，keywords 只能在**新建分片**时设置。` +
          `（关键词头是首行，改它需要重写首行；请用 memory_correct 或直接说明你要改的意图。）`,
      );
    }

    // 完全重复（日期 + 正文都相同）→ 不写第二次。
    if (isTailDuplicate(existing, entry)) {
      return { content: existing, result: { ok: true, duplicate: true, path: displayPath(file, input.cwd), shard: shardName, target: scope.target } };
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
        content: existing,
        result: {
          ok: false,
          duplicate: true,
          reason: "same-fact-other-date",
          sameFactOtherDate: sameFactDate,
          path: displayPath(file, input.cwd),
          shard: shardName,
          target: scope.target,
        },
      };
    }

    let next;
    if (isNewShard) {
      // 新建分片（含"只有头、还没有条目"的情况）：首行写关键词头
      // （P2b —— 调用方在此刻最清楚这片要装什么）。
      // 头行与正文之间保留一个空行：与 README 里的格式示例一致，也让 markdown
      // 渲染、人工编辑都更好读。空行不影响解析（parseEntries 按行扫描）。
      // 没给关键词时保留 `·` 占位，并回一个 warning：空关键词的片在地图里只能靠片名路由。
      const kept = parseHeader(existing.split("\n")[0] ?? "").title;
      const name = kept !== "" ? kept : shardName;
      next = `${renderHeader(name, input.keywords)}\n\n${entry}\n`;
    } else {
      const sep = existing.endsWith("\n") ? "" : "\n";
      next = `${existing}${sep}${entry}\n`;
    }

    const after = parseEntries(next);
    const line = after.length > 0 ? after[after.length - 1].line : 0;
    const result = {
      ok: true,
      duplicate: false,
      target: scope.target,
      shard: shardName,
      path: displayPath(file, input.cwd),
      line,
      entry,
      totalEntries: after.length,
      ...(sameFactDate === undefined ? {} : { sameFactOtherDate: sameFactDate }),
      // 两个**不阻断**的提醒都从这里出去，合成一个 `warning` 字段：
      // ① 新建但没给关键词 → 该片在地图里只能靠片名路由（地图里已渲染成"（未设置）"，
      //    这里再从写入侧提醒一次，让模型有机会当场补上）；
      // ② 正文超过内联显示上限 160 字符 → 尾部在注入里会**静默消失**（P10）。
      //    这条曾经只能靠事后肉眼比对发现，现在写入时就可见。
      ...(() => {
        const warnings = [];
        if (isNewShard && !wantsKeywords) {
          warnings.push(
            `新建分片 "${shardName}" 时未提供 keywords，该片在地图里将只能靠片名路由。` +
              `若这片有明确主题，建议下次新建时带上 keywords。`,
          );
        }
        const truncation = inlineTruncationWarning(fact);
        if (truncation !== undefined) warnings.push(truncation);
        return warnings.length === 0 ? {} : { warning: warnings.join(" ") };
      })(),
    };
    return { content: next, result };
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

  const day = input.date === undefined || String(input.date).trim() === "" ? today() : String(input.date).trim();
  if (!validEntryDate(day)) {
    throw new Error(`拒绝修正：日期非法或晚于今天（收到 "${day}"），格式必须是 YYYY-MM-DD`);
  }

  const shardName = input.shard === undefined || String(input.shard).trim() === "" ? undefined : String(input.shard);
  const dir = scope.dir;
  const files = shardName === undefined ? listShardFiles(dir) : [shardPath(dir, shardName)];

  // 不指定 shard 时会遍历该层所有分片查找 id。顺序是 `listShardFiles` 的**排序**结果，
  // 因此"哪个分片被命中"是确定的（与顺序无关地，id 在层内唯一）。
  for (const file of files) {
    const text = readTextOrEmpty(file);
    if (text === "") continue;

    // 读-改-写整体包在**同一个** `writeAtomically` 里：它是该文件的唯一写入口，
    // 既保证"写前重读"，也避免对同一文件套两层串行链（自死锁，见 fs-utils 注释）。
    const outcome = await writeAtomically(file, () => {
      const current = readTextOrEmpty(file);
      const entries = parseEntries(current);
      const target = entries.find((e) => e.id === id);
      if (target === undefined) return { content: current, result: undefined };

      // 新条目日期不得**早于**被取代者：那等于让修正结论的时间倒挂，会把时间线写乱。
      //
      // 同日取代是**允许**的 —— 这一条是修正过的设计。初版要求"严格更晚"，结果是
      // **当天刚写错的记忆无法修正**，而"刚记下就发现错了"恰恰是最常见的情形
      // （本项目的 .agent-memory 命名就正好撞上：当天写、当天被用户纠正）。
      // 初版还把"直接编辑文件"当作出路写进错误信息，等于把自己的功能缺口转嫁给用户。
      // 同日取代不会产生环（旧条目已被注释掉、不再是活条目），因此是安全的。
      if (day < target.date) {
        throw new Error(
          `拒绝修正：#${id} 的日期是 ${target.date}，而你给的替换日期是 ${day} —— ` +
            `修正结论不能早于被取代的结论。请把日期改到 ${target.date} 或之后（默认今天即可）。`,
        );
      }

      const lines = current.split("\n");
      lines[target.line - 1] = markSuperseded(lines[target.line - 1]);

      const newHead = replacement === undefined
        ? undefined
        : renderEntry(day, replacement + renderFixMeta(reason, id));

      let next = lines.join("\n");
      if (newHead !== undefined) {
        next = next.endsWith("\n") ? `${next}${newHead}\n` : `${next}\n${newHead}\n`;
      }

      const after = parseEntries(next);
      // 与 memory_add 同一条纪律：新结论超过内联显示上限时提醒（不阻断）。
      // 修正的前后值都可能是长条目 —— 提醒在这里同样有价值。
      const truncation = replacement === undefined ? undefined : inlineTruncationWarning(replacement);
      return {
        content: next,
        result: {
          ok: true,
          reason,
          superseded: { id, date: target.date, text: target.text, line: target.line },
          shard: basename(file, SHARD_EXT),
          path: displayPath(file, input.cwd),
          target: scope.target,
          ...(truncation === undefined ? {} : { warning: truncation }),
          ...(newHead === undefined
            ? { retracted: true }
            : {
                newEntry: newHead,
                newId: entryId(day, replacement),
                newLine: after.length > 0 ? after[after.length - 1].line : 0,
              }),
          totalEntries: after.length,
        },
      };
    });

    if (outcome !== undefined) return outcome;
  }

  const where = shardName === undefined ? "全部已存在分片" : `分片 ${shardName}`;
  throw new Error(
    `拒绝修正：在${where}里找不到 id 为 #${id} 的条目。` +
      `请先用 memory_search 重新确认（记忆可能已被修改），不要凭记忆猜 id。`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 容量策略（P6 / 0.2.0）：把**已失效条目**与**空分片**物理挪进归档目录
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 归档一个分片里**已失效**且已过宽限期的条目。
 *
 * 语义边界（写清楚，因为这是本项目里唯一会**移动**记忆数据的动作）：
 *
 * | 会不会被动 | 原因 |
 * |---|---|
 * | **活条目**（`- [日期] 事实`） | **永不**。归档只搬"已经被 memory_correct 取代/撤回"的历史，绝不会把仍然生效的结论挪出注入 |
 * | 已失效但**未过宽限期**的条目 | 不动。刚取代完就搬走会让"取代可追溯"名存实亡 |
 * | 宽限期内**被检索命中**过的失效条目 | 再等一轮（见 `archivableLines` 的减档条件） |
 * | 分片首行的关键词头 | 只有"整片归档"时随文件走；单片内归档不动首行 |
 *
 * 搬走的行是**原样**搬（连 `<!-- -->` 一起），所以归档是**可逆的纯文本操作**：
 * 需要复原时把行贴回原分片即可，行文本没有任何改写。
 *
 * @param {string} layerDir - 层目录绝对路径。
 * @param {object} shard - `describeShard` 的结果（需要 `absPath` / `name` / `text`）。
 * @param {object} options - 参数。
 * @param {number} options.days - 宽限期天数。
 * @param {Date} [options.now] - 注入点，便于测试固定"今天"。
 * @param {Date} options.now - 注入点（测试用）。
 * @returns {{shard:string, count:number, file:string, removedLines:number}|undefined} 归档结果。
 */
function archiveSupersededOf(layerDir, shard, { days, day, now }) {
  const text = shard.text ?? "";
  if (text === "") return undefined;

  const lines = text.split("\n");
  // 用**行号 + 日期 + id** 重新扫一遍失效条目：`parseEntries` 会跳过它们
  // （那正是"失效"的定义），所以这里必须自己读原始行。
  const superseded = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!SUPERSEDED_RE.test(lines[i])) continue;
    const m = /^<!--\s*-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.*?)\s*-->$/.exec(lines[i]);
    if (m === null) continue;
    superseded.push({ line: i + 1, date: m[1], id: entryId(m[1], m[2]) });
  }
  if (superseded.length === 0) return undefined;

  const access = new Map(superseded.map((e) => [e.id, stateOf(layerDir).access?.[shard.name]?.entries?.[e.id] ?? ""]));
  const take = archivableLines({ superseded, days, day, access });
  if (take.length === 0) return undefined;

  const takeSet = new Set(take);
  const kept = lines.filter((_l, i) => !takeSet.has(i + 1));
  const archivedLines = take.map((n) => lines[n - 1]);
  const nextShard = kept.join("\n");

  // 归档文件按**分片名**聚合：同一个分片的多次清理追加到同一个文件里，
  // 而不是每次清理留一个带日期的散件 —— 后者会让归档目录随清理次数线性膨胀。
  return {
    shard: shard.name,
    file: join(archiveRoot(layerDir), `${shard.name}${SHARD_EXT}`),
    count: archivedLines.length,
    removedLines: take.length,
    wholeShard: parseEntries(nextShard).length === 0,
    nextShard,
    // 整片归档时首行关键词头也一起走：它是这片**唯一**的路由线索，
    // 留下一个只有注释头的空文件既没用、又会在层视图里变成一条 0 条目的行（限制 12）。
    body: archivedLines.join("\n"),
  };
}

/**
 * 把一段归档块追加进归档文件（同分片累积在一个文件里）。
 *
 * @param {string} file - 归档文件绝对路径。
 * @param {string} block - 要追加的块（已含头行与内容行、以换行结尾）。
 * @returns {Promise<void>} 完成后 resolve。
 */
async function appendArchiveFile(file, block) {
  const existing = readTextOrEmpty(file);
  const next =
    existing === ""
      ? `<!-- dsh-memory-win · 归档件。内容为 memory_correct 取代/撤回后的历史条目，原样保留。 -->\n\n${block}`
      : `${existing.endsWith("\n") ? existing : `${existing}\n`}\n${block}`;
  await writeTextSerialized(file, next);
}

/**
 * 对**一层**执行容量策略。
 *
 * 只做两件事，且都只针对"已经不是活记忆"的东西：
 * 1. 把超出宽限期的**已失效条目**搬进 `<层目录>/<archiveDir>/`；
 * 2. 分片因此变成 0 有效条目时，把整片归档并删掉那个空文件。
 *
 * 不做的事：不删活条目、不按"很久没被检索"归档活分片、不做后台巩固。
 * 第三条尤其重要 —— "很少有人问的记忆"与"没用的记忆"不是一回事，
 * 自动搬走前者属于**悄悄改变提示词内容**，本项目明确不做。
 *
 * @param {"global"|"project"} target - 作用域。
 * @param {{cwd?:string, days?:number, now?:Date}} [options] - 参数。
 * @returns {Promise<{target:string, dir:string, archived:object[], removedShards:string[]}>} 结果。
 */
export async function cleanupLayer(target, options = {}) {
  const scope = resolveScope(target, options.cwd);
  const days = Number.isInteger(options.days) ? options.days : configNum("cleanupDays");
  const now = options.now ?? new Date();
  const day = today(now);

  const archived = [];
  const removedShards = [];
  for (const file of listShardFiles(scope.dir)) {
    const text = readTextOrEmpty(file);
    if (text === "") continue;
    const shard = describeShard(file, scope.dir);
    const plan = archiveSupersededOf(scope.dir, shard, { days, day, now });
    if (plan === undefined) continue;

    // 先落归档、再改原分片：顺序反了的话，一旦归档写失败，历史就真丢了。
    const head = plan.wholeShard
      ? `<!-- archived · from ${plan.shard} · ${day} · 整片归档（${plan.count} 条失效，无有效条目） -->`
      : `<!-- archived · from ${plan.shard} · ${day} · ${plan.count} 条 -->`;
    let block = `${head}\n${plan.body}\n`;
    if (plan.wholeShard) {
      // 整片归档：连首行关键词头一起搬走（它是这片唯一的路由线索）。
      block = `${head}\n${text.endsWith("\n") ? text : `${text}\n`}\n`;
    }
    await appendArchiveFile(plan.file, block);

    if (plan.wholeShard) {
      rmSync(file, { force: true }); // 空分片（只剩失效条目）不再留一个 0 条目的行
      removedShards.push(plan.shard);
    } else {
      await writeTextSerialized(file, plan.nextShard);
    }
    archived.push({
      shard: plan.shard,
      count: plan.count,
      file: plan.file,
      wholeShard: plan.wholeShard === true,
    });
  }

  return { target: scope.target, dir: scope.dir, archived, removedShards };
}

/**
 * 两层一起执行容量策略，并按"**当天首次启动**"去重。
 *
 * 触发时机（T1 补充第 2 条）：
 * - 由 `index.js` 在挂载后延迟 `config.cleanupDelaySeconds` 秒调用（默认 10 秒）；
 * - 去重依据是**每层状态文件里的 `lastCleanup`**，而不是内存标记 —— 所以软件当天
 *   再启动多少次都不会重复清理，跨天则自动恢复；
 * - `force: true` 时忽略"今天已清理"，供 `memory_cleanup` 手动触发。
 *
 * 与"延后 10 秒"的配合是刻意的：启动瞬间宿主正在加载各插件、装配提示词，
 * 这时候去读改记忆目录既慢又容易和在途写入抢文件。
 *
 * @param {{cwd?:string, days?:number, now?:Date, force?:boolean, enabled?:boolean}} [options] - 参数。
 * @returns {Promise<object>} 结果摘要（含是否真的执行了）。
 */
export async function runCleanup(options = {}) {
  const now = options.now ?? new Date();
  const day = today(now);
  const days = Number.isInteger(options.days) ? options.days : configNum("cleanupDays");
  const enabled = options.enabled === undefined ? configValue("cleanupEnabled") : options.enabled === true;

  if (!enabled) {
    return { ran: false, reason: "disabled", today: day, days, layers: [], archived: 0, removedShards: 0 };
  }

  const layers = [];
  for (const target of ["global", "project"]) {
    const dir = layerDirOf(target, options.cwd);
    if (dir === undefined) continue; // 项目层无 cwd：跳过，而不是猜一个目录
    if (options.force !== true && cleanupDoneToday(dir, day)) {
      layers.push({ target, dir, skipped: "cleanup-done-today", archived: [], removedShards: [] });
      continue;
    }
    let result;
    try {
      result = await cleanupLayer(target, { cwd: options.cwd, days, now });
    } catch (error) {
      layers.push({ target, dir, error: String(error?.message ?? error), archived: [], removedShards: [] });
      continue;
    }
    await markCleanup(dir, day);
    layers.push({
      target,
      dir,
      archived: result.archived.map((a) => ({ shard: a.shard, count: a.count, file: displayPath(a.file, options.cwd), wholeShard: a.wholeShard === true })),
      removedShards: result.removedShards,
    });
  }

  const archived = layers.reduce((n, l) => n + (l.archived?.length ?? 0), 0);
  const removedShards = layers.reduce((n, l) => n + (l.removedShards?.length ?? 0), 0);
  return {
    ran: layers.some((l) => l.skipped === undefined && l.error === undefined),
    reason: "ok",
    today: day,
    days,
    cutoff: shiftDays(day, -days),
    layers,
    archived,
    removedShards,
  };
}

/**
 * 每层归档件的数量（供调用方按目录统计，不必自己拼归档路径）。
 *
 * @param {string} layerDir - 层目录绝对路径。
 * @returns {number} 归档件数。
 */
export function archivedCountOf(layerDir) {
  return archivedFileNames(layerDir).length;
}

/**
 * 取出"已知工作区"的根路径（后台清理用）。
 *
 * ## 为什么需要它
 *
 * 后台清理触发在**当天首次启动后约 10 秒**，那时可能还没有任何会话 ——
 * 于是拿不到 `cwd`，而项目层记忆目录是 `<cwd>/.agent-memory`。
 * 不管项目层就等于"项目层永远不会被清理"，而它正是最容易长大的那层
 * （复盘、排查过程都写在项目里）。
 *
 * ## 两条来源，都**失败即降级**
 *
 * 1. `ctx.get("workspace")`（宿主服务，若存在）—— 优先，因为它给的是活状态；
 * 2. `%DSH_HOME%/storages/workspace.json`（宿主的持久化文件）—— 兜底。
 *
 * 读文件是在读宿主的**内部格式**，所以这里刻意做得很保守：任何异常、任何字段形态
 * 不符都返回空数组，绝不上抛。清理少扫一层是"少做一件事"，
 * 而把插件/清理整个搞崩是"做坏一件事"。
 *
 * @param {object|undefined} ctx - 插件上下文（可缺省）。
 * @returns {string[]} 工作区根路径（去重后的绝对路径）。
 */
export function knownWorkspacePaths(ctx) {
  const out = [];

  // 来源 1：宿主服务（有就用；没有不算失败）
  try {
    const workspace = ctx?.get?.("workspace");
    const list = workspace?.list?.() ?? workspace?.workspaces?.() ?? workspace?.all?.();
    if (Array.isArray(list)) {
      for (const item of list) {
        const p = item?.path ?? item?.root ?? item?.cwd;
        if (typeof p === "string" && p.trim() !== "") out.push(resolve(p.trim()));
      }
    }
  } catch {
    /* 服务形态不符 ⇒ 只用兜底来源 */
  }

  // 来源 2：宿主的持久化文件（内部格式；读不懂就算了）
  try {
    const raw = JSON.parse(readTextOrEmpty(join(dshHome(), "storages", "workspace.json")));
    const table = raw?.tables?.workspaces;
    if (table !== null && typeof table === "object" && !Array.isArray(table)) {
      for (const record of Object.values(table)) {
        const p = record?.path;
        if (typeof p === "string" && p.trim() !== "") out.push(resolve(p.trim()));
      }
    }
  } catch {
    /* 文件不存在/格式变了 ⇒ 不猜，直接少扫这一层 */
  }

  const limit = configNum("maxProjectLayers");
  const seen = new Set();
  const unique = [];
  for (const p of out) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
    if (unique.length >= limit) break;
  }
  return unique;
}

/**
 * 启动后的容量策略：全局层 + **所有已知工作区**的项目层。
 *
 * 与 `runCleanup` 的分工：`runCleanup` 只认"一个 cwd"，是工具与测试的入口；
 * 这里是后台入口，它替每一层算好目录再各自去重（去重依据是状态文件里的
 * `lastCleanup`，所以"当天重启多次"与"同一工作区被列两次"都不会重复清理）。
 *
 * @param {{ctx?:object, cwd?:string, now?:Date, force?:boolean}} [options] - 参数。
 * @returns {Promise<object>} 汇总结果。
 */
export async function runStartupCleanup(options = {}) {
  const now = options.now ?? new Date();
  const day = today(now);
  const days = configNum("cleanupDays");
  if (configValue("cleanupEnabled") !== true) {
    return { ran: false, reason: "disabled", today: day, days, layers: [], archived: 0, removedShards: 0 };
  }

  const layers = [];
  const push = (result) => {
    for (const layer of result.layers ?? []) layers.push(layer);
  };

  push(await runCleanup({ cwd: options.cwd, now, force: options.force, days }));

  const roots = [];
  if (typeof options.cwd === "string" && options.cwd.trim() !== "") roots.push(options.cwd);
  for (const p of knownWorkspacePaths(options.ctx)) roots.push(p);

  const seen = new Set();
  for (const root of roots) {
    const key = String(root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (layers.some((l) => l.target === "project" && l.dir === projectRoot(root))) continue;
    push(await runCleanup({ cwd: root, now, force: options.force, days }));
  }

  return {
    ran: layers.some((l) => l.skipped === undefined && l.error === undefined),
    reason: "ok",
    today: day,
    days,
    cutoff: shiftDays(day, -days),
    layers,
    archived: layers.reduce((n, l) => n + (l.archived?.length ?? 0), 0),
    removedShards: layers.reduce((n, l) => n + (l.removedShards?.length ?? 0), 0),
  };
}
