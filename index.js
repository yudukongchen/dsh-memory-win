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

  // ── 3. 写入守卫（两条路径**同时**挂，取并集）──────────────────────────────
  //
  // 早期这里写的是 `if (tools.guard) {...} else { pre-execute }` —— 二选一，
  // 结果因为 DSH 有 tools.guard，项目层那条分支从不执行，
  // `<repo>/.dsh-memory/*.md` 的直写完全不被拦（真实宿主实测到）。
  // 教训：**单调性更强 ≠ 覆盖面更广**，两个机制不是替代关系。
  //
  // 现在两条都挂：
  //   · `tools.guard()`      —— 单调，无法被后续监听者 force-allow；
  //   · `tools/pre-execute`  —— waterfall，兼容没有 guard() 的旧宿主。
  // 判定逻辑共用 `directWriteDenial`（见 lib/guard.js），两条路径覆盖面一致。
  // 宿主按注册顺序取**第一个**非空 deny，所以重复挂不会产生重复拒绝。
  ctx.effect(
    () => {
      const tools = ctx.get("tools");
      const disposers = [];

      if (tools !== undefined && typeof tools.guard === "function") {
        const dispose = tools.guard((execution) => directWriteDenial(execution));
        if (typeof dispose === "function") disposers.push(dispose);
      }

      const off = ctx.on("tools/pre-execute", preExecuteGuard);
      if (typeof off === "function") disposers.push(off);

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
    "dsh-memory-win: memory write guard",
  );
}
