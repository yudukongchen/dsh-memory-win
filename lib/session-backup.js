/**
 * 压缩前的会话备份（0.4.0）：把会话日志拷成一份**可长期留存的快照**。
 *
 * ## 为什么需要它（先纠正一个常见误解）
 *
 * DSH 的压缩是**表层（surface）替换**：被遮蔽的事件原样留在
 * `session.v4.jsonl.zstd` 里，回放仍能重现。所以"怕压缩丢信息"这个理由**不成立**。
 *
 * 真正成立的理由有两个：
 *
 * 1. **日志不可读**：`session.v4.jsonl.zstd` 是**逐帧 zstd**，grep 搜不进去。
 *    压缩把历史从上下文里拿掉之后，人想再翻那一段就只能靠工具解码 —— 于是
 *    插件顺手留一份明文（`*.jsonl`）。
 * 2. **压缩点是个天然的快照时机**：750k 触发的那一刻正是"这一刻之前的内容
 *    值得留档"的判定点，比事后按时间瞎猜可靠。
 *
 * ## 落点与命名
 *
 * 落点是 `$DSH_HOME/memory-win/session-backups/<sessionId>/`，刻意**不在工作区、
 * 也不在 `sessions/` 下**：
 *
 * - 不在工作区 ⇒ 仓库内 grep 不会命中重复内容（这正是需求里"避免后续搜索重复"的落点）；
 * - 不在 `sessions/` 下 ⇒ 不会被会话列表/导出/清理扫成"又一个会话"。
 *
 * 命名规则来自需求：`<会话名称>_YYYYMMDD_HHmmss`（本地时间），扩展名由本模块定：
 *
 * | 文件 | 内容 |
 * |---|---|
 * | `<名称>.jsonl.zstd` | 原始日志字节的**逐字节拷贝**（无损，可放回去重放） |
 * | `<名称>.jsonl` | 解码后的明文，**只保留压缩起点之前**的记录（可 grep） |
 * | `<名称>.meta.json` | 会话 id / 标题 / compactionId / 起点 seq / 压缩前 token / 时间 |
 *
 * ## 逐帧解码（本机实测过的坑）
 *
 * Node 的 `zstdDecompressSync` **只解第一帧**，而 DSH 每条记录是独立帧；
 * 一帧里又可能装多条记录（中间有 `\n`）。所以必须：按魔数切帧 → 逐帧解 →
 * 再按 `\n` 切记录。实测本机 3.2MB 日志 = 2811 帧 / 4361 条记录，全部解码成功。
 *
 * @module dsh-memory-win/lib/session-backup
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { configNum, configValue } from "./config.js";
import { dshHome } from "./paths.js";

/** 会话日志文件名（`session.v4.jsonl.zstd`，v 号随宿主版本变）。 */
const LOG_NAME_RE = /^session\.v\d+\.jsonl\.zstd$/;

/** zstd 帧魔数（小端：`28 B5 2F FD`）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 会话名称截断长度（字符）。太长会顶到 Windows 的路径长度限制。 */
const TITLE_MAX_CHARS = 60;

/** Windows 非法文件名字符 + 全部 C0 控制符。 */
const ILLEGAL_TITLE_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/** 备份目录（绝对路径）。 */
export function backupRoot() {
  const configured = configValue("compactBackupDir");
  if (typeof configured === "string" && configured.trim() !== "") return resolve(configured.trim());
  return join(dshHome(), "memory-win", "session-backups");
}

/**
 * 定位一个会话的日志目录。
 *
 * 目录名就是会话 id（`session-<uuid>`，字符集安全，无需解码），
 * 但仍逐工作区扫描 —— 因为会话落在哪个工作区桶里由宿主的编码规则决定，
 * 插件不该复制那套规则。
 *
 * @param {string} sessionId - 会话 id。
 * @returns {string|undefined} 目录绝对路径。
 */
export function locateSessionDir(sessionId) {
  const id = String(sessionId ?? "").trim();
  if (id === "") return undefined;
  const root = join(dshHome(), "sessions");
  let buckets;
  try {
    buckets = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const candidate = join(root, bucket.name, id);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 找出目录里的会话日志文件。
 *
 * @param {string} dir - 会话目录。
 * @returns {string|undefined} 文件绝对路径。
 */
export function findSessionLog(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const hit = names.find((name) => LOG_NAME_RE.test(name));
  return hit === undefined ? undefined : join(dir, hit);
}

/**
 * 把会话标题清洗成可用的文件名字干。
 *
 * 标题来自模型生成，属于**不可信输入**：可能带路径分隔符、Windows 保留字符、
 * 控制字符，也可能整段是空的。清洗规则是"换成 `-`、折叠、去首尾点与空格、
 * 截断"，任何情况下都返回一个非空、无非法字符的片段。
 *
 * @param {string|undefined} title - 原始标题。
 * @param {string} fallback - 标题不可用时的回退（通常是会话 id）。
 * @returns {string} 安全的文件片段。
 */
export function safeTitleStem(title, fallback = "session") {
  const raw = typeof title === "string" ? title : "";
  const cleaned = raw
    .replace(ILLEGAL_TITLE_CHARS, "-")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\s-]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  const usable = cleaned === "" ? String(fallback ?? "session") : cleaned;
  const truncated = usable.length > TITLE_MAX_CHARS ? usable.slice(0, TITLE_MAX_CHARS).trim() : usable;
  const final = truncated === "" ? "session" : truncated;
  // 截断后可能又落到保留名上（Windows 的 CON/PRN/NUL 等）。
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(final) ? `${final}-` : final;
}

/**
 * 本地时间的 `YYYYMMDD` 与 `HHmmss`。
 *
 * @param {Date} [now] - 时刻。
 * @returns {{date:string, time:string}} 两段。
 */
export function localStampParts(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`,
    time: `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`,
  };
}

/**
 * 拼出备份基名 `<会话名称>_YYYYMMDD_HHmmss`。
 *
 * @param {string} titleStem - 已清洗的标题片段。
 * @param {Date} [now] - 时刻。
 * @returns {string} 基名（不含扩展名）。
 */
export function backupBaseName(titleStem, now = new Date()) {
  const { date, time } = localStampParts(now);
  return `${titleStem}_${date}_${time}`;
}

/**
 * 在同一目录里找一个不冲突的基名（同一秒内重复压缩时追加序号）。
 *
 * @param {string} dir - 备份目录。
 * @param {string} base - 候选基名。
 * @returns {string} 可用的基名。
 */
export function uniqueBaseName(dir, base) {
  if (!existsSync(join(dir, `${base}.meta.json`)) && !existsSync(join(dir, `${base}.jsonl.zstd`))) return base;
  for (let i = 2; i <= 99; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existsSync(join(dir, `${candidate}.meta.json`)) && !existsSync(join(dir, `${candidate}.jsonl.zstd`))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 把日志字节按 zstd 帧切开。
 *
 * 实现是"扫魔数"：DSH 每条记录一个独立帧，帧尾紧跟下一帧的魔数。
 * 理论上压缩载荷里也可能出现同一串字节，所以调用方对"解不开的切片"要容忍；
 * 本机实测（3.2MB / 2811 帧）零失败。
 *
 * @param {Buffer} buffer - 日志字节。
 * @returns {Buffer[]} 帧切片。
 */
export function splitZstdFrames(buffer) {
  const offsets = [];
  let cursor = 0;
  for (;;) {
    const at = buffer.indexOf(ZSTD_MAGIC, cursor);
    if (at === -1) break;
    offsets.push(at);
    cursor = at + ZSTD_MAGIC.length;
  }
  if (offsets.length === 0) return [];
  const frames = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
    frames.push(buffer.subarray(offsets[i], end));
  }
  return frames;
}

/**
 * 把会话日志解码成明文记录数组。
 *
 * 一帧可能装多条记录，所以逐帧解码后还要按 `\n` 切；空行丢弃。
 *
 * ## 为什么"坏帧"按空输出判定，而不是按异常
 *
 * 本机实测（Node 22.23）：**截断帧、全 `0xFF`、skippable 帧都不抛**，
 * `zstdDecompressSync` 一律返回**空 Buffer**。若只靠 `catch` 计失败，
 * 一份被截断的日志会**看起来解码成功**——正是本项目最忌讳的
 * "显示正常但不成立"。所以"有字节却解出空"才算可疑帧。
 *
 * @param {Buffer} buffer - 日志字节。
 * @returns {{records:string[], frames:number, failed:number}} 解码结果；
 *   `failed` = 有载荷却解不出内容的帧数（正常记录不会是空帧）。
 */
export function decodeSessionLog(buffer) {
  const frames = splitZstdFrames(buffer);
  const records = [];
  let failed = 0;
  for (const frame of frames) {
    let text = "";
    try {
      text = zstdDecompressSync(frame).toString("utf8");
    } catch {
      failed += 1;
      continue;
    }
    if (text === "") {
      if (frame.length > ZSTD_MAGIC.length) failed += 1;
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() !== "") records.push(line);
    }
  }
  return { records, frames, failed };
}

/**
 * 从记录里读出 `seq`；头记录（`type: "session"`）没有 seq。
 *
 * @param {string} line - 一条 JSONL 记录。
 * @returns {number|undefined} seq。
 */
function seqOfRecord(line) {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed?.seq === "number" ? parsed.seq : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 保留"压缩起点之前"的记录，生成可 grep 的明文。
 *
 * 为什么按 seq 过滤而不是整份导出：压缩事务本身也会追加
 * `compaction/*` 与替换消息，全量导出会让备份里混进**压缩后**的状态，
 * 与"压缩前的会话"这个语义不符。
 *
 * @param {string[]} records - 全部明文记录。
 * @param {number} beforeSeq - 压缩起点 seq（不含）。
 * @returns {string} 明文正文（行尾 `\n`）。
 */
export function plaintextBefore(records, beforeSeq) {
  const keep = [];
  for (const line of records) {
    const seq = seqOfRecord(line);
    if (seq !== undefined && Number.isFinite(beforeSeq) && seq >= beforeSeq) continue;
    keep.push(line);
  }
  return keep.length === 0 ? "" : `${keep.join("\n")}\n`;
}

/**
 * 每会话只保留最近 N 份备份（按基名分组，`compactBackupKeep`）。
 *
 * 分组依据是"基名"而不是文件：一份备份由 `.jsonl.zstd` / `.jsonl` / `.meta.json`
 * 三个文件组成，按文件删会删成半份。
 *
 * @param {string} dir - 某个会话的备份目录。
 * @param {number} keep - 保留份数（≥1）。
 * @returns {string[]} 被删掉的基名。
 */
export function pruneBackups(dir, keep) {
  if (!Number.isInteger(keep) || keep < 1) return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const groups = new Map();
  for (const name of names) {
    const match = /^(.*)\.(jsonl\.zstd|jsonl|meta\.json)$/.exec(name);
    if (match === null) continue;
    const base = match[1];
    const list = groups.get(base) ?? { files: [], mtime: 0 };
    list.files.push(name);
    try {
      list.mtime = Math.max(list.mtime, statSync(join(dir, name)).mtimeMs);
    } catch {
      /* 读不到时间就按 0 计，排到最后 */
    }
    groups.set(base, list);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].mtime - a[1].mtime);
  const removed = [];
  for (const [base, info] of ordered.slice(keep)) {
    for (const name of info.files) {
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        /* 删不掉就留着：备份目录多一份文件不影响正确性 */
      }
    }
    removed.push(base);
  }
  return removed;
}

/**
 * 压缩前备份一个会话 —— 本模块唯一的对外入口。
 *
 * 调用前**必须**已经 flush 过会话（`ctx.sessions.flush(session)`），否则持久化缓冲里
 * 的尾事件还不在磁盘文件里，备份会少一截。flush 由调用方负责，因为"何时 flush"
 * 属于会话生命周期的知识，不属于本模块。
 *
 * 本函数**永不抛**：备份是增强动作，失败只能降级成返回值里的 `reason`。
 *
 * @param {object} input - 输入。
 * @param {string} input.sessionId - 会话 id。
 * @param {string|undefined} input.title - 会话标题（取自 `ctx.sessionTitle`）。
 * @param {string|undefined} input.compactionId - 触发本次备份的压缩事务 id。
 * @param {number|undefined} input.startSeq - `compaction/start` 的 seq。
 * @param {number|undefined} input.totalTokens - 压缩前测得的请求压力（诊断用）。
 * @param {Date} [input.now] - 时刻（测试注入）。
 * @returns {Promise<{ok:boolean, reason?:string, base?:string, dir?:string, plaintext?:boolean}>} 结果。
 */
export async function backupSessionBeforeCompaction(input) {
  const { sessionId, title, compactionId, startSeq, totalTokens, now } = input ?? {};
  try {
    const dir = locateSessionDir(sessionId);
    if (dir === undefined) return { ok: false, reason: `找不到会话目录：${String(sessionId)}` };
    const logFile = findSessionLog(dir);
    if (logFile === undefined) return { ok: false, reason: `会话目录里没有 session.v*.jsonl.zstd：${dir}` };

    const target = join(backupRoot(), String(sessionId));
    mkdirSync(target, { recursive: true });

    const stem = safeTitleStem(title, sessionId);
    const base = uniqueBaseName(target, backupBaseName(stem, now instanceof Date ? now : new Date()));

    const raw = readFileSync(logFile);
    copyFileSync(logFile, join(target, `${base}.jsonl.zstd`));

    const wantPlaintext = configValue("compactBackupPlaintext") === true;
    if (wantPlaintext) {
      const decoded = decodeSessionLog(raw);
      const text = plaintextBefore(decoded.records, Number(startSeq ?? Number.POSITIVE_INFINITY));
      await writeFile(join(target, `${base}.jsonl`), text, "utf8");
    }

    const meta = {
      sessionId,
      title: typeof title === "string" ? title : null,
      compactionId: compactionId ?? null,
      startSeq: startSeq ?? null,
      totalTokens: totalTokens ?? null,
      takenAt: new Date().toISOString(),
      source: logFile,
      zstdBytes: raw.length,
      plaintext: wantPlaintext,
      keep: configNum("compactBackupKeep"),
    };
    await writeFile(join(target, `${base}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    pruneBackups(target, configNum("compactBackupKeep"));
    return { ok: true, base, dir: target, plaintext: wantPlaintext };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * 备份目录里某个会话已有几份（测试与诊断用）。
 *
 * @param {string} sessionId - 会话 id。
 * @returns {number} 份数。
 */
export function backupCount(sessionId) {
  const dir = join(backupRoot(), String(sessionId));
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".meta.json")).length;
  } catch {
    return 0;
  }
}
