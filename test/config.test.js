/**
 * 配置层测试：默认值、解析顺序（默认 < config 段）、类型/范围/交叉约束校验、
 * 凭据模式表的替换与编译。
 *
 * 这一层的价值全在"边界"上：配错了要么**拒绝启动**（可见），要么**静默按错的数跑**
 * （这正是本项目反复踩的形态）。所以这里几乎每个用例都是"非法输入必须抛"。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  CONFIG_DEFAULTS,
  compilePattern,
  configNum,
  configSnapshot,
  configValue,
  credentialPatternList,
  initConfig,
  normalizeConfig,
} from "../lib/config.js";
import { SECRET_PATTERNS, inlineTruncationWarning, validateFactBody, validateKeywords } from "../lib/format.js";

afterEach(() => {
  // 每个用例都把配置恢复成默认，避免用例之间互相影响（配置是模块级状态）。
  initConfig(undefined);
});

test("默认配置：空配置与 undefined 等价，且每项都有值", () => {
  const fromUndefined = normalizeConfig(undefined);
  const fromEmpty = normalizeConfig({});
  assert.deepEqual(fromEmpty, fromUndefined);
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    assert.notEqual(fromUndefined[key], undefined, `${key} 必须有默认值`);
  }
});

test("解析顺序：写了 config 段的键覆盖默认，未写的键保留默认", () => {
  initConfig({ inlineTextMax: 200 });
  assert.equal(configNum("inlineTextMax"), 200, "写了的键按 config");
  assert.equal(configNum("factBodyMax"), CONFIG_DEFAULTS.factBodyMax, "未写的键保留默认");
});

test("未知键被保留（前向兼容），但不参与校验", () => {
  const out = normalizeConfig({ somethingNew: 42 });
  assert.equal(out.somethingNew, 42);
  assert.equal(out.inlineTextMax, CONFIG_DEFAULTS.inlineTextMax);
});

test("类型与范围非法一律抛，且消息里带键名与收到的值", () => {
  assert.throws(() => normalizeConfig({ inlineTextMax: "160" }), /inlineTextMax 必须是整数/);
  assert.throws(() => normalizeConfig({ inlineTextMax: 1.5 }), /必须是整数/);
  assert.throws(() => normalizeConfig({ cleanupDays: 0 }), /超出允许范围 \[1, 10000\]/, "cleanupDays 最小为 1");
  assert.throws(() => normalizeConfig({ cleanupDelaySeconds: -1 }), /超出允许范围 \[0, 86400\]/);
  assert.throws(() => normalizeConfig({ cleanupEnabled: "yes" }), /必须是 true\/false/);
  assert.throws(() => normalizeConfig({ projectDir: "" }), /必须是非空字符串/);
  assert.throws(() => normalizeConfig({ archiveDir: "a\nb" }), /不能包含换行/);
  assert.throws(() => normalizeConfig([]), /config 必须是一个对象/);
  assert.throws(() => normalizeConfig("x"), /config 必须是一个对象/);
});

test("logEnabled（0.2.5 效果日志开关）：默认 false，非 boolean 一律拒", () => {
  assert.equal(CONFIG_DEFAULTS.logEnabled, false, "体检功能不该默认写盘");
  assert.equal(normalizeConfig({}).logEnabled, false);
  assert.equal(normalizeConfig({ logEnabled: true }).logEnabled, true);
  assert.throws(() => normalizeConfig({ logEnabled: "yes" }), /logEnabled 必须是 true\/false/);
  assert.throws(() => normalizeConfig({ logEnabled: 1 }), /logEnabled 必须是 true\/false/);
  // 与 cleanupEnabled 走同一张 boolean 校验表（改一处两边同步变）
  assert.throws(() => normalizeConfig({ cleanupEnabled: 1 }), /cleanupEnabled 必须是 true\/false/);
});

test("交叉约束：inlineTextMax 不能大于 factBodyMax（否则提醒永远不可能触发）", () => {
  assert.throws(
    () => normalizeConfig({ inlineTextMax: 3000, factBodyMax: 2000 }),
    /inlineTextMax \(3000\) 不能大于 factBodyMax \(2000\)/,
  );
  // 相等是允许的：此时"超限"只剩一个边界，但仍然成立
  assert.equal(normalizeConfig({ inlineTextMax: 500, factBodyMax: 500 }).inlineTextMax, 500);
});

test("globalSubpath 拒绝分隔符、.. 与 Windows 保留字符", () => {
  assert.throws(() => normalizeConfig({ globalSubpath: [] }), /必须是非空字符串数组/);
  assert.throws(() => normalizeConfig({ globalSubpath: ["a/b"] }), /不能含分隔符/);
  assert.throws(() => normalizeConfig({ globalSubpath: [".."] }), /不能含分隔符/);
  assert.throws(() => normalizeConfig({ globalSubpath: ["a:b"] }), /不能含分隔符/);
  assert.equal(normalizeConfig({ globalSubpath: ["memory-win", "global"] }).globalSubpath.length, 2);
});

test("配置值真的被行为层读到（不是只存起来）", () => {
  initConfig({ inlineTextMax: 10, factBodyMax: 20, keywordsMaxChars: 5 });
  assert.equal(inlineTruncationWarning("0123456789"), undefined, "正好 10 字符不提醒");
  assert.match(inlineTruncationWarning("01234567890") ?? "", /超过内联档的显示上限 10/);
  assert.equal(validateFactBody("01234567890123456789"), undefined, "正好 20 字符合法");
  assert.match(validateFactBody("012345678901234567890") ?? "", /超过 20 字符/, "21 字符被拒");
  assert.match(validateKeywords("012345") ?? "", /超过 5 字符/);
});

test("configValue 对未知键抛错（拼错键名要立刻可见）", () => {
  assert.throws(() => configValue("inlineTextMaximum"), /未知配置键/);
});

test("快照是浅拷贝，改它不影响生效配置", () => {
  const snap = configSnapshot();
  snap.inlineTextMax = 9999;
  assert.equal(configNum("inlineTextMax"), CONFIG_DEFAULTS.inlineTextMax);
});

test("credentialPatterns = null 时用内置 8 类（同一个数组，不复制）", () => {
  initConfig(undefined);
  assert.equal(credentialPatternList(), SECRET_PATTERNS);
});

test("credentialPatterns 写表时整段替换内置表，并编译成正则", () => {
  initConfig({ credentialPatterns: { "自定义 token": "TOK-[0-9]{4}" } });
  const list = credentialPatternList();
  assert.equal(list.length, 1);
  assert.equal(list[0][0], "自定义 token");
  assert.equal(list[0][1].test("TOK-1234"), true);
  assert.equal(list[0][1].test("sk-abcdefghijklmnop"), false, "内置表已被替换，不再命中 sk-");
});

test("非法正则、空对象、非字符串值都被拒", () => {
  assert.throws(() => normalizeConfig({ credentialPatterns: { bad: "([a-z" } }), /不是合法正则/);
  assert.throws(() => normalizeConfig({ credentialPatterns: {} }), /不能是空对象/);
  assert.throws(() => normalizeConfig({ credentialPatterns: { a: 1 } }), /必须是非空正则字符串/);
  assert.throws(() => normalizeConfig({ credentialPatterns: [] }), /必须是 \{ 模式名: 正则字符串 \}/);
});

test("compilePattern 剥掉有状态的 g/y 标志（否则 test() 会忽真忽假）", () => {
  const re = compilePattern("/abc/g");
  assert.equal(re.flags.includes("g"), false);
  assert.equal(re.test("abc"), true);
  assert.equal(re.test("abc"), true, "第二次仍应为 true（无 lastIndex 残留）");

  const bare = compilePattern("x+");
  assert.equal(bare.test("xx"), true);
  const withFlags = compilePattern("/x+/i");
  assert.equal(withFlags.flags.includes("i"), true);
});

test("每次 initConfig 都会重算凭据模式表（两个来源任意先后）", () => {
  initConfig({ credentialPatterns: { a: "AAA" } });
  assert.equal(credentialPatternList()[0][0], "a");
  initConfig({ credentialPatterns: null });
  assert.equal(credentialPatternList(), SECRET_PATTERNS);
  initConfig({ credentialPatterns: { b: "BBB" } });
  assert.equal(credentialPatternList()[0][0], "b");
});
