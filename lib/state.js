/**
 * 每层的**运维状态**：`.state.json`。
 *
 * 承载两件 0.2.0 新增的事：
 *
 * 1. **检索命中记录**（`access`）—— "哪些分片/条目被取回过"。容量策略只把它当
 *    **减档条件**（最近被取回过的东西不归档），绝不用它去归档活跃条目；
 * 2. **当天清理标记**（`lastCleanup`）—— 配合"当天首次启动 + 延迟 N 秒"的触发时机，
 *    避免同一天软件重启后重复清理。
 *
 * ## 三条纪律
 *
 * - **状态不是记忆**：它不参与注入、不参与检索，格式变化也不影响任何记忆正文。
 *   因此读坏了（JSON 解析失败、结构不对）一律**退回空状态**，而不是让整个插件挂掉 ——
 *   与"记忆正文坏掉要可见"是两种不同的东西，不能一刀切。
 * - **写入只在值真的变了时发生**：命中记录按**日**粒度，所以同一天内第 1 次命中之后
 *   的每一次命中都不会产生写盘。这很关键：`memory_search` 可能每轮都跑，
 *   若每次都写盘，就把一个只读操作变成了热写路径。
 * - **写盘失败不影响检索**：状态是运维数据，丢一次命中记录最多让某个分片晚几天归档；
 *   而让 `memory_search` 报错则是功能不可用。所以写失败只吞掉。
 *
 * @module dsh-memory-win/lib/state
 */

import { shiftDays, today } from "./format.js";
import { listFileNames, readTextOrEmpty, writeTextSerialized } from "./fs-utils.js";
import { archiveRoot, stateFile } from "./paths.js";

/** 状态结构版本。将来改结构时用它做迁移判断。 */
export const STATE_VERSION = 1;

/**
 * 一份**空状态**。
 *
 * @returns {{version:number, lastCleanup:string, access:object}} 新对象。
 */
export function emptyState() {
  return { version: STATE_VERSION, lastCleanup: "", access: {} };
}

/**
 * 把任意读到的 JSON 值规整成合法状态。
 *
 * 任何不认识的东西都被丢掉而不报错：状态是运维数据，不是记忆正文，
 * 它坏掉不该让插件不可用（对比：`parseEntries` 面对坏条目必须保守，
 * 因为那会影响"哪些结论还算数"）。
 *
 * @param {*} raw - JSON.parse 的结果。
 * @returns {{version:number, lastCleanup:string, access:object}} 合法状态。
 */
export function sanitizeState(raw) {
  const out = emptyState();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;

  if (typeof raw.lastCleanup === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastCleanup)) {
    out.lastCleanup = raw.lastCleanup;
  }
  if (raw.access !== null && typeof raw.access === "object" && !Array.isArray(raw.access)) {
    for (const [shard, rec] of Object.entries(raw.access)) {
      if (typeof shard !== "string" || shard.trim() === "") continue;
      if (rec === null || typeof rec !== "object" || Array.isArray(rec)) continue;
      const last = typeof rec.last === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rec.last) ? rec.last : "";
      const entries = {};
      if (rec.entries !== null && typeof rec.entries === "object" && !Array.isArray(rec.entries)) {
        for (const [id, date] of Object.entries(rec.entries)) {
          if (typeof id === "string" && id !== "" && typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
            entries[id] = date;
          }
        }
      }
      out.access[shard] = { last, entries };
    }
  }
  return out;
}

/** 每层目录的**内存状态**（进程内缓存）：避免每次检索都读盘。 */
const cache = new Map();

/**
 * 取某层的状态（带缓存）。
 *
 * @param {string} layerDir - 层目录绝对路径。
 * @returns {{version:number, lastCleanup:string, access:object}} 状态对象（**共享引用**，调用方不要改）。
 */
export function stateOf(layerDir) {
  const key = String(layerDir).toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const data = sanitizeState(parseJsonOrUndefined(readTextOrEmpty(stateFile(layerDir))));
  cache.set(key, data);
  return data;
}

/** 丢弃内存缓存（测试用；生产路径不需要）。 */
export function resetStateCache() {
  cache.clear();
}

/**
 * JSON 解析，失败返回 `undefined`（不抛）。
 *
 * @param {string} text - 文本。
 * @returns {*} 解析结果或 `undefined`。
 */
function parseJsonOrUndefined(text) {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 记录"这次检索/浏览取回了这些条目"。
 *
 * 只在日期**真的变化**时才写盘：同一天内的重复命中是纯粹的缓存命中，
 * 不产生 I/O。写入是**串行化 + 原子**的（与分片写入共用一套纪律）。
 *
 * @param {string} layerDir - 层目录绝对路径。
 * @param {string} shardName - 分片名。
 * @param {{id:string}[]} entries - 命中的条目（至少要带 id）。
 * @param {string} [day] - 本地日期，默认今天。
 * @returns {Promise<boolean>} 是否真的写盘了。
 */
export async function recordAccess(layerDir, shardName, entries, day = today()) {
  const name = String(shardName ?? "").trim();
  if (name === "" || !Array.isArray(entries) || entries.length === 0) return false;

  const state = stateOf(layerDir);
  const rec = state.access[name] ?? { last: "", entries: {} };
  let changed = false;

  for (const entry of entries) {
    const id = String(entry?.id ?? "").trim();
    if (id === "") continue;
    if (rec.entries[id] === day) continue;
    rec.entries[id] = day;
    changed = true;
  }
  if (rec.last !== day) {
    rec.last = day;
    changed = true;
  }
  if (!changed) return false;

  state.access[name] = rec;
  await persist(layerDir, state);
  return true;
}

/**
 * 把某层的状态写盘（串行化 + 原子）。**失败只记录、不上抛。**
 *
 * @param {string} layerDir - 层目录绝对路径。
 * @param {object} state - 要写入的状态（同一份内存对象）。
 * @returns {Promise<boolean>} 是否写入成功。
 */
async function persist(layerDir, state) {
  const file = stateFile(layerDir);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  try {
    await writeTextSerialized(file, text);
    return true;
  } catch {
    // 状态写盘失败不影响检索与写入这两条主线功能。
    return false;
  }
}

/**
 * 标记"今天已经清理过"。
 *
 * 这是**唯一**的当天去重依据：软件当天再次启动时，读到的 `lastCleanup` 就是今天，
 * 于是跳过 —— 不需要另存开关文件，重启也不会把标记弄丢。
 *
 * @param {string} layerDir - 层目录绝对路径。
 * @param {string} [day] - 本地日期，默认今天。
 * @returns {Promise<boolean>} 状态是否被更新（已标记过则为 `false`）。
 */
export async function markCleanup(layerDir, day = today()) {
  const state = stateOf(layerDir);
  if (state.lastCleanup === day) return false;
  state.lastCleanup = day;
  await persist(layerDir, state);
  return true;
}

/**
 * 今天是否已经清理过。
 *
 * @param {string} layerDir - 层目录绝对路径。
 * @param {string} [day] - 本地日期，默认今天。
 * @returns {boolean} 是否已清理。
 */
export function cleanupDoneToday(layerDir, day = today()) {
  return stateOf(layerDir).lastCleanup === day;
}

/**
 * 某分片最近一次被取回的日期（从未取回过则为空串）。
 *
 * @param {string} layerDir - 层目录绝对路径。
 * @param {string} shardName - 分片名。
 * @returns {string} `YYYY-MM-DD` 或空串。
 */
export function lastAccessOf(layerDir, shardName) {
  return stateOf(layerDir).access[String(shardName ?? "")]?.last ?? "";
}

/**
 * 某条目最近一次被取回的日期（从未取回过则为空串）。
 *
 * @param {string} layerDir - 层目录绝对路径。
 * @param {string} shardName - 分片名。
 * @param {string} id - 条目 id。
 * @returns {string} `YYYY-MM-DD` 或空串。
 */
export function lastAccessOfEntry(layerDir, shardName, id) {
  return stateOf(layerDir).access[String(shardName ?? "")]?.entries?.[String(id ?? "")] ?? "";
}

/**
 * 计算"某分片里应当被归档的已失效条目行号"。
 *
 * **纯函数**（除状态读取外不碰 I/O），把判定从归档动作里分出来，便于穷举测试。
 *
 * 判定同时满足两条才归档：
 * 1. 该行是**已失效条目**（`<!-- - [日期] … -->`）—— 活条目的坟不是这里挖的：
 *    归档绝不能把仍然生效的结论挪出注入；
 * 2. 其日期已超出宽限期（`cleanupDays`）。
 *
 * 关于"未被检索命中"这一条：它在这里的作用是**减档**而不是增档 ——
 * 若这个条目在宽限期内还被取回过（`access` 里有比条目日期更新的记录），
 * 就再等一轮。理由是"刚被查过"通常意味着它还在被追查（例如正在复盘那次修正），
 * 此时把形成它的历史搬走最不合时宜。
 *
 * @param {object} params - 参数。
 * @param {{line:number,date:string,id:string}[]} params.superseded - 已失效条目（带行号与日期）。
 * @param {number} params.days - 宽限期天数（`cleanupDays`）。
 * @param {string} params.day - 本地今天（**参数名刻意不叫 `today`**：那会遮蔽本模块从
 *   `format.js` 引入的 `today()`，是本项目最不想再要的一类"看起来对"的错）。
 * @param {Map<string,string>} [params.access] - 条目 id → 最近取回日期。
 * @returns {number[]} 可归档的行号（升序）。
 */
export function archivableLines({ superseded, days, day, access }) {
  const cutoff = shiftDays(day, -days);
  const out = [];
  for (const entry of superseded ?? []) {
    const date = String(entry?.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!(date < cutoff)) continue;
    const seen = access?.get?.(String(entry.id ?? "")) ?? "";
    // 宽限期内被取回过 ⇒ 再等一轮（减档条件，见上面注释）。
    if (/^\d{4}-\d{2}-\d{2}$/.test(seen) && !(seen < cutoff)) continue;
    out.push(Number(entry.line));
  }
  return out.sort((a, b) => a - b);
}

/**
 * 归档目录里已有的归档文件名清单（用于 `memory_cleanup` 的回显与统计）。
 *
 * @param {string} layerDir - 层目录绝对路径。
 * @returns {string[]} 文件名列表（升序）。
 */
export function archivedFileNames(layerDir) {
  return listFileNames(archiveRoot(layerDir))
    .filter((n) => n.endsWith(".md"))
    .sort();
}
