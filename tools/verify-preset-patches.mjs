/**
 * 组合体检：`convergence` 补丁到底会落在哪个 preset 的 compaction 组里。
 *
 * ## 为什么要单独一个工具
 *
 * `applyEntryPatches` 的 `entryMap` 是"**后写覆盖**"（`entryMap.set(id, entry)`），
 * 而 `standard` / `ptc` / `cordis` 三个 preset **各自都有一套** `compaction` 组与
 * `compaction-basic` 行 —— id 完全重复。于是"按 id 打补丁"实际命中的是
 * **bundle patch 列表里最后一个 preset**。desktop 用的正好是 `cordis`（排在最后），
 * 能命中，但那是**顺序巧合**：宿主哪天调整顺序，同一份补丁会**静默**落到别的 preset 上。
 *
 * 所以补丁落盘前后都该跑一次本脚本，看清"我以为改的"和"实际改的"是不是同一个。
 *
 * ## 怎么跑的
 *
 * 用**宿主自己的** `applyEntryPatches`（`cordis-plugin-include` 导出），
 * 按 profile 的 bundle 顺序把各 bundle 的 patch 文件依次叠上去，最后叠用户的
 * profile `cordis.patch.yml`，然后直接看结果树。不是复刻实现，是真函数。
 *
 * 用法：
 *   node tools/verify-preset-patches.mjs                 # 用 desktop profile
 *   node tools/verify-preset-patches.mjs --profile web
 *   node tools/verify-preset-patches.mjs --patch 额外.yml
 *
 * @module dsh-memory-win/tools/verify-preset-patches
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DSH_MODULES = "D:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

/** DSH 主目录。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv.trim());
  return join(homedir(), ".dsh");
}

/** 取命令行开关。 */
function argOf(argv, key) {
  const index = argv.indexOf(`--${key}`);
  return index === -1 ? undefined : argv[index + 1];
}

const argv = process.argv;
const profileName = argOf(argv, "profile") ?? "desktop";
const extraPatch = argOf(argv, "patch");

const includeDir = join(DSH_MODULES, "cordis-plugin-include", "lib", "index.js");
if (!existsSync(includeDir)) {
  console.error(`找不到宿主的 cordis-plugin-include：${includeDir}`);
  console.error("（本脚本用宿主**真函数** applyEntryPatches，没有它就只能退化成读源码猜测）");
  process.exit(1);
}
const { applyEntryPatches } = await import(pathToFileURL(includeDir).href);

const profileDir = join(dshHome(), "profiles", profileName);
const profilePkgFile = join(profileDir, "package.json");
if (!existsSync(profilePkgFile)) {
  console.error(`profile 不存在：${profileDir}`);
  process.exit(1);
}
const profilePkg = JSON.parse(readFileSync(profilePkgFile, "utf8"));

/**
 * 读一个 YAML patch 文件并取它的 patch 数组。
 *
 * 宿主给 loader 注册了 `!!js` 自定义标签（`!!js "!ctx.get('profileContext')"` 这类
 * 条件表达式）。本脚本只关心**结构**，所以把该标签当成不透明标量收下，不求值。
 *
 * @param {string} file - patch 文件。
 * @returns {Promise<object[]>} patch 列表。
 */
async function loadPatches(file) {
  if (!existsSync(file)) return [];
  const { default: yaml } = await import(pathToFileURL(join(DSH_MODULES, "..", "js-yaml", "index.js")).href);
  const schema = yaml.DEFAULT_SCHEMA.extend([
    new yaml.Type("tag:yaml.org,2002:js", {
      kind: "scalar",
      construct: (data) => ({ __js: data }),
    }),
  ]);
  const raw = readFileSync(file, "utf8");
  const parsed = yaml.load(raw, { schema });
  return Array.isArray(parsed) ? parsed : [];
}

/** 从某 bundle 包里找它的 patch 列表（`dsh.bundle.patch`，可能是字符串或数组）。 */
function bundlePatches(pkgDir) {
  const pkgFile = join(pkgDir, "package.json");
  if (!existsSync(pkgFile)) return [];
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  const declared = pkg?.dsh?.bundle?.patch;
  if (declared === undefined) return [];
  const list = Array.isArray(declared) ? declared : [declared];
  return list.map((rel) => join(pkgDir, rel));
}

/**
 * 找 bundle 包所在目录。
 *
 * profile 的 `node_modules` 里通常**没有** `@deepseek-ai/dsh-*`：桌面版把这些包放在
 * app.asar 里、由应用自己的解析器加载。所以退到"同一版本的独立安装"
 * （`@deepseek-ai/dsh` 的 node_modules）读它的 patch 文件 —— **同版本、内容一致**，
 * 用来推演组合结果是可靠的；但它是**替身**，所以每条都会把来源打出来。
 *
 * @param {string} bundleName - bundle 包名。
 * @returns {string|undefined} 包目录。
 */
function bundleDir(bundleName) {
  const candidates = [
    join(profileDir, "node_modules", bundleName),
    join(dirname(DSH_MODULES), bundleName),
    join(DSH_MODULES, bundleName),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "package.json")));
}

const warnings = [];
const warn = (format, ...args) => {
  let index = 0;
  warnings.push(String(format).replace(/%C/g, () => JSON.stringify(args[index++])));
};

// 按 profile 的 bundles 顺序叠 patch，最后叠用户的 cordis.patch.yml。
const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
let data = [];
const applied = [];
for (const bundleName of bundles) {
  const pkgDir = bundleDir(bundleName);
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
data = applyEntryPatches(data, userPatches, warn);
if (extraPatch !== undefined) {
  const patches = await loadPatches(resolve(extraPatch));
  data = applyEntryPatches(data, patches, warn);
}

console.log(`profile      ${profileName}  (${profileDir})`);
console.log(`叠入 patch   ${applied.length} 个文件 + profile cordis.patch.yml(${userPatches.length} 条)`);
if (extraPatch !== undefined) console.log(`额外 patch   ${resolve(extraPatch)}`);
console.log("");

// ── 逐个 preset 看它的 compaction 组 ────────────────────────────────────────
const presetRows = data.filter((entry) => typeof entry?.id === "string" && entry.id.startsWith("preset-"));
if (presetRows.length === 0) {
  console.log("没有找到任何 preset 行（这个 profile 可能没有 preset 平面）。");
}

for (const preset of presetRows) {
  const plugins = preset?.config?.plugins;
  if (!Array.isArray(plugins)) continue;
  const group = plugins.find((entry) => entry?.id === "compaction");
  if (group === undefined) {
    console.log(`${preset.id.padEnd(16)} 无 compaction 组`);
    continue;
  }
  const inner = Array.isArray(group.config) ? group.config : [];
  const names = inner.map((entry) => entry?.id ?? "?").join(", ");
  console.log(`${preset.id.padEnd(16)} compaction 组 [${names}]`);
  for (const entry of inner) {
    if (entry?.id === "dsh-memory-win-converge" || entry?.id === "dsh-memory-win") {
      console.log(`   ↑ 收敛半边在这里：config=${JSON.stringify(entry.config ?? {})}`);
    }
    if (entry?.id === "compaction-basic") {
      console.log(`   ↑ 压缩阈值：config=${JSON.stringify(entry.config ?? {})}`);
    }
  }
}

console.log("");
if (warnings.length > 0) {
  console.log(`patch 警告 ${warnings.length} 条（宿主会静默跳过，所以这里显式列出）：`);
  for (const line of warnings) console.log(`  · ${line}`);
} else {
  console.log("patch 警告：无");
}

// ── 可达性：preset 内部的行**打不中** ───────────────────────────────────────
//
// `applyEntryPatches` 的 `buildMap` 只递归进 `entry.group && Array.isArray(entry.config)`
// （即 `cordis:group` 那种"组"），**不会**进 preset 行的 `config.plugins` 列表。
// 所以凡是在 preset 内部出现的 id（`compaction`、`compaction-basic`、`persona`…），
// 按 id 打补丁都会"not found"⇒ 被静默跳过。
const reachable = new Set();
const collectReachable = (entries) => {
  for (const entry of entries) {
    if (entry?.id) reachable.add(entry.id);
    if (entry?.group && Array.isArray(entry.config)) collectReachable(entry.config);
  }
};
collectReachable(data);

const presetInternal = new Map();
const collectPresetInternal = (entries) => {
  for (const entry of entries) {
    if (entry?.id) presetInternal.set(entry.id, (presetInternal.get(entry.id) ?? 0) + 1);
    if (Array.isArray(entry?.config)) collectPresetInternal(entry.config);
    if (Array.isArray(entry?.config?.plugins)) collectPresetInternal(entry.config.plugins);
  }
};
for (const preset of presetRows) collectPresetInternal(Array.isArray(preset?.config?.plugins) ? preset.config.plugins : []);

const collisions = userPatches
  .filter((patch) => typeof patch?.id === "string" && !patch.insert)
  .filter((patch) => presetInternal.has(patch.id));

if (collisions.length > 0) {
  console.log("");
  console.log("⚠️ 这些补丁的 id 在 preset 内部**也有同名行**，而宿主只认能走到的那一条：");
  for (const patch of collisions) {
    const inside = presetInternal.get(patch.id);
    const where = reachable.has(patch.id)
      ? `命中**根上**那条（外壳行在，但根上的压缩后端是被 dsh-web-app 停用的）`
      : `**一条都打不中**（目标只存在于 preset 的 config.plugins 里）`;
    console.log(`  · ${patch.id} —— preset 内另有 ${inside} 处；本补丁${where}`);
  }
  console.log("   ⇒ 想改 preset 内部那一份，只能**整段覆盖对应的 preset-* 行**（或走 Web 端 preset 编辑器）。");
}
