/**
 * 路径与标识：本插件的 Windows 适配核心。
 *
 * 设计约束（针对四个参考插件在 Windows 上的真实故障，逐条反着做）：
 *
 * 1. **绝不在模块加载期求值根目录。** dsh-memory 的 `const HOME = process.env.HOME ?? ""`
 *    在 Windows 上（`HOME` 通常未设，用的是 `USERPROFILE`）会得到空串，于是
 *    `TOPICS_DIR` 变成 `/.dsh/memory/topics`，**全局层整体静默失效**，连开关文件
 *    都落到当前盘符根。本文件所有解析都发生在**函数调用时**，且 `DSH_HOME` 优先、
 *    `homedir()` 兜底 —— 任何情况下都不会返回空串或相对路径。
 * 2. **零 shell、零外部进程。** 不调用 `git`、不 `spawn` 任何东西。evolve 的
 *    `spawnSync('git', ...)` 失败会被静默 catch，导致分支隔离静默失效；本项目干脆
 *    不依赖外部进程，因此不存在"探针失败回落到错误默认值"这条路径。
 * 3. **全部走 `node:path`。** 不手写 `lastIndexOf("/")`，不假设分隔符。Windows 与
 *    POSIX 路径在这里被统一成同一种"层级"表达，slug 因此跨平台稳定。
 *
 * @module dsh-memory-win/lib/paths
 */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** 每层记忆目录下的分片文件后缀。 */
export const SHARD_EXT = ".md";

/** 项目层记忆目录名（放在仓库根下，可被 .gitignore 忽略）。 */
export const PROJECT_DIR_NAME = ".dsh-memory";

/** 全局层的默认子路径（相对于 DSH_HOME 或用户主目录）。 */
export const GLOBAL_SUBPATH = ["memory-win", "global"];

/**
 * 解析 DSH 主目录。**每次调用都重新读环境**，这是刻意的：
 * 面板/测试改 `DSH_HOME` 后立刻生效，不存在模块级快照。
 *
 * @returns {string} 绝对路径，永不为空串。
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return resolve(fromEnv.trim());
  }
  // homedir() 在 Windows 上解析 USERPROFILE，在 POSIX 上解析 HOME —— 这正是
  // dsh-memory 栽跟头的地方：不要用 process.env.HOME 去代替它。
  return join(homedir(), ".dsh");
}

/**
 * 全局层目录（绝对路径）。
 *
 * @returns {string} 例：`C:\Users\me\.dsh\memory-win\global`。
 */
export function globalRoot() {
  return join(dshHome(), ...GLOBAL_SUBPATH);
}

/**
 * 项目层目录（绝对路径）。项目记忆放在**仓库内**，因此可随 git 走、可 review。
 *
 * 注意：`cwd` 为空的场景（会话没有工作目录）会失败关闭 → 返回 `undefined`，
 * 调用方必须显式处理，而不是悄悄回落到全局层（那种"回落"正是静默失效的来源）。
 *
 * @param {string} [cwd] - 会话工作目录。
 * @returns {string|undefined} 绝对路径，或 cwd 不可用时 `undefined`。
 */
export function projectRoot(cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") return undefined;
  return join(resolve(cwd.trim()), PROJECT_DIR_NAME);
}

/**
 * 把任意平台的绝对路径归一成一个稳定的 slug。
 *
 * 两个平台的写法归一到同一串：`E:\Game\github` 与 `/Game/github` 都要变成
 * 可读、可比较、无非法字符的标识。做法是先统一分隔符，再剥掉"盘符/根"前缀，
 * 最后把分隔符与冒号换成 `-`。
 *
 * 与 dsh-memory 的 `slugOf` 的差异：它会保留 `::` 或 `-` 混用导致的歧义，
 * 且只处理 `/`；这里显式处理 `\` 与盘符，Windows 上语义才正确。
 *
 * @param {string} p - 绝对路径。
 * @returns {string} slug，例：`game-github`、`users-me-code-repo`。
 */
export function slugOf(p) {
  if (typeof p !== "string" || p === "") return "";
  let s = p.replace(/\\/g, "/");
  s = s.replace(/\/+/g, "/");
  s = s.replace(/^[A-Za-z]:/, ""); // 盘符前缀
  s = s.replace(/^\/+/, "");
  s = s.replace(/\/+$/, "");
  s = s.replace(/[:*?"<>|]/g, "-"); // Windows 保留字符，避免生成非法文件名
  s = s.replace(/\//g, "-");
  return s.toLowerCase();
}

/**
 * 是否为绝对路径（跨平台判定）。仅用于参数校验。
 *
 * @param {string} p - 候选路径。
 * @returns {boolean} 是否绝对。
 */
export function isAbsoluteAny(p) {
  return typeof p === "string" && (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\"));
}

/**
 * 把绝对路径渲染成**面向模型的可读路径**：项目层用相对路径，全局层保持绝对。
 *
 * 目的有二：① 提示词里不出现 `C:\Users\<用户名>\...` 这种机器特定信息；
 * ② 让模型直接拿这个路径去调 `read`/`grep`，不必自己拼。
 *
 * @param {string} abs - 绝对路径。
 * @param {string} [cwd] - 会话工作目录。
 * @returns {string} 展示用路径。
 */
export function displayPath(abs, cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") return abs;
  const base = resolve(cwd.trim());
  const norm = (x) => x.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const nAbs = norm(abs);
  const nBase = norm(base);
  if (nAbs === nBase) return ".";
  if (nAbs.startsWith(nBase + "/")) return abs.slice(base.length + 1).replace(/\\/g, "/");
  return abs;
}

/**
 * 在给定目录下拼接分片文件名，并**强制留在该目录内**。
 *
 * 名称来自模型输入，属于不可信数据：`../` 逃逸必须被拒绝，而不是"拼接后侥幸"。
 *
 * @param {string} dir - 分片所在目录（绝对）。
 * @param {string} name - 分片名（可带或不带扩展名）。
 * @returns {string} 绝对文件路径。
 * @throws {Error} 名称为空、含分隔符、或解析后逃出 dir 时抛出。
 */
export function shardPath(dir, name) {
  const raw = String(name ?? "").trim();
  if (raw === "") throw new Error("shard 名称不能为空");
  if (/[\\/]/.test(raw)) throw new Error(`shard 名称不能包含路径分隔符：${raw}`);
  if (raw === "." || raw === "..") throw new Error(`非法的 shard 名称：${raw}`);
  const base = raw.endsWith(SHARD_EXT) ? raw.slice(0, -SHARD_EXT.length) : raw;
  if (!/^[\w\u4e00-\u9fff][\w\u4e00-\u9fff .-]*$/u.test(base)) {
    throw new Error(`shard 名称只允许中英文、数字、空格、点、横线与下划线：${raw}`);
  }
  const full = join(dir, base + SHARD_EXT);
  // 双保险：即使上面的校验被绕过，也保证落点仍在 dir 内。
  const parent = resolve(full, "..");
  if (resolve(parent) !== resolve(dir)) throw new Error(`shard 路径逃出了记忆目录：${raw}`);
  return full;
}

/** 当前平台是否为 Windows（仅用于文案，不用于任何分支逻辑）。 */
export const IS_WINDOWS = process.platform === "win32";

/** 平台原生分隔符，导出给测试断言用。 */
export const NATIVE_SEP = sep;
