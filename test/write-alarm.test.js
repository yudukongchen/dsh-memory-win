/**
 * 写入步效果告警（守护断言第二层）测试。
 *
 * 覆盖 Q18/Q21/Q26 定案：
 * 1. 真写入（add/correct/cleanup-有归档）→ 下一条 usage `uncached > 10000` → 落
 *    `write_alarm`（带 threshold/session/seqRef），且**只判读一次**（复位）；
 * 2. 写入后第一步未超阈值 → 静默复位、无告警行；
 * 3. 不改字节的事件（duplicate add、cleanup 空跑）→ 不置位，后续 usage 再高也不告警；
 * 4. 关日志时整条链路零副作用（与 log.test.js 的总闸一致）。
 *
 * 环境照例 mkdtemp + DSH_HOME 重定向。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { initConfig } from "../lib/config.js";
import { WRITE_ALARM_UNCACHED, logFilePath, logInject, logToolCall, logUsage, resetLogForTests } from "../lib/log.js";

const savedDshHome = process.env.DSH_HOME;
let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "dsh-memory-win-alarm-"));
  process.env.DSH_HOME = join(sandbox, "dshhome");
  initConfig({ logEnabled: true });
  resetLogForTests();
});

afterEach(() => {
  initConfig(undefined);
  resetLogForTests();
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* 忽略 Windows 占用 */
  }
});

/** 读当前日志全部事件（逐行 JSON.parse，顺带验证 JSONL 合法性）。 */
function readLines() {
  const file = logFilePath();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** 一条 assistant/message 事件，uncached 取给定值。 */
function usageEvent(uncached) {
  return {
    type: "assistant/message",
    data: { turn: 1, step: 1, usage: { inputTokens: uncached, cacheReadTokens: 110000, cacheWriteTokens: 0, outputTokens: 128 } },
  };
}

const SESSION = { id: "session-alarm-test" };

test("真写入后第一步超阈值 → write_alarm 一次，带 threshold/seqRef，复位后不再告警", () => {
  logInject({ chars: 100, parts: {}, modes: {} });
  logToolCall("memory_add", { fact: "x" }, { target: "project", shard: "s" }, { session: SESSION.id });

  logUsage(SESSION, usageEvent(110613)); // 基线悬崖同款数值
  const alarms = readLines().filter((l) => l.ev === "write_alarm");
  assert.equal(alarms.length, 1, "应恰好一条告警");
  assert.equal(alarms[0].uncached, 110613);
  assert.equal(alarms[0].threshold, WRITE_ALARM_UNCACHED);
  assert.equal(alarms[0].session, SESSION.id);
  assert.equal(alarms[0].seqRef, 1, "seqRef 回指写入后最近一次注入");
  assert.match(alarms[0].hint, /patches\//, "提示应指向补丁重放链");

  logUsage(SESSION, usageEvent(120000)); // 已复位：第二条 usage 不再判读
  assert.equal(readLines().filter((l) => l.ev === "write_alarm").length, 1, "告警是一次性的");
});

test("写入后第一步未超阈值 → 静默复位、无告警", () => {
  logToolCall("memory_add", { fact: "x" }, { target: "project", shard: "s" }, { session: SESSION.id });
  logUsage(SESSION, usageEvent(1525)); // 恢复步同款数值
  assert.equal(readLines().filter((l) => l.ev === "write_alarm").length, 0);
});

test("duplicate add 与 cleanup 空跑不置位：后续 usage 再高也不告警", () => {
  logToolCall("memory_add", { fact: "x" }, { target: "project", shard: "s", duplicate: true }, { session: SESSION.id });
  logUsage(SESSION, usageEvent(200000));
  assert.equal(readLines().filter((l) => l.ev === "write_alarm").length, 0, "重复命中不改字节，不该判读");

  logToolCall("memory_cleanup", {}, { ran: false, archived: 0, removedShards: 0 }, { session: SESSION.id });
  logUsage(SESSION, usageEvent(200000));
  assert.equal(readLines().filter((l) => l.ev === "write_alarm").length, 0, "空跑不改字节，不该判读");
});

test("cleanup 有归档 → 置位，超阈值照常告警", () => {
  logToolCall("memory_cleanup", {}, { ran: true, archived: 3, removedShards: 1 }, { session: SESSION.id });
  logUsage(SESSION, usageEvent(50000));
  const alarms = readLines().filter((l) => l.ev === "write_alarm");
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].uncached, 50000);
});

test("logEnabled=false（默认）：告警链路整体零写盘", () => {
  initConfig(undefined);
  logToolCall("memory_add", { fact: "x" }, { target: "project", shard: "s" }, { session: SESSION.id });
  logUsage(SESSION, usageEvent(999999));
  assert.equal(existsSync(logFilePath()), false, "关日志连目录都不该建");
});
