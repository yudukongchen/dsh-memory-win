/**
 * 容量策略测试（0.2.0 的 P6）：哪些东西会被归档、哪些**永远不会**被归档。
 *
 * 这个文件的重点是**边界与保护**，不是"能不能归档"：
 * 归档是本项目里唯一会**移动记忆数据**的动作，所以"活条目永不被搬走"
 * 与"宽限期内不动手"这两条必须有用例钉住。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { initConfig } from "../lib/config.js";
import {
  appendMemory,
  cleanupLayer,
  correctMemory,
  listEntries,
  listLayer,
  runCleanup,
  runStartupCleanup,
  searchMemory,
} from "../lib/engine.js";
import { daysAgo, shiftDays, today } from "../lib/format.js";
import { PROJECT_DIR_NAME, archiveRoot, globalRoot } from "../lib/paths.js";
import { archivableLines, recordAccess, resetStateCache } from "../lib/state.js";

const savedDshHome = process.env.DSH_HOME;
let sandbox;
let fakeHome;
let projectCwd;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "dsh-memory-win-cleanup-"));
  fakeHome = join(sandbox, "dshhome");
  projectCwd = join(sandbox, "repo");
  process.env.DSH_HOME = fakeHome;
  initConfig(undefined);
  resetStateCache();
});

afterEach(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  initConfig(undefined);
  resetStateCache();
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用 */
  }
});

/**
 * 建一个分片并让其中一条**已被取代**：先写旧结论，再用 `memory_correct` 取代它。
 *
 * @param {object} params - 参数。
 * @param {string} params.shard - 分片名。
 * @param {string} params.oldFact - 旧结论。
 * @param {string} params.newFact - 新结论。
 * @param {string} [params.oldDate] - 旧条目的日期（决定它是否超出宽限期）。
 * @returns {Promise<{hitId:string, newId:string}>} id 信息。
 */
async function supersede({ shard, oldFact, newFact, oldDate }) {
  await appendMemory({ target: "global", shard, fact: oldFact, ...(oldDate === undefined ? {} : { date: oldDate }) });
  const found = searchMemory(oldFact.split(" ")[0], { target: "global" });
  const hit = found.hits.find((h) => h.shard === shard);
  assert.notEqual(hit, undefined, "刚写的条目必须能检索到");
  const corrected = await correctMemory({ target: "global", id: hit.id, reason: "overturned", replacement: newFact });
  assert.equal(corrected.ok, true);
  return { hitId: hit.id, newId: corrected.newId };
}

test("归档只搬**已失效且超出宽限期**的条目；活条目一条不动", async () => {
  await supersede({ shard: "kap", oldFact: "旧结论 甲", newFact: "新结论 乙", oldDate: daysAgo(10) });
  await appendMemory({ target: "global", shard: "kap", fact: "另一条活结论 丙" });

  const shardFile = join(globalRoot(), "kap.md");
  assert.match(readFileSync(shardFile, "utf8"), /^<!-- - \[/m, "取代后的旧条目应是注释行");

  const result = await cleanupLayer("global", { days: 3 });

  assert.equal(result.archived.length, 1, "恰好归档 1 个分片件");
  assert.equal(result.archived[0].count, 1, "恰好搬走 1 条失效条目");
  assert.equal(result.removedShards.length, 0, "还有活条目 ⇒ 分片文件不能删");

  const after = readFileSync(shardFile, "utf8");
  assert.equal(/旧结论 甲/.test(after), false, "失效条目已离开原分片");
  assert.match(after, /另一条活结论 丙/, "活条目必须留在原分片");

  const archived = readFileSync(join(archiveRoot(globalRoot()), "kap.md"), "utf8");
  assert.match(archived, /旧结论 甲/, "归档件里原样保留那条失效条目");
  assert.match(archived, /archived · from kap/, "归档件带来源与日期头");
});

test("**活条目永远不会被归档**：即使它很老、而且从没被检索过", async () => {
  await appendMemory({
    target: "global",
    shard: "live",
    fact: "很久以前的一条仍然有效的结论",
    date: daysAgo(365),
  });

  const result = await cleanupLayer("global", { days: 3 });

  assert.equal(result.archived.length, 0, "没有任何失效条目 ⇒ 什么都不搬");
  assert.equal(existsSync(join(globalRoot(), "live.md")), true);
  assert.match(readFileSync(join(globalRoot(), "live.md"), "utf8"), /仍然有效的结论/);
  assert.equal(existsSync(archiveRoot(globalRoot())), false, "连归档目录都不该被创建");
});

test("宽限期内的失效条目不动手（刚取代完就搬走会让取代可追溯名存实亡）", async () => {
  await supersede({ shard: "fresh", oldFact: "今天刚写错的结论 甲", newFact: "今天改对 乙", oldDate: today() });

  const result = await cleanupLayer("global", { days: 3 });
  assert.equal(result.archived.length, 0);
  assert.match(readFileSync(join(globalRoot(), "fresh.md"), "utf8"), /^<!-- - \[/m, "失效条目仍就地保留");
});

test("宽限期内**被检索命中过**的失效条目再等一轮（减档条件）", async () => {
  const { hitId } = await supersede({ shard: "seen", oldFact: "旧结论 甲", newFact: "新乙", oldDate: daysAgo(10) });

  // 失效条目本身不会被检索命中（parseEntries 跳过它），所以只能直接记一条
  // "今天取回过它"的命中记录 —— 那正是归档减档条件要读的东西。
  await recordAccess(globalRoot(), "seen", [{ id: hitId }], today());

  const result = await cleanupLayer("global", { days: 3 });
  assert.equal(result.archived.length, 0, "宽限期内被取回过 ⇒ 本轮不搬");

  // 对照组：换一条没有取回记录的，同样日期就应该被搬走
  const other = await supersede({ shard: "unseen", oldFact: "旧结论 乙", newFact: "新丙", oldDate: daysAgo(10) });
  assert.equal(typeof other.hitId, "string");
  const again = await cleanupLayer("global", { days: 3 });
  assert.equal(again.archived.length, 1, "没有取回记录的照常归档");
  assert.equal(again.archived[0].shard, "unseen");
});

test("整片只剩失效条目 ⇒ 归档后删掉那个分片文件（限制 12 的落点）", async () => {
  // 用 retract（纯撤回、无新结论）造出"这片再也没有活条目"的状态 ——
  // 这正是限制 12 说的那种残留：文件还在、条目全是注释、层视图里留下一条 0 条目的行。
  await appendMemory({ target: "global", shard: "empty", fact: "唯一一条且已被撤回 甲", date: daysAgo(9) });
  const hit = searchMemory("已被撤回", { target: "global" }).hits[0];
  await correctMemory({ target: "global", id: hit.id, reason: "retract" });

  const shardFile = join(globalRoot(), "empty.md");
  assert.equal(listLayer("global").total, 0, "撤回后该层有效条目为 0");

  const result = await cleanupLayer("global", { days: 3 });

  assert.deepEqual(result.removedShards, ["empty"]);
  assert.equal(existsSync(shardFile), false, "空分片文件已删除");
  const archived = readFileSync(join(archiveRoot(globalRoot()), "empty.md"), "utf8");
  assert.match(archived, /整片归档/, "整片归档时连首行关键词头一起留档");
  assert.match(archived, /唯一一条且已被撤回 甲/);
});

test("同一条失效条目只被搬一次（第二次清理是无操作）", async () => {
  await supersede({ shard: "once", oldFact: "旧 甲", newFact: "新 乙", oldDate: daysAgo(8) });
  await appendMemory({ target: "global", shard: "once", fact: "活 丙" });

  const first = await cleanupLayer("global", { days: 3 });
  assert.equal(first.archived[0].count, 1);
  const second = await cleanupLayer("global", { days: 3 });
  assert.equal(second.archived.length, 0, "第二次没有可搬的了");
  const archiveText = readFileSync(join(archiveRoot(globalRoot()), "once.md"), "utf8");
  assert.equal(archiveText.split("旧 甲").length - 1, 1, "归档件里只出现一次");
});

test("归档后层视图不再报那条失效条目，且归档数可见", async () => {
  await supersede({ shard: "view", oldFact: "被推翻的 甲", newFact: "新的 乙", oldDate: daysAgo(7) });
  await appendMemory({ target: "global", shard: "view", fact: "活 丙" });

  const beforeLayer = listLayer("global");
  const beforeView = beforeLayer.shards.find((s) => s.name === "view");
  assert.equal(beforeView.entries.length, 2, "失效条目不进层视图（只剩取代后的新条目与那条活条目）");
  assert.equal(
    beforeView.entries.some((e) => e.text.includes("被推翻")),
    false,
    "被取代的结论不再出现在层视图里",
  );
  assert.equal(beforeLayer.archived, 0);

  await cleanupLayer("global", { days: 3 });

  const afterLayer = listLayer("global");
  assert.equal(afterLayer.shards.find((s) => s.name === "view").entries.length, 2, "两条活条目仍在");
  assert.equal(afterLayer.archived, 1, "归档件数出现在层视图里");
  assert.equal(afterLayer.archiveDir.includes("archive"), true);
});

test("runCleanup：当天只跑一次（lastCleanup 落盘，重启也认）", async () => {
  await supersede({ shard: "daily", oldFact: "旧 甲", newFact: "新 乙", oldDate: daysAgo(6) });

  const first = await runCleanup({ cwd: projectCwd });
  assert.equal(first.ran, true);
  assert.equal(first.archived, 1);

  const second = await runCleanup({ cwd: projectCwd });
  assert.equal(second.ran, false, "今天已经清理过");
  assert.equal(second.archived, 0);
  assert.equal(
    second.layers.some((l) => l.skipped === "cleanup-done-today"),
    true,
    "要显式说明是「今天已清理」而不是「没东西可清」",
  );

  const forced = await runCleanup({ cwd: projectCwd, force: true });
  assert.equal(forced.ran, true, "force 时忽略当天标记");

  const state = JSON.parse(readFileSync(join(globalRoot(), ".state.json"), "utf8"));
  assert.equal(state.lastCleanup, today());
});

test("runCleanup：cleanupEnabled=false 时完全不动手", async () => {
  await supersede({ shard: "off", oldFact: "旧 甲", newFact: "新 乙", oldDate: daysAgo(6) });
  initConfig({ cleanupEnabled: false });

  const result = await runCleanup({ cwd: projectCwd });
  assert.equal(result.ran, false);
  assert.equal(result.reason, "disabled");
  assert.equal(existsSync(join(archiveRoot(globalRoot()), "off.md")), false);
});

test("项目层与全局层彼此独立：只清自己那层", async () => {
  await appendMemory({ target: "project", cwd: projectCwd, shard: "p", fact: "项目旧 甲", date: daysAgo(9) });
  const hit = searchMemory("项目旧", { target: "project", cwd: projectCwd }).hits[0];
  await correctMemory({ target: "project", cwd: projectCwd, id: hit.id, reason: "defect", replacement: "项目新 乙" });
  await appendMemory({ target: "global", shard: "g", fact: "全局活 丙" });

  const result = await runStartupCleanup({ cwd: projectCwd });
  const projectLayer = result.layers.find((l) => l.target === "project");
  const globalLayer = result.layers.find((l) => l.target === "global");
  assert.equal(projectLayer.archived.length, 1, "项目层归档了整片（无活条目）");
  assert.equal(globalLayer.archived.length, 0, "全局层没有失效条目");
  assert.equal(existsSync(join(archiveRoot(globalRoot()), "g.md")), false);
});

test("已知工作区：从 storages/workspace.json 读出别的仓库并清理它的项目层", async () => {
  const otherRoot = join(sandbox, "other-repo");
  await appendMemory({ target: "project", cwd: otherRoot, shard: "o", fact: "别处的旧结论 甲", date: daysAgo(12) });
  const hit = searchMemory("别处的旧结论", { target: "project", cwd: otherRoot }).hits[0];
  await correctMemory({ target: "project", cwd: otherRoot, id: hit.id, reason: "retract" });

  // 模拟宿主持久化的工作区列表（本项目唯一读宿主内部格式的地方，失败即降级）
  mkdirSync(join(fakeHome, "storages"), { recursive: true });
  writeFileSync(
    join(fakeHome, "storages", "workspace.json"),
    JSON.stringify({ tables: { workspaces: { a: { path: otherRoot } } } }),
    "utf8",
  );

  // cwd 给一个**没有记忆的**新目录，确保被清的是 workspace.json 里那个仓库
  const unrelated = join(sandbox, "unrelated");
  const result = await runStartupCleanup({ cwd: unrelated });
  const cleaned = result.layers.filter((l) => l.target === "project");
  assert.equal(cleaned.some((l) => l.removedShards.includes("o")), true, "别的仓库的项目层也被清理了");
  assert.equal(existsSync(join(otherRoot, PROJECT_DIR_NAME, "o.md")), false);

  // 回归（0.2.1 宿主内实测踩到）：**没有任何分片的层必须什么都不写** ——
  // 旧实现会给每个已知工作区写一份 `.state.json`，于是插件在用户从没用过它的仓库里
  // 凭空建出一个隐藏目录（实测：某个从未写过记忆的仓库的 git status 多了一条 `?? .agent-memory/`）。
  assert.equal(existsSync(join(unrelated, PROJECT_DIR_NAME)), false, "没有记忆的目录不该被创建");
  const skipped = result.layers.filter((l) => l.skipped === "no-shards");
  assert.equal(skipped.length >= 1, true, "没有分片的层应报 no-shards（而非写状态）");
});

test("没有任何分片的层：不创建目录、不写状态文件，且下次启动仍会重新检查", async () => {
  const emptyRepo = join(sandbox, "empty-repo");

  const first = await runStartupCleanup({ cwd: emptyRepo });
  const projectLayer = first.layers.find((l) => l.target === "project");
  assert.equal(projectLayer.skipped, "no-shards");
  assert.equal(first.ran, false, "整层都没做任何事 ⇒ 不算跑过");
  assert.equal(existsSync(join(emptyRepo, PROJECT_DIR_NAME)), false, "目录不该被创建");

  // 即便 force，也仍然不写（force 是"忽略当天标记"，不是"允许建目录"）
  await runStartupCleanup({ cwd: emptyRepo, force: true });
  assert.equal(existsSync(join(emptyRepo, PROJECT_DIR_NAME)), false);

  // 之后真有记忆了，就正常参与清理并写状态
  await appendMemory({ target: "project", cwd: emptyRepo, shard: "later", fact: "后来才有的一条" });
  const second = await runStartupCleanup({ cwd: emptyRepo });
  assert.equal(second.layers.find((l) => l.target === "project").skipped, undefined);
  assert.equal(existsSync(join(emptyRepo, PROJECT_DIR_NAME, ".state.json")), true, "有分片之后才写状态");
});

test("workspace.json 读不懂时降级：全局层照常清理，不抛错", async () => {
  await supersede({ shard: "deg", oldFact: "旧 甲", newFact: "新 乙", oldDate: daysAgo(6) });
  mkdirSync(join(fakeHome, "storages"), { recursive: true });
  writeFileSync(join(fakeHome, "storages", "workspace.json"), "{ 这不是 JSON", "utf8");

  const result = await runStartupCleanup({ cwd: join(sandbox, "unrelated") });
  assert.equal(result.archived, 1, "全局层照常归档");
});

test("listEntries 的 access 计划只含**真正返回**的条目（被 limit 截掉的不算）", async () => {
  for (let i = 0; i < 4; i += 1) {
    await appendMemory({ target: "global", shard: "many", fact: `条目 ${i}` });
  }
  assert.equal(listEntries({ target: "global", limit: 100 }).access.length, 4);
  const limited = listEntries({ target: "global", limit: 2 });
  assert.equal(limited.total, 2);
  assert.equal(limited.access.length, 2, "只返回了 2 条，命中计划里也只应有 2 条");
});

test("命中记录按**日**粒度：同一天重复取回不产生第二次写盘", async () => {
  await appendMemory({ target: "global", shard: "acc", fact: "一条会被反复取回的记忆" });
  const hit = searchMemory("反复取回", { target: "global" }).hits[0];

  const first = await recordAccess(globalRoot(), "acc", [{ id: hit.id }], today());
  assert.equal(first, true, "第一次记命中要写盘");
  const second = await recordAccess(globalRoot(), "acc", [{ id: hit.id }], today());
  assert.equal(second, false, "同一天第二次不再写盘");

  const state = JSON.parse(readFileSync(join(globalRoot(), ".state.json"), "utf8"));
  assert.equal(state.access.acc.entries[hit.id], today());
});

// ══════════════════════════════════════════════════════════════════════════════
// 归档判定的**边界**（纯函数，不碰磁盘）
//
// 归档是唯一会移动记忆数据的动作，所以"差一天算不算"必须钉死 —— 而且钉在
// 判定函数上（`archivableLines`），不是在集成测试里靠日期凑。
// ══════════════════════════════════════════════════════════════════════════════

test("archivableLines 边界：正好等于截止日**不**归档，早一天才归档", () => {
  const day = today();
  const cutoff = shiftDays(day, -3); // cleanupDays = 3
  const entries = [
    { line: 2, date: cutoff, id: "eq" }, // 正好 3 天前 ⇒ 不动
    { line: 4, date: shiftDays(day, -4), id: "old" }, // 4 天前 ⇒ 动
    { line: 6, date: shiftDays(day, -1), id: "new" }, // 1 天前 ⇒ 不动
  ];
  assert.deepEqual(archivableLines({ superseded: entries, days: 3, day }), [4]);
});

test("archivableLines：宽限期内被取回过的要减档；取回记录也过期时照常归档", () => {
  const day = today();
  const old = shiftDays(day, -10);
  const entries = [
    { line: 2, date: old, id: "seen" },
    { line: 3, date: old, id: "stale" },
  ];
  const access = new Map([
    ["seen", day], // 今天刚被取回 ⇒ 减档
    ["stale", shiftDays(day, -9)], // 取回记录本身也过了宽限期 ⇒ 不减档
  ]);
  assert.deepEqual(archivableLines({ superseded: entries, days: 3, day, access }), [3]);
});

test("archivableLines：日期串非法一律不动手（清理是不可逆方向的动作）", () => {
  const day = today();
  const entries = [
    { line: 2, date: "2026-13-45", id: "bad" },
    { line: 3, date: "", id: "empty" },
    { line: 4, date: undefined, id: "none" },
  ];
  assert.deepEqual(archivableLines({ superseded: entries, days: 3, day }), []);
});

test("日期工具只有一个实现处：today / shiftDays / daysAgo 互相对得上", () => {
  const day = today();
  assert.equal(daysAgo(0), day);
  assert.equal(daysAgo(3), shiftDays(day, -3));
  assert.equal(shiftDays(shiftDays(day, -5), 5), day, "平移可逆");
  assert.equal(shiftDays("2026-03-01", -1), "2026-02-28", "跨月");
  assert.equal(shiftDays("2026-01-01", -1), "2025-12-31", "跨年");
  assert.equal(shiftDays("非法", 1), "非法", "非法输入原样返回（不抛）");
});
