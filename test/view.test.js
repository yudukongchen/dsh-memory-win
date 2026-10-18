/**
 * 记忆视图（0.3.0）宿主侧测试：两条只读路由的**接线、信任门、白名单与档位**。
 *
 * 与 mount.test.js 同一思路：纯逻辑可以用返回值测，但"接上假 webServer 后
 * handler 真的可调用、query 真的解析、403 真的留痕"只有走一遍 route() 的完整
 * 闭包才算证明。
 *
 * ## 为什么每个用例都在函数体第一行重设 DSH_HOME
 *
 * `node test/run.mjs` 把所有测试文件 import 进**同一进程**，异步用例的
 * `beforeEach/afterEach` 会在别人的 `await` 点上交错 —— 本项目实测过：只在
 * `beforeEach` 里设 `DSH_HOME`，合并跑时会被别的文件的钩子在**同一个用例的同步段
 * 之前**换掉，于是白名单读到了别人的 workspace.json。同步语句之间没有微任务边界，
 * 所以"重设环境 → 同步完成路由调用 → 断言返回值"在同一段里就是原子的。
 *
 * 假 request 的字段形态与 `webServer.register({kind,path,handler})` 返回 disposer
 * 这两条契约，分别对照 dsh-archived 在真实宿主跑通的用法与 compat-check 对
 * app.asar 的断言，不是凭类型声明猜的。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { initConfig } from "../lib/config.js";
import { BASE, API_VERSION, HEADER, refusalLog, registerViewRoutes, trustReport } from "../lib/view.js";

const savedDshHome = process.env.DSH_HOME;
let sandbox;
let fakeHome;
let repoA;
let repoB;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "dsh-mw-view-"));
  fakeHome = join(sandbox, "dshhome");
  repoA = join(sandbox, "repo-a");
  repoB = join(sandbox, "repo b"); // 含空格：query 编码回归
  mkdirSync(join(fakeHome, "storages"), { recursive: true });
  mkdirSync(join(repoA, ".agent-memory"), { recursive: true });
  mkdirSync(join(repoB, ".agent-memory"), { recursive: true });
  mkdirSync(join(fakeHome, "memory-win", "global"), { recursive: true });
  writeFileSync(
    join(fakeHome, "storages", "workspace.json"),
    JSON.stringify({ tables: { workspaces: { w1: { path: repoA }, w2: { path: repoB } } } }),
  );
  process.env.DSH_HOME = fakeHome;
  initConfig(undefined);
});

afterEach(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 占用 */
  }
});

/** 用例内再保险：同步段第一行把环境钉回本用例的沙箱（见文件头说明）。 */
function pinEnv() {
  process.env.DSH_HOME = fakeHome;
  initConfig(undefined);
}

/**
 * 造一个记录路由的假上下文。
 *
 * @param {{workspaceList?:string[]}} [options] - 宿主 `workspace` 服务的返回（测服务优先）。
 * @returns {{ctx:object, routes:object[], warns:object[]}} 假 ctx 与录到的内容。
 */
function fakeCtx(options = {}) {
  const routes = [];
  const warns = [];
  const ctx = {
    effect(factory) {
      const dispose = factory();
      return typeof dispose === "function" ? dispose : () => {};
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          route.disposed = true;
        };
      },
    },
    get(key) {
      if (key === "webServer") return ctx.webServer;
      if (key === "workspace" && options.workspaceList !== undefined) {
        return { list: () => options.workspaceList.map((path) => ({ path })) };
      }
      return undefined;
    },
    logger: { warn: (...args) => warns.push(args) },
  };
  return { ctx, routes, warns };
}

function fakeResponse() {
  return {
    statusCode: 0,
    body: "",
    writeHead(status) {
      this.statusCode = status;
    },
    end(text) {
      this.body = String(text ?? "");
    },
    payload() {
      return JSON.parse(this.body);
    },
  };
}

/** 受信 request（桌面形态：回环 + 标头）。 */
function trusted(url, extraHeaders = {}) {
  return {
    method: "GET",
    url,
    headers: { host: "127.0.0.1:63951", [HEADER]: "1", ...extraHeaders },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

/**
 * 挂载路由并**同步**完成一次调用，返回 response。
 *
 * GET handler 的整条链路（方法门 → 信任门 → handle → json）没有 await 点，
 * 因此从 pinEnv 到 payload 就绪都在同一个同步段里 —— 交错不进来。
 *
 * @param {string} path - 请求的精确路径（不含 query）。
 * @param {string} [url] - 完整 url（含 query），默认等于 path。
 * @param {object} [request] - 覆盖用的假 request。
 * @param {object} [options] - 透传 fakeCtx（workspaceList）。
 * @returns {object} response。
 */
function callOnce(path, url = path, request = undefined, options = {}) {
  pinEnv();
  const { ctx, routes } = fakeCtx(options);
  registerViewRoutes(ctx);
  const route = routes.find((r) => r.path === path);
  assert.ok(route, `路由未注册：${path}`);
  const response = fakeResponse();
  void route.handler(request ?? trusted(url), response);
  return response;
}

function writeShard(dir, name, lines) {
  writeFileSync(join(dir, `${name}.md`), lines.join("\n") + "\n");
}

// ── 接线 ────────────────────────────────────────────────────────────────────

test("registerViewRoutes 挂两条 GET 路由，路径与契约常量一致", () => {
  pinEnv();
  const { ctx, routes } = fakeCtx();
  registerViewRoutes(ctx);
  assert.deepEqual(routes.map((r) => [r.kind, r.path]).sort(), [
    ["exact", `${BASE}/layers`],
    ["exact", `${BASE}/shards`],
  ]);
});

test("layers：只列目录，不读任何分片（初始零查询的宿主侧证明）", () => {
  // 放一条记忆：若初始列表读过分片，条数会出现在响应里 —— 断言它**不出现**。
  writeShard(join(repoA, ".agent-memory"), "x", ["- [2026-10-01] 一条不该被初始查询读到的记忆"]);
  const payload = callOnce(`${BASE}/layers`).payload();
  assert.equal(payload.ok, true);
  assert.equal(payload.apiVersion, API_VERSION);
  assert.deepEqual(
    payload.workspaces.map((w) => w.title).sort(),
    ["repo b", "repo-a"].sort(),
    "两个已登记工作区都出现（与登记表一致，重名由 path 区分）",
  );
  assert.equal(payload.global.workspace, "global");
  assert.equal(payload.global.path, join(fakeHome, "memory-win", "global"));
  for (const row of [payload.global, ...payload.workspaces]) {
    assert.equal(row.total, undefined, "初始列表不得带条数（那意味着已经查过分片）");
    assert.equal(row.shards, undefined);
  }
});

test("layers：workspace 服务优先于持久化文件（两条来源同层合并去重）", () => {
  const repoC = join(sandbox, "repo-c");
  const payload = callOnce(`${BASE}/layers`, `${BASE}/layers`, undefined, { workspaceList: [repoC] }).payload();
  const titles = payload.workspaces.map((w) => w.title);
  assert.ok(titles.includes("repo-c"), "活服务的条目要在");
  assert.ok(titles.includes("repo-a"), "持久化文件的条目也要在（knownWorkspacePaths 合并两源）");
});

test("shards?workspace=global：内联档逐条给完整正文（不截 160）", () => {
  const longText = `复盘结论：这条正文超过内联档的显示上限一百六十个字符所以要刻意堆很长很长很长直到确实超过一百六十字符为止以便证明UI不做截断${"尾".repeat(40)}`;
  writeShard(join(fakeHome, "memory-win", "global"), "g", [
    "<!-- g · 关键词甲 -->",
    "",
    "- [2026-09-30] 旧的一条",
    `- [2026-10-02] ${longText}`,
  ]);
  const payload = callOnce(`${BASE}/shards`, `${BASE}/shards?workspace=global`).payload();
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "inline");
  assert.equal(payload.entries.length, 2);
  const texts = payload.entries.map((e) => e.text);
  assert.ok(texts.includes(longText), "UI 给完整正文：注入截断不传染只读视图");
  assert.equal(payload.shardList, undefined, "内联档不再重复给片列表");
  for (const entry of payload.entries) {
    assert.match(entry.id, /^[0-9a-f]{4}$/);
    assert.equal(entry.shard, "g");
  }
});

test("shards：超过阈值切地图档，逐片给 name/count/latest/keywords", () => {
  const lines = [];
  for (let i = 1; i <= 9; i += 1) lines.push(`- [2026-10-0${(i % 9) + 1}] 条目 ${i}`);
  writeShard(join(repoA, ".agent-memory"), "many", ["<!-- many · 路由词 -->", "", ...lines]);
  const payload = callOnce(`${BASE}/shards`, `${BASE}/shards?workspace=${encodeURIComponent(repoA)}`).payload();
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "map", "9 条 > 阈值 8 ⇒ 地图档");
  assert.equal(payload.entries, undefined);
  assert.deepEqual(payload.shardList, [{ name: "many", count: 9, latest: payload.shardList[0].latest, keywords: "路由词" }]);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(payload.shardList[0].latest));
});

test("shards：已登记但无记忆的层返回 empty（不报错、不省略）", () => {
  const payload = callOnce(`${BASE}/shards`, `${BASE}/shards?workspace=${encodeURIComponent(repoB)}`).payload();
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "empty");
  assert.equal(payload.total, 0);
});

test("shards：被取代的历史行不进视图（复用 parseEntries 的跳过）", () => {
  writeShard(join(repoA, ".agent-memory"), "s", [
    "<!-- - [2026-09-30] 已被取代的旧结论 -->",
    "- [2026-10-02] 现行结论 [fix:overturned of #bc32]",
  ]);
  const payload = callOnce(`${BASE}/shards`, `${BASE}/shards?workspace=${encodeURIComponent(repoA)}`).payload();
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].text, "现行结论");
});

test("shards：archive/ 与 .state.json 不出现在任何字段", () => {
  writeShard(join(repoA, ".agent-memory"), "live", ["- [2026-10-02] 活的"]);
  mkdirSync(join(repoA, ".agent-memory", "archive"), { recursive: true });
  writeShard(join(repoA, ".agent-memory", "archive"), "gone", ["<!-- - [2026-09-01] 归档的旧结论 -->"]);
  writeFileSync(join(repoA, ".agent-memory", ".state.json"), "{}");
  const payload = callOnce(`${BASE}/shards`, `${BASE}/shards?workspace=${encodeURIComponent(repoA)}`).payload();
  assert.equal(payload.shards, 1, "只有 live 分片算数");
  const names = (payload.entries ?? []).map((x) => x.shard);
  assert.deepEqual(names, ["live"]);
});

// ── 白名单（路径逃逸的只读面等价物）────────────────────────────────────────

test("shards：未登记路径拒绝为 unknown-workspace，且不泄漏目录是否存在", () => {
  const elsewhere = join(sandbox, "not-registered");
  mkdirSync(join(elsewhere, ".agent-memory"), { recursive: true });
  writeShard(join(elsewhere, ".agent-memory"), "secret", ["- [2026-10-02] 不该被读到的内容"]);
  const a = callOnce(`${BASE}/shards`, `${BASE}/shards?workspace=${encodeURIComponent(elsewhere)}`).payload();
  assert.equal(a.ok, false);
  assert.equal(a.error, "unknown-workspace");
  const b = callOnce(`${BASE}/shards`, `${BASE}/shards?workspace=${encodeURIComponent(join(sandbox, "does-not-exist"))}`).payload();
  assert.equal(b.error, "unknown-workspace", "不存在与未登记给**同一个**错误码：不通过响应探测目录");
  assert.ok(!JSON.stringify(a).includes("不该被读到"));
});

test("shards：大小写变体可命中白名单，层目录取登记表的权威路径（dir 是层目录而非根）", () => {
  writeShard(join(repoA, ".agent-memory"), "k", ["- [2026-10-02] 大小写回归"]);
  const lower = repoA.toLowerCase();
  const payload = callOnce(`${BASE}/shards`, `${BASE}/shards?workspace=${encodeURIComponent(lower)}`).payload();
  assert.equal(payload.ok, true);
  assert.equal(payload.dir, join(repoA, ".agent-memory"));
  assert.equal(payload.entries.length, 1);
});

test("shards：缺 workspace 参数 → missing-workspace（空串与空白都是）", () => {
  assert.equal(callOnce(`${BASE}/shards`, `${BASE}/shards`).payload().error, "missing-workspace");
  assert.equal(callOnce(`${BASE}/shards`, `${BASE}/shards?workspace=%20`).payload().error, "missing-workspace");
});

// ── 信任门与方法门 ──────────────────────────────────────────────────────────

test("非 GET 一律 405（只读面没有 POST 的入口）", () => {
  const response = callOnce(`${BASE}/layers`, `${BASE}/layers`, { ...trusted(`${BASE}/layers`), method: "POST" });
  assert.equal(response.statusCode, 405);
});

test("非回环来源 403 并留痕（拒绝必须可见）", () => {
  const response = callOnce(`${BASE}/layers`, `${BASE}/layers`, {
    ...trusted(`${BASE}/layers`),
    socket: { remoteAddress: "10.0.0.9" },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.payload().error, "forbidden");
  assert.ok(refusalLog().some((r) => r.path === `${BASE}/layers` && r.loopback === false), "refusals 里要有这条证据");
});

test("Origin 出现且与 Host 不符时，标头救不回来（Fetch Metadata 是权威）", () => {
  const report = trustReport({
    headers: { host: "127.0.0.1:63951", [HEADER]: "1", origin: "http://evil.example" },
    socket: { remoteAddress: "127.0.0.1" },
  });
  assert.equal(report.trusted, false);
  assert.equal(report.originOk, false);
});

test("sec-fetch-site 非 same-origin 时同样拒绝；缺失时 Origin 或标头二选一可放行", () => {
  const base = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:63951" } };
  assert.equal(
    trustReport({ ...base, headers: { ...base.headers, [HEADER]: "1", "sec-fetch-site": "cross-site" } }).trusted,
    false,
  );
  // 桌面应用自带管线：两个 Fetch Metadata 头都没有 ⇒ 标头兜底成立。
  assert.equal(trustReport({ ...base, headers: { ...base.headers, [HEADER]: "1" } }).trusted, true);
  // 信号齐备（同源 Origin）⇒ 无需标头。
  assert.equal(trustReport({ ...base, headers: { ...base.headers, origin: "http://127.0.0.1:63951" } }).trusted, true);
  // 什么信号都没有 ⇒ 拒。
  assert.equal(trustReport(base).trusted, false);
});
