/**
 * 地图注入测试：验证"小层内联 / 大层只给地图"这条档位切换，以及前缀稳定性。
 *
 * 这两点都是**成本契约**，不是表现细节：档位切错会让提示词开销随记忆增长，
 * 而头行里混入动态数字会让整个前缀失去缓存。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { appendMemory } from "../lib/engine.js";
import { INLINE_MAX_ENTRIES } from "../lib/engine.js";
import { renderMap } from "../lib/map.js";

const savedDshHome = process.env.DSH_HOME;
let sandbox;
let projectCwd;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "dsh-memory-win-map-"));
  process.env.DSH_HOME = join(sandbox, "dshhome");
  projectCwd = join(sandbox, "repo");
});

afterEach(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* 忽略 Windows 占用 */
  }
});

test("空记忆也注入纪律块与写入指引", () => {
  const text = renderMap({ cwd: projectCwd });
  assert.match(text, /长期记忆/);
  assert.match(text, /还没有任何记忆/, "空态必须告诉模型如何写下第一条");
  assert.match(text, /memory_search/, "取回方式必须始终在场");
});

test("小层逐条内联，并标注档位", async () => {
  await appendMemory({ target: "global", shard: "s", fact: "唯一的一条" });
  const text = renderMap({ cwd: projectCwd });
  assert.match(text, /本层条目少（1 条），已逐条内联/);
  assert.match(text, /唯一的一条/, "小层应直接把条目给模型，省一次检索");
});

test("超过阈值后切换为片级地图，不再逐条内联", async () => {
  for (let i = 0; i <= INLINE_MAX_ENTRIES; i += 1) {
    await appendMemory({ target: "global", shard: "big", fact: `第 ${i} 条事实`, date: "2026-01-01" });
  }
  const text = renderMap({ cwd: projectCwd });

  assert.match(text, /big：\d+ 条 ｜ 最新 2026-01-01 ｜/, "应给出片级统计行");
  assert.match(text, /关键词：/, "片级统计应带关键词线索");
  // 关键词未设置时必须**显式可见**，否则"这片没有检索线索"就不可见了。
  assert.match(text, /关键词：（未设置）/, "空关键词要显式写出，不能静默省略");
  assert.equal(text.includes("第 0 条事实"), false, "大层不应逐条内联正文");
  assert.equal(/已逐条内联/.test(text), false, "不应再标注内联档");
});

test("分片关键词头被写入地图作为路由线索", async () => {
  await appendMemory({ target: "global", shard: "big", fact: "x", date: "2026-01-01" });
  for (let i = 0; i < INLINE_MAX_ENTRIES; i += 1) {
    await appendMemory({ target: "global", shard: "big", fact: `填充 ${i}`, date: "2026-01-01" });
  }
  // 手工补上关键词头（真实使用中由人或模型维护）
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { globalRoot } = await import("../lib/paths.js");
  const file = join(globalRoot(), "big.md");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^<!-- big · {2}-->/, "<!-- big · 构建 路径 msys -->"));

  const text = renderMap({ cwd: projectCwd });
  assert.match(text, /关键词：构建 路径 msys/);
  assert.equal(text.includes("（未设置）"), false, "有关键词时不应出现未设置占位");
});

test("头行不含统计数字（保护前缀缓存）", () => {
  const text = renderMap({ cwd: projectCwd });
  const header = text.split("\n")[0];
  assert.equal(header, "## 长期记忆（地图档 · 正文按需检索）");
  // 头行若混入"N 片 / M 条"，每写一条记忆就会让整个提示词前缀失效。
  assert.equal(/\d/.test(header), false, `头行不得含数字，实际 "${header}"`);
});

test("统计数字放在段尾", async () => {
  await appendMemory({ target: "global", shard: "s", fact: "一条" });
  const text = renderMap({ cwd: projectCwd });
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  assert.match(lines[lines.length - 1], /记忆合计 \d+ 片 \/ \d+ 条/);
});

test("记忆正文里的 {{ 被中和，不会让宿主插值抛错", async () => {
  await appendMemory({ target: "global", shard: "s", fact: "模板里写 {{unknown_var}} 会让装配失败" });
  const text = renderMap({ cwd: projectCwd });
  assert.equal(text.includes("{{"), false, "注入文本里不得残留 {{");
  assert.match(text, /\{ \{unknown_var/);
});

test("无 cwd 时声明项目层不可用，而不是静默少一层", () => {
  const text = renderMap({});
  assert.match(text, /没有工作目录/);
  assert.match(text, /只有全局层生效/);
});

test("项目层与全局层同时存在时都出现", async () => {
  await appendMemory({ target: "global", shard: "g", fact: "全局的一条" });
  await appendMemory({ target: "project", cwd: projectCwd, shard: "p", fact: "项目的一条" });
  const text = renderMap({ cwd: projectCwd });
  assert.match(text, /### 全局记忆/);
  assert.match(text, /### 项目记忆/);
  assert.match(text, /全局的一条/);
  assert.match(text, /项目的一条/);
});
