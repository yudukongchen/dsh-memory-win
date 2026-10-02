/**
 * 纯函数层：条目格式、日期校验、凭据扫描、去重、提示词中和。
 *
 * 本模块**不做任何 I/O**，因此可以被 `node --test` 直接、彻底地覆盖。
 * 参考插件把这类判定与文件读写混在同一个巨型文件里，导致"想测判定"必须先把
 * 整个宿主上下文搭起来 —— 这里刻意把边界划在 I/O 之外。
 *
 * @module dsh-memory-win/lib/format
 */

/**
 * 条目的唯一硬约定：`- [YYYY-MM-DD] 事实`。
 *
 * 行号不进正则（行号由扫描器另行记录），因为 `parseEntries` 需要按行返回。
 */
export const ENTRY_RE = /^-\s+\[(\d{4})-(\d{2})-(\d{2})\]\s+(.*)$/;

/**
 * 分片首行的关键词头：`<!-- 片名 · 关键词1 关键词2 -->`。
 *
 * `·` 之后那段是**检索线索**：片名只说"这片叫什么"，关键词才说"这片讲什么"。
 * 与 Claude Skills 用 `description` 决定是否加载是同一个思路。
 */
export const HEADER_RE = /^<!--\s*(.*?)\s*-->\s*$/;

/**
 * 校验 `YYYY-MM-DD` 是否为一个**真实存在且不在未来**的日期。
 *
 * 必须做 UTC 回读校验：`new Date("2026-13-45")` 不会返回 Invalid Date，而是进位
 * 到 2027-02-14。只判 `NaN` 会把这类明显错误的日期放行。
 *
 * "不在未来"用的是**本地今天**（`getFullYear/getMonth/getDate` 而非 `getUTC*`）：
 * 用户口中的"今天"是本地日历日，用 UTC 会在 UTC+8 的上午误判并拒绝当天条目。
 *
 * @param {string} s - 候选日期串。
 * @returns {boolean} 是否合法。
 */
export function validEntryDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  if (d.getUTCFullYear() !== Number(m[1])) return false;
  if (d.getUTCMonth() + 1 !== Number(m[2])) return false;
  if (d.getUTCDate() !== Number(m[3])) return false;
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime() <= todayUtc;
}

/**
 * 本地日历日的 `YYYY-MM-DD`。
 *
 * @param {Date} [now] - 注入点，便于测试。
 * @returns {string} 例：`2026-10-05`。
 */
export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 凭据特征表：命中即拒写。**只报模式名，绝不回显匹配值。** */
export const SECRET_PATTERNS = [
  ["api key (sk-…)", /sk-[A-Za-z0-9_-]{16,}/],
  ["anthropic key (sk-ant-…)", /sk-ant-[A-Za-z0-9_-]{16,}/],
  ["aws access key", /AKIA[0-9A-Z]{16}/],
  ["github token (gh?_…)", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["slack token (xox…)", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  ["credential assignment", /\b(api[_-]?key|secret|passwd|password|pwd|token)\b\s*[:=]\s*["']?[A-Za-z0-9+/_-]{12,}/i],
];

/**
 * 扫描疑似凭据。
 *
 * 契约：返回值里**只有模式名与所在行号**。绝不返回匹配到的字符串本身 ——
 * 否则拒绝原因会带着密钥进入模型上下文与日志，等于把凭据复制了一遍。
 *
 * @param {string} text - 待扫描文本。
 * @returns {{pattern:string,line:number}[]} 命中列表（可能为空）。
 */
export function scanSecrets(text) {
  const hits = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(lines[i])) {
        hits.push({ pattern: name, line: i + 1 });
        break; // 一行只报一次，避免冗余
      }
    }
  }
  return hits;
}

/**
 * 把记忆正文里的 `{{` 拆开，避免被宿主当成提示词插值。
 *
 * 宿主的插值规则是严格的 `/^\{\{([^{}]*)\}\}/` + 变量名白名单，**未知变量直接抛**，
 * 一旦记忆正文里出现 `{{foo}}`，整段 `dsh-memory-win:map` 组装失败 —— 也就是说
 * 一条记忆能把提示词装配整个搞崩。拆 `{{` 即可让扫描器不再匹配，同时保持可读。
 *
 * @param {string} text - 原文。
 * @returns {string} 中和后的文本。
 */
export function neutralizePromptVars(text) {
  return String(text ?? "").replaceAll("{{", "{ {");
}

/**
 * 压平空白为单空格（注入的地图必须每片一行）。
 *
 * @param {string} s - 原串。
 * @returns {string} 单行串。
 */
export function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 解析分片首行的关键词头。
 *
 * 约定：`<!-- 片名 · 关键词… -->`。`·` 之后为关键词；没有 `·` 时整段就是片名，
 * 关键词为空（此时模型只能靠片名路由，是可接受的降级而非错误）。
 *
 * @param {string} firstLine - 文件首行。
 * @returns {{title:string, keywords:string}} 片名与关键词。
 */
export function parseHeader(firstLine) {
  const m = HEADER_RE.exec(String(firstLine ?? "").trim());
  if (!m) return { title: "", keywords: "" };
  const body = m[1];
  const idx = body.indexOf("·");
  if (idx < 0) return { title: body.trim(), keywords: "" };
  return { title: body.slice(0, idx).trim(), keywords: body.slice(idx + 1).trim() };
}

/**
 * 逐行解析正文，产出带**行号**的条目列表。
 *
 * 行号是检索取回的关键：命中行号后模型可以直接 `read offset=<行号>`，
 * 不必整份读回。因此解析必须以行为单位，不能被"合并段落"之类的处理破坏。
 *
 * 代码围栏内的 `- [日期]` 会被跳过（示例文本不应被当成真实记忆）。
 *
 * @param {string} text - 分片正文。
 * @returns {{line:number, section:string, date:string, text:string}[]} 条目。
 */
export function parseEntries(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let section = "";
  let fence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    if (/^\s*```/.test(ln)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (/^##\s+/.test(ln)) {
      section = ln.replace(/^##\s+/, "").trim();
      continue;
    }
    const m = ENTRY_RE.exec(ln);
    if (m) out.push({ line: i + 1, section, date: m[1] + "-" + m[2] + "-" + m[3], text: m[4].trim() });
  }
  return out;
}

/**
 * 取"最新日期"：条目日期的字典序最大值（`YYYY-MM-DD` 定长，字典序即时间序）。
 *
 * 用途是让模型一眼看出这片是"活片"还是"陈年归档"，因此没有条目时返回空串
 * 而不是伪造一个日期。
 *
 * @param {{date:string}[]} entries - 条目列表。
 * @returns {string} 最新日期，或空串。
 */
export function latestDate(entries) {
  let best = "";
  for (const e of entries) if (e.date > best) best = e.date;
  return best;
}

/**
 * 判断追加内容是否与**尾部窗口内某一条完全相同**（含日期）。
 *
 * 语义刻意收窄：只有"日期 + 正文"都相同才算重复。
 * 如果只比对正文，那么"同一事实在不同日期被再次确认"也会被判重 —— 而那恰恰是
 * 应当留下的信息（说明该结论仍然成立）。宁可留下一条有日期的重复确认，
 * 也不要静默丢掉一次真实的观察。
 *
 * 正文相邻但日期不同的情况由 `findSameFactOtherDate()` 单独报出，交给模型判断。
 *
 * @param {string} existing - 现有正文。
 * @param {string} incoming - 待追加正文。
 * @param {number} [window] - 回看行数。
 * @returns {boolean} 是否完全重复。
 */
export function isTailDuplicate(existing, incoming, window = 60) {
  const tail = String(existing ?? "")
    .split("\n")
    .slice(-window)
    .map((l) => l.trim());
  const want = String(incoming ?? "").trim();
  if (want === "") return false;
  return tail.includes(want);
}

/**
 * 在既有内容里找"正文相同但日期不同"的条目，用于给出更准确的提示。
 *
 * @param {string} existing - 现有正文。
 * @param {string} date - 待写入日期。
 * @param {string} body - 待写入正文。
 * @returns {string|undefined} 命中的既有日期，无命中时 `undefined`。
 */
export function findSameFactOtherDate(existing, date, body) {
  const want = String(body ?? "").trim();
  if (want === "") return undefined;
  for (const entry of parseEntries(existing)) {
    if (entry.text === want && entry.date !== date) return entry.date;
  }
  return undefined;
}

/**
 * 校验一条待写入事实的正文本身（不含日期与格式拼装）。
 *
 * @param {string} body - 事实正文。
 * @returns {string|undefined} 违规原因，合法时为 `undefined`。
 */
export function validateFactBody(body) {
  const t = String(body ?? "").trim();
  if (t === "") return "事实正文不能为空";
  if (t.includes("\n")) return "一条记忆必须是单行（换行会破坏 `- [日期] 事实` 的行结构）";
  if (ENTRY_RE.test(t)) return "正文不要自带 `- [日期]` 前缀，日期由插件生成";
  if (t.length > 2000) return `单条超过 2000 字符（实测 ${t.length}），请拆分或精简`;
  return undefined;
}

/**
 * 拼装一条规范条目。
 *
 * @param {string} date - `YYYY-MM-DD`。
 * @param {string} body - 事实正文。
 * @returns {string} `- [YYYY-MM-DD] 事实`。
 */
export function renderEntry(date, body) {
  return `- [${date}] ${String(body).trim()}`;
}
