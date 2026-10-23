/**
 * 组合与"源解析"层：把 profile 的 bundle patch 依次叠起来，得到与宿主一致的 loader 入口树。
 *
 * ## 为什么要有"源解析"（0.4.7，真实事故驱动）
 *
 * 生成 preset 覆盖时必须拿到**宿主真正加载的那份** patch 文件。0.4.5/0.4.6 从
 * "同版本独立安装"（`D:/Program Files/nodejs/node_modules/@deepseek-ai/dsh`）读基线，
 * 而那份副本可以被单独更新：宿主把 `presets/standard.patch.yml` 里 persona 的
 * `suffix: Your working directory is {{cwd}}.` 删掉之后，本地副本一度还是旧的，
 * 于是生成的覆盖**把 `{{cwd}}` 又写了回去**，宿主报
 * `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`
 * —— 整轮直接失败。
 *
 * ⇒ 基线优先级必须是：**app.asar（宿主真正加载的）** → profile 的 node_modules →
 * 本地独立安装；并且要拿"影子源"逐文件比文本**显式告警**（同一版本号也可能内容不同，
 * 只比版本号不够）。
 *
 * ## 另一条关键事实（实读源码 + 实测）
 *
 * `applyEntryPatches` 的 `buildMap` 只递归 `entry.group && Array.isArray(entry.config)`
 * 的"组"；preset 行的子项挂在 `config.plugins` 下 ⇒ **preset 内部的行按 id 打补丁打不中**。
 *
 * @module dsh-memory-win/tools/lib/compose
 */

import { existsSync, openSync, closeSync, readFileSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 宿主 `@deepseek-ai/*` 包的本地独立安装位置（asar 不可用时的兜底）。 */
export const DSH_MODULES = "D:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

/** 桌面版 app.asar 的默认位置。 */
export const APP_ASAR = join(
  homedir(),
  "AppData",
  "Local",
  "Programs",
  "DeepSeek Harness",
  "resources",
  "app.asar",
);

/** asar 内宿主包的根（asar 根下就是 `dsh/`）。 */
const ASAR_DSH_ROOT = "dsh";

/** `!!js` 表达式在 JS 对象里的表示：保留来源文本，dump 时原样写回标签。 */
export class JsExpr {
  /**
   * @param {string} src - 表达式源码。
   */
  constructor(src) {
    this.src = src;
  }
}

/**
 * 打开 app.asar 的只读读取器（宿主**真正加载**的那份代码）。
 *
 * 只读：`openSync(name, "r")` + `readSync`，不写入、不改动安装。
 *
 * @param {string} [archive] - asar 路径。
 * @returns {{label:string, readText:(rel:string)=>string|undefined, list:(dir:string)=>string[], close:()=>void}|undefined} 读取器。
 */
export function openAsarReader(archive = process.env.DSH_APP_ASAR ?? APP_ASAR) {
  if (typeof archive !== "string" || !existsSync(archive)) return undefined;
  const fd = openSync(archive, "r");
  let tree;
  let start;
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 16);
    tree = JSON.parse(json.toString());
    start = 8 + head.readUInt32LE(4);
  } catch {
    closeSync(fd);
    return undefined;
  }
  const nodeOf = (path) => {
    if (path === "" || path === undefined) return tree;
    let entry = tree;
    for (const part of String(path).split("/")) {
      if (entry?.files === undefined) return undefined;
      entry = entry.files[part];
    }
    return entry;
  };
  return {
    label: `${archive}（asar）`,
    readText(rel) {
      const entry = nodeOf(rel);
      if (entry === undefined || entry.size === undefined) return undefined;
      const buffer = Buffer.alloc(entry.size);
      readSync(fd, buffer, 0, buffer.length, start + Number(entry.offset));
      return buffer.toString("utf8");
    },
    list(dir) {
      return Object.keys(nodeOf(dir)?.files ?? {});
    },
    close() {
      closeSync(fd);
    },
  };
}

/** yaml 库（懒加载）。 */
let yamlLib;

/**
 * 拿到 js-yaml 与带 `!!js` 标签的 schema。
 *
 * @returns {Promise<{yaml: object, schema: object}>} yaml 与 schema。
 */
export async function yamlToolkit() {
  if (yamlLib === undefined) {
    const mod = await import(pathToFileURL(join(DSH_MODULES, "..", "js-yaml", "index.js")).href);
    const yaml = mod.default ?? mod;
    const type = new yaml.Type("tag:yaml.org,2002:js", {
      kind: "scalar",
      construct: (data) => new JsExpr(String(data)),
      instanceOf: JsExpr,
      represent: (value) => value.src,
    });
    yamlLib = { yaml, schema: yaml.DEFAULT_SCHEMA.extend([type]) };
  }
  return yamlLib;
}

/** DSH 主目录（与插件同一套解析规则）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv.trim());
  return join(homedir(), ".dsh");
}

/**
 * 解析一段 YAML patch 文本。
 *
 * @param {string} text - 文本。
 * @returns {Promise<object[]>} patch 列表。
 */
export async function parsePatches(text) {
  if (typeof text !== "string") return [];
  const { yaml, schema } = await yamlToolkit();
  const parsed = yaml.load(text, { schema });
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * 读一个文件系统上的 YAML patch 文件。
 *
 * @param {string} file - 路径。
 * @returns {Promise<object[]>} patch 列表。
 */
export async function loadPatches(file) {
  return existsSync(file) ? parsePatches(readFileSync(file, "utf8")) : [];
}

/**
 * 造一个"目录型"源。
 *
 * @param {string} dir - 目录。
 * @param {string} kind - 类型标签（profile / install）。
 * @returns {object} 源。
 */
function dirSource(dir, kind) {
  return {
    kind,
    dir,
    label: `${dir}（${kind === "profile" ? "profile" : "本地独立安装"}）`,
    readText(rel) {
      const file = join(dir, rel);
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    },
    list(sub) {
      try {
        return readdirSync(join(dir, sub));
      } catch {
        return [];
      }
    },
  };
}

/**
 * 解析一个 bundle 的源：asar 优先，其次 profile 的 node_modules，最后本地独立安装。
 *
 * @param {object} input - 组成。
 * @param {string} input.profileDir - profile 目录。
 * @param {string} input.bundleName - bundle 包名。
 * @param {object|undefined} input.asar - asar 读取器。
 * @returns {{source:object|undefined, shadow:object|undefined, warnings:string[]}} 源、影子源与告警。
 */
export function resolveBundleSource({ profileDir, bundleName, asar }) {
  const warnings = [];
  const asarRoot = `${ASAR_DSH_ROOT}/node_modules/${bundleName}`;
  const candidates = [];

  if (asar !== undefined && typeof asar.readText(`${asarRoot}/package.json`) === "string") {
    candidates.push({
      kind: "asar",
      dir: asarRoot,
      label: `${asar.label} → ${bundleName}`,
      readText: (rel) => asar.readText(`${asarRoot}/${rel}`),
      list: (sub) => asar.list(`${asarRoot}/${sub}`),
    });
  }
  const profilePath = join(profileDir, "node_modules", bundleName);
  if (existsSync(join(profilePath, "package.json"))) candidates.push(dirSource(profilePath, "profile"));
  const installPath = join(dirname(DSH_MODULES), bundleName);
  if (existsSync(join(installPath, "package.json"))) candidates.push(dirSource(installPath, "install"));

  if (candidates.length === 0) return { source: undefined, shadow: undefined, warnings };

  const source = candidates[0];
  const shadow = candidates.find((candidate) => candidate.kind !== source.kind);
  if (shadow !== undefined) {
    for (const rel of bundlePatchPaths(source)) {
      const a = source.readText(rel);
      const b = shadow.readText(rel);
      if (a === undefined || b === undefined) continue;
      if (a !== b) {
        warnings.push(
          `bundle ${bundleName} 的 ${rel} 在「${source.label}」与影子源「${shadow.label}」**内容不一致**` +
            (source.kind === "asar"
              ? "（已以 asar 为准；影子源可能过期，别拿它当基线）"
              : "（⚠️ 基线不是宿主真正加载的那份，先更新本地副本）"),
        );
      }
    }
  }
  return { source, shadow, warnings };
}

/**
 * 从某 bundle 源里取它声明的 patch 相对路径。
 *
 * @param {object} source - bundle 源。
 * @returns {string[]} 相对路径。
 */
export function bundlePatchPaths(source) {
  const pkgText = source.readText("package.json");
  if (pkgText === undefined) return [];
  const declared = JSON.parse(pkgText)?.dsh?.bundle?.patch;
  if (declared === undefined) return [];
  return (Array.isArray(declared) ? declared : [declared])
    .filter((value) => typeof value === "string")
    .map((value) => value.replace(/^\.\//, ""));
}

/**
 * 叠出组合树。
 *
 * @param {object} [options] - 选项。
 * @param {string} [options.profileName] - profile 名（默认 desktop）。
 * @param {boolean} [options.withUserPatch] - 是否叠用户的 `cordis.patch.yml`（默认 false）。
 * @param {string[]} [options.extraPatches] - 额外 patch 文件（叠在最后）。
 * @returns {Promise<object>} 组合结果。
 * @throws {Error} 宿主函数或 profile 不可用时抛出。
 */
export async function composeLayers(options = {}) {
  const { profileName = "desktop", withUserPatch = false, extraPatches = [] } = options;

  const includeFile = join(DSH_MODULES, "cordis-plugin-include", "lib", "index.js");
  if (!existsSync(includeFile)) throw new Error(`找不到宿主的 cordis-plugin-include：${includeFile}`);
  const { applyEntryPatches } = await import(pathToFileURL(includeFile).href);

  const profileDir = join(dshHome(), "profiles", profileName);
  const profilePkgFile = join(profileDir, "package.json");
  if (!existsSync(profilePkgFile)) throw new Error(`profile 不存在：${profileDir}`);
  const profilePkg = JSON.parse(readFileSync(profilePkgFile, "utf8"));

  const asar = openAsarReader();
  const warnings = [];
  const warn = (format, ...args) => {
    let index = 0;
    warnings.push(String(format).replace(/%C/g, () => JSON.stringify(args[index++])));
  };

  let data = [];
  const applied = [];
  const sources = [];
  for (const bundleName of profilePkg?.dsh?.profile?.bundles ?? []) {
    const resolved = resolveBundleSource({ profileDir, bundleName, asar });
    warnings.push(...resolved.warnings);
    if (resolved.source === undefined) {
      warnings.push(`bundle ${JSON.stringify(bundleName)} 找不到源（跳过它的 patch）`);
      continue;
    }
    sources.push({ bundle: bundleName, label: resolved.source.label });
    for (const rel of bundlePatchPaths(resolved.source)) {
      data = applyEntryPatches(data, await parsePatches(resolved.source.readText(rel)), warn);
      applied.push({ file: `${resolved.source.label} → ${rel}`, patches: 1 });
    }
  }

  const userPatches = await loadPatches(join(profileDir, "cordis.patch.yml"));
  if (withUserPatch) data = applyEntryPatches(data, userPatches, warn);
  for (const file of extraPatches) data = applyEntryPatches(data, await loadPatches(resolve(file)), warn);

  return { data, warnings, applied, profileDir, userPatches, sources, asar };
}

/**
 * 列出组合树里的 preset 行。
 *
 * @param {object[]} data - 组合树。
 * @returns {object[]} preset 行。
 */
export function presetRowsOf(data) {
  return data.filter((entry) => typeof entry?.id === "string" && entry.id.startsWith("preset-"));
}

/**
 * 找到某个 preset 行的**源插入处**（保真基线：`!!js` 保留为 `JsExpr`）。
 *
 * 逐 bundle、逐 patch 文件找 `insert` 里 id 匹配的那一行，返回它**在哪个源、哪个文件**里 ——
 * 生成整段覆盖时必须用源定义而不是 structuredClone 之后的组合树（后者会丢类原型）。
 *
 * @param {object} input - 组成。
 * @param {string} input.presetId - preset 行 id（如 `preset-standard`）。
 * @param {string} [input.profileName] - profile 名。
 * @returns {Promise<{entry:object, rel:string, sourceLabel:string, warnings:string[]}|undefined>} 源插入处。
 */
export async function findPresetInsert({ presetId, profileName = "desktop" }) {
  const profileDir = join(dshHome(), "profiles", profileName);
  const profilePkg = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
  const asar = openAsarReader();
  const warnings = [];
  let found;
  for (const bundleName of profilePkg?.dsh?.profile?.bundles ?? []) {
    const resolved = resolveBundleSource({ profileDir, bundleName, asar });
    warnings.push(...resolved.warnings);
    if (resolved.source === undefined) continue;
    for (const rel of bundlePatchPaths(resolved.source)) {
      for (const patch of await parsePatches(resolved.source.readText(rel))) {
        const list = Array.isArray(patch?.insert) ? patch.insert : [];
        for (const entry of list) {
          if (entry?.id === presetId) found = { entry, rel, sourceLabel: resolved.source.label, warnings };
        }
      }
    }
  }
  return found;
}

/**
 * 深比较两个值（认 `JsExpr`：按表达式源码比较）。
 *
 * @param {*} a - 值。
 * @param {*} b - 值。
 * @returns {boolean} 是否等价。
 */
export function deepEqualWithJs(a, b) {
  if (a === b) return true;
  if (a instanceof JsExpr || b instanceof JsExpr) {
    return a instanceof JsExpr && b instanceof JsExpr && a.src === b.src;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqualWithJs(value, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((key) => Object.hasOwn(b, key) && deepEqualWithJs(a[key], b[key]));
  }
  return false;
}
