/**
 * 组合体检（只读）：补丁到底会落在哪 —— 用**宿主真函数** `applyEntryPatches` 复演。
 *
 * ## 为什么需要它
 *
 * 两条坑都只能靠复演看清：
 *
 * 1. **preset 内部的行打不中 id 补丁**：`buildMap` 只递归"组"
 *    （`entry.group && Array.isArray(entry.config)`），preset 行的子项在 `config.plugins`
 *    下，不在递归范围里 ⇒ 按 id 打补丁只会 `not found` 并被**静默跳过**。
 * 2. **id 在多个 preset 里重名**：`compaction` / `compaction-basic` / `persona` 每个 preset
 *    各有一套，`entryMap` 又是"后写覆盖"，于是"我以为改的"和"实际改的"经常不是同一个。
 *
 * ## 源解析（0.4.7 起）
 *
 * 叠层用的 bundle patch 一律**优先取 app.asar**（宿主真正加载的那份），其次是 profile 的
 * `node_modules`，最后才是本地独立安装 —— 并逐文件比对影子源、不一致就告警。
 * 0.4.5/0.4.6 的事故就出在"本地副本过期"上（宿主已删掉的 `{{cwd}}` 被写回，整轮失败）。
 *
 * 用法：
 *   node tools/verify-preset-patches.mjs                    # desktop profile，叠上用户 patch
 *   node tools/verify-preset-patches.mjs --profile web
 *   node tools/verify-preset-patches.mjs --patch 额外.yml    # 预演一份还没落盘的覆盖
 *
 * @module dsh-memory-win/tools/verify-preset-patches
 */

import { resolve } from "node:path";

import { composeLayers, presetRowsOf } from "./lib/compose.mjs";

/** 取命令行开关。 */
function argOf(argv, key) {
  const index = argv.indexOf(`--${key}`);
  return index === -1 ? undefined : argv[index + 1];
}

const argv = process.argv;
const profileName = argOf(argv, "profile") ?? "desktop";
const extraPatch = argOf(argv, "patch");

const { data, warnings, sources, profileDir, userPatches } = await composeLayers({
  profileName,
  withUserPatch: true,
  extraPatches: extraPatch === undefined ? [] : [resolve(extraPatch)],
});

console.log(`profile      ${profileName}  (${profileDir})`);
console.log(
  `用户 patch   cordis.patch.yml（${userPatches.length} 条）` +
    (extraPatch === undefined ? "" : ` + ${resolve(extraPatch)}（预演）`),
);
console.log("");
console.log("bundle → 源：");
for (const row of sources) console.log(`  ${row.bundle.padEnd(36)} ${row.label}`);
console.log("");

const presetRows = presetRowsOf(data);
if (presetRows.length === 0) console.log("没有找到任何 preset 行（这个 profile 可能没有 preset 平面）。");

for (const preset of presetRows) {
  const plugins = preset?.config?.plugins;
  if (!Array.isArray(plugins)) continue;
  const group = plugins.find((entry) => entry?.id === "compaction");
  if (group === undefined) {
    console.log(`${preset.id.padEnd(16)} 无 compaction 组`);
    continue;
  }
  const inner = Array.isArray(group.config) ? group.config : [];
  console.log(`${preset.id.padEnd(16)} compaction 组 [${inner.map((entry) => entry?.id ?? "?").join(", ")}]`);
  for (const entry of inner) {
    if (entry?.id === "compaction-basic") {
      const config = entry.config ?? {};
      console.log(
        `   ↑ 压缩阈值：${Object.keys(config).length === 0 ? "config={}（宿主默认）" : JSON.stringify(config)}`,
      );
    }
    if (entry?.id === "dsh-memory-win-converge") {
      console.log(`   ↑ 收敛半边：${JSON.stringify(entry.config ?? {})}`);
    }
  }
}

// ── 可达性：preset 内部的行**打不中** ───────────────────────────────────────
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
for (const preset of presetRows) {
  collectPresetInternal(Array.isArray(preset?.config?.plugins) ? preset.config.plugins : []);
}

const collisions = userPatches
  .filter((patch) => typeof patch?.id === "string" && !patch.insert)
  .filter((patch) => presetInternal.has(patch.id));

console.log("");
if (collisions.length > 0) {
  console.log("⚠️ 这些补丁的 id 在 preset 内部**也有同名行**，而宿主只认能走到的那一条：");
  for (const patch of collisions) {
    const inside = presetInternal.get(patch.id);
    const where = reachable.has(patch.id)
      ? "命中**根上**那条（preset 内部那些够不着）"
      : "**一条都打不中**（目标只存在于 preset 的 config.plugins 里）";
    console.log(`  · ${patch.id} —— preset 内另有 ${inside} 处；本补丁${where}`);
  }
  console.log("   ⇒ 想改 preset 内部那一份，只能**整段覆盖对应的 preset-* 行**（或用 Web 端 preset 编辑器）。");
}

console.log("");
if (warnings.length > 0) {
  console.log(`patch / 源一致性告警 ${warnings.length} 条：`);
  for (const line of warnings) console.log(`  · ${line}`);
} else {
  console.log("告警：无");
}
