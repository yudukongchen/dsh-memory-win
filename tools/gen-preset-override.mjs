/**
 * 生成 `preset-*` 行的**整段覆盖** patch（B 路线）。
 *
 * ## 为什么必须整段覆盖
 *
 * `applyEntryPatches` 只递归"组"（`entry.group && Array.isArray(entry.config)`），
 * preset 行的子项在 `config.plugins` 下 ⇒ 按 id 打补丁**打不中** preset 内部的行
 * （`tools/verify-preset-patches.mjs` 能复现这一点）。所以要在 preset 的 compaction 组里
 * 加一行 `convergeOnly` 实例、或改它的 `compaction-basic` 阈值，只能把整行 `config`
 * 重写一遍。手抄几百行不可接受，因此本脚本从**组合树**里机械生成：
 *
 *   组合树（宿主 + bundle 层）里那份 preset-* 行 → 深拷贝 → 只改两处 → 输出 YAML
 *
 * 生成后会做两道自检：
 *   1. **往返一致性**：dump 出来的 YAML 重新 load 回来，必须与内存对象深等价
 *      （含 `!!js` 表达式 —— 用 `JsExpr` 按源码比较）；
 *   2. **落点自检**：把生成物叠回组合树，打印每个 preset 的 compaction 组，确认只有目标
 *      preset 变了、别的 preset 没被波及。
 *
 * 用法：
 *   node tools/gen-preset-override.mjs                        # 默认 preset-cordis，写到 .scratch/
 *   node tools/gen-preset-override.mjs --preset preset-ptc
 *   node tools/gen-preset-override.mjs --threshold 0.7 --retain 6000 --max 6000
 *   node tools/gen-preset-override.mjs --no-converge          # 只改阈值，不挂收敛半边
 *
 * @module dsh-memory-win/tools/gen-preset-override
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  JsExpr,
  composeLayers,
  deepEqualWithJs,
  findPresetInsert,
  loadPatches,
  presetRowsOf,
  yamlToolkit,
} from "./lib/compose.mjs";

/** 取命令行开关。 */
function argOf(argv, key) {
  const index = argv.indexOf(`--${key}`);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * 把 `JsExpr` 换成普通 `{src}` 形状，用于"与 structuredClone 之后的对象比较"。
 *
 * ⚠️ 宿主自己的 `applyEntryPatches` 开头就 `structuredClone(data)`，**会剥掉类原型** ——
 * 组合树里的 `!!js` 表达式已经退化成 `{src: "..."}` 普通对象。所以生成基线**不能**取自
 * 组合树（否则会写出 `disabled: {src: …}` 这种坏 YAML），必须回到源 patch 文件取。
 *
 * @param {*} value - 任意值。
 * @returns {*} 归一化后的值。
 */
function normalizeJs(value) {
  if (value instanceof JsExpr) return { src: value.src };
  if (Array.isArray(value)) return value.map(normalizeJs);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = normalizeJs(value[key]);
    return out;
  }
  return value;
}

const argv = process.argv;
const presetId = argOf(argv, "preset") ?? "preset-cordis";
const thresholdRatio = Number(argOf(argv, "threshold") ?? 0.75);
const retainTokens = Number(argOf(argv, "retain") ?? 8000);
const maxTokens = Number(argOf(argv, "max") ?? 8000);
const withConverge = !argv.includes("--no-converge");
const outFile = resolve(argOf(argv, "out") ?? join(".scratch", `${presetId}-override.yml`));

// ── 组合树（**不含**用户 patch：否则会把自己上次的补丁当基线，越生成越大）──────────
const { data, profileDir, warnings: composeWarnings, sources } = await composeLayers({ withUserPatch: false });
const presets = presetRowsOf(data);
const composed = presets.find((entry) => entry.id === presetId);
if (composed === undefined) {
  console.error(`组合树里没有 ${presetId}；现有：${presets.map((entry) => entry.id).join(", ") || "（无）"}`);
  process.exit(1);
}
console.log("基线来源（bundle → 源）：");
for (const row of sources) console.log(`  ${row.bundle.padEnd(28)} ${row.label}`);
if (composeWarnings.length > 0) {
  console.log("⚠️ 源一致性告警：");
  for (const line of composeWarnings) console.log(`  · ${line}`);
}

// ── 基线：回到**源 patch 文件**取（保住 !!js）────────────────────────────────
const source = await findPresetInsert({ presetId });
if (source === undefined) {
  console.error(`在 bundle 的 patch 文件里找不到 ${presetId} 的插入行，无法取得保真基线（不猜）`);
  process.exit(1);
}
console.log(`保真基线  ${source.sourceLabel} → ${source.rel}`);
// 组合树可能被后续层改过：逐字（归一化后）比对，确认"源 == 组合"才敢用源做基线。
if (!deepEqualWithJs(normalizeJs(source.entry.config), normalizeJs(composed.config))) {
  console.error(`${presetId} 在组合树里与源 patch 不一致（有后续层改过它）—— 请人工确认后再生成，本脚本不猜`);
  process.exit(1);
}

const { yaml, schema } = await yamlToolkit();
// 深拷贝走 YAML 往返（保住 JsExpr 的类身份；structuredClone 会剥原型）。
const clone = yaml.load(yaml.dump(source.entry.config, { schema, lineWidth: -1, noRefs: true }), { schema });

// ── 只改两处 ────────────────────────────────────────────────────────────────
const cloneGroup = clone.plugins.find((entry) => entry?.id === "compaction");
const basic = cloneGroup.config.find((entry) => entry?.id === "compaction-basic");
if (basic === undefined) {
  console.error("compaction 组里没有 compaction-basic 行");
  process.exit(1);
}
basic.config = { thresholdRatio, retainTokens, maxTokens };

const convergeId = "dsh-memory-win-converge";
cloneGroup.config = cloneGroup.config.filter((entry) => entry?.id !== convergeId);
if (withConverge) {
  cloneGroup.config.push({
    id: convergeId,
    name: "dsh-memory-win",
    config: { convergeOnly: true },
  });
}

const patchRow = { id: source.entry.id, name: source.entry.name, config: clone };
const text = `# 由 tools/gen-preset-override.mjs 生成 —— ${presetId} 整段覆盖（B 路线）
#
# 为什么整段覆盖：applyEntryPatches 的 buildMap 只递归"组"（entry.group && 数组 config），
# preset 行的子项在 config.plugins 下 ⇒ 按 id 打补丁打不中 preset 内部的行。
# 所以这里把宿主那份 preset 定义整段抄下来，只改两处：
#   1. compaction 组里的 compaction-basic：阈值 ${thresholdRatio} / 保留 ${retainTokens} / 摘要上限 ${maxTokens}
${withConverge ? `#   2. compaction 组里追加 ${convergeId}（convergeOnly: true）—— 收敛专用形态，只挂 agent/pre-step\n` : "#   2. 未追加收敛半边（--no-converge）\n"}#\n# 基线来源：${join(profileDir, "node_modules")} 下各 bundle 的 patch（桌面版在 app.asar 里时为同版本替身）
${yaml.dump([patchRow], { schema, lineWidth: -1, noRefs: true })}`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, text, "utf8");

// ── 自检 1：往返一致 ────────────────────────────────────────────────────────
const reparsed = yaml.load(text, { schema });
const roundTripOk = deepEqualWithJs(reparsed?.[0]?.config, clone);
if (!roundTripOk) {
  console.error("❌ 往返不一致：dump 后再 load 回来的 config 与内存对象不等价（`!!js` 或空白/折叠出问题）");
  process.exit(1);
}

// ── 自检 2：落点 ────────────────────────────────────────────────────────────
const after = await composeLayers({ withUserPatch: false, extraPatches: [outFile] });
const afterPresets = presetRowsOf(after.data);

console.log(`profile      ${profileDir}`);
console.log(`目标 preset  ${presetId}（${Array.isArray(source.entry.config.plugins) ? source.entry.config.plugins.length : 0} 个子项，整段覆盖 ${text.split("\n").length} 行）`);
console.log(`输出         ${outFile}`);
console.log(`往返一致     ${roundTripOk ? "✅" : "❌"}（含 !!js 表达式）`);
console.log("");
console.log("【叠加后各 preset 的 compaction 组】");
for (const row of afterPresets) {
  const inner = row?.config?.plugins?.find((entry) => entry?.id === "compaction");
  if (inner === undefined) {
    console.log(`  ${row.id.padEnd(16)} 无 compaction 组`);
    continue;
  }
  const list = Array.isArray(inner.config) ? inner.config : [];
  const flags = list.map((entry) => entry?.id ?? "?");
  const converge = list.find((entry) => entry?.id === convergeId);
  const basicRow = list.find((entry) => entry?.id === "compaction-basic");
  const changed =
    converge !== undefined || (basicRow?.config !== undefined && Object.keys(basicRow.config).length > 0);
  console.log(`  ${row.id.padEnd(16)} [${flags.join(", ")}]${changed ? "   ← 已改" : ""}`);
  if (converge !== undefined) console.log(`      ${convergeId}: ${JSON.stringify(converge.config)}`);
  if (changed && basicRow?.config !== undefined) console.log(`      compaction-basic: ${JSON.stringify(basicRow.config)}`);
}

const touchedOthers = afterPresets.filter((row) => {
  if (row.id === presetId) return false;
  const inner = row?.config?.plugins?.find((entry) => entry?.id === "compaction");
  const list = Array.isArray(inner?.config) ? inner.config : [];
  const converge = list.find((entry) => entry?.id === convergeId);
  const basicRow = list.find((entry) => entry?.id === "compaction-basic");
  return converge !== undefined || (basicRow?.config !== undefined && Object.keys(basicRow.config).length > 0);
});
if (touchedOthers.length > 0) {
  console.error(`\n❌ 误伤：${touchedOthers.map((row) => row.id).join(", ")} 也被改了 —— 不要落盘`);
  process.exit(1);
}

console.log("");
if (after.warnings.length > 0) {
  console.log(`patch 警告 ${after.warnings.length} 条：`);
  for (const line of after.warnings) console.log(`  · ${line}`);
}
console.log("只动了目标 preset ✅（其它 preset 的 compaction 组未变）");

// 与用户现有 patch 的冲突提示：根上那条 compaction-basic 对 preset 无效，留着只会误导。
const userPatches = await loadPatches(join(profileDir, "cordis.patch.yml"));
const inert = userPatches.filter((patch) => patch?.id === "compaction-basic" && !patch.insert);
if (inert.length > 0) {
  console.log("");
  console.log(`ℹ️  profile 的 cordis.patch.yml 里还有 ${inert.length} 条根上的 compaction-basic 补丁 ——`);
  console.log("   它命中的是**被 dsh-web-app 停用的根行**，对本 preset 无效；落盘本覆盖时建议一并删掉。");
}
