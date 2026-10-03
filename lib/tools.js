/**
 * 模型可见的工具：`memory_list` / `memory_search` / `memory_add` / `memory_correct` /
 * `memory_cleanup`。
 *
 * 契约来自宿主运行时（**实读 DSH bundle 得到，不是照 TypeScript 声明猜的**）：
 *
 * - `ctx.tools.register(def)` 收的是**原始** `ToolDefinition`：
 *   `{ name, description, parameters, output: { schema, render }, execute }`。
 * - `parameters` 必须是**合法 JSON Schema**（`defineTool()` 那层类型化包装在宿主内部，
 *   插件 import 不到，所以这里直接写 JSON Schema）。
 * - `execute()` 返回一个**普通 JSON 值**，宿主按 `output.schema` 校验，
 *   再交给 `output.render(args, value)` 转成 `ContentBlock[]`。
 *
 * 因此每个 render 都必须能从 value 单独渲染出人可读文本 —— 如果只在 execute 里
 * 拼字符串，`output.schema: {type:'string'}` 与返回对象就会对不上。
 *
 * @module dsh-memory-win/lib/tools
 */

import { configNum } from "./config.js";
import {
  appendMemory,
  correctMemory,
  groupAccess,
  listEntries,
  listLayer,
  runCleanup,
  searchMemory,
} from "./engine.js";
import { recordAccess } from "./state.js";
import { cwdOf } from "./context.js";

/**
 * 记录"这次读操作真的把哪些条目交给了模型"。
 *
 * 三点刻意为之：
 * 1. **不 await、不阻断**：读操作不该因为"要记一笔命中"而变慢或变脆 —— 状态写盘
 *    失败也只影响归档的减档判断，不影响检索本身；
 * 2. **只记返回给调用方的条目**（engine 已按 limit 截断后再产出 `access`），
 *    否则"被截掉的命中"会被误当成"被取回过"，让归档判定失真；
 * 3. 同日重复命中在 `recordAccess` 里被折掉，因此**不产生 I/O**。
 *
 * @param {{layerDir:string, shard:string, entries:{id:string}[]}[]} groups - 聚合后的命中。
 * @returns {void}
 */
function trackAccess(groups) {
  for (const group of groups) {
    recordAccess(group.layerDir, group.shard, group.entries).catch(() => {
      /* 状态是运维数据：写失败不该冒泡成工具失败 */
    });
  }
}

/**
 * 把一次工具调用的结果渲染成单个 text block。
 *
 * @param {string} text - 文本。
 * @returns {{type:'text',text:string}[]} 内容块。
 */
function textBlock(text) {
  return [{ type: "text", text }];
}

/**
 * 全局层与项目层的根目录展示路径（`memory_list` 顶部的两行）。
 *
 * @param {string} [cwd] - 会话工作目录。
 * @returns {{global:string, project?:string}} 展示路径。
 */
function rootsFor(cwd) {
  const out = {};
  try {
    out.global = listLayer("global", cwd).dirPath;
  } catch {
    out.global = "(不可用)";
  }
  if (typeof cwd === "string" && cwd.trim() !== "") {
    try {
      out.project = listLayer("project", cwd).dirPath;
    } catch {
      out.project = "(不可用)";
    }
  }
  return out;
}

/** `memory_list` 的 output schema。 */
const LIST_OUTPUT = {
  type: "object",
  properties: {
    roots: { type: "object" },
    truncated: { type: "boolean" },
    layers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target: { type: "string" },
          dir: { type: "string" },
          total: { type: "number" },
          archiveDir: { type: "string" },
          archived: { type: "number" },
          shards: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                path: { type: "string" },
                count: { type: "number" },
                latest: { type: "string" },
                keywords: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

/** `memory_search` 的 output schema。 */
const SEARCH_OUTPUT = {
  type: "object",
  properties: {
    query: { type: "string" },
    scanned: { type: "number" },
    truncated: { type: "boolean" },
    hits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          score: { type: "number" },
          id: { type: "string" },
          target: { type: "string" },
          shard: { type: "string" },
          path: { type: "string" },
          line: { type: "number" },
          date: { type: "string" },
          text: { type: "string" },
        },
      },
    },
  },
};

/** `memory_add` 的 output schema。 */
const ADD_OUTPUT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    duplicate: { type: "boolean" },
    reason: { type: "string" },
    target: { type: "string" },
    shard: { type: "string" },
    path: { type: "string" },
    line: { type: "number" },
    entry: { type: "string" },
    totalEntries: { type: "number" },
    sameFactOtherDate: { type: "string" },
    warning: { type: "string" },
  },
};

/**
 * 构造 `memory_list` 定义。
 *
 * @returns {object} ToolDefinition。
 */
export function memoryListTool() {
  return {
    name: "memory_list",
    description:
      "List long-term memory as a map: every layer (global / project) and every shard with its entry count, latest date, keywords and file path. Call this before a task to see what is already known, or to discover which shard to search. Set entries=true to list every entry WITH its id — that is the reliable way to obtain the id memory_correct needs when a keyword search cannot find the entry you mean.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["global", "project", "all"],
          description: "Which layer to list. Defaults to all.",
        },
        entries: {
          type: "boolean",
          description:
            "Also list every entry with its id, date, line and text. Use this when you need an id but memory_search cannot find the entry by keyword.",
        },
        shard: {
          type: "string",
          description: "Restrict an entries listing to one shard.",
        },
        limit: {
          type: "number",
          description: "Maximum entries to list when entries=true (1-200). Defaults to 50.",
        },
      },
    },
    output: {
      schema: LIST_OUTPUT,
      render(_args, value) {
        const lines = [];
        const roots = value?.roots ?? {};
        lines.push(`全局层根目录：${roots.global ?? "(不可用)"}`);
        if (roots.project !== undefined) lines.push(`项目层根目录：${roots.project}`);
        for (const layer of value?.layers ?? []) {
          lines.push("");
          const archivedNote =
            (layer.archived ?? 0) === 0
              ? ""
              : ` · 归档 ${layer.archived} 件（${layer.archiveDir ?? "?"}，不参与注入）`;
          lines.push(
            `## ${layer.target === "global" ? "全局记忆" : "项目记忆"}（${layer.total} 条 · ${layer.dir}${archivedNote}）`,
          );
          if ((layer.shards ?? []).length === 0) {
            lines.push("- （空）");
            continue;
          }
          for (const s of layer.shards) {
            const kw = s.keywords === "" ? "" : ` ｜ 关键词：${s.keywords}`;
            lines.push(`- ${s.name}：${s.count} 条 ｜ 最新 ${s.latest || "—"} ｜ ${s.path}${kw}`);
          }
          // 条目清单（entries=true 时）—— 让"搜不到的记忆"也能拿到 id 被修正
          if ((layer.entries ?? []).length > 0) {
            lines.push("  条目（id 可用于 memory_correct）：");
            for (const e of layer.entries) {
              lines.push(`  - [${e.date}] #${e.id} ${e.text}`);
              lines.push(`      └ ${e.path} line=${e.line}`);
            }
          }
        }
        if (value?.truncated === true) lines.push("", "（条目清单被 limit 截断；可加 shard 收窄。）");
        return textBlock(lines.join("\n"));
      },
    },
    async execute(args, exec) {
      const requested = args?.target;
      const targets =
        requested === "global" || requested === "project" ? [requested] : ["global", "project"];
      const cwd = cwdOf(exec);
      const wantEntries = args?.entries === true;

      // entries=true 走 listEntries：它产出带 id 的完整清单
      const detail = wantEntries
        ? listEntries({ target: requested, cwd, shard: args?.shard, limit: args?.limit })
        : undefined;
      // 浏览（尤其是 entries=true）也算"取回"：否则只有 memory_search 能刷新命中记录，
      // 而"搜不到才用 memory_list 兜底"恰恰是长尾条目的常见取回方式。
      if (detail !== undefined) trackAccess(groupAccess(detail.access));

      const layers = [];
      for (const target of targets) {
        try {
          const layer = listLayer(target, cwd);
          // entries=true 时把带 id 的完整条目清单挂到对应层上
          const detailLayer = detail?.layers.find((l) => l.target === target);
          layers.push({
            target,
            dir: layer.dirPath,
            total: layer.total,
            archiveDir: layer.archiveDir,
            archived: layer.archived,
            shards: layer.shards.map((s) => ({
              name: s.name,
              path: s.path,
              count: s.entries.length,
              latest: s.latest,
              keywords: s.keywords,
            })),
            ...(detailLayer === undefined ? {} : { entries: detailLayer.entries }),
          });
        } catch {
          // 项目层无 cwd 时跳过；缺席是可见的（layers 里就没有这一层）。
        }
      }
      return {
        roots: rootsFor(cwd),
        layers,
        ...(detail === undefined ? {} : { truncated: detail.truncated }),
      };
    },
  };
}

/**
 * 构造 `memory_search` 定义。
 *
 * @returns {object} ToolDefinition。
 */
export function memorySearchTool() {
  return {
    name: "memory_search",
    description:
      "Search long-term memory by keyword, across the global and/or project layer, and return matching entries WITH their file path and line number. Pure substring matching over space-separated terms (all terms must match one entry) — no model call, no embedding. After a hit, read the surrounding context with the read tool using the returned line number. Always call this before assuming memory has nothing relevant.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords to find. Space-separated terms are ANDed. Chinese needs no segmentation.",
        },
        target: {
          type: "string",
          enum: ["global", "project", "all"],
          description: "Which layer to search. Defaults to all.",
        },
        shard: {
          type: "string",
          description: "Restrict the search to one shard name (as shown by memory_list).",
        },
        limit: {
          type: "number",
          description: "Maximum hits to return, 1-50. Defaults to 20.",
        },
      },
      required: ["query"],
    },
    output: {
      schema: SEARCH_OUTPUT,
      render(_args, value) {
        const hits = value?.hits ?? [];
        if (hits.length === 0) {
          return textBlock(
            `未命中：query="${value?.query ?? ""}"（已扫描 ${value?.scanned ?? 0} 条）。\n` +
              "换更短或更通用的关键词再试一次；仍无命中时不要凭猜测补写记忆。",
          );
        }
        const lines = [`query="${value.query}" 命中 ${hits.length} 条（已扫描 ${value.scanned} 条）：`];
        for (const h of hits) {
          lines.push(`- ${h.text}`);
          // id 放在前缀：它是 memory_correct 的唯一锚点，必须和 date/line 一样显眼。
          lines.push(
            `  └ id=${h.id} date=${h.date} source=${h.target}/${h.shard} path=${h.path} line=${h.line}`,
          );
        }
        if (value.truncated === true) {
          lines.push("");
          lines.push("（命中被 limit 截断；如需更多请提高 limit 或收窄 query。）");
        }
        return textBlock(lines.join("\n"));
      },
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const result = searchMemory(args?.query, {
        target: args?.target,
        shard: args?.shard,
        limit: args?.limit,
        cwd,
      });
      trackAccess(groupAccess(result.access));
      return result;
    },
  };
}

/**
 * 构造 `memory_add` 定义。
 *
 * @returns {object} ToolDefinition。
 */
export function memoryAddTool() {
  return {
    name: "memory_add",
    description:
      "Append ONE durable fact to long-term memory. Use it for reusable conclusions, user preferences, pitfalls with their cause, and environment facts — not for narrating what you just did. The entry is validated (single line, date not in the future, no credentials) and appended atomically. Duplicate tail entries are reported instead of appended twice.",
    parameters: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description:
            `The fact, as ONE line, without a leading \`- [date]\` prefix (the plugin adds it). Hard limit ${configNum("factBodyMax")} characters; keep it under ${configNum("inlineTextMax")} characters, because in inline mode (a layer with up to ${configNum("inlineThreshold")} entries) the injected map shows only the first ${configNum("inlineTextMax")} characters of each entry. Longer entries are truncated there silently apart from a warning returned by this tool, so for long narratives write the document in the repo and store a one-line pointer instead.`,
        },
        target: {
          type: "string",
          enum: ["global", "project"],
          description:
            "global = true across projects (user preferences, tooling gotchas). project = only about this repository, stored inside the repo at .agent-memory/. Defaults to project when a working directory exists, otherwise global.",
        },
        shard: {
          type: "string",
          description:
            "Topic shard name, e.g. windows-paths or build-setup. Letters, digits, CJK, space, dot, dash and underscore only. Defaults to 'default'.",
        },
        date: {
          type: "string",
          description: "YYYY-MM-DD. Defaults to today. Must not be in the future.",
        },
        confirm: {
          type: "boolean",
          description:
            "Only set when you intend to re-record a fact that already exists with a DIFFERENT date. By default such a write is refused, because repeating a fact inflates the injected map without adding knowledge.",
        },
        keywords: {
          type: "string",
          description:
            `Routing hint for a NEW shard only, written into its first line as \`<!-- name · keywords -->\` and shown in the injected map so the shard can be found without reading it. Space-separated, a few distinctive terms, under ${configNum("keywordsMaxChars")} characters. Refused if the shard already has entries — the header is the first line and memory_add only appends.`,
        },
      },
      required: ["fact"],
    },
    output: {
      schema: ADD_OUTPUT,
      render(_args, value) {
        if (value?.reason === "same-fact-other-date") {
          return textBlock(
            [
              `未写入：同一事实已在 ${value.sameFactOtherDate} 记过（${value.path}）。`,
              "这通常是重复，因此默认拒绝，以免同一条事实在注入的地图里重复占位。",
              '若你确实要留下"该结论在某天仍然成立"的记录，请带 confirm: true 重试；',
              "若只是重复，请改记别的事实，或不再写入。",
            ].join("\n"),
          );
        }
        if (value?.duplicate === true) {
          return textBlock(`未写入：该条已存在于 ${value.path} 的尾部（完全重复）。`);
        }
        const note =
          value?.sameFactOtherDate === undefined
            ? ""
            : `\n  已按 confirm 写入；同一事实此前记于 ${value.sameFactOtherDate}。`;
        const warn = value?.warning === undefined ? "" : `\n  ⚠️ ${value.warning}`;
        return textBlock(
          `已写入 ${value.target}/${value.shard}\n  path=${value.path} line=${value.line}\n  entry=${value.entry}\n  该分片现有 ${value.totalEntries} 条。${note}${warn}`,
        );
      },
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const requested = args?.target;
      const target =
        requested === "global" || requested === "project"
          ? requested
          : cwd === undefined
            ? "global"
            : "project";
      return appendMemory({
        target,
        cwd,
        shard: args?.shard,
        fact: args?.fact,
        date: args?.date,
        confirm: args?.confirm,
        keywords: args?.keywords,
      });
    },
  };
}

/**
 * `memory_correct` 的 output schema。
 *
 * 注意 `superseded` / `newEntry` 都用 `additionalProperties: true` 的宽松对象：
 * 宿主会按本 schema 校验返回值，字段收紧到逐个声明反而容易在演进时卡住自己。
 */
const CORRECT_OUTPUT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    reason: { type: "string" },
    target: { type: "string" },
    shard: { type: "string" },
    path: { type: "string" },
    retracted: { type: "boolean" },
    newEntry: { type: "string" },
    newId: { type: "string" },
    newLine: { type: "number" },
    totalEntries: { type: "number" },
    warning: { type: "string" },
  },
};

/**
 * 构造 `memory_correct` 定义。
 *
 * 这是 P1 的核心：让记忆**可修正**。取代语义而非删除 —— 旧条目就地注释、不再进地图
 * 也不再被检索命中，新条目带 `[fix:<类型> of #<旧 id>]` 链接。
 *
 * @returns {object} ToolDefinition。
 */
export function memoryCorrectTool() {
  return {
    name: "memory_correct",
    description:
      "Replace a long-term memory entry that has turned out to be wrong. Use it in exactly three situations: (1) you discovered a DEFECT (your own earlier implementation or judgement was broken), (2) a PREVIOUS CONCLUSION is OVERTURNED, (3) the USER CORRECTED you. The old entry is kept in the file as a comment for history but stops being injected and stops matching memory_search, so the stale conclusion can no longer mislead. Requires the entry id from memory_search. Prefer this over memory_add whenever you are fixing something you previously recorded — appending instead would leave the wrong entry live.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The id shown by memory_search for the entry being replaced, e.g. a3f1.",
        },
        reason: {
          type: "string",
          enum: ["defect", "overturned", "correction", "retract"],
          description:
            "defect = you found a bug in something you recorded; overturned = a previous conclusion proved wrong; correction = the user corrected you; retract = the fact no longer holds and there is no replacement.",
        },
        replacement: {
          type: "string",
          description: `The corrected fact, ONE line. Required unless reason=retract. State the corrected conclusion, not a narration of the fix. Keep it under ${configNum("inlineTextMax")} characters if you want it fully visible in the injected map (longer entries get truncated there, and you get a warning when that happens).`,
        },
        shard: {
          type: "string",
          description: "Restrict the lookup to one shard. Omit to search every shard in the layer.",
        },
        target: {
          type: "string",
          enum: ["global", "project"],
          description: "Which layer the entry lives in. Defaults to project when a working directory exists.",
        },
      },
      required: ["id", "reason"],
    },
    output: {
      schema: CORRECT_OUTPUT,
      render(_args, value) {
        const superseded = `#${value.superseded?.id ?? "?"}（${value.superseded?.date ?? "?"}）：${value.superseded?.text ?? ""}`;
        if (value?.retracted === true) {
          return textBlock(
            `已撤回（retract）${value.target}/${value.shard}\n  失效条目 ${superseded}\n  文件 line=${value.superseded?.line ?? "?"} 已就地标记为历史，不再注入、不再被检索命中。\n  该分片现余 ${value.totalEntries} 条有效记忆。`,
          );
        }
        const warn = value?.warning === undefined ? "" : `\n  ⚠️ ${value.warning}`;
        return textBlock(
          [
            `已修正（${value.reason}）${value.target}/${value.shard}`,
            `  失效条目 ${superseded}`,
            `    └ 已就地标记为历史，${value.path} line=${value.superseded?.line ?? "?"}`,
            `      它不再注入提示词、也不再被 memory_search 命中 —— 不会再误导后续判断。`,
            `  新条目 #${value.newId ?? "?"} line=${value.newLine ?? "?"}`,
            `    ${value.newEntry ?? ""}`,
            `  该分片现余 ${value.totalEntries} 条有效记忆。${warn}`,
          ].join("\n"),
        );
      },
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const requested = args?.target;
      const target =
        requested === "global" || requested === "project"
          ? requested
          : cwd === undefined
            ? "global"
            : "project";
      return correctMemory({
        target,
        cwd,
        shard: args?.shard,
        id: args?.id,
        reason: args?.reason,
        replacement: args?.replacement,
        });
    },
  };
}

/** `memory_cleanup` 的 output schema。 */
const CLEANUP_OUTPUT = {
  type: "object",
  properties: {
    ran: { type: "boolean" },
    reason: { type: "string" },
    today: { type: "string" },
    days: { type: "number" },
    cutoff: { type: "string" },
    archived: { type: "number" },
    removedShards: { type: "number" },
    layers: { type: "array" },
  },
};

/**
 * 构造 `memory_cleanup` 定义（0.2.0 的容量策略入口）。
 *
 * 为什么要有模型可见的入口：自动清理是"当天首次启动 + 延迟"触发的，**不是随时可看**；
 * 而"这份归档里到底有什么、去哪读"必须有一个不靠猜的答案。同时它也让清理这件事
 * **不神秘** —— 模型（和用户）随时能自己跑一次看结果。
 *
 * @returns {object} ToolDefinition。
 */
export function memoryCleanupTool() {
  return {
    name: "memory_cleanup",
    description:
      "Run (or inspect) the memory capacity policy: entries that were already SUPERSEDED or RETRACTED by memory_correct, and are older than the configured grace period (default 3 days), are physically moved out of the shard into that layer's archive directory; a shard left with no live entries is archived whole and its file removed. Live entries are NEVER moved — 'rarely searched' is not 'useless'. Archived content is not injected and is not matched by memory_search. Returns what was moved and where. Also runs automatically once per day, about 10 seconds after the app's first start that day.",
    parameters: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description:
            "Run even if today's automatic cleanup already happened. Defaults to true (an explicit call is an explicit intent); set false to let the once-per-day rule also apply here.",
        },
        days: {
          type: "number",
          description: "Override the grace period in days for this call (minimum 1). Defaults to the configured cleanupDays.",
        },
        target: {
          type: "string",
          enum: ["global", "project", "all"],
          description: "Which layer to clean. Defaults to all.",
        },
      },
    },
    output: {
      schema: CLEANUP_OUTPUT,
      render(_args, value) {
        if (value?.reason === "disabled") {
          return textBlock(
            "归档已关闭（config.cleanupEnabled = false）：没有搬动任何东西，分片与归档目录都保持原样。",
          );
        }
        const lines = [
          `容量策略：失效满 ${value?.days ?? "?"} 天起可归档（截止日 ${value?.cutoff ?? "?"}；本次运行日 ${value?.today ?? "?"}）。`,
        ];
        for (const layer of value?.layers ?? []) {
          const name = layer.target === "global" ? "全局层" : "项目层";
          if (layer.error !== undefined) {
            lines.push(`- ${name}：跳过（${layer.error}）`);
            continue;
          }
          if (layer.skipped !== undefined) {
            lines.push(`- ${name}：今天已经清理过，跳过（force:true 可强制重跑）`);
            continue;
          }
          const moved = layer.archived ?? [];
          const removed = layer.removedShards ?? [];
          if (moved.length === 0 && removed.length === 0) {
            lines.push(`- ${name}：没有可归档的失效条目（活条目一律不动）。`);
            continue;
          }
          for (const a of moved) {
            lines.push(
              `- ${name}：${a.shard} 归档 ${a.count} 条 → ${a.file}${a.wholeShard ? "（整片归档，分片文件已移除）" : ""}`,
            );
          }
          if (removed.length > 0) lines.push(`  ${name}：已被移除的空分片：${removed.join(" / ")}`);
        }
        lines.push(
          "",
          "归档件是**原样保留的失效条目**（连取代注释一起搬），需要复原就把行贴回原分片 ——",
          "它不在注入里、也不被 memory_search 命中；要读原文请用 read + 上面的归档路径。",
        );
        return textBlock(lines.join("\n"));
      },
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const target = args?.target === "global" || args?.target === "project" ? args.target : undefined;
      const result = await runCleanup({
        cwd,
        // 显式调用默认强制跑：否则"今天自动清理过了"会让这次调用看起来什么都没做，
        // 而在真实场景里这恰恰是用户最想要的那次（刚取代完一批记忆）。
        force: args?.force !== false,
        ...(Number.isInteger(args?.days) ? { days: args.days } : {}),
      });
      if (target === undefined) return result;
      return { ...result, layers: (result.layers ?? []).filter((l) => l.target === target) };
    },
  };
}

/**
 * 全部工具定义。
 *
 * @returns {object[]} 五个 ToolDefinition。
 */
export function allTools() {
  return [memoryListTool(), memorySearchTool(), memoryAddTool(), memoryCorrectTool(), memoryCleanupTool()];
}
