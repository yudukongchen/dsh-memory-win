/**
 * 纯函数层测试：条目格式、日期校验、凭据扫描、去重、提示词中和。
 *
 * 这些是本插件的"判定内核"，全部无 I/O，因此可以穷举边界。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  entryId,
  findSameFactOtherDate,
  isBeforeToday,
  isTailDuplicate,
  latestDate,
  markSuperseded,
  neutralizePromptVars,
  parseEntries,
  parseHeader,
  renderEntry,
  scanSecrets,
  splitFixMeta,
  today,
  uniqueIdIn,
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

// ══════════════════════════════════════════════════════════════════════════════
// 取代机制：条目 id、fix 元数据、注释标记
// ══════════════════════════════════════════════════════════════════════════════

test("entryId 由内容决定：稳定、区分日期与正文", () => {
  const a = entryId("2026-01-01", "同一条事实");
  assert.equal(entryId("2026-01-01", "同一条事实"), a, "相同输入必须得到相同 id");
  assert.notEqual(entryId("2026-01-02", "同一条事实"), a, "日期不同 → id 不同");
  assert.notEqual(entryId("2026-01-01", "另一条事实"), a, "正文不同 → id 不同");
  assert.match(a, /^[0-9a-f]{4}$/, "id 应为 4 位十六进制");
  // id 不应依赖行号或文件名，否则插入行就会让已发出的 id 失效
  assert.equal(entryId("2026-01-01", "  同一条事实  "), a, "首尾空白不影响");
});

test("uniqueIdIn 在同文件冲突时加后缀，保证可定位", () => {
  const taken = new Set(["abcd"]);
  assert.equal(uniqueIdIn("abcd", taken), "abcd-2");
  taken.add("abcd-2");
  assert.equal(uniqueIdIn("abcd", taken), "abcd-3");
  assert.equal(uniqueIdIn("beef", taken), "beef", "不冲突时原样返回");
});

test("splitFixMeta 拆出 fix 元数据，且只认行尾", () => {
  assert.deepEqual(splitFixMeta("新结论 [fix:defect of #a3f1]"), {
    text: "新结论",
    fix: { reason: "defect", of: "a3f1" },
  });
  // 四类 reason 都要认
  for (const reason of ["defect", "overturned", "correction", "retract"]) {
    const r = splitFixMeta(`结论 [fix:${reason} of #abcd]`);
    assert.equal(r.fix.reason, reason);
  }
  // 不在行尾 / 非法 reason / 非法 id → 视为普通正文，避免误伤
  assert.equal(splitFixMeta("新结论 [fix:defect of #a3f1] 后面还有话").fix, undefined);
  assert.equal(splitFixMeta("结论 [fix:瞎写 of #a3f1]").fix, undefined);
  assert.equal(splitFixMeta("结论 [fix:defect of #zzzz]").fix, undefined);
  assert.equal(splitFixMeta("普通正文").fix, undefined);
});

test("markSuperseded 产出整行注释（含边界空格）", () => {
  assert.equal(markSuperseded("- [2026-01-01] 旧结论"), "<!-- - [2026-01-01] 旧结论 -->");
  assert.equal(markSuperseded("  - [2026-01-01] 旧结论  "), "<!-- - [2026-01-01] 旧结论 -->");
});

test("parseEntries 跳过被取代的条目，并给存活条目附 id", () => {
  const text = [
    "<!-- 片名 · 关键词 -->",
    "",
    "<!-- - [2026-01-01] 已失效的旧结论 -->",
    "- [2026-01-02] 有效结论",
    "- [2026-01-03] 修正后的结论 [fix:defect of #abcd]",
  ].join("\n");
  const entries = parseEntries(text);

  assert.equal(entries.length, 2, "被注释的旧条目必须被跳过");
  assert.equal(entries[0].text, "有效结论");
  assert.equal(entries[0].line, 4, "行号仍指向文件真实行");
  assert.match(entries[0].id, /^[0-9a-f]{4}$/);
  // 修正条目的元数据被拆出，正文保持干净
  assert.equal(entries[1].text, "修正后的结论");
  assert.deepEqual(entries[1].fix, { reason: "defect", of: "abcd" });
});

test("parseEntries 不把分片首行的关键词头当成被取代条目", () => {
  // SUPERSEDED_RE 只认 `<!-- - [`，所以关键词头必须照常被解析为头部而非跳过整行
  const entries = parseEntries("<!-- 片名 · 关键词 -->\n\n- [2026-01-01] 一条");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "一条");
});

test("validateFactBody 拒绝会破坏取代标记的序列", () => {
  assert.notEqual(validateFactBody("含 --> 的正文"), undefined, "--> 会提前闭合注释");
  // 只拒"位于行尾"的 fix 串 —— 因为只有行尾那种会被 splitFixMeta 误拆成元数据。
  assert.notEqual(validateFactBody("[fix:defect of #abcd]"), undefined, "整条就是保留语法");
  assert.notEqual(validateFactBody("正文 [fix:defect of #abcd]"), undefined, "行尾的保留语法");
  // 串在中间不会被误拆，因此放行（避免误伤正常讨论该语法的正文）
  assert.equal(validateFactBody("自带 [fix:defect of #abcd] 后缀"), undefined);
  assert.equal(validateFactBody("正常正文 [fix 相关但格式不对]"), undefined);
});

test("isBeforeToday 只认严格早于今天", () => {
  assert.equal(isBeforeToday("2020-01-01"), true);
  assert.equal(isBeforeToday(today()), false, "当天不算早于今天");
  assert.equal(isBeforeToday("2999-01-01"), false, "未来不算");
  assert.equal(isBeforeToday("2026-13-45"), false, "非法日期不算");
});
