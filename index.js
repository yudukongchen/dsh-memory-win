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
 * - 不做浏览器半身 / 设置面板 → 配置只走 profile patch 的 `config:` 段（见 lib/config.js）。
 *
 * 0.2.0 的两项变化：
 * - **配置层**（`lib/config.js`）：`inlineTextMax` / `factBodyMax` / `inlineThreshold` /
 *   `keywordsMaxChars` / `cleanupDays` / `cleanupDelaySeconds` / 凭据模式表等都从
 *   "硬编码常量"变成 config 键，解析顺序与交叉校验都在那一个模块里；
 * - **容量策略**（`lib/engine.js` 的 `runCleanup` + `lib/state.js`）：当天首次启动延迟
 *   若干秒，把**已失效条目**与**空分片**搬进每层的归档目录。活条目永不搬走。
 *
 * @module dsh-memory-win
 */

import { configNum, configValue, initConfig } from "./lib/config.js";
import { cwdOf } from "./lib/context.js";
import { runStartupCleanup } from "./lib/engine.js";
import { denialText, directWriteDenial, preExecuteGuard } from "./lib/guard.js";
import { SECTION_NAME, renderMap } from "./lib/map.js";
import { allTools } from "./lib/tools.js";

/** 插件名。 */
export const name = "dsh-memory-win";

/**
 * 硬依赖。`inject` 的语义是"**服务就绪后才调用 apply**"，因此下面可以直接
 * `ctx.tools.xxx` 点号访问，无需判空。
 *
 * ## 这里曾有一个真实缺陷（值得留档）
 *
 * 初版写成 `inject: ["systemPrompt"]` + `ctx.get("tools")`，理由是"桌面版若没有工具
 * 注册表，插件也不该整个起不来"。但 `ctx.get()` 在服务**尚未就绪**时返回 `undefined`，
 * 而我那个 effect 遇到 undefined 就返回空 disposer —— 于是**四个工具一个都没注册上，
 * 且没有任何报错**。表现极具迷惑性：提示词注入一路正常（section 用的是 systemPrompt，
 * 与 tools 无关），只有工具静默消失。
 *
 * 这正是我在别处反复批评的"静默失效"，却亲手在自己的接线处犯了一次。
 * 修法就是官方插件的做法：把 `tools` 声明为依赖，让 Cordis 等它就绪。
 * 代价是桌面版不加载工具注册表时本插件整体不加载 —— 这比"一半功能静默消失"好得多。
 */
export const inject = ["systemPrompt", "tools"];

/**
 * 挂载。
 *
 * @param {object} ctx - cordis 插件上下文。
 * @param {object} [config] - profile patch 的 `config:` 段（宿主按 `apply(ctx, config)` 传入）。
 *   非法配置会在这里**抛错、拒绝启动** —— 见 lib/config.js 的解析顺序与交叉校验。
 */
export function apply(ctx, config) {
  // ── 0. 配置层：先于一切读取 ──────────────────────────────────────────────
  // 必须在任何 `configNum()` 被调用之前完成（提示词段、工具描述、清理时机都读它）。
  // 抛错是刻意的：配错了要看得见，不要带着半截配置跑。
  initConfig(config);

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

  // ── 2. 四个工具 ──────────────────────────────────────────────────────────
  // `tools` 已在 inject 里声明，因此这里**不必也无法**静默跳过：拿不到就留痕。
  ctx.effect(
    () => {
      const tools = ctx.tools ?? ctx.get("tools");
      if (tools === undefined || typeof tools.register !== "function") {
        // 到这一步说明 inject 声明与实际服务不符，属于宿主契约变化。
        // 宁可抛错让插件加载失败（可见），也不要静默少掉全部工具。
        throw new Error("dsh-memory-win: tools 服务不可用，无法注册记忆工具");
      }
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
      const tools = ctx.tools ?? ctx.get("tools");
      const disposers = [];

      // `guard()` 是较新的接口：宿主没有它时**这条**分支跳过是合法的（下面有 waterfall 兜底），
      // 因此这里判空与上面不同 —— 那是"设计上可选"，不是"接线失败"。
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

  // ── 4. 容量策略：**当天首次启动 + 延迟 N 秒**触发一次 ───────────────────────
  //
  // 时机是用户明确指定的（T1 补充第 2 条）：软件当天首次启动后约 10 秒跑一次，
  // 并且**当天不重复** —— 去重依据写在每层状态文件的 `lastCleanup` 里，
  // 而不是内存标记，所以当天重启多少次都不会重复清理，跨天自动恢复。
  //
  // 延迟的另一个理由：启动瞬间宿主正在加载插件、装配提示词，这时去读写记忆目录
  // 既慢又容易和在途写入抢文件。
  //
  // 只做"搬走已经失效的条目与空分片"，活条目永不搬走（详见 lib/engine.js 的
  // `cleanupLayer`）。清理失败只记日志，绝不影响插件其余功能。
  ctx.effect(
    () => {
      if (configValue("cleanupEnabled") !== true) return () => {};
      const day = localDay();
      // 同一天内重复 apply（例如多个工作区各装配一次）只排一次定时器。
      if (lastScheduledDay === day) return () => {};
      lastScheduledDay = day;
      const delayMs = Math.max(0, configNum("cleanupDelaySeconds")) * 1000;
      let cancelled = false;
      const timer = setTimeout(() => {
        if (cancelled) return;
        runStartupCleanup({ ctx }).catch(() => {
          /* 清理是后台增强：失败不该冒泡成插件错误 */
        });
      }, delayMs);
      // 不要让这个定时器把进程钉住（桌面版退出时不必等它）。
      if (typeof timer.unref === "function") timer.unref();
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    },
    "dsh-memory-win: capacity cleanup (first start of the day)",
  );
}

/** 已经排过清理定时器的日历日（同一天不重复排）。 */
let lastScheduledDay = "";

/**
 * 本地日历日的 `YYYY-MM-DD`（只在 `index.js` 用一次，故不额外引模块）。
 *
 * @returns {string} 例：`2026-10-05`。
 */
function localDay() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
