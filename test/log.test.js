/**
 * 效果日志（0.2.5）测试。
 *
 * 覆盖 Q18 定案的最小集：
 * 1. 关 = 零写盘零副作用；开 = 每事件一行合法 JSONL；
 * 2. 轮转触发与"只留一份"；
 * 3. 小时累计**含种子回读**（跨重启不丢计数，且不碰 .state.json）；
 * 4. 写失败即停写（不抛、不重试、不污染注入）；
 * 5. 命中率算式与宿主 UI 同分母（含 cacheWrite > 0 的边界）；
 * 6. 零命中 search 照记；memory_list 不记（Q22）；
 * 7. 注入分项校验和闭合（parts 之和 === chars === 文本长度）。
 *
 * 环境照例用 mkdtemp + DSH_HOME 重定向（环境事实 2）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { initConfig } from "../lib/config.js";
import {
  LOG_MAX_BYTES,
  cacheHitRate,
  logConfigError,
  logEvent,
  logFilePath,
  logGuardDenial,
  logInject,
  logInjectError,
  logToolCall,
  logUsage,
  resetLogForTests,
} from "../lib/log.js";
import { renderMapWithStats } from "../lib/map.js";

const savedDshHome = process.env.DSH_HOME;
let sandbox;
let home;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "dsh-memory-win-log-"));
  home = join(sandbox, "dshhome");
  process.env.DSH_HOME = home;
  initConfig(undefined); // 默认档：logEnabled=false
  resetLogForTests();
});

afterEach(() => {
  // 配置与日志状态都是模块级的：恢复默认，别污染后面的测试文件（同进程依次 import）。
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

/**
 * 读当前日志的全部事件行（逐行 JSON.parse —— 顺带验证 JSONL 合法性）。
 *
 * @returns {object[]} 事件数组；文件不存在时为空数组。
 */
function readLines() {
  const file = logFilePath();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * 本地自然小时键（与 lib/log.js 的口径一致：`YYYY-MM-DDTHH`）。
 *
 * @returns {string} 小时键。
 */
function currentHour() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}`;
}

test("logEnabled=false（默认）：所有入口零写盘、连日志目录都不建", () => {
  logInject({ chars: 10, parts: {}, modes: {} });
  logInjectError(new Error("x"));
  logEvent({ ev: "probe" });
  logToolCall("memory_search", { query: "a" }, { hits: [] });
  logUsage({ id: "s" }, { type: "assistant/message", data: { usage: { inputTokens: 1 } } });
  logGuardDenial({ name: "write", arguments: { file_path: "C:\\x.md" } });

  assert.equal(existsSync(home), false, "关着的时候不该有任何文件系统副作用");
});

test("logEnabled=true：inject 与零命中 search 各写一行合法 JSONL（Q4/Q5）", () => {
  initConfig({ logEnabled: true });

  const parts = { discipline: 900, global: 40, project: 0, other: 300 };
  logInject({ chars: 1240, parts, modes: { global: "inline", project: "unavailable" }, cwd: "E:\\repo" });
  logToolCall("memory_search", { query: "绝不存在的词" }, { query: "绝不存在的词", hits: [], scanned: 7 }, {});

  const lines = readLines();
  assert.equal(lines.length, 2, "每事件一行");

  assert.equal(lines[0].ev, "inject");
  assert.equal(lines[0].seq, 1, "自增 seq 从 1 开始");
  assert.equal(lines[0].chars, 1240);
  assert.deepEqual(lines[0].parts, parts, "分项原样落盘");
  assert.deepEqual(lines[0].modes, { global: "inline", project: "unavailable" });
  assert.equal(lines[0].cwd, "E:\\repo");
  assert.match(lines[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/, "本地时间戳");

  // 零命中是最重要的信号之一：照记（hits=0），不记正文、不记 id 列表
  assert.equal(lines[1].ev, "search");
  assert.equal(lines[1].query, "绝不存在的词");
  assert.equal(lines[1].hits, 0);
  assert.deepEqual(lines[1].shards, []);
  assert.equal(lines[1].text, undefined, "不搬运记忆正文");
});

test("search 命中：分片名数组去重并带层前缀", () => {
  initConfig({ logEnabled: true });
  logToolCall(
    "memory_search",
    { query: "pwsh" },
    {
      query: "pwsh",
      hits: [
        { target: "global", shard: "windows-paths" },
        { target: "global", shard: "windows-paths" },
        { target: "project", shard: "windows-paths" },
      ],
    },
    {},
  );
  const [line] = readLines();
  assert.equal(line.hits, 3);
  assert.deepEqual(line.shards, ["global/windows-paths", "project/windows-paths"], "同名不同层不歧义");
});

test("memory_list 不记（Q22 定案）", () => {
  initConfig({ logEnabled: true });
  logToolCall("memory_list", { entries: true }, { layers: [], roots: {} }, {});
  assert.equal(existsSync(logFilePath()), false, "list 是最无趣的事件，白拿的信号也不要");
});

test("add 行：自然小时 + 该小时当前累计；种子从日志文件回读（Q6/Q9）", () => {
  initConfig({ logEnabled: true });

  // 模拟"上一次进程"在本小时已写过 2 条
  const file = logFilePath();
  mkdirSync(dirname(file), { recursive: true });
  const seedLine = JSON.stringify({ at: "2026-01-01T00:00:00.000", ev: "add", hour: currentHour(), hourCount: 2 });
  writeFileSync(file, `${seedLine}\n${seedLine}\n`, "utf8");
  resetLogForTests(); // 清内存计数：本进程第一次碰到该小时要走种子回读

  logToolCall("memory_add", { fact: "x" }, { ok: true, target: "project", shard: "s" }, { cwd: "E:\\repo" });
  logToolCall("memory_add", { fact: "y" }, { ok: true, target: "project", shard: "s" }, { cwd: "E:\\repo" });

  const lines = readLines();
  assert.equal(lines.length, 4, "文件里是 2 条种子 + 2 条新事件");
  const [first, second] = lines.slice(2);
  assert.equal(first.ev, "add");
  assert.equal(first.hour, currentHour(), "自然小时（本地时区）");
  assert.equal(first.hourCount, 3, "种子 2 + 本条 = 3（跨重启不丢）");
  assert.equal(second.hourCount, 4, "随后进程内累计");
  assert.equal(first.target, "project");
  assert.equal(first.shard, "s");
});

test("轮转：超过 1 MB 变成 prev，且只留一份", () => {
  initConfig({ logEnabled: true });
  const file = logFilePath();
  const prev = join(dirname(file), "debug.prev.jsonl");
  mkdirSync(dirname(file), { recursive: true });

  // 第一代写满阈值
  writeFileSync(file, "x".repeat(LOG_MAX_BYTES), "utf8");
  logEvent({ ev: "gen1" });
  assert.equal(existsSync(prev), true, "超阈值先轮转");
  assert.equal(readFileSync(prev, "utf8").length, LOG_MAX_BYTES, "旧内容原样进 prev");
  assert.equal(readLines().length, 1, "轮转后当前文件只剩新行");

  // 第二代再写满 → 覆盖 prev（不是 gen2.prev / gen3.prev…）
  writeFileSync(file, "y".repeat(LOG_MAX_BYTES), "utf8");
  logEvent({ ev: "gen2" });
  const names = readdirSync(dirname(file)).sort();
  assert.deepEqual(names, ["debug.jsonl", "debug.prev.jsonl"], "永远只有两个文件");
  assert.equal(readFileSync(prev, "utf8").startsWith("y"), true, "prev 被整体替换，只留一份");
});

test("写失败即停写：不抛、不重试、不污染注入（Q11）", () => {
  initConfig({ logEnabled: true });
  // 在日志目录该在的位置放一个**文件**：mkdir 必然失败
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "memory-win"), "not a directory", "utf8");

  assert.doesNotThrow(() => logInject({ chars: 1, parts: {}, modes: {} }), "第一个事件失败不能上抛");
  assert.doesNotThrow(() => logInject({ chars: 2, parts: {}, modes: {} }));
  assert.equal(existsSync(logFilePath()), false);

  // 障碍移除后**仍然**停写：进程内一次失败即停，不给失败的磁盘每轮刷屏
  rmSync(join(home, "memory-win"));
  logInject({ chars: 3, parts: {}, modes: {} });
  assert.equal(existsSync(logFilePath()), false, "停写是进程内的，不因障碍消失而恢复");
});

test("cacheHitRate 与宿主 UI 同分母（Q17：uncached + cacheRead + cacheWrite）", () => {
  assert.equal(cacheHitRate({ uncached: 30, cacheRead: 60, cacheWrite: 10 }), 0.6, "cacheWrite 计入分母");
  // UI 公式（app.asar:395653）：cacheRead / (uncached + cacheRead + cacheWrite)
  assert.equal(cacheHitRate({ uncached: 40, cacheRead: 60, cacheWrite: 10 }), Math.round((60 / 110) * 10000) / 10000);
  assert.equal(cacheHitRate({ uncached: 0, cacheRead: 1, cacheWrite: 0 }), 1, "全命中");
  assert.equal(cacheHitRate({ uncached: 1, cacheRead: 0, cacheWrite: 0 }), 0, "全未命中");
  assert.equal(cacheHitRate({ uncached: 0, cacheRead: 0, cacheWrite: 0 }), null, "分母 0 = 不可算，不伪造 0%");
  assert.equal(cacheHitRate({ uncached: -1, cacheRead: 0, cacheWrite: 0 }), null, "负数视为不可算");
});

test("usage 行：四元组 + 命中率 + seqRef 回指；attempt 从流末 chunk 取（Q13/Q14）", () => {
  initConfig({ logEnabled: true });
  logInject({ chars: 100, parts: { discipline: 60, global: 0, project: 0, other: 40 }, modes: {} });

  logUsage(
    { id: "session-abc" },
    {
      type: "assistant/message",
      data: { turn: 2, step: 3, usage: { inputTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 5 } },
    },
  );
  logUsage(
    { id: "session-abc" },
    {
      type: "assistant/attempt",
      data: {
        turn: 2,
        step: 4,
        stream: [
          { type: "chunk", chunk: { type: "text" } },
          { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 5, cacheReadTokens: 1 } } },
          { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 7 } } }, // 反扫取到的应是这条
        ],
      },
    },
  );
  logUsage({ id: "s" }, { type: "tool/result", data: {} }); // 非 assistant 事件忽略

  const lines = readLines();
  assert.equal(lines.length, 3, "inject + message usage + attempt usage");

  const message = lines[1];
  assert.equal(message.ev, "usage");
  assert.equal(message.kind, "message");
  assert.equal(message.session, "session-abc", "全会话全记并带 session（Q16）");
  assert.deepEqual(message.tokens, { uncached: 30, cacheRead: 60, cacheWrite: 10, output: 5 });
  assert.equal(message.hitRate, 0.6);
  assert.equal(message.turn, 2);
  assert.equal(message.step, 3);
  assert.equal(message.seqRef, 1, "回指最近一次 inject 的 seq");

  const attempt = lines[2];
  assert.equal(attempt.kind, "attempt");
  assert.equal(attempt.tokens.uncached, 7, "流里多个 usage chunk 时取最后一个");
  assert.equal(attempt.seqRef, 1);
});

test("correct / cleanup / guard_deny / config_error 各落一行（Q7 覆盖面）", () => {
  initConfig({ logEnabled: true });

  logToolCall("memory_correct", { id: "a3f1", reason: "overturned" }, { target: "global", shard: "x" }, {});
  logToolCall("memory_cleanup", {}, { ran: true, archived: 2, removedShards: 1, layers: [{ archived: [{ count: 3 }] }] }, {});
  logGuardDenial({ name: "write", arguments: { file_path: "C:\\repo\\.agent-memory\\x.md" } });
  logConfigError(new Error("配置非法：inlineTextMax 超限"), { logEnabled: true });

  const lines = readLines();
  assert.deepEqual(lines.map((l) => l.ev), ["correct", "cleanup", "guard_deny", "config_error"]);

  assert.equal(lines[0].reason, "overturned");
  assert.equal(lines[0].id, "a3f1", "带 id，便于事后对账（不带正文）");
  assert.equal(lines[1].archived, 2);
  assert.equal(lines[1].entries, 3, "逐层累加归档条目数");
  assert.equal(lines[1].removedShards, 1);
  assert.equal(lines[2].tool, "write");
  assert.equal(lines[2].path, "C:\\repo\\.agent-memory\\x.md");
  assert.match(lines[3].message, /inlineTextMax/);
});

test("config_error：开关没开就不写；消息过中和与凭据扫描", () => {
  initConfig({ logEnabled: true });

  logConfigError(new Error("坏配置"), {}); // 没写 logEnabled
  logConfigError(new Error("坏配置"), { logEnabled: "yes" }); // 开关本身非法
  assert.equal(existsSync(logFilePath()), false, "开关没明确打开就不写");

  logConfigError(new Error("token=abcdefghijklmnop1234 泄漏"), { logEnabled: true });
  const [line] = readLines();
  assert.equal(line.ev, "config_error");
  assert.equal(line.message.includes("abcdefghijklmnop1234"), false, "凭据绝不进日志");
  assert.match(line.message, /含疑似凭据/);

  logInjectError(new Error("渲染炸了 {{foo}}"));
  const [, errorLine] = readLines();
  assert.equal(errorLine.message.includes("{{"), false, "{{ 已中和，日志行仍是纯数据");
  assert.match(errorLine.message, /渲染炸了/);
});

test("inject 分项校验和闭合：parts 之和 === chars === 文本长度（Q4）", () => {
  // 空态（项目层无 cwd ⇒ unavailable）
  const empty = renderMapWithStats({});
  const sumEmpty = Object.values(empty.stats.parts).reduce((a, b) => a + b, 0);
  assert.equal(sumEmpty, empty.stats.chars, "空态校验和闭合");
  assert.equal(empty.stats.chars, empty.text.length, "chars 就是最终注入文本的长度");
  assert.equal(empty.stats.parts.discipline > 0, true, "纪律块是常量开销");
  assert.equal(empty.stats.modes.project, "unavailable");

  // 有内容：全局层 9 条 ⇒ 地图档；项目层 cwd 存在但没记忆 ⇒ empty
  const globalDir = join(home, "memory-win", "global");
  mkdirSync(globalDir, { recursive: true });
  const entries = Array.from({ length: 9 }, (_, i) => `- [2026-01-01] 事实编号 ${i}`).join("\n");
  writeFileSync(join(globalDir, "big.md"), `<!-- big · 测试关键词 -->\n\n${entries}\n`, "utf8");

  const cwd = join(sandbox, "repo");
  const full = renderMapWithStats({ cwd });
  const sumFull = Object.values(full.stats.parts).reduce((a, b) => a + b, 0);
  assert.equal(sumFull, full.stats.chars, "有内容时校验和同样闭合");
  assert.equal(full.stats.modes.global, "map", "9 条 > 阈值 8 ⇒ 地图档");
  assert.equal(full.stats.modes.project, "empty");
  assert.equal(full.stats.parts.global > 0, true, "地图段计入 global 分项");
});
