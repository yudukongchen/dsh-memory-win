/**
 * 记忆视图（0.3.0）：只读的浏览器半身数据源。
 *
 * 两条 GET 路由，形状照 dsh-archived 的宿主半边（webServer exact 路由 + 信任门 + 拒绝留痕）：
 *
 *   GET /api/dsh-memory-win/layers   初始列表：全局记忆 + 已知工作区（**不查任何层的条目**）
 *   GET /api/dsh-memory-win/shards   ?workspace=<绝对路径|global>，展开时才查该层
 *
 * 与参考实现的三处刻意差异：
 *
 * 1. **只读。** 没有任何 POST 路由，因此没有删除、没有回收站、没有并发写保护。
 *    信任门照抄（回环 + 同源证明 + 标头兜底），因为"只读"不等于"谁都可以访问" ——
 *    `layers` 会把本机所有工作区路径列出去，这本身就是本机信息。
 * 2. **工作区白名单。** `shards?workspace=` 的路径必须命中 `knownWorkspacePaths()`
 *    登记表（或等于字面量 `global`），拒绝任何未登记路径 —— 否则这条路由就成了
 *    "任意目录的 markdown 读取器"（路径遍历）。判定与检索共用同一个来源，
 *    客户端与后台清理看到的永远是同一份工作区清单。
 * 3. **档位判定在服务端。** `shards` 返回的是渲染就绪的结构（inline 逐条 / map 每片一行 /
 *    empty），阈值与注入地图共用 `config.inlineThreshold` —— UI 与注入**永不出现两套档位口径**。
 *    区别只有一条且是刻意的：注入截断到 `inlineTextMax`，UI 给**完整正文**（Q4 定案）。
 *
 * 被 `memory_correct` 取代的历史行不显示：`parseEntries` 只返回活条目（注释行恰好被它跳过），
 * 这是复用而非新判定。`archive/` 与 `.state.json` 同样不进列表。
 *
 * @module dsh-memory-win/lib/view
 */

import { basename } from "node:path";

import { configNum } from "./config.js";
import { knownWorkspacePaths, listLayer } from "./engine.js";
import { oneLine } from "./format.js";
import { globalRoot } from "./paths.js";

/** 路由前缀。 */
export const BASE = "/api/dsh-memory-win";

/** 前后端契约版本：半身上新而下留在旧版时，面板显示"请重启"而不是画半截列表。 */
export const API_VERSION = 1;

/** 信任标头：与桌面应用自带的请求管线配合使用（两者都缺时兜底，见 trustReport）。 */
export const HEADER = "x-dsh-memory-win";

/** 拒绝留痕的容量（只读路由被拒多半是环境问题，不需要 archived 那样的 20 条）。 */
const MAX_REFUSALS = 10;

/** 最近被拒绝的请求及证据。**只存标头布尔与主机名，绝不存 query 之外的路径。** */
const refusals = [];

/**
 * 记录一次拒绝的证据。
 *
 * @param {string} path - 被拒的路由。
 * @param {object} request - 宿主 request。
 * @param {object} report - trustReport 结果。
 */
function recordRefusal(path, request, report) {
  refusals.push({
    at: new Date().toISOString(),
    path,
    remote: String(request.socket?.remoteAddress ?? "").slice(0, 40),
    ...report,
  });
  if (refusals.length > MAX_REFUSALS) refusals.shift();
}

/** 最近的拒绝记录（挂进 `/layers` 响应之外的调试通道：日志与 `refusalLog()`）。 */
export function refusalLog() {
  return [...refusals];
}

function headerOf(request, key) {
  const value = request.headers?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopback(value) {
  const address = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  return (
    address === "localhost" ||
    address === "localhost." ||
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

function originMatchesHost(origin, host) {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isLoopback(url.hostname) &&
      url.host === host
    );
  } catch {
    return false;
  }
}

/**
 * 信任判定（逐条对齐 dsh-archived 的实测结论）：
 * 回环是硬条件；`Origin` / `sec-fetch-site` **只要出现就是权威**，不能被标头推翻；
 * 两者都不存在时（桌面应用自带请求管线），要求信任标头。
 *
 * @param {object} request - 宿主 request。
 * @returns {{trusted:boolean, ...}} 判定与证据。
 */
export function trustReport(request) {
  const marker = headerOf(request, HEADER);
  const site = headerOf(request, "sec-fetch-site");
  const host = headerOf(request, "host");
  const origin = headerOf(request, "origin");
  const loopback = isLoopback(request.socket?.remoteAddress);
  const originOk = origin === undefined || originMatchesHost(origin, host);
  const siteOk = site === undefined || site === "same-origin";
  const provenSameOrigin = (origin !== undefined && originOk) || site === "same-origin";
  const trusted = Boolean(host) && loopback && originOk && siteOk && (marker === "1" || provenSameOrigin);
  return {
    trusted,
    marker: marker ?? null,
    loopback,
    host: host ?? null,
    site: site ?? null,
    origin: origin ?? null,
    originOk,
    siteOk,
    provenSameOrigin,
  };
}

/** 写 JSON 响应。`no-store` 是刻意的：列表数据每轮都可能变，缓存会画旧账。 */
export function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

/**
 * 初始列表：全局记忆 + 已知工作区。**只列目录名与路径，不读任何分片。**
 *
 * 行的去留只有一个判据（Q1 定案 A + Q2 定案 A）：路径本身有效就展示。
 * "有没有记忆"是展开时才算的事 —— 初始一次分片都不读。
 *
 * @param {{ctx?:object}} [options] - 可注入宿主 ctx（`workspace` 服务优先于持久化文件）。
 * @returns {{ok:true, apiVersion:number, global:object, workspaces:object[]}} 列表。
 */
export function layersSnapshot(options = {}) {
  const workspaces = [];
  const seen = new Set();
  for (const p of knownWorkspacePaths(options.ctx)) {
    const key = String(p).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    workspaces.push({ workspace: p, title: basename(p) || p, path: p });
  }
  return {
    ok: true,
    apiVersion: API_VERSION,
    global: { workspace: "global", title: "global", path: globalRoot() },
    workspaces,
  };
}

/**
 * 单层视图（展开时调用）。
 *
 * @param {string} workspace - 字面量 `global`，或已登记工作区的绝对路径。
 * @param {{ctx?:object}} [options] - 白名单判定用的宿主 ctx。
 * @returns {object} `{ok:true, mode:'inline'|'map'|'empty', ...}`；
 *   未登记路径 → `{ok:false, error:'unknown-workspace'}`；目录读不出 → `{ok:false, error:'unreadable', detail}`。
 */
export function shardsSnapshot(workspace, options = {}) {
  const requested = String(workspace ?? "").trim();
  if (requested === "") return { ok: false, error: "missing-workspace" };

  const global = requested === "global";
  let cwd = undefined;
  if (!global) {
    // 白名单命中后**用登记表里的原始路径**去解析层目录，而不是调用方给的串：
    // 大小写不敏感的匹配只用于"是不是这个工作区"，路径本身必须取权威形态 ——
    // 否则在大小写敏感的平台上，一个近似变体就能读出别的目录。
    const allowed = knownWorkspacePaths(options.ctx);
    const canonical = allowed.find((p) => String(p).toLowerCase() === requested.toLowerCase());
    if (canonical === undefined) {
      // 白名单外：按"未知工作区"拒绝。不给"路径存在但没登记"与"路径不存在"两种区别 ——
      // 这条路由的访问者不该通过错误码探测本机目录结构。
      return { ok: false, error: "unknown-workspace" };
    }
    cwd = canonical;
  }

  let layer;
  try {
    layer = listLayer(global ? "global" : "project", cwd);
  } catch (error) {
    return { ok: false, error: "unreadable", detail: String(error?.message ?? error).slice(0, 200) };
  }

  const mode = layer.total === 0 ? "empty" : layer.total <= configNum("inlineThreshold") ? "inline" : "map";
  const payload = {
    ok: true,
    apiVersion: API_VERSION,
    workspace: requested,
    mode,
    dir: layer.dir,
    total: layer.total,
    shards: layer.shards.length,
  };

  if (mode === "inline") {
    // 逐条：完整正文 + 日期 + id + 所属片名。历史行不在 entries 里（parseEntries 已跳过）。
    const items = [];
    for (const shard of layer.shards) {
      for (const entry of shard.entries) {
        items.push({ shard: shard.name, id: entry.id, date: entry.date, text: entry.text });
      }
    }
    payload.entries = items;
  } else if (mode === "map") {
    // 每片一行：与注入地图档同一组字段、同一个关键词截断口径。
    payload.shardList = layer.shards
      .filter((s) => s.entries.length > 0)
      .map((s) => ({
        name: s.name,
        count: s.entries.length,
        latest: s.latest || "",
        keywords: oneLine(s.keywords).slice(0, configNum("keywordsMaxChars")),
      }));
  }
  return payload;
}

/** 解析 GET 的 query（只有一个参数 `workspace`，故手写，不引 URL 解析器的歧义）。 */
function queryParam(url, key) {
  const index = String(url ?? "").indexOf("?");
  if (index === -1) return "";
  for (const pair of String(url).slice(index + 1).split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const name = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    if (name !== key) continue;
    try {
      return decodeURIComponent(eq === -1 ? "" : pair.slice(eq + 1));
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * 一条只读路由：方法门 → 信任门 → handler → 统一失败报告。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {{path:string, handle:(request:object)=>object}} spec - 路由。
 * @returns {Function} disposer。
 */
function route(ctx, { path, handle }) {
  return ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path,
        handler: async (request, response) => {
          if (request.method !== "GET") {
            json(response, 405, { error: "method-not-allowed" });
            return;
          }
          const report = trustReport(request);
          if (!report.trusted) {
            recordRefusal(path, request, report);
            ctx.logger?.warn?.(`[dsh-memory-win] refused GET ${path}: ${JSON.stringify(report)}`);
            json(response, 403, { ok: false, error: "forbidden" });
            return;
          }
          try {
            json(response, 200, handle(request));
          } catch (error) {
            ctx.logger?.warn?.(`[dsh-memory-win] ${path} failed:`, error);
            json(response, 500, { ok: false, error: "internal", detail: String(error?.message ?? error).slice(0, 200) });
          }
        },
      }),
    `dsh-memory-win: GET ${path}`,
  );
}

/**
 * 挂载两条路由。由 index.js 的独立注入作用域调用，等待 `webServer` 就绪。
 *
 * @param {object} ctx - cordis 上下文（用 `ctx.webServer` 与 `ctx.logger`）。
 */
export function registerViewRoutes(ctx) {
  route(ctx, {
    path: `${BASE}/layers`,
    handle: () => layersSnapshot({ ctx }),
  });
  route(ctx, {
    path: `${BASE}/shards`,
    handle: (request) => shardsSnapshot(queryParam(request.url, "workspace"), { ctx }),
  });
}
