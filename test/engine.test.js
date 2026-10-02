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

import { appendMemory, correctMemory, listLayer, searchMemory, writeChainSize } from "../lib/engine.js";
import { PROJECT_DIR_NAME, globalRoot } from "../lib/paths.js";

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
  assert.equal(project.dir, join(projectCwd, PROJECT_DIR_NAME));
  assert.equal(project.dirPath, PROJECT_DIR_NAME, "注入里应是相对路径，不泄漏机器特定信息");
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

// ══════════════════════════════════════════════════════════════════════════════
// memory_correct：取代语义（需求补充 2 —— 发现缺陷 / 结论被推翻 / 用户纠正）
// ══════════════════════════════════════════════════════════════════════════════

/** 写一条旧条目并回传它的 id，供修正测试使用。 */
async function seedOld(fact = "旧的结论", date = "2026-01-01", shard = "t") {
  await appendMemory({ target: "global", shard, fact, date });
  const entry = listLayer("global", projectCwd).shards.find((s) => s.name === shard).entries.find((e) => e.text === fact);
  return entry.id;
}

test("correctMemory 取代旧条目：新条目带 fix 链接，旧条目变注释", async () => {
  const id = await seedOld("项目层守卫覆盖全局层就够了");
  const r = await correctMemory({
    target: "global",
    shard: "t",
    id,
    reason: "defect",
    replacement: "项目层必须单独覆盖，守卫两条路径都要挂",
  });

  assert.equal(r.ok, true);
  assert.equal(r.reason, "defect");
  assert.equal(r.superseded.id, id);
  assert.equal(r.superseded.text, "项目层守卫覆盖全局层就够了");
  assert.match(r.newEntry, /\[fix:defect of #/);

  const text = readFileSync(join(globalRoot(), "t.md"), "utf8");
  assert.match(text, /<!-- - \[2026-01-01\] 项目层守卫覆盖全局层就够了 -->/, "旧条目应就地注释");
  assert.match(text, /\[fix:defect of #/, "新条目应带因果链接");
});

test("被取代的条目不再进地图、也不再被检索命中", async () => {
  // 这是取代语义的**核心价值**：仅追加会让旧结论继续误导后续判断。
  const id = await seedOld("这条结论是错的");
  assert.equal(searchMemory("结论是错的", { cwd: projectCwd }).hits.length, 1, "取代前可检索到");

  await correctMemory({ target: "global", shard: "t", id, reason: "overturned", replacement: "这条结论已修正" });

  const hits = searchMemory("结论是错的", { cwd: projectCwd });
  assert.equal(hits.hits.length, 0, "取代后旧条目必须检索不到");
  assert.equal(searchMemory("已修正", { cwd: projectCwd }).hits.length, 1, "新条目可检索到");

  const layer = listLayer("global", projectCwd);
  assert.equal(layer.total, 1, "有效条目只剩新的一条");
  assert.equal(
    layer.shards[0].entries.some((e) => e.text === "这条结论是错的"),
    false,
    "旧条目不得出现在层视图里",
  );
});

test("correctMemory 保留历史：被取代的行仍在文件里且行号不变", async () => {
  const a = await seedOld("第一条", "2026-01-01", "keep");
  await appendMemory({ target: "global", shard: "keep", fact: "第二条", date: "2026-01-02" });
  await appendMemory({ target: "global", shard: "keep", fact: "第三条", date: "2026-01-03" });

  const before = readFileSync(join(globalRoot(), "keep.md"), "utf8").split("\n");
  const thirdLine = before.findIndex((l) => l.includes("第三条")) + 1;
  assert.equal(thirdLine, 5, "前置：第三条在第 5 行");

  await correctMemory({ target: "global", shard: "keep", id: a, reason: "correction", replacement: "第一条已改" });

  const after = readFileSync(join(globalRoot(), "keep.md"), "utf8").split("\n");
  // 单行替换 ⇒ 行号不变，其它条目的 read offset 不受影响
  assert.match(after[2], /^<!-- - \[2026-01-01\] 第一条 -->$/, "第 3 行变成注释行");
  assert.match(after[4], /第三条/, "第三条仍在第 5 行");
  // 新条目追加在文件末尾（第 6 行）；第 7 项是收尾换行产生的空串
  assert.match(after[5], /^\- \[2\d{3}-\d{2}-\d{2}\] 第一条已改 \[fix:correction of #/, "新条目应在第 6 行");
  assert.deepEqual(after.slice(6), [""], "除末尾空行外不应多出任何行");
});

test("reason=retract 表示纯撤回：旧条目失效且不产生新条目", async () => {
  const id = await seedOld("这个环境不再适用了");
  const r = await correctMemory({ target: "global", shard: "t", id, reason: "retract" });

  assert.equal(r.ok, true);
  assert.equal(r.retracted, true);
  assert.equal(r.newEntry, undefined);
  assert.equal(listLayer("global", projectCwd).total, 0, "撤回后该层没有有效条目");
  assert.equal(searchMemory("不再适用", { cwd: projectCwd }).hits.length, 0);
});

test("correctMemory 四类 reason 全部可用", async () => {
  for (const reason of ["defect", "overturned", "correction"]) {
    const id = await seedOld(`待修正 ${reason}`, "2026-01-01", "reasons");
    const r = await correctMemory({ target: "global", shard: "reasons", id, reason, replacement: `已修正 ${reason}` });
    assert.equal(r.reason, reason, `reason=${reason} 应被接受`);
  }
  const id = await seedOld("待撤回", "2026-01-01", "reasons");
  const r = await correctMemory({ target: "global", shard: "reasons", id, reason: "retract" });
  assert.equal(r.retracted, true);
});

test("correctMemory 在不指定 shard 时跨分片查找", async () => {
  await appendMemory({ target: "global", shard: "alpha", fact: "藏在 alpha 里", date: "2026-01-01" });
  const id = listLayer("global", projectCwd).shards.find((s) => s.name === "alpha").entries[0].id;

  const r = await correctMemory({ target: "global", id, reason: "defect", replacement: "改好了" });
  assert.equal(r.shard, "alpha", "应报出它实际所在的分片");
});

test("correctMemory 校验：id / reason / replacement 的各类非法输入", async () => {
  await seedOld("基准");

  // 只测**确实非法**的输入。注意不能拿"合法但没写 shard"的调用去测错误路径 ——
  // 那种调用会真的成功，断言就会因为"没有抛错"而失败（本测试初版就踩了这个坑）。
  await assert.rejects(() => correctMemory({ target: "global", reason: "defect", replacement: "x" }), /缺少 id/);
  await assert.rejects(() => correctMemory({ target: "global", id: "  ", reason: "defect", replacement: "x" }), /缺少 id/);

  const id = listLayer("global", projectCwd).shards[0].entries[0].id;
  await assert.rejects(() => correctMemory({ target: "global", id, reason: "  ", replacement: "x" }), /缺少 reason/);
  await assert.rejects(() => correctMemory({ target: "global", id, reason: "瞎写", replacement: "x" }), /非法/);

  // 非 retract 必须给新结论
  await assert.rejects(() => correctMemory({ target: "global", id, reason: "defect" }), /必须给出 replacement/);
  // retract 不应给新结论
  await assert.rejects(
    () => correctMemory({ target: "global", id, reason: "retract", replacement: "多余" }),
    /不应再给 replacement/,
  );
  // 新结论同样要过正文与凭据校验
  await assert.rejects(
    () => correctMemory({ target: "global", id, reason: "defect", replacement: "多行\n内容" }),
    /单行/,
  );
  await assert.rejects(
    () =>
      correctMemory({
        target: "global",
        id,
        reason: "defect",
        replacement: "密钥 sk-abcdefghijklmnopqrstuvwxyz123456",
      }),
    /疑似凭据/,
  );
  // 正文不得包含会提前闭合注释的序列
  await assert.rejects(
    () => correctMemory({ target: "global", id, reason: "defect", replacement: "含 --> 的正文" }),
    /-->/,
  );

  // 以上全部失败 ⇒ 原条目必须完好无损
  const layer = listLayer("global", projectCwd);
  assert.equal(layer.total, 1, "全部校验失败后不得改动文件");
});

test("correctMemory 找不到 id 时给出可执行提示，且不改动文件", async () => {
  await seedOld("只此一条");
  const before = readFileSync(join(globalRoot(), "t.md"), "utf8");

  await assert.rejects(
    () => correctMemory({ target: "global", shard: "t", id: "ffff", reason: "defect", replacement: "x" }),
    /找不到 id 为 #ffff 的条目/,
  );
  assert.equal(readFileSync(join(globalRoot(), "t.md"), "utf8"), before, "失败时不得改动文件");
});

test("correctMemory 允许**同日**取代（当天刚写错的记忆必须能改）", async () => {
  // 这条规则修正过一次：初版要求"严格更晚"，导致当天写错的记忆无法修正 ——
  // 而"刚记下就发现错了"恰恰是最常见的情形。现在只要**不早于**被取代者即可。
  await appendMemory({ target: "global", shard: "today", fact: "今天刚写的，写错了" });
  const id = listLayer("global", projectCwd).shards[0].entries[0].id;

  const r = await correctMemory({ target: "global", shard: "today", id, reason: "correction", replacement: "当天就改对了" });
  assert.equal(r.ok, true);
  assert.equal(r.superseded.date, r.newEntry.match(/\[(\d{4}-\d{2}-\d{2})\]/)[1], "同日取代：新旧条目同一天");
  assert.equal(listLayer("global", projectCwd).total, 1, "旧条目已失效");
  assert.equal(searchMemory("写错了", { cwd: projectCwd }).hits.length, 0);
});

test("correctMemory 拒绝**回填**：替换日期早于被取代者", async () => {
  await appendMemory({ target: "global", shard: "back", fact: "较新的结论", date: "2026-06-01" });
  const id = listLayer("global", projectCwd).shards[0].entries[0].id;

  await assert.rejects(
    () => correctMemory({ target: "global", shard: "back", id, reason: "defect", replacement: "回填的旧结论", date: "2026-01-01" }),
    /不能早于被取代的结论/,
  );
  // 边界：同日（等于被取代者）应放行
  const ok = await correctMemory({ target: "global", shard: "back", id, reason: "defect", replacement: "同日修正", date: "2026-06-01" });
  assert.equal(ok.ok, true);
});

test("修正后的新条目自身可以被再次修正", async () => {
  const id1 = await seedOld("第一版", "2026-01-01", "chain");
  const r1 = await correctMemory({ target: "global", shard: "chain", id: id1, reason: "defect", replacement: "第二版", date: "2026-01-02" });
  const r2 = await correctMemory({ target: "global", shard: "chain", id: r1.newId, reason: "correction", replacement: "第三版" });

  assert.equal(r2.superseded.text, "第二版");
  const layer = listLayer("global", projectCwd);
  assert.equal(layer.total, 1, "只剩最新一版有效");
  assert.equal(layer.shards[0].entries[0].text, "第三版");
});

test("id 在同一文件内唯一，且由内容决定（同一内容同一天 id 相同）", async () => {
  await appendMemory({ target: "global", shard: "ids", fact: "内容甲", date: "2026-01-01" });
  await appendMemory({ target: "global", shard: "ids", fact: "内容乙", date: "2026-01-01" });
  const entries = listLayer("global", projectCwd).shards[0].entries;
  assert.equal(new Set(entries.map((e) => e.id)).size, 2, "同一天不同内容的 id 必须不同");

  // 换成另一个分片、同样内容同样日期 → id 应相同（id 不含文件名）
  await appendMemory({ target: "global", shard: "ids2", fact: "内容甲", date: "2026-01-01" });
  const other = listLayer("global", projectCwd).shards.find((s) => s.name === "ids2").entries[0];
  assert.equal(other.id, entries.find((e) => e.text === "内容甲").id);
});
