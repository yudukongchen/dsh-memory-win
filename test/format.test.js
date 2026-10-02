/**
 * 纯函数层测试：条目格式、日期校验、凭据扫描、去重、提示词中和。
 *
 * 这些是本插件的"判定内核"，全部无 I/O，因此可以穷举边界。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findSameFactOtherDate,
  isTailDuplicate,
  latestDate,
  neutralizePromptVars,
  parseEntries,
  parseHeader,
  renderEntry,
  scanSecrets,
  today,
  validateFactBody,
  validEntryDate,
} from "../lib/format.js";

test("validEntryDate 接受今天与过去，拒绝未来", () => {
  assert.equal(validEntryDate(today()), true);
  assert.equal(validEntryDate("2020-01-01"), true);
  assert.equal(validEntryDate("2999-01-01"), false, "未来日期必须被拒");
});

test("validEntryDate 拒绝 Date 会进位的伪日期", () => {
  // new Date("2026-13-45") 不返回 Invalid Date，而是进位到 2027-02-14。
  // 只判 NaN 的实现会把这类明显错误放行 —— 这里必须靠 UTC 回读拦住。
  assert.equal(validEntryDate("2026-13-45"), false);
  assert.equal(validEntryDate("2026-02-30"), false);
  assert.equal(validEntryDate("2026-00-10"), false);
  assert.equal(validEntryDate("2026-1-1"), false, "必须是零填充的 YYYY-MM-DD");
  assert.equal(validEntryDate(""), false);
  assert.equal(validEntryDate(undefined), false);
});

test("validEntryDate 认闰年", () => {
  assert.equal(validEntryDate("2024-02-29"), true, "2024 是闰年");
  assert.equal(validEntryDate("2026-02-29"), false, "2026 不是闰年");
});

test("scanSecrets 命中各类凭据，且只报模式名不回显值", () => {
  const key = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const hits = scanSecrets(`配置见 ${key}`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
  // 最关键的一条断言：返回值里绝不能出现密钥本身，
  // 否则拒绝原因会把凭据复制进模型上下文与日志。
  assert.equal(JSON.stringify(hits).includes(key), false, "不得回显匹配到的凭据");
});

test("scanSecrets 覆盖私钥块与凭据赋值", () => {
  assert.equal(scanSecrets("-----BEGIN RSA PRIVATE KEY-----").length, 1);
  assert.equal(scanSecrets("api_key = 'abcdefghijklmnop'").length, 1);
  assert.equal(scanSecrets("这是一条正常的记忆，没有任何凭据").length, 0);
});

test("scanSecrets 给出正确的行号", () => {
  const text = ["第一行正常", "第二行正常", "token: abcdefghijklmnopqrst"].join("\n");
  const hits = scanSecrets(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});

test("neutralizePromptVars 拆开 {{ ，避免宿主插值抛错", () => {
  // 宿主规则是严格的 /^\{\{([^{}]*)\}\}/ + 变量名白名单，未知变量直接抛。
  // 记忆正文里出现 {{foo}} 能把整段提示词装配搞崩。
  const out = neutralizePromptVars("正文里有 {{foo}} 这样的东西");
  assert.equal(out.includes("{{"), false, "输出里不能再有 {{");
  assert.equal(out, "正文里有 { {foo}} 这样的东西");
});

test("parseHeader 解析片名与关键词", () => {
  assert.deepEqual(parseHeader("<!-- 构建 · Windows msys 路径 -->"), {
    title: "构建",
    keywords: "Windows msys 路径",
  });
  assert.deepEqual(parseHeader("<!-- 只有片名 -->"), { title: "只有片名", keywords: "" });
  assert.deepEqual(parseHeader("这不是注释头"), { title: "", keywords: "" });
});

test("parseEntries 返回带行号的条目", () => {
  const text = ["<!-- 片名 · 关键词 -->", "", "## 分节", "- [2026-01-01] 第一条", "- [2026-01-02] 第二条"].join(
    "\n",
  );
  const entries = parseEntries(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].line, 4, "行号必须指向文件真实行，供 read offset 使用");
  assert.equal(entries[0].date, "2026-01-01");
  assert.equal(entries[0].section, "分节");
  assert.equal(entries[1].text, "第二条");
});

test("parseEntries 跳过代码围栏里的示例条目", () => {
  const text = ["```", "- [2026-01-01] 这是示例不是记忆", "```", "- [2026-01-02] 这才是真的"].join("\n");
  const entries = parseEntries(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "这才是真的");
});

test("latestDate 取字典序最大值，空列表返回空串", () => {
  assert.equal(latestDate([]), "");
  assert.equal(latestDate([{ date: "2026-01-01" }, { date: "2026-03-09" }, { date: "2025-12-31" }]), "2026-03-09");
});

test("isTailDuplicate 只判完全重复（日期+正文），不同日期不算重复", () => {
  const existing = ["- [2026-01-01] 甲", "- [2026-01-02] 乙"].join("\n");
  assert.equal(isTailDuplicate(existing, "- [2026-01-01] 甲"), true, "日期与正文都相同 → 重复");
  assert.equal(isTailDuplicate(existing, "- [2026-01-03] 甲"), false, "同一事实的另一天是新的确认，不应静默丢弃");
  assert.equal(isTailDuplicate(existing, "- [2026-01-03] 丙"), false);
  assert.equal(isTailDuplicate("", "- [2026-01-03] 丙"), false);
});

test("findSameFactOtherDate 报出正文相同但日期不同的既有日期", () => {
  const existing = ["- [2026-01-01] 甲", "- [2026-01-02] 乙"].join("\n");
  assert.equal(findSameFactOtherDate(existing, "2026-03-03", "甲"), "2026-01-01");
  assert.equal(findSameFactOtherDate(existing, "2026-01-01", "甲"), undefined, "日期相同不算 other");
  assert.equal(findSameFactOtherDate(existing, "2026-03-03", "丙"), undefined);
  assert.equal(findSameFactOtherDate("", "2026-03-03", "甲"), undefined);
});

test("validateFactBody 拒绝空、多行、自带前缀与超长", () => {
  assert.equal(validateFactBody("正常的一条"), undefined);
  assert.notEqual(validateFactBody(""), undefined);
  assert.notEqual(validateFactBody("第一行\n第二行"), undefined, "多行会破坏行结构");
  assert.notEqual(validateFactBody("- [2026-01-01] 自带前缀"), undefined);
  assert.notEqual(validateFactBody("x".repeat(2001)), undefined);
  assert.equal(validateFactBody("x".repeat(2000)), undefined, "边界值应放行");
});

test("renderEntry 产出规范条目", () => {
  assert.equal(renderEntry("2026-10-05", "  事实  "), "- [2026-10-05] 事实");
});
