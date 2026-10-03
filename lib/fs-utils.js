/**
 * 文件读写的**唯一实现处**：安全读、原子写、按文件串行化。
 *
 * ## 为什么单独成文件
 *
 * 0.2.0 新增了每层的状态文件（`.state.json`：检索命中记录 + 当天清理标记），
 * 它和分片文件一样需要"原子写 + 串行化"。这两样东西此前长在 `lib/engine.js` 里，
 * 如果状态模块再抄一份，就会出现**两套写文件纪律** —— 而"同一套规则被复制成两份"
 * 正是本项目吃过两次亏的形态（守卫覆盖面漂移、160 截断两处计长）。
 *
 * 所以：`engine.js`（分片）与 `state.js`（状态）都从这里取，纪律只有一份。
 *
 * ## 两条纪律
 *
 * 1. **原子写**：同目录临时文件（带 pid + 随机数）→ `rename` 覆盖。同目录是必须的
 *    （跨卷 rename 会失败）；临时名带随机数是必须的（参考插件用固定 `.tmp`，
 *    同目录并发会互相踩）。
 * 2. **每文件一条 promise 串行链 + 写前重读**：DSH 插件跑在宿主进程内，同进程内的
 *    并发用链串行化即可。跨进程并发是**已声明的限制**（README 第 3 节限制 4），
 *    不做锁文件 —— 参考插件的 pid 存活探测锁在 Windows 上语义不可靠。
 *
 * @module dsh-memory-win/lib/fs-utils
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/** 每文件的写入串行链。key = 小写化后的绝对路径。 */
const writeChains = new Map();

/**
 * 把一次写操作排到该文件的串行链尾。
 *
 * @template T
 * @param {string} file - 目标文件绝对路径。
 * @param {() => Promise<T>} op - 写操作。
 * @returns {Promise<T>} 操作结果。
 */
export function serializeWrite(file, op) {
  const key = String(file).toLowerCase();
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(op, op);
  // 链上只保留"已 settle"的表示，避免一次失败把后续写入永久卡住。
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
 * 串行化 + 原子地写一个文本文件（**唯一的写入口**）。
 *
 * ## 为什么"计算正文"也必须在这个回调里（这里踩过一个自死锁）
 *
 * 0.2.0 初版把写入写成 `serializeWrite(file, async () => { ...; await writeTextSerialized(file, next) })`
 * —— 对**同一个文件**套了两层串行链：外层 op 要等内层写完，而内层排在**外层自己**后面，
 * 于是这条 promise 永远不会 settle（`appendMemory` 整个挂住、事件循环结束后被 Node 判为
 * 未决 promise）。修法不是加超时，而是**取消嵌套**：读-改-写整个包在同一个 op 里，
 * 由本函数负责唯一的落盘。
 *
 * 所以约定是：`op` **返回要写入的正文**（或 `{content, result}` 表示"写这个、但把那个
 * 当结果返回"）；它**不得**自己再调用任何写入函数。
 *
 * @template T
 * @param {string} file - 目标绝对路径。
 * @param {() => Promise<string|{content:string,result:T}>|string|{content:string,result:T}} op - 计算正文的操作。
 * @returns {Promise<string|T>} 写入的正文，或 `op` 指定的返回值。
 * @throws {Error} `op` 抛错时原样上抛（此时不会写任何东西）。
 */
export function writeAtomically(file, op) {
  return serializeWrite(file, async () => {
    const produced = await op();
    const shaped = produced !== null && typeof produced === "object" ? produced : { content: produced, result: produced };
    mkdirSync(dirOf(file), { recursive: true });
    atomicWrite(file, shaped.content);
    return shaped.result;
  });
}

/**
 * `writeAtomically` 的便捷形式：正文已经算好，直接串行化 + 原子写。
 *
 * @param {string} file - 目标绝对路径。
 * @param {string} content - 完整正文。
 * @returns {Promise<string>} 写入的正文。
 */
export function writeTextSerialized(file, content) {
  return writeAtomically(file, () => content);
}

/**
 * 安全读文本：文件不存在、不是文件或不可读都返回空串。
 *
 * @param {string} file - 绝对路径。
 * @returns {string} 正文。
 */
export function readTextOrEmpty(file) {
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
 * @param {string} file - 目标绝对路径。
 * @param {string} content - 完整正文。
 * @throws {Error} 写或 rename 失败时抛出（原文件保持不动，临时文件被清理）。
 */
export function atomicWrite(file, content) {
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
 * 列出一个目录下的文件名（不递归）。
 *
 * @param {string} dir - 目录绝对路径。
 * @returns {string[]} 文件名；目录不存在或不可读时为空数组。
 */
export function listFileNames(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 取一个路径的父目录（不引入 `node:path` 只为这一处，保持依赖面清晰）。
 *
 * @param {string} file - 文件绝对路径。
 * @returns {string} 父目录。
 */
function dirOf(file) {
  const s = String(file);
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return idx <= 0 ? s : s.slice(0, idx);
}

/** 供测试使用的写入链长度（确认没有无限累积）。 */
export function writeChainSize() {
  return writeChains.size;
}
