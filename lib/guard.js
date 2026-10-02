/**
 * 写入守卫：挂在 `tools/pre-execute` waterfall 上，拦住绕过 `memory_add` 的直写。
 *
 * 设计边界（**诚实地写清楚，不含糊**）：
 *
 * - 本守卫只覆盖**原生 `write` / `edit` 工具**对记忆目录的直写。
 *   它**不是全工具面的安全边界**：`pwsh`、MCP 工具、其它插件、`node`/`python`
 *   执行都能绕过 —— dsh-memory 的同类守卫有一样的边界，但它没有声明这一点。
 * - 因此本守卫的定位是**防手滑，不是防对抗**。
 * - **不做 shell 解析**。dsh-memory 会去解析 `bash` 的重定向/`tee`/`sed -i` 目标，
 *   这在 Windows 上收益很低（桌面版走 pwsh / git bash，命令形态完全不同），
 *   而且那类启发式正是"只读命令被误判成写记忆"的来源。这里选择不做，而不是做个
 *   半准的。
 *
 * @module dsh-memory-win/lib/guard
 */

import { relative, resolve } from "node:path";

import { cwdOf } from "./context.js";
import { globalRoot, projectRoot } from "./paths.js";

/** 本插件允许写入记忆的**唯一**工具名。 */
export const OWN_TOOL = "memory_add";

/**
 * 判断一个路径是否落在某个记忆根目录内。
 *
 * 用 `relative()` 而不是字符串前缀比较：前缀比较在 `C:\a` 与 `C:\ab` 上会误判，
 * 且大小写与分隔符差异会让它静默漏判 —— 这两点都是"守卫看着装了其实没装"的成因。
 *
 * @param {string} file - 待检路径。
 * @param {string} root - 记忆根目录。
 * @returns {boolean} 是否在根内。
 */
export function isUnder(file, root) {
  if (typeof file !== "string" || file.trim() === "") return false;
  const rel = relative(resolve(root), resolve(file));
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  // Windows 上跨盘符时 relative 返回绝对路径，也会被上面的 startsWith("..") 漏掉。
  if (/^[A-Za-z]:/.test(rel)) return false;
  return true;
}

/**
 * 取本次调用要写入的目标路径（`write` 用 `file_path`，`edit` 同）。
 *
 * @param {object} args - 工具参数。
 * @returns {string|undefined} 目标路径。
 */
function targetOf(args) {
  const p = args?.file_path;
  return typeof p === "string" && p.trim() !== "" ? p.trim() : undefined;
}

/**
 * `tools/pre-execute` 守卫本体。
 *
 * 命中时返回 `{kind:'deny', reason}`；放行时返回 `undefined` 并调用 `next()`。
 * 拒绝理由写成**给模型看的可执行清单**（哪里错了、该怎么改），而不是一句"不允许"。
 *
 * 任一环节抛错都**放行**并继续 `next()` —— 守卫故障绝不能变成"所有工具都不可用"。
 * 这是与 dsh-memory 相反的选择：它那个钩子在 Windows 上会同步抛穿、把进程搞崩。
 *
 * @param {object} exec - 工具执行上下文。
 * @param {() => Promise<object>} next - waterfall 的下一环。
 * @returns {Promise<object|undefined>} 决策。
 */
export async function preExecuteGuard(exec, next) {
  try {
    const name = exec?.name;
    if (name !== "write" && name !== "edit") return await next();

    const target = targetOf(exec?.arguments);
    if (target === undefined) return await next();

    const cwd = cwdOf(exec);
    const roots = [globalRoot()];
    const proj = projectRoot(cwd);
    if (proj !== undefined) roots.push(proj);

    if (!roots.some((root) => isUnder(target, root))) return await next();

    return { kind: "deny", reason: denialText(name, target) };
  } catch {
    // 守卫故障放行：宁可漏拦一次，也不让一次异常把整个工具面打死。
    return await next();
  }
}

/**
 * 面向模型的拒绝文案。两条守卫路径共用，避免措辞漂移。
 *
 * @param {string} toolName - 工具名。
 * @param {string} target - 目标路径。
 * @returns {string} 拒绝原因。
 */
export function denialText(toolName, target) {
  return [
    `拒绝：不要用 \`${toolName}\` 直接改记忆文件（${target}）。`,
    "请改用 `memory_add` 追加一条：",
    '  memory_add { target: "global" | "project", shard: "<主题>", fact: "<一句话事实>" }',
    "原因：`memory_add` 会做条目格式、日期合法性与凭据扫描三项校验，并做原子追加；",
    "直接改写会破坏 `- [YYYY-MM-DD] 事实` 的行结构，导致记忆无法被检索或整层失效。",
    "（若确实需要修订既有条目，请先 `memory_search` 找到行号，再说明你的意图。）",
  ].join("\n");
}

/**
 * `tools.guard()` 回调：**同步**目录包含判定。
 *
 * `tools.guard` 是同步接口，且回调只拿到 `execution`，拿不到可靠的会话 cwd。
 * 因此这里**只拦全局层**，项目层交给 `preExecuteGuard`（它能拿到 agent → cwd）。
 *
 * 这个覆盖面差异是**刻意声明**的，不是遗漏：`tools.guard` 是单调守卫（无法被
 * 后续监听者 force-allow），但覆盖窄；waterfall 覆盖面宽，但理论上可被后续
 * 监听者放行。两条一起挂，得到"全局层不可绕过 + 项目层也拦得住"。
 *
 * 本函数**不做任何 I/O**，因此不会因文件系统失败而抛错 —— 对同步守卫尤其重要。
 *
 * @param {object|undefined} execution - 工具执行上下文。
 * @returns {string|undefined} 拒绝原因，或放行时的 `undefined`。
 */
export function directWriteDenial(execution) {
  try {
    const name = execution?.name;
    if (name !== "write" && name !== "edit") return undefined;
    const target = targetOf(execution?.arguments);
    if (target === undefined) return undefined;
    if (!isUnder(target, globalRoot())) return undefined;
    return denialText(name, target);
  } catch {
    // 同步守卫抛错会变成"拒绝执行"，因此这里必须吞掉并放行。
    return undefined;
  }
}
