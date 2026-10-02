/**
 * dsh-memory-win —— DSH 桌面版（Windows 优先）的长期记忆插件。
 *
 * 与四个参考插件（dsh-memory / dsh-auto-memory / dsh-memory-evolve / hindsight）
 * 的关系：**取它们的取舍，去掉它们在本机环境上真实失效的部分。**
 *
 * 采用的机制（来自 dsh-memory 的核心洞察）：
 * - 记忆就是明文 markdown，零依赖、零额外模型调用、可 git、可手改；
 * - 注入提示词的只有**地图**（片名 / 条数 / 最新日期 / 关键词 / 路径），
 *   正文一律按需检索 —— 于是提示词开销恒定，不随记忆增长；
 * - 条目用 `- [YYYY-MM-DD] 事实`，检索命中带**行号**，可直接 `read` 取原文。
 *
 * 明确**不做**的事，以及原因：
 * - 不做向量检索、不下载模型、不起后台服务 → 满足"纯本地、无服务依赖"；
 * - 不调用任何模型做巩固/反思 → 零额外成本，也避免弱模型把噪音写进长期记忆；
 * - 不 spawn 任何外部进程、不拼 shell 命令 → 这正是四个参考插件在 Windows 上
 *   最集中的故障源（`/bin/zsh` 抛穿、`sh -c` 静默吞错、`process.kill(-pid)` 失效）；
 * - 不做浏览器半身 / 设置面板 → demo 阶段刻意最小化（详见 README 的限制清单）。
 *
 * @module dsh-memory-win
 */

import { cwdOf } from "./lib/context.js";
import { denialText, directWriteDenial, preExecuteGuard } from "./lib/guard.js";
import { SECTION_NAME, renderMap } from "./lib/map.js";
import { allTools } from "./lib/tools.js";

/** 插件名。 */
export const name = "dsh-memory-win";

/**
 * 硬依赖。只声明 `systemPrompt`（注入段的载体）。
 *
 * `tools` 刻意**不**放进 inject：桌面版若不加载工具注册表，插件也不该整个起不来 ——
 * 用 `ctx.get("tools")` 可选获取，缺席时只少三个工具，注入仍然有效。
 */
export const inject = ["systemPrompt"];

/**
 * 挂载。
 *
 * @param {object} ctx - cordis 插件上下文。
 */
export function apply(ctx) {
  // ── 1. 地图注入 ──────────────────────────────────────────────────────────
  // text 传的是**函数**而非字符串：宿主每次装配时重新求值，所以记忆一改，
  // 下一轮注入立刻反映 —— 不存在"读到缓存的旧地图"。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION_NAME,
        // 紧跟在人格前缀之后、工具规范之前，与 dsh-memory 取同位次。
        order: 1,
        text: (assembleContext) => {
          try {
            return renderMap({ cwd: cwdOf(assembleContext) });
          } catch (error) {
            // 注入失败不能连带把提示词装配搞崩（那会让整个会话不可用），
            // 但仍然**留下痕迹**，而不是静默返回空串假装没有记忆。
            return `## 长期记忆（地图档）\n<!-- dsh-memory-win: 渲染地图失败：${String(error?.message ?? error)} -->`;
          }
        },
      }),
    "dsh-memory-win: memory map section",
  );

  // ── 2. 三个工具 ──────────────────────────────────────────────────────────
  ctx.effect(
    () => {
      const tools = ctx.get("tools");
      if (tools === undefined) return () => {};
      const disposers = [];
      for (const definition of allTools()) {
        const dispose = tools.register(definition);
        if (typeof dispose === "function") disposers.push(dispose);
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 卸载期的失败无需上抛 */
          }
        }
      };
    },
    "dsh-memory-win: memory tools",
  );

  // ── 3. 写入守卫 ──────────────────────────────────────────────────────────
  // 优先用 `tools.guard()`：单调守卫，**无法被后续监听者 force-allow**，
  // 比 waterfall 事件更难绕过。旧宿主没有该方法时回落到 `tools/pre-execute`。
  //
  // 两条路径的覆盖面**不同，且这一点被显式声明**（见 lib/guard.js）：
  // guard() 的回调只拿到 execution、没有可靠的 cwd，因此它只拦**全局层**；
  // 项目层的直写由 waterfall 那条路径覆盖（它能拿到 agent → cwd）。
  ctx.effect(
    () => {
      const tools = ctx.get("tools");
      if (tools !== undefined && typeof tools.guard === "function") {
        const dispose = tools.guard((execution) => directWriteDenial(execution));
        return typeof dispose === "function" ? dispose : () => {};
      }
      return ctx.on("tools/pre-execute", preExecuteGuard);
    },
    "dsh-memory-win: memory write guard",
  );
}
