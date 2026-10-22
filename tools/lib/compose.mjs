/**
 * 组合层：把 profile 的 bundle patch 依次叠起来，得到与宿主一致的 loader 入口树。
 *
 * 两个工具共用这份逻辑（只读体检 / 生成 preset 覆盖），避免"两套叠法各自漂移" ——
 * 这类工具一旦与宿主语义分叉，就会给出"看起来对但不对"的结论，比没有工具更糟。
 *
 * ## 关键事实（实读源码 + 实测）
 *
 * `applyEntryPatches`（`cordis-plugin-include/lib/index.js`）的 `buildMap` 只递归
 * **`entry.group` 为真且 `config` 是数组** 的"组"；preset 行的子项挂在 `config.plugins`
 * 下，不在递归范围内 ⇒ **preset 内部的行按 id 打补丁打不中**。
 *
 * ## 为什么读的是"替身"包目录
 *
 * 桌面版把 `@deepseek-ai/dsh-*` 放在 app.asar 里，profile 的 `node_modules` 下没有副本。
 * 所以本模块按"同版本独立安装"去找这些包（全局 npm 的 `@deepseek-ai/dsh/node_modules`）。
 * 版本一致时读到的 patch 文件与宿主一致；升级主机后应先核对版本。
 *
 * @module dsh-memory-win/tools/lib/compose
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 宿主 `@deepseek-ai/*` 包的默认位置（同版本独立安装的替身）。 */
export const DSH_MODULES = "D:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

/** `!!js` 表达式在 JS 对象里的表示：保留来源文本，dump 时原样写回标签。 */
export class JsExpr {
  /**
   * @param {string} src - 表达式源码。
   */
  constructor(src) {
    this.src = src;
  }
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
    const schema = yaml.DEFAULT_SCHEMA.extend([type]);
    yamlLib = { yaml, schema };
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
 * 读一个 YAML patch 文件并取它的 patch 数组。
 *
 * @param {string} file - patch 文件绝对路径。
 * @returns {Promise<object[]>} patch 列表。
 */
export async function loadPatches(file) {
  if (!existsSync(file)) return [];
  const { yaml, schema } = await yamlToolkit();
  const parsed = yaml.load(readFileSync(file, "utf8"), { schema });
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * 从 bundle 包里找它声明的 patch 文件列表。
 *
 * @param {string} pkgDir - 包目录。
 * @returns {string[]} patch 文件绝对路径。
 */
export function bundlePatches(pkgDir) {
  const pkgFile = join(pkgDir, "package.json");
  if (!existsSync(pkgFile)) return [];
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  const declared = pkg?.dsh?.bundle?.patch;
  if (declared === undefined) return [];
  return (Array.isArray(declared) ? declared : [declared]).map((rel) => join(pkgDir, rel));
}

/**
 * 找 bundle 包目录（profile 优先，其次同版本替身）。
 *
 * @param {string} profileDir - profile 目录。
 * @param {string} bundleName - bundle 包名。
 * @returns {string|undefined} 包目录。
 */
export function bundleDir(profileDir, bundleName) {
  return [
    join(profileDir, "node_modules", bundleName),
    join(dirname(DSH_MODULES), bundleName),
    join(DSH_MODULES, bundleName),
  ].find((candidate) => existsSync(join(candidate, "package.json")));
}

/**
 * 叠出组合树。
 *
 * @param {object} [options] - 选项。
 * @param {string} [options.profileName] - profile 名（默认 desktop）。
 * @param {boolean} [options.withUserPatch] - 是否叠用户的 `cordis.patch.yml`（默认 false）。
 * @param {string[]} [options.extraPatches] - 额外 patch 文件（叠在最后）。
 * @returns {Promise<{data:object[], warnings:string[], applied:object[], profileDir:string, userPatches:object[]}>} 组合结果。
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

  const warnings = [];
  const warn = (format, ...args) => {
    let index = 0;
    warnings.push(String(format).replace(/%C/g, () => JSON.stringify(args[index++])));
  };

  let data = [];
  const applied = [];
  for (const bundleName of profilePkg?.dsh?.profile?.bundles ?? []) {
    const pkgDir = bundleDir(profileDir, bundleName);
    if (pkgDir === undefined) {
      warnings.push(`bundle ${JSON.stringify(bundleName)} 找不到包目录（跳过它的 patch）`);
      continue;
    }
    for (const patchFile of bundlePatches(pkgDir)) {
      const patches = await loadPatches(patchFile);
      data = applyEntryPatches(data, patches, warn);
      applied.push({ file: patchFile, patches: patches.length });
    }
  }

  const userPatchFile = join(profileDir, "cordis.patch.yml");
  const userPatches = await loadPatches(userPatchFile);
  if (withUserPatch) data = applyEntryPatches(data, userPatches, warn);

  for (const file of extraPatches) {
    data = applyEntryPatches(data, await loadPatches(resolve(file)), warn);
  }

  return { data, warnings, applied, profileDir, userPatches };
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
