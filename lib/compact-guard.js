/**
 * 压缩守护（0.4.0）：**压缩前备份 + 压缩后达标校验与二次收敛**。
 *
 * ## 为什么是"守护"而不是"触发器"
 *
 * 宿主自带压缩后端（`@deepseek-ai/dsh-compaction-basic`，默认挂在 `dsh-base`），
 * 它在 `agent/pre-step` 上按 token 压力自动压缩。本插件**不另造触发器**，只做两件
 * 宿主不做的事：
 *
 * 1. **压缩前备份**：监听日志里的 `compaction/start`（压缩事务的持久锁），
 *    在摘要写出来之前把会话日志拷一份出去；
 * 2. **压缩后达标校验**：监听 `compaction/end`，量一次"消息历史"，若仍高于
 *    `compactTargetTokens` 就补一次收敛压缩（**每个压缩周期最多一次**，
 *    因此包含宿主那一次在内最多两次）。
 *
 * 这样做的理由：另造触发器会和宿主原生阈值打架，而且拿不到路由容量时会
 * **连兜底都没有**；守护形态则是"宿主压完我看一眼"，宿主缺席时本模块整体不生效，
 * 不会把会话卡在半路。
 *
 * ## 监听顺序：两种顺序都能收敛，只是早晚不同
 *
 * Cordis 的同一个事件按**注册顺序**分发。`compaction-basic` 属于 `dsh-base`，
 * 注册先于本插件，正常情况下它的 `agent/pre-step` 监听器先跑、末尾 `return next()`，
 * 于是本插件的监听器主体在**宿主压缩完成之后**执行 —— 同一轮就能校验 + 补压。
 *
 * 但这是**契约假设**，不是保证：Cordis 的 `apply` 时机取决于依赖就绪，不是纯粹的行
 * 顺序。所以本模块不依赖它也能正确工作 —— 收敛的触发条件是"**观测到过
 * `compaction/end` 且还没补过**"，而不是"刚压完"：
 *
 * | 我们的监听器跑在 | 结果 |
 * |---|---|
 * | 宿主之后 | 同一 pre-step 内校验并补压（理想路径） |
 * | 宿主之前 | 本轮看到的是压缩前的状态、没有标记 → 什么都不做；标记留到**下一个** pre-step 才被消费，补压晚一步发生 |
 *
 * 两种顺序下都不会误压：本轮没观测到压缩就不动手。代价只是次优顺序下收敛晚一步。
 *
 * ## 目标口径：消息历史，不是整个请求
 *
 * 需求里的 16k 是"压缩提炼后的上下文"。整个请求还要加上系统提示词与工具声明，
 * 那部分**压不掉**（宿主文档明确：压缩只缩派生历史，绝不缩系统提示词/工具/前缀），
 * 本机实测信封 ≈ 9.8k tokens。所以目标口径取投影 `contextBreakdown.messageTokens`
 * —— 即"除信封以外的可见历史"，也是设置页/UI 显示压力时用的同一族数字。
 *
 * @module dsh-memory-win/lib/compact-guard
 */

import { configNum, configValue } from "./config.js";
import { logEvent } from "./log.js";
import { backupSessionBeforeCompaction } from "./session-backup.js";

/** 收敛时最多为"工具配对平衡"往回退几个节点（防御性上限，正常 0～1 次）。 */
const MAX_BALANCE_STEPS = 24;

/**
 * 每个会话的守护状态。
 *
 * @type {Map<string, {converge: {compactionId: string, turn: number|null}|null, selfInitiated: boolean, inflight: Set<string>}>}
 */
const sessionStates = new Map();

/**
 * 取（或建）一个会话的守护状态。
 *
 * @param {string} sessionId - 会话 id。
 * @returns {object} 状态对象。
 */
function stateOf(sessionId) {
  const key = String(sessionId ?? "");
  let state = sessionStates.get(key);
  if (state === undefined) {
    state = { converge: null, selfInitiated: false, inflight: new Set() };
    sessionStates.set(key, state);
  }
  return state;
}

/**
 * 从投影里读"消息历史"token 数。
 *
 * @param {object} ctx - 已注入依赖的服务上下文。
 * @param {object} session - 会话。
 * @returns {number|undefined} token 数（投影不可用时为 `undefined`）。
 */
export function messageTokensOf(ctx, session) {
  try {
    const state = ctx.sessionProjections?.stateOf?.(session, "contextBreakdown");
    const value = state?.breakdown?.messageTokens;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 规划"最大幅度"收敛区间：保留最后一个节点，其余全压。
 *
 * 为什么保留最后一个节点而不是全压：对话要继续，最后一条消息（通常是刚结束的
 * 助手回复）是模型理解"我在哪"的锚点；宿主自己的 `compactNow` 也是这个取舍。
 *
 * @param {{seq:number, system:boolean}[]} nodes - 投影里的表层节点（head→tail）。
 * @returns {{startSeq:number, endIndex:number}|null} 区间，或无法压缩时 `null`。
 */
export function planConvergeRange(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const firstIdx = nodes[0]?.system === true ? 1 : 0;
  const endIndex = nodes.length - 2;
  if (endIndex < firstIdx) return null;
  const startSeq = nodes[firstIdx]?.seq;
  if (typeof startSeq !== "number") return null;
  return { startSeq, endIndex };
}

/**
 * 判断压缩后端抛的错是不是"边界没对齐工具配对"。
 *
 * 宿主 `compactRegion` 会拒绝跨越未完成工具调用的区间；这类拒绝可以通过
 * 把区间尾部往回收一个节点修复，所以值得重试，其它错误不该重试。
 *
 * @param {unknown} error - 异常。
 * @returns {boolean} 是否为配对/边界类错误。
 */
export function isBalanceError(error) {
  const message = String(error?.message ?? error ?? "");
  return /unbalanc|balanced|pair|pairing|边界|配对/i.test(message);
}

/**
 * 压缩后校验 + 至多一次收敛。
 *
 * @param {object} ctx - 服务上下文。
 * @param {object} agent - 当前 agent（提供 session 与路由选项）。
 * @param {AbortSignal} signal - 本轮取消信号。
 * @returns {Promise<void>} 完成。
 */
async function convergeAfterCompaction(ctx, agent, signal) {
  const session = agent?.session;
  if (session === undefined) return;
  const state = stateOf(session.id);
  const pending = state.converge;
  if (pending === null) return;
  // 一个压缩周期只补一次：先清标记再干活，失败也不会反复触发。
  state.converge = null;
  if (signal?.aborted === true) return;

  const target = configNum("compactTargetTokens");
  if (target <= 0) return;

  const before = messageTokensOf(ctx, session);
  if (before === undefined) {
    logEvent({ ev: "compact_verify", ok: false, reason: "no-projection", compactionId: pending.compactionId ?? null });
    return;
  }
  if (before <= target) {
    logEvent({ ev: "compact_verify", ok: true, messageTokens: before, target, compactionId: pending.compactionId ?? null });
    return;
  }

  const projectionNodes = ctx.sessionProjections?.stateOf?.(session, "contextBreakdown")?.nodes;
  const range = planConvergeRange(projectionNodes);
  if (range === null) {
    logEvent({ ev: "compact_verify", ok: false, reason: "no-range", messageTokens: before, target, compactionId: pending.compactionId ?? null });
    return;
  }

  let endIndex = range.endIndex;
  state.selfInitiated = true; // 本插件发起的压缩不再备份（备份应发生在第一次之前）
  try {
    for (let attempt = 0; attempt < MAX_BALANCE_STEPS; attempt += 1) {
      const endSeq = projectionNodes[endIndex]?.seq;
      if (typeof endSeq !== "number" || endIndex < 0) break;
      if (signal?.aborted === true) break;
      try {
        await ctx.compaction.compactRegion(range.startSeq, endSeq, agent, signal);
        const after = messageTokensOf(ctx, session);
        logEvent({
          ev: "compact_converge",
          ok: after === undefined ? null : after <= target,
          before,
          after: after ?? null,
          target,
          compactionId: pending.compactionId ?? null,
        });
        return;
      } catch (error) {
        if (!isBalanceError(error)) throw error;
        endIndex -= 1;
      }
    }
    logEvent({ ev: "compact_converge", ok: false, reason: "no-balanced-range", before, target });
  } catch (error) {
    logEvent({ ev: "compact_converge_error", message: String(error?.message ?? error), compactionId: pending.compactionId ?? null });
  } finally {
    state.selfInitiated = false;
  }
}

/**
 * 处理一条会话事件：捕获压缩事务的起止。
 *
 * @param {object} ctx - 服务上下文。
 * @param {object} session - 事件所属会话。
 * @param {object} event - 会话事件。
 * @returns {void}
 */
function onSessionEvent(ctx, session, event) {
  const type = event?.type;
  if (type !== "compaction/start" && type !== "compaction/end") return;
  const state = stateOf(session?.id);

  if (type === "compaction/start") {
    const selfInitiated = state.selfInitiated;
    const compactionId = event?.data?.compactionId;
    if (!selfInitiated && configValue("compactBackupEnabled") === true) {
      scheduleBackup(ctx, session, event, state);
    }
    if (selfInitiated) {
      logEvent({ ev: "compact_start", self: true, compactionId: compactionId ?? null });
    }
    return;
  }

  // compaction/end：带 error 的是失败尝试，不参与收敛判定。
  if (event?.data?.error !== undefined) {
    logEvent({ ev: "compact_failed", compactionId: event?.data?.compactionId ?? null, error: String(event.data.error) });
    return;
  }
  if (configValue("compactConvergeEnabled") === true) {
    state.converge = { compactionId: event?.data?.compactionId ?? null, turn: event?.data?.turn ?? null };
  }
}

/**
 * 排一次异步备份（`session/event` 监听器是同步的，不能在这里 await）。
 *
 * @param {object} ctx - 服务上下文。
 * @param {object} session - 会话。
 * @param {object} event - `compaction/start` 事件。
 * @param {object} state - 该会话的守护状态。
 * @returns {void}
 */
function scheduleBackup(ctx, session, event, state) {
  const compactionId = String(event?.data?.compactionId ?? "");
  if (compactionId !== "" && state.inflight.has(compactionId)) return;
  if (compactionId !== "") state.inflight.add(compactionId);

  let totalTokens;
  try {
    totalTokens = ctx.tokenMeter?.measure?.(session)?.totalTokens;
  } catch {
    totalTokens = undefined;
  }
  let title;
  try {
    title = ctx.sessionTitle?.get?.(session)?.title;
  } catch {
    title = undefined;
  }

  void (async () => {
    try {
      // 先落盘再拷贝：持久化是异步缓冲的，不 flush 会少最后一截。
      try {
        await ctx.sessions?.flush?.(session);
      } catch {
        /* flush 失败也要备份 —— 少了尾部，但比没有强 */
      }
      const result = await backupSessionBeforeCompaction({
        sessionId: session.id,
        title,
        compactionId,
        startSeq: typeof event?.seq === "number" ? event.seq : undefined,
        totalTokens,
      });
      logEvent({
        ev: "compact_backup",
        ok: result.ok,
        base: result.base ?? null,
        reason: result.reason ?? null,
        plaintext: result.plaintext ?? null,
        totalTokens: totalTokens ?? null,
        compactionId: compactionId === "" ? null : compactionId,
      });
    } finally {
      if (compactionId !== "") state.inflight.delete(compactionId);
    }
  })();
}

/**
 * 备份半边：只听**会话事件总线**，在 `compaction/start` 时把会话日志拷一份出去。
 *
 * ## 为什么它必须和收敛半边分开装配（0.4.2 修）
 *
 * 这里曾经是一个 `ctx.inject(["sessions", "compaction", "tokenMeter",
 * "sessionProjections", "sessionTitle"], …)` 的整体 —— 看起来"依赖齐了才开始干活"，
 * 但在 web profile 上是**整块静默死掉**：
 *
 * - `dsh-web-app` 把宿主平面的 `compaction-basic` 打了 `disabled: true`，
 *   真正生效的压缩后端挂在**每个 agent preset 内部**（`isolate: {compaction: true}`）；
 * - 本插件挂在**根作用域**，于是 `compaction` 永远不就绪 ⇒ 回调永不执行 ⇒
 *   **连"压缩前备份"这个根本不需要 compaction 的半边也一起没了**，且没有任何报错。
 *
 * 实测（2026-10-22，dsh 0.2.1-rc.2 + web profile）：探针显示另外四个服务都就绪、
 * `compaction` 不就绪；那之后真实发生的压缩（`session-91031863`，10-22 07:29/07:33
 * 三次）**一份备份都没留下** —— `session-backups/` 目录都不存在。
 *
 * 所以两半边各自声明依赖：备份只要 `sessions`（`sessionTitle` / `tokenMeter` /
 * `sessionProjections` 都是可选的，代码里一律 `?.`），收敛才要 `compaction`。
 *
 * @param {object} ctx - 注入了 `sessions`（其余可选）的上下文。
 * @returns {void}
 */
export function registerCompactBackup(ctx) {
  if (configValue("compactGuardEnabled") !== true) return;

  ctx.effect(
    () => {
      const offEvent = ctx.on("session/event", (session, event) => {
        try {
          onSessionEvent(ctx, session, event);
        } catch (error) {
          // 事件监听器抛错会被宿主记录成插件故障并影响会话：这里必须自己吞掉。
          logEvent({ ev: "compact_guard_error", message: String(error?.message ?? error) });
        }
      });
      // 留痕：日志里**有没有这一行**就是"备份半边活着没有"的判据
      //（效果日志默认关，打开后即可自查；见 README 第 2.8 节）。
      logEvent({ ev: "compact_guard_half", half: "backup", ok: true });
      return () => {
        if (typeof offEvent === "function") offEvent();
        sessionStates.clear();
      };
    },
    "dsh-memory-win: compaction guard (session events)",
  );
}

/**
 * 收敛半边：在 `agent/pre-step` 上做"压缩后达标校验 + 最多一次补压"。
 *
 * ⚠️ 它需要的 `compaction` 服务**只在 agent preset 作用域里存在**（见上）。
 * 本插件在根作用域拿不到时，这个半边**不注册**（而不是让整块守护哑掉）；
 * 要判断它到底有没有装上，看效果日志里有没有
 * `compact_guard_half half=converge` 那一行。
 *
 * @param {object} ctx - 注入了 `compaction` 的上下文。
 * @returns {void}
 */
export function registerCompactConvergence(ctx) {
  if (configValue("compactGuardEnabled") !== true) return;

  ctx.effect(
    () => {
      const offStep = ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
        try {
          await convergeAfterCompaction(ctx, agent, signal);
        } catch (error) {
          logEvent({ ev: "compact_guard_error", message: String(error?.message ?? error) });
        }
        return next();
      });
      logEvent({ ev: "compact_guard_half", half: "converge", ok: true });
      return () => {
        if (typeof offStep === "function") offStep();
      };
    },
    "dsh-memory-win: compaction guard (convergence pass)",
  );
}

/**
 * 两半边一起装配（同一个作用域里依赖都齐时用；测试与单作用域调用方走这个）。
 *
 * @param {object} ctx - 注入了 `sessions` / `compaction` / `tokenMeter`
 *   / `sessionProjections` / `sessionTitle` 的上下文。
 * @returns {void}
 */
export function registerCompactGuard(ctx) {
  registerCompactBackup(ctx);
  registerCompactConvergence(ctx);
}

/**
 * 清空守护状态（测试用）。
 *
 * @returns {void}
 */
export function resetCompactGuardForTests() {
  sessionStates.clear();
}
