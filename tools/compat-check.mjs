#!/usr/bin/env node
/**
 * 宿主契约检查（0.3.0 记忆视图）——本机这份 DSH 还认不认插件写它所依赖的半身契约。
 *
 * 其它套件测的是"插件自己"，这一套测的是"宿主还是不是那个宿主"。DSH 升级后
 * **先跑这个**：浏览器半身依赖 `webServer` 的 exact 路由、`settings.section`
 * 的 list 插槽与 `locale` 服务；任何一个变形，设置页就会静默变成"读不到宿主状态"。
 *
 * 直接读随包的 app.asar（宿主跑的同一批字节），不起服务。
 *
 *     node tools/compat-check.mjs
 *     DSH_APP_ASAR=<path>/app.asar node tools/compat-check.mjs
 *
 * 找不到 bundle 时打 SKIP 并退 0（没有 DSH 的 CI 机）。
 */

import { existsSync, openSync, readSync, closeSync } from "node:fs";

// 默认候选从环境推导（不写死用户名 —— 这是公开仓库，机器特定信息一律不进 git）。
// Windows 桌面版装在 %LOCALAPPDATA%，macOS 在 /Applications；都找不到就靠 DSH_APP_ASAR。
const winDefault =
  typeof process.env.LOCALAPPDATA === "string" && process.env.LOCALAPPDATA.length > 0
    ? `${process.env.LOCALAPPDATA.replace(/\\/g, "/")}/Programs/DeepSeek Harness/resources/app.asar`
    : undefined;

const CANDIDATES = [
  process.env.DSH_APP_ASAR,
  winDefault,
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar",
].filter((p) => typeof p === "string" && p.length > 0);

const failures = [];
function check(label, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

const archive = CANDIDATES.find((p) => existsSync(p));
if (archive === undefined) {
  console.log("SKIP: 找不到 DSH app bundle（设 DSH_APP_ASAR 指向一个）");
  process.exit(0);
}
console.log(`bundle: ${archive}`);

// --- 最小 asar 读取（与 dsh-archived 的实测形态一致）--------------------------
const fd = openSync(archive, "r");
const sizeBuf = Buffer.alloc(8);
readSync(fd, sizeBuf, 0, 8, 0);
const headerSize = sizeBuf.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerSize);
readSync(fd, headerBuf, 0, headerSize, 8);
const jsonLength = headerBuf.readUInt32LE(4);
const tree = JSON.parse(headerBuf.toString("utf8", 8, 8 + jsonLength).replace(/\u0000+$/, ""));
const dataStart = 8 + headerSize;

function entry(path) {
  let node = tree;
  for (const part of path.split("/").filter(Boolean)) {
    node = node?.files?.[part];
    if (node === undefined) return null;
  }
  return node?.files === undefined ? node : null;
}
function readText(path) {
  const node = entry(path);
  if (node === null) return null;
  const buffer = Buffer.alloc(node.size);
  readSync(fd, buffer, 0, node.size, dataStart + parseInt(node.offset, 10));
  return buffer.toString("utf8");
}
const modules = "/dsh/node_modules/@deepseek-ai/";

const rootPkg = readText("/dsh/package.json");
const version = rootPkg === null ? null : JSON.parse(rootPkg).version;
check("bundle 是可读的 DSH app", typeof version === "string", String(version));

// --- 宿主半边：webServer 仍收 exact 路由 --------------------------------------
const webServer = readText(modules + "dsh-host-webserver/lib/index.js");
check(
  "webServer 仍提供 exact 路由表（记忆视图两条 GET 的挂载点）",
  typeof webServer === "string" && webServer.includes("register(route)") && webServer.includes('route.kind === "exact"'),
);

// --- 浏览器半边：settings.section / locale / 我们的格子还空着 -------------------
const shell = readText(modules + "dsh-client-ui-settings-general/lib/client.js");
check(
  "settings.section 仍是 list 插槽",
  typeof shell === "string" && /"settings\.section":\s*\{\s*kind:\s*"list"/.test(shell),
);
const officialIds = [];
for (const name of ["dsh-client-ui-settings-general", "dsh-client-ui-settings-models", "dsh-client-ui-settings-plugins", "dsh-client-ui-agent-preset", "dsh-client-ui-settings-account"]) {
  const source = readText(`${modules}${name}/lib/client.js`);
  if (source === null) continue;
  for (const match of source.matchAll(/name:\s*"settings\.section"[\s\S]{0,240}?id:\s*"([^"]+)"/g)) officialIds.push(match[1]);
}
check("settings.section 仍被随包区块占用", officialIds.length > 0, officialIds.join(", "));
check("我们的 'memory-view' 格子在这台宿主上是空的", !officialIds.includes("memory-view"), officialIds.join(", "));
check("locale 服务仍在（词典注册与 bind 的来源）", entry(modules + "dsh-client-locale/lib/index.js") !== null);

closeSync(fd);

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("all checks passed");
