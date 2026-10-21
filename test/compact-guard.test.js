/**
 * 压缩守护（0.4.0）测试：备份命名/解码/保留策略，以及"守护"的接线与收敛规则。
 *
 * 两条纪律（都是本项目吃过亏的地方）：
 * 1. **环境敏感断言在用例同步段第一行重设** `DSH_HOME` —— 同进程跑多个测试文件时，
 *    别人挂起的异步用例会在本用例的 `await` 点换掉环境变量（见 README 第 7 节）。
 * 2. 备份是**并发安全**的副作用：`session/event` 监听器只排任务不等待，所以断言前
 *    必须显式等一个 tick，而不是假定它已经跑完。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, test } from "node:test";

import { initConfig, normalizeConfig } from "../lib/config.js";
import {
  backupBaseName,
  backupRoot,
  backupSessionBeforeCompaction,
  decodeSessionLog,
  localStampParts,
  locateSessionDir,
  plaintextBefore,
  pruneBackups,
  safeTitleStem,
  splitZstdFrames,
} from "../lib/session-backup.js";
import {
  isBalanceError,
  messageTokensOf,
  planConvergeRange,
  registerCompactGuard,
  resetCompactGuardForTests,
} from "../lib/compact-guard.js";

const savedDshHome = process.env.DSH_HOME;
let sandbox;
let home;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "dsh-memory-win-compact-"));
  home = join(sandbox, "dshhome");
});

/**
 * 在用例**同步段第一行**重设环境与配置。
 *
 * 必须每个用例自己调：同进程跑多个测试文件时，**后注册**的文件的 `beforeEach`
 * 会在本用例的 `await` 点之后重设 `process.env.DSH_HOME` 与模块级配置
 * （README 第 7 节记过这条坑：只依赖自己的钩子会拿到别人的沙箱）。
 *
 * @param {object} [extra] - 追加的配置覆盖。
 * @returns {void}
 */
function arm(extra = {}) {
  process.env.DSH_HOME = home;
  initConfig({ logEnabled: false, ...extra });
  resetCompactGuardForTests();
}

afterEach(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  resetCompactGuardForTests();
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 占用时忽略 */
  }
});

/**
 * 写一份**逐帧** zstd 会话日志（模拟 DSH 的 `session.v4.jsonl.zstd`）。
 *
 * @param {string} sessionId - 会话 id。
 * @param {object[]} events - 每条记录（会被各自压成一帧）。
 * @param {string} [bucket] - 工作区桶名。
 * @returns {string} 日志文件绝对路径。
 */
function writeSessionLog(sessionId, events, bucket = "--repo--") {
  // 先钉环境：本函数是所有落盘用例的第一步，在这里 arm 一次能盖住
  // "别的测试文件在我 await 之后改了 DSH_HOME" 这条坑。
  arm();
  const dir = join(home, "sessions", bucket, sessionId);
  mkdirSync(dir, { recursive: true });
  const frames = events.map((event) => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, "utf8")));
  const file = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(file, Buffer.concat(frames));
  return file;
}

/** 等一个 tick，让备份那条异步任务跑完。 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

// ── 命名与清洗 ───────────────────────────────────────────────────────────────

test("safeTitleStem：清洗非法字符、折叠空白、截断超长、兜底空标题", () => {
  assert.equal(safeTitleStem("重构 记忆 插件"), "重构 记忆 插件");
  assert.equal(safeTitleStem('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
  assert.equal(safeTitleStem("  前后空格  "), "前后空格");
  assert.equal(safeTitleStem("...点开头"), "点开头");
  assert.equal(safeTitleStem(""), "session");
  assert.equal(safeTitleStem(undefined, "session-x"), "session-x");
  assert.equal(safeTitleStem("x".repeat(120)).length, 60);
  // Windows 保留名不能被当成普通名字
  assert.equal(safeTitleStem("CON"), "CON-");
  // 控制字符（含换行、制表）要被换成 `-`
  assert.equal(safeTitleStem("a\nb\tc"), "a-b-c");
});

test("backupBaseName：`<名称>_YYYYMMDD_HHmmss`（本地时间，时分秒齐全）", () => {
  const now = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(backupBaseName("标题", now), "标题_20260102_030405");
  const parts = localStampParts(now);
  assert.deepEqual(parts, { date: "20260102", time: "030405" });
  assert.match(backupBaseName("x"), /^x_\d{8}_\d{6}$/);
});

// ── 逐帧解码 ─────────────────────────────────────────────────────────────────

test("decodeSessionLog：逐帧解码 + 一帧多记录；坏帧按空输出判失败（不抛）", () => {
  const a = zstdCompressSync(Buffer.from('{"type":"session","id":"s"}\n{"seq":0,"type":"turn/start"}\n', "utf8"));
  const b = zstdCompressSync(Buffer.from('{"seq":1,"type":"user/message"}\n', "utf8"));
  // 有魔数、有载荷，但解不出内容 —— 本机 Node 的 zstd 对这类输入 **不抛异常**，
  // 所以"坏帧"必须按"解出空"来判定，否则截断日志会被当成解码成功。
  const bad = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02]);
  const buffer = Buffer.concat([a, b, bad]);

  const frames = splitZstdFrames(buffer);
  assert.equal(frames.length, 3);

  const decoded = decodeSessionLog(buffer);
  assert.equal(decoded.records.length, 3);
  assert.equal(decoded.failed, 1);
  assert.equal(decoded.records[0].includes('"type":"session"'), true);
});

test("plaintextBefore：只保留压缩起点之前的记录（含无 seq 的头记录）", () => {
  const records = ['{"type":"session"}', '{"seq":0}', '{"seq":5}', '{"seq":9}'];
  const text = plaintextBefore(records, 9);
  assert.equal(text.split("\n").filter(Boolean).length, 3);
  assert.equal(text.includes('"seq":9'), false);
  assert.equal(text.endsWith("\n"), true);
});

// ── 备份落盘 ─────────────────────────────────────────────────────────────────

test("backupSessionBeforeCompaction：落三件套、明文只到压缩起点、meta 带诊断字段", async () => {
  const sessionId = "session-11111111-2222-3333-4444-555555555555";
  writeSessionLog(sessionId, [
    { type: "session", id: sessionId },
    { seq: 0, type: "turn/start", data: {} },
    { seq: 1, type: "user/message", data: { text: "压缩前的正文" } },
    { seq: 9, type: "compaction/start", data: { compactionId: "c-1", turn: 1 } },
  ]);

  assert.equal(locateSessionDir(sessionId)?.endsWith(sessionId), true);

  const result = await backupSessionBeforeCompaction({
    sessionId,
    title: "会话 标题",
    compactionId: "c-1",
    startSeq: 9,
    totalTokens: 750000,
    now: new Date(2026, 9, 21, 14, 9, 21),
  });

  assert.equal(result.ok, true);
  assert.equal(result.base, "会话 标题_20261021_140921");
  assert.equal(result.dir, join(backupRoot(), sessionId));

  const raw = readFileSync(join(result.dir, `${result.base}.jsonl.zstd`));
  assert.equal(raw.length > 0, true);

  const plain = readFileSync(join(result.dir, `${result.base}.jsonl`), "utf8");
  assert.equal(plain.includes("压缩前的正文"), true);
  assert.equal(plain.includes("compaction/start"), false);

  const meta = JSON.parse(readFileSync(join(result.dir, `${result.base}.meta.json`), "utf8"));
  assert.equal(meta.sessionId, sessionId);
  assert.equal(meta.compactionId, "c-1");
  assert.equal(meta.startSeq, 9);
  assert.equal(meta.totalTokens, 750000);
  assert.equal(meta.plaintext, true);
});

test("backupSessionBeforeCompaction：同一秒内重复备份不覆盖（追加序号）", async () => {
  const sessionId = "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  writeSessionLog(sessionId, [{ type: "session", id: sessionId }, { seq: 1, type: "x" }]);
  const now = new Date(2026, 9, 21, 14, 9, 21);

  const first = await backupSessionBeforeCompaction({ sessionId, title: "T", startSeq: 5, now });
  const second = await backupSessionBeforeCompaction({ sessionId, title: "T", startSeq: 5, now });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.base, second.base);
  assert.equal(second.base, `${first.base}-2`);
});

test("backupSessionBeforeCompaction：找不到会话目录时返回失败而不是抛错", async () => {
  const result = await backupSessionBeforeCompaction({ sessionId: "session-missing", title: "T", startSeq: 1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /找不到会话目录/);
});

test("pruneBackups：按份保留，删整份（不会留下半份三件套）", async () => {
  const sessionId = "session-99999999-8888-7777-6666-555555555555";
  writeSessionLog(sessionId, [{ type: "session", id: sessionId }, { seq: 1, type: "x" }]);

  for (let i = 0; i < 3; i += 1) {
    const now = new Date(2026, 9, 21, 14, 9, 20 + i);
    const result = await backupSessionBeforeCompaction({ sessionId, title: "T", startSeq: 5, now });
    assert.equal(result.ok, true);
  }

  initConfig({ logEnabled: false, compactBackupKeep: 2 });
  const dir = join(backupRoot(), sessionId);
  const removed = pruneBackups(dir, 2);
  assert.equal(removed.length, 1);
  // 被删的那份三个文件都不该还在（按"份"删，而不是按"文件"删）
  for (const suffix of [".jsonl.zstd", ".jsonl", ".meta.json"]) {
    assert.equal(existsSync(join(dir, `${removed[0]}${suffix}`)), false);
  }
  // 另外两份必须完整
  const kept = readdirSync(dir).filter((name) => name.endsWith(".meta.json"));
  assert.equal(kept.length, 2);
});

// ── 收敛判定 ─────────────────────────────────────────────────────────────────

test("planConvergeRange：跳过 system 头节点、保留最后一个节点；过短返回 null", () => {
  const nodes = [
    { seq: 10, system: true },
    { seq: 11, system: false },
    { seq: 12, system: false },
    { seq: 13, system: false },
  ];
  assert.deepEqual(planConvergeRange(nodes), { startSeq: 11, endIndex: 2 });

  const noSystem = [
    { seq: 20, system: false },
    { seq: 21, system: false },
  ];
  assert.deepEqual(planConvergeRange(noSystem), { startSeq: 20, endIndex: 0 });

  assert.equal(planConvergeRange([{ seq: 1, system: true }, { seq: 2, system: false }]), null);
  assert.equal(planConvergeRange([]), null);
  assert.equal(planConvergeRange(undefined), null);
});

test("isBalanceError：只认边界/配对类错误（其它错误不该重试）", () => {
  assert.equal(isBalanceError(new Error("compaction: range is unbalanced")), true);
  assert.equal(isBalanceError(new Error("tool pairing boundary rejected")), true);
  assert.equal(isBalanceError(new Error("boom: disk full")), false);
  assert.equal(isBalanceError(undefined), false);
});

test("messageTokensOf：投影缺席时返回 undefined（而不是 0）", () => {
  const session = { id: "s" };
  assert.equal(messageTokensOf({}, session), undefined);
  assert.equal(
    messageTokensOf({ sessionProjections: { stateOf: () => ({ breakdown: { messageTokens: 1234 } }) } }, session),
    1234,
  );
  assert.equal(
    messageTokensOf({
      sessionProjections: {
        stateOf: () => {
          throw new Error("boom");
        },
      },
    }, session),
    undefined,
  );
});

// ── 守护接线 ─────────────────────────────────────────────────────────────────

/**
 * 造一个能承接压缩守护的假 ctx。
 *
 * @param {object} [options] - 注入点。
 * @returns {object} `{ctx, record}`，`record` 收集监听器与调用。
 */
function fakeGuardCtx(options = {}) {
  const listeners = new Map();
  const record = { compactCalls: [], flushes: 0, events: [] };
  const state = {
    messageTokens: options.messageTokens ?? 1000,
    nodes: options.nodes ?? [
      { seq: 10, system: true },
      { seq: 11, system: false },
      { seq: 12, system: false },
      { seq: 13, system: false },
    ],
  };
  let balanceFailures = options.balanceFailures ?? 0;

  const ctx = {
    effect(factory) {
      const dispose = factory();
      return typeof dispose === "function" ? dispose : () => {};
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    sessions: {
      async flush() {
        record.flushes += 1;
        return true;
      },
    },
    tokenMeter: {
      measure: () => ({ totalTokens: 750000, nodes: [] }),
    },
    sessionTitle: {
      get: () => ({ title: "假标题" }),
    },
    sessionProjections: {
      stateOf: (_session, key) =>
        key === "contextBreakdown" ? { nodes: state.nodes, breakdown: { messageTokens: state.messageTokens } } : undefined,
    },
    compaction: {
      async compactRegion(start, end, agent, _signal) {
        record.compactCalls.push({ start, end });
        record.events.push("compact:start");
        // 模拟宿主：压缩事务的第一件事就是追加 compaction/start（同一会话）。
        listeners.get("session/event")?.(agent.session, {
          type: "compaction/start",
          seq: 100,
          data: { compactionId: `self-${record.compactCalls.length}` },
        });
        if (balanceFailures > 0) {
          balanceFailures -= 1;
          throw new Error("compaction: range is unbalanced");
        }
        // 收敛之后消息历史降下来了
        state.messageTokens = options.afterTokens ?? 3000;
        return { compacted: true };
      },
    },
  };

  return { ctx, record, state, listeners };
}

test("守护：compaction/start 触发备份，落点与命名符合规则", async () => {
  const sessionId = "session-12121212-3434-5656-7878-909090909090";
  writeSessionLog(sessionId, [
    { type: "session", id: sessionId },
    { seq: 1, type: "user/message", data: { text: "hi" } },
    { seq: 2, type: "compaction/start", data: { compactionId: "c-9", turn: 3 } },
  ]);

  const { ctx, record, listeners } = fakeGuardCtx();
  registerCompactGuard(ctx);

  listeners.get("session/event")(
    { id: sessionId },
    { type: "compaction/start", seq: 2, data: { compactionId: "c-9", turn: 3 } },
  );
  await tick();

  assert.equal(record.flushes, 1);
  const dir = join(backupRoot(), sessionId);
  const metaName = readdirSync(dir).find((name) => name.endsWith(".meta.json"));
  assert.equal(typeof metaName, "string");
  const meta = JSON.parse(readFileSync(join(dir, metaName), "utf8"));
  assert.equal(meta.compactionId, "c-9");
  assert.match(metaName, /^假标题_\d{8}_\d{6}\.meta\.json$/);
});

test("守护：压缩后未超标则不补收敛", async () => {
  arm();
  const { ctx, record, listeners } = fakeGuardCtx({ messageTokens: 1000 });
  registerCompactGuard(ctx);

  const session = { id: "s1" };
  listeners.get("session/event")(session, { type: "compaction/end", data: { compactionId: "c-1" } });
  const preStep = listeners.get("agent/pre-step");
  let nextCalled = 0;
  await preStep({ agent: { session }, signal: { aborted: false } }, () => {
    nextCalled += 1;
  });

  assert.equal(record.compactCalls.length, 0);
  assert.equal(nextCalled, 1);
});

test("守护：压缩后超标则补一次收敛，且同一周期只补一次", async () => {
  arm();
  const { ctx, record, listeners, state } = fakeGuardCtx({ messageTokens: 60000, afterTokens: 3000 });
  registerCompactGuard(ctx);

  const session = { id: "s1" };
  const preStep = listeners.get("agent/pre-step");
  listeners.get("session/event")(session, { type: "compaction/end", data: { compactionId: "c-1" } });
  await preStep({ agent: { session }, signal: { aborted: false } }, () => {});

  assert.equal(record.compactCalls.length, 1);
  // 区间：从第一个非 system 节点（seq 11）到倒数第二个（seq 12）
  assert.deepEqual(record.compactCalls[0], { start: 11, end: 12 });
  assert.equal(state.messageTokens, 3000);

  // 同一周期再跑一次 pre-step：没有新的 compaction/end，不该再压
  await preStep({ agent: { session }, signal: { aborted: false } }, () => {});
  assert.equal(record.compactCalls.length, 1);
});

test("守护：本插件发起的收敛压缩不再触发备份", async () => {
  const sessionId = "session-13131313-2424-3535-4646-575757575757";
  writeSessionLog(sessionId, [
    { type: "session", id: sessionId },
    { seq: 1, type: "x" },
    { seq: 2, type: "compaction/start", data: { compactionId: "c-1" } },
  ]);

  const { ctx, record, listeners } = fakeGuardCtx({ messageTokens: 60000 });
  registerCompactGuard(ctx);
  const session = { id: sessionId };

  listeners.get("session/event")(session, { type: "compaction/end", data: { compactionId: "c-1" } });
  await listeners.get("agent/pre-step")({ agent: { session }, signal: { aborted: false } }, () => {});
  await tick();

  assert.equal(record.compactCalls.length, 1);
  // compactRegion 里模拟追加的 compaction/start 不应产生备份
  assert.equal(record.flushes, 0);
});

test("守护：配对失败时把区间尾部回收一个节点再试", async () => {
  arm();
  const { ctx, record, listeners } = fakeGuardCtx({ messageTokens: 60000, balanceFailures: 1, afterTokens: 3000 });
  registerCompactGuard(ctx);

  const session = { id: "s1" };
  listeners.get("session/event")(session, { type: "compaction/end", data: { compactionId: "c-1" } });
  await listeners.get("agent/pre-step")({ agent: { session }, signal: { aborted: false } }, () => {});

  assert.equal(record.compactCalls.length, 2);
  assert.deepEqual(record.compactCalls[0], { start: 11, end: 12 });
  assert.deepEqual(record.compactCalls[1], { start: 11, end: 11 });
});

test("守护：总开关关闭时一个监听器都不挂", () => {
  arm({ compactGuardEnabled: false });
  const { ctx, listeners } = fakeGuardCtx();
  registerCompactGuard(ctx);
  assert.equal(listeners.size, 0);
});

test("守护：compaction/end 带 error 时不参与收敛", async () => {
  arm();
  const { ctx, record, listeners } = fakeGuardCtx({ messageTokens: 60000 });
  registerCompactGuard(ctx);
  const session = { id: "s1" };

  listeners.get("session/event")(session, { type: "compaction/end", data: { compactionId: "c-1", error: "summarizer failed" } });
  await listeners.get("agent/pre-step")({ agent: { session }, signal: { aborted: false } }, () => {});
  assert.equal(record.compactCalls.length, 0);
});

// ── 配置项校验 ───────────────────────────────────────────────────────────────

test("配置：压缩守护新增键的默认值与类型校验", () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.compactGuardEnabled, true);
  assert.equal(defaults.compactBackupEnabled, true);
  assert.equal(defaults.compactBackupPlaintext, true);
  assert.equal(defaults.compactBackupKeep, 3);
  assert.equal(defaults.compactBackupDir, "");
  assert.equal(defaults.compactConvergeEnabled, true);
  assert.equal(defaults.compactTargetTokens, 16000);

  assert.throws(() => normalizeConfig({ compactGuardEnabled: "yes" }), /compactGuardEnabled/);
  assert.throws(() => normalizeConfig({ compactBackupKeep: 0 }), /compactBackupKeep/);
  assert.throws(() => normalizeConfig({ compactBackupKeep: 1.5 }), /compactBackupKeep/);
  assert.throws(() => normalizeConfig({ compactTargetTokens: -1 }), /compactTargetTokens/);
  assert.throws(() => normalizeConfig({ compactBackupDir: 5 }), /compactBackupDir/);
  assert.throws(() => normalizeConfig({ compactBackupDir: "a\nb" }), /compactBackupDir/);
  // 空串是合法值（= 用默认落点）
  assert.equal(normalizeConfig({ compactBackupDir: "" }).compactBackupDir, "");
});
