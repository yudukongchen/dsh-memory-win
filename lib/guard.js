/**
 * 写入守卫：拦住绕过 `memory_add` / `memory_correct` 的直写。
 *
 * ## 两条挂载路径，取**并集**（不是二选一）
 *
 * 宿主提供两种拦截机制，覆盖面不同，**两条都挂**：
 *
 * | 路径 | 机制 | 覆盖 |
 * |---|---|---|
 * | `tools.guard(fn)` | **同步**、单调（返回拒绝原因字符串），无法被后续监听者放行 | 全局层 + 项目层（能拿到 agent 时） |
 * | `tools/pre-execute` | waterfall（返回 `{kind:'deny'}`），理论上可被后续监听者放行 | 全局层 + 项目层 |
 *
 * ## 历史缺陷（已修，值得留档）
 *
 * 早期实现是 `if (tools.guard) 用 guard; else 用 pre-execute` —— **二选一**。
 * 由于 DSH 确实有 `tools.guard`，项目层那条分支**从不执行**，于是
 * `<repo>/.dsh-memory/*.md` 的直写完全不被拦。这在真实宿主里被实测到：
 * 对 `E:\Game\github\.dsh-memory\verify.md` 的 `write` **竟然成功落盘**。
 *
 * 根因是把"更强的机制"误当成"更全的机制" —— **单调性更强 ≠ 覆盖面更广**。
 * 这个缺陷单测抓不到，因为单测里两条路径都被分别断言过，漏的是"二者只挂一条"这个
 * 组合事实；只有真实宿主里点一下才暴露。
 *
 * ## 设计边界（**诚实地写清楚，不含糊**）
 *
 * - 只覆盖**原生 `write` / `edit`** 对记忆目录的直写。
 *   它**不是全工具面的安全边界**：`pwsh`、MCP 工具、其它插件、`node`/`python`
 *   执行都能绕过 —— dsh-memory 的同类守卫有一样的边界，但它没有声明这一点。
 * - 因此定位是**防手滑，不是防对抗**。
 * - **不做 shell 解析**。dsh-memory 会去解析 `bash` 的重定向/`tee`/`sed -i` 目标，
 *   这在 Windows 上收益很低（桌面版走 pwsh / git bash，命令形态完全不同），
 *   而且那类启发式正是"只读命令被误判成写记忆"的来源。这里选择不做，而不是做个半准的。
 *
 * @module dsh-memory-win/lib/guard
 */

import { relative, resolve } from "node:path";

import { cwdOf } from "./context.js";
import { globalRoot, projectRoot } from "./paths.js";

/**
 * 本插件用来写记忆的**自有**工具名集合。
 *
 * 它们是唯一被允许写记忆文件的通道，因此守卫必须放行它们；其它任何 `write`/`edit`
 * 落到记忆目录都要拒。
 */
export const OWN_TOOLS = ["memory_add", "memory_correct"];

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
export function targetOf(args) {
  const p = args?.file_path;
  return typeof p === "string" && p.trim() !== "" ? p.trim() : undefined;
}

/**
 * 列出本次调用需要检查的记忆根目录。**同步、不做任何 I/O。**
 *
 * 项目层需要 cwd，而 cwd 要从 `exec.agent` 上取。宿主在 `guardReason(exec)` 里
 * 显式读 `exec.agent`（并据此决定是否继续走 scoped guard 层），因此该字段在实际
 * 分派时是存在的 —— 这也意味着**同步 guard 同样能覆盖项目层**，不需要回调到
 * waterfall。取不到 cwd 时就只检查全局层，**不猜路径**。
 *
 * @param {object|undefined} execution - 工具执行上下文。
 * @returns {string[]} 绝对目录列表（至少含全局层）。
 */
function memoryRootsOf(execution) {
  const roots = [globalRoot()];
  const project = projectRoot(cwdOf(execution));
  if (project !== undefined) roots.push(project);
  return roots;
}

/**
 * 判定一次 `write`/`edit` 是否命中记忆目录，命中则给出拒绝原因。
 *
 * 这是**唯一**的判定入口：同步 `tools.guard()` 与 waterfall `pre-execute`
 * 共用它，避免两条路径的覆盖面或措辞漂移
 * （evolve 的 `lib/skills.js` 少了一处兜底、导致技能永远改不动，成因正是
 * "同一套判定被复制成两份"）。
 *
 * @param {object|undefined} execution - 工具执行上下文。
 * @returns {string|undefined} 拒绝原因；放行时 `undefined`。
 */
export function directWriteDenial(execution) {
  try {
    const name = execution?.name;
    if (name !== "write" && name !== "edit") return undefined;

    const target = targetOf(execution?.arguments);
    if (target === undefined) return undefined;

    if (!memoryRootsOf(execution).some((root) => isUnder(target, root))) return undefined;
    return denialText(name, target);
  } catch {
    // 同步守卫抛错会变成"拒绝执行"，因此这里必须吞掉并放行。
    // 宁可漏拦一次，也不让一次异常把整个工具面打死。
    return undefined;
  }
}

/**
 * `tools/pre-execute` 守卫本体（waterfall 路径）。
 *
 * 与 `directWriteDenial` 共用同一判定；命中时返回 `{kind:'deny', reason}`，
 * 放行时返回 `undefined` 并调用 `next()`。
 *
 * 任一环节抛错都**放行**并继续 `next()`。这是与 dsh-memory 相反的选择：
 * 它那个钩子在 Windows 上会因硬编码 `/bin/zsh` 同步抛穿、把进程搞崩。
 *
 * @param {object} exec - 工具执行上下文。
 * @param {() => Promise<object>} next - waterfall 的下一环。
 * @returns {Promise<object|undefined>} 决策。
 */
export async function preExecuteGuard(exec, next) {
  const reason = directWriteDenial(exec);
  if (reason !== undefined) return { kind: "deny", reason };
  return await next();
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
    "改写记忆只有两条通道，按你的意图选：",
    "  · 新增一条 → memory_add { target: \"global\"|\"project\", shard: \"<主题>\", fact: \"<一句话事实>\" }",
    "  · 修正已有条目 → 先用 memory_search 拿到它的 id，再",
    "      memory_correct { id: \"<id>\", reason: \"defect|overturned|correction|retract\", replacement: \"<新结论>\" }",
    "原因：这两个工具会做条目格式、日期合法性与凭据扫描三项校验，并做原子追加；",
    "`memory_correct` 还会把旧条目就地标记为历史，使它不再注入、也不再被检索命中。",
    "直接改写会破坏 `- [YYYY-MM-DD] 事实` 的行结构，导致记忆无法被检索或整层失效。",
  ].join("\n");
}
