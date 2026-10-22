/**
 * 压缩守护的**只读**体检脚本（0.4.x）。
 *
 * 宿主重启后跑一次，就能回答三个问题，不需要读代码、也不需要模型参与：
 *
 *   1. **备份半边装上了吗？** —— 效果日志里有没有 `compact_guard_half half=backup`
 *      （0.4.2 起每个半边各写一行；缺这行就是没挂上）。
 *   2. **真的备份过吗？** —— `~/.dsh/memory-win/session-backups/<sessionId>/` 下有没有
 *      成组的 `<名称>_YYYYMMDD_HHmmss` 三件套，以及 `compact_backup ok=true`。
 *   3. **收敛半边呢？** —— `compact_guard_half half=converge` 有没有出现。
 *      桌面/Web profile 上预期**没有**：`compaction` 服务被 preset 的
 *      `cordis:group(compaction)` + `isolate` 关在组里，根作用域拿不到（README 0.4.2/0.4.3）。
 *
 * 本脚本**只读**：不写文件、不调宿主服务、不改配置。诊断失败只打印，退出码保持 0。
 *
 * 用法：
 *   node tools/verify-compaction-backup.mjs
 *   node tools/verify-compaction-backup.mjs --session session-xxxx    # 只看某个会话
 *   node tools/verify-compaction-backup.mjs --dir D:\bak              # 自定义备份根目录
 *
 * @module dsh-memory-win/tools/verify-compaction-backup
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** DSH 主目录（与插件同一套解析规则：DSH_HOME 优先，homedir 兜底）。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv.trim());
  return join(homedir(), ".dsh");
}

/** 取一个命令行开关的值（`--k v` 形式）。 */
function argOf(argv, key) {
  const index = argv.indexOf(`--${key}`);
  return index === -1 ? undefined : argv[index + 1];
}

const argv = process.argv;
const onlySession = argOf(argv, "session");
const explicitDir = argOf(argv, "dir");

const home = dshHome();
const backupRoot = explicitDir !== undefined ? resolve(explicitDir) : join(home, "memory-win", "session-backups");
const logFile = join(home, "memory-win", "logs", "debug.jsonl");

/** 备份基名的合规判定：`<会话名称>_YYYYMMDD_HHmmss`（同秒重复时带 `-N`）。 */
const BASE_RE = /^(.*)_(\d{8})_(\d{6})(?:-(\d+))?$/;

console.log(`DSH_HOME      ${home}`);
console.log(`备份根目录     ${backupRoot}`);
console.log(`效果日志       ${logFile}`);
console.log("");

// ── 1. 效果日志：两个半边各自有没有挂上 ─────────────────────────────────────
const logStats = { halfBackup: 0, halfConverge: 0, backupOk: 0, backupFail: 0, verify: 0, converge: 0, convergeError: 0 };
let lastBackup = null;
if (existsSync(logFile)) {
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.ev === "compact_guard_half") {
      if (event.half === "backup") logStats.halfBackup += 1;
      if (event.half === "converge") logStats.halfConverge += 1;
    }
    if (event.ev === "compact_backup") {
      if (event.ok === true) {
        logStats.backupOk += 1;
        lastBackup = event;
      } else logStats.backupFail += 1;
    }
    if (event.ev === "compact_verify") logStats.verify += 1;
    if (event.ev === "compact_converge") logStats.converge += 1;
    if (event.ev === "compact_converge_error") logStats.convergeError += 1;
  }
}

console.log("【效果日志】");
if (!existsSync(logFile)) {
  console.log("  ⚠️ 日志文件不存在 —— `logEnabled: true` 才写日志（profile 的 config 段）。");
} else {
  console.log(`  compact_guard_half half=backup    ${logStats.halfBackup} 行   ${logStats.halfBackup > 0 ? "✅ 备份半边已挂上" : "❌ 备份半边没挂上"}`);
  console.log(`  compact_guard_half half=converge  ${logStats.halfConverge} 行   ${logStats.halfConverge > 0 ? "✅ 收敛半边已挂上" : "⏸ 收敛半边没挂上（desktop/web 上属预期：compaction 被 preset isolate）"}`);
  console.log(`  compact_backup  成功 ${logStats.backupOk} / 失败 ${logStats.backupFail}`);
  console.log(`  compact_verify ${logStats.verify} 行 · compact_converge ${logStats.converge} 行 · converge_error ${logStats.convergeError} 行`);
  if (lastBackup !== null) {
    console.log(`  最近一次备份：base=${lastBackup.base ?? "?"} totalTokens=${lastBackup.totalTokens ?? "?"} plaintext=${lastBackup.plaintext ?? "?"}`);
  }
}
console.log("");

// ── 2. 备份目录：成组的三件套 ───────────────────────────────────────────────
console.log("【备份文件】");
if (!existsSync(backupRoot)) {
  console.log(`  ❌ 目录不存在：${backupRoot}`);
  console.log("     ⇒ 还没发生过任何压缩，或备份半边没挂上（看上面 half=backup 那行）。");
  process.exit(0);
}

const sessionDirs = readdirSync(backupRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
if (sessionDirs.length === 0) {
  console.log("  （目录为空）");
  process.exit(0);
}

let totalGroups = 0;
let badGroups = 0;
for (const entry of sessionDirs) {
  if (onlySession !== undefined && entry.name !== onlySession) continue;
  const dir = join(backupRoot, entry.name);
  const groups = new Map();
  for (const name of readdirSync(dir)) {
    const match = /^(.*)\.(jsonl\.zstd|jsonl|meta\.json)$/.exec(name);
    if (match === null) continue;
    const list = groups.get(match[1]) ?? new Set();
    list.add(match[2]);
    groups.set(match[1], list);
  }
  console.log(`  ${entry.name}  （${groups.size} 份）`);
  for (const [base, kinds] of [...groups.entries()].sort()) {
    totalGroups += 1;
    const naming = BASE_RE.test(base);
    const complete = kinds.has("jsonl.zstd") && kinds.has("meta.json");
    if (!naming || !complete) badGroups += 1;
    const sizes = [...kinds]
      .sort()
      .map((kind) => {
        const file = join(dir, `${base}.${kind}`);
        return `${kind}=${(statSync(file).size / 1024).toFixed(0)}KB`;
      })
      .join(" ");
    const flags = [naming ? "命名✅" : "命名❌", complete ? "完整✅" : "缺件❌"].join(" ");
    console.log(`    · ${base}   ${flags}   ${sizes}`);
    if (kinds.has("meta.json")) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, `${base}.meta.json`), "utf8"));
        console.log(`      meta: compactionId=${meta.compactionId} startSeq=${meta.startSeq} totalTokens=${meta.totalTokens} plaintext=${meta.plaintext}`);
      } catch {
        console.log("      meta: ⚠️ 解析失败");
      }
    }
  }
}
console.log("");

// ── 3. 结论 ─────────────────────────────────────────────────────────────────
if (totalGroups === 0) {
  console.log("结论：没有找到任何备份。若日志里也没有 half=backup，先确认插件版本 ≥ 0.4.2 并已重启。");
} else if (badGroups === 0) {
  console.log(`结论：${totalGroups} 份备份全部合规（命名 + 三件套齐全）。`);
} else {
  console.log(`结论：${totalGroups} 份里有 ${badGroups} 份不合规，见上面的 ❌。`);
}
