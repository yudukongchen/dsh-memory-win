/**
 * 存储层测试：追加、去重、校验、分层、检索、并发串行化。
 *
 * 每个用例都跑在临时 `DSH_HOME` 下，**不碰真实 `~/.dsh`**。因为根目录是
 * 调用时求值（而非模块加载时快照），这里不需要"先设 env 再 import"的技巧 ——
 * 那也是"路径在加载期求值"这一缺陷的反向证据。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { appendMemory, listLayer, searchMemory, writeChainSize } from "../lib/engine.js";
import { globalRoot } from "../lib/paths.js";

const savedDshHome = process.env.DSH_HOME;
let sandbox;
let fakeHome;
let projectCwd;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "dsh-memory-win-"));
  fakeHome = join(sandbox, "dshhome");
  projectCwd = join(sandbox, "repo");
  process.env.DSH_HOME = fakeHome;
});

afterEach(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用，交给系统清理临时目录 */
  }
});

test("appendMemory 建新分片：关键词头 + 规范条目", async () => {
  const result = await appendMemory({ target: "global", shard: "tools", fact: "pwsh 下用 Get-Content -Raw" });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.totalEntries, 1);
  assert.equal(result.line, 3, "首行头 + 空行 → 条目在第 3 行");

  const file = join(globalRoot(), "tools.md");
  assert.equal(existsSync(file), true);
  const text = readFileSync(file, "utf8");
  assert.match(text, /^<!-- tools ·  -->/, "首行应是关键词头");
  assert.match(text, /^- \[2\d{3}-\d{2}-\d{2}\] pwsh 下用 Get-Content -Raw$/m);
});

test("appendMemory 追加到既有分片，条数累加", async () => {
  const first = await appendMemory({ target: "global", shard: "t", fact: "第一条" });
  const second = await appendMemory({ target: "global", shard: "t", fact: "第二条" });
  assert.equal(second.totalEntries, 2);
  assert.equal(second.line > first.line, true, "追加的行号应大于首条");

  const layer = listLayer("global", projectCwd);
  assert.equal(layer.total, 2);
  assert.equal(layer.shards[0].entries[1].text, "第二条");
});

test("appendMemory 尾部重复不重复写入", async () => {
  const fact = "同一事实只应存一次";
  await appendMemory({ target: "global", shard: "t", fact });
  const again = await appendMemory({ target: "global", shard: "t", fact });
  assert.equal(again.duplicate, true);
  assert.equal(listLayer("global", projectCwd).total, 1, "文件里仍只有一条");
});

test("同一事实换个日期默认被拒，不产生重复条目", async () => {
  // 这是 demo 实跑时暴露的问题：同一事实两个日期会在注入的地图里重复占位，
  // 使提示词开销随"重申次数"增长 —— 正是本插件要避免的成本形态。
  await appendMemory({ target: "global", shard: "t", fact: "该结论仍然成立", date: "2026-01-01" });
  const second = await appendMemory({ target: "global", shard: "t", fact: "该结论仍然成立", date: "2026-01-05" });

  assert.equal(second.ok, false);
  assert.equal(second.reason, "same-fact-other-date");
  assert.equal(second.sameFactOtherDate, "2026-01-01");
  assert.equal(listLayer("global", projectCwd).total, 1, "拒绝时不得落盘");
});

test("显式 confirm 才允许按不同日期重申", async () => {
  await appendMemory({ target: "global", shard: "t", fact: "仍然成立", date: "2026-01-01" });
  const second = await appendMemory({
    target: "global",
    shard: "t",
    fact: "仍然成立",
    date: "2026-01-05",
    confirm: true,
  });
  assert.equal(second.ok, true);
  assert.equal(second.sameFactOtherDate, "2026-01-01");
  assert.equal(listLayer("global", projectCwd).total, 2);
});

test("不同正文不受同日重申规则影响", async () => {
  await appendMemory({ target: "global", shard: "t", fact: "甲", date: "2026-01-01" });
  const r = await appendMemory({ target: "global", shard: "t", fact: "乙", date: "2026-01-01" });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
});

test("appendMemory 拒绝凭据且不回显凭据值", async () => {
  const key = "sk-abcdefghijklmnopqrstuvwxyz123456";
  await assert.rejects(
    () => appendMemory({ target: "global", shard: "t", fact: `密钥是 ${key}` }),
    (error) => {
      assert.match(error.message, /疑似凭据/);
      assert.equal(error.message.includes(key), false, "拒绝原因里不得出现密钥本身");
      return true;
    },
  );
  assert.equal(listLayer("global", projectCwd).total, 0, "拒绝后不得落盘任何内容");
});

test("appendMemory 拒绝非法与未来日期", async () => {
  await assert.rejects(() => appendMemory({ target: "global", shard: "t", fact: "x", date: "2026-13-45" }), /日期非法/);
  await assert.rejects(() => appendMemory({ target: "global", shard: "t", fact: "x", date: "2999-01-01" }), /日期非法/);
});

test("appendMemory 拒绝多行事实与自带前缀", async () => {
  await assert.rejects(() => appendMemory({ target: "global", shard: "t", fact: "a\nb" }), /单行/);
  await assert.rejects(() => appendMemory({ target: "global", shard: "t", fact: "- [2026-01-01] x" }), /前缀/);
});

test("appendMemory 拒绝 shard 路径逃逸", async () => {
  await assert.rejects(() => appendMemory({ target: "global", shard: "../evil", fact: "x" }), /分隔符/);
});

test("全局层与项目层互相隔离", async () => {
  await appendMemory({ target: "global", cwd: projectCwd, shard: "g", fact: "全局事实" });
  await appendMemory({ target: "project", cwd: projectCwd, shard: "p", fact: "项目事实" });

  const global = listLayer("global", projectCwd);
  const project = listLayer("project", projectCwd);

  assert.equal(global.total, 1);
  assert.equal(project.total, 1);
  assert.equal(global.shards[0].entries[0].text, "全局事实");
  assert.equal(project.shards[0].entries[0].text, "项目事实");

  // 项目层落在**仓库内**，符合设计决策
  assert.equal(project.dir, join(projectCwd, ".dsh-memory"));
  assert.equal(project.dirPath, ".dsh-memory", "注入里应是相对路径，不泄漏机器特定信息");
});

test("项目层在 cwd 缺失时失败关闭，不回落到全局层", async () => {
  await assert.rejects(() => appendMemory({ target: "project", cwd: undefined, fact: "x" }), /工作目录/);
  assert.equal(listLayer("global", undefined).total, 0, "不得悄悄写进全局层");
});

test("多层多分片：listLayer 汇总条数与最新日期", async () => {
  await appendMemory({ target: "global", shard: "a", fact: "a1", date: "2026-01-01" });
  await appendMemory({ target: "global", shard: "a", fact: "a2", date: "2026-05-05" });
  await appendMemory({ target: "global", shard: "b", fact: "b1", date: "2026-03-03" });

  const layer = listLayer("global", projectCwd);
  assert.equal(layer.total, 3);
  assert.equal(layer.shards.length, 2);
  const a = layer.shards.find((s) => s.name === "a");
  assert.equal(a.entries.length, 2);
  assert.equal(a.latest, "2026-05-05", "最新日期应是该片内最大值");
});

test("searchMemory 跨层检索并按命中词数排序", async () => {
  await appendMemory({ target: "global", shard: "win", fact: "Windows 路径要用 path.join" });
  await appendMemory({ target: "project", cwd: projectCwd, shard: "win", fact: "本项目 Windows 构建需要 msys 路径" });
  await appendMemory({ target: "global", shard: "other", fact: "无关的一条记忆" });

  const r = searchMemory("windows 路径", { cwd: projectCwd });
  assert.equal(r.hits.length, 2, "两个层各命中一条");
  assert.equal(r.hits[0].score, 2, "同时命中两个词的排最前");
  assert.equal(r.scanned, 3);
  // 命中必须带可行取回的信息
  assert.equal(typeof r.hits[0].path, "string");
  assert.equal(typeof r.hits[0].line, "number");
});

test("searchMemory 支持 target 与 shard 收窄", async () => {
  await appendMemory({ target: "global", shard: "x", fact: "共同关键词 alpha" });
  await appendMemory({ target: "global", shard: "y", fact: "共同关键词 alpha" });
  await appendMemory({ target: "project", cwd: projectCwd, shard: "x", fact: "共同关键词 alpha" });

  assert.equal(searchMemory("alpha", { cwd: projectCwd }).hits.length, 3);
  assert.equal(searchMemory("alpha", { cwd: projectCwd, target: "global" }).hits.length, 2);
  assert.equal(searchMemory("alpha", { cwd: projectCwd, target: "global", shard: "x" }).hits.length, 1);
});

test("searchMemory 空 query 报错、无命中返回空列表", async () => {
  assert.throws(() => searchMemory("", {}), /不能为空/);
  assert.throws(() => searchMemory("   ", {}), /不能为空/);
  assert.deepEqual(searchMemory("绝不存在的词", { cwd: projectCwd }).hits, []);
});

test("searchMemory 尊重 limit 并标记截断", async () => {
  for (let i = 0; i < 12; i += 1) {
    await appendMemory({ target: "global", shard: "many", fact: `关键词命中 ${i}` });
  }
  const r = searchMemory("关键词", { cwd: projectCwd, limit: 5 });
  assert.equal(r.hits.length, 5);
  assert.equal(r.truncated, true);
});

test("并发追加被串行化，不丢条目", async () => {
  // 关键回归：读-改-写若不串行化，N 个并发追加会互相覆盖，最终只剩 1 条。
  const facts = Array.from({ length: 20 }, (_, i) => `并发写入第 ${i} 条`);
  await Promise.all(facts.map((fact) => appendMemory({ target: "global", shard: "race", fact })));

  const layer = listLayer("global", projectCwd);
  assert.equal(layer.total, 20, "20 个并发追加后必须一条不少");
  const written = layer.shards[0].entries.map((e) => e.text).sort();
  assert.deepEqual(written, [...facts].sort());
});

test("写入链按文件维度复用槽位，而非按写入次数增长", async () => {
  // 同一个分片写 5 次：链槽位只应有 1 个（复用它），而不是 5 个。
  // 注意 writeChains 是模块级状态，跨用例累积，所以这里只断言"增量"。
  const before = writeChainSize();
  for (let i = 0; i < 5; i += 1) {
    await appendMemory({ target: "global", shard: "chain-same", fact: `第 ${i} 条` });
  }
  assert.equal(writeChainSize() - before, 1, "5 次写入同一文件只应新增 1 个链槽位");

  await appendMemory({ target: "global", shard: "chain-other", fact: "另一个文件" });
  assert.equal(writeChainSize() - before, 2, "换一个文件才新增槽位");
});
