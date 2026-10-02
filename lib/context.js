/**
 * 宿主上下文的读取工具。
 *
 * 单独成文件的原因：`cwdOf` 同时被守卫与工具使用，而"两处各写一份兜底链"正是
 * evolve 里那个真实缺陷的形态（`lib/skills.js` 少了一处 `ownEvents?.()` 兜底，
 * 导致技能永远改不动）。共用一份实现，就不存在两处漂移。
 *
 * @module dsh-memory-win/lib/context
 */

/**
 * 从工具执行上下文或提示词装配上下文里取出会话工作目录。
 *
 * 声明里 `AssembleContext` 只有 `{scope, signal}`，`ToolExecution` 上也没有 cwd，
 * 它必须从 agent/session 上取；而不同版本的载体不同，因此做多路可选兜底。
 * **拿不到就返回 `undefined`**，由调用方决定怎么处理 —— 绝不猜一个路径出来。
 *
 * @param {object|undefined} source - 工具执行上下文 / 装配上下文。
 * @returns {string|undefined} 去空后的绝对或相对 cwd。
 */
export function cwdOf(source) {
  const candidates = [
    source?.agent?.session?.header?.cwd,
    source?.agent?.session?.cwd,
    source?.agent?.cwd,
    source?.session?.header?.cwd,
    source?.session?.cwd,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return undefined;
}
