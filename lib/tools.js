/**
 * 三个模型可见的工具：`memory_list` / `memory_search` / `memory_add`。
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

import { appendMemory, listLayer, searchMemory } from "./engine.js";
import { cwdOf } from "./context.js";

/** 全局层与项目层的根目录展示路径。 */
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

/**
 * 把一次工具调用的结果渲染成单个 text block。
 *
 * @param {string} text - 文本。
 * @returns {{type:'text',text:string}[]} 内容块。
 */
function textBlock(text) {
  return [{ type: "text", text }];
}

/** `memory_list` 的 output schema。 */
const LIST_OUTPUT = {
  type: "object",
  properties: {
    roots: { type: "object" },
    layers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target: { type: "string" },
          dir: { type: "string" },
          total: { type: "number" },
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
      "List long-term memory as a map: every layer (global / project) and every shard with its entry count, latest date, keywords and file path. Call this before a task to see what is already known, or to discover which shard to search. Returns paths, not entry bodies — use memory_search to pull entries.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["global", "project", "all"],
          description: "Which layer to list. Defaults to all.",
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
          lines.push(`## ${layer.target === "global" ? "全局记忆" : "项目记忆"}（${layer.total} 条 · ${layer.dir}）`);
          if ((layer.shards ?? []).length === 0) {
            lines.push("- （空）");
            continue;
          }
          for (const s of layer.shards) {
            const kw = s.keywords === "" ? "" : ` ｜ 关键词：${s.keywords}`;
            lines.push(`- ${s.name}：${s.count} 条 ｜ 最新 ${s.latest || "—"} ｜ ${s.path}${kw}`);
          }
        }
        return textBlock(lines.join("\n"));
      },
    },
    async execute(args, exec) {
      const requested = args?.target;
      const targets =
        requested === "global" || requested === "project" ? [requested] : ["global", "project"];
      const cwd = cwdOf(exec);
      const layers = [];
      for (const target of targets) {
        try {
          const layer = listLayer(target, cwd);
          layers.push({
            target,
            dir: layer.dirPath,
            total: layer.total,
            shards: layer.shards.map((s) => ({
              name: s.name,
              path: s.path,
              count: s.entries.length,
              latest: s.latest,
              keywords: s.keywords,
            })),
          });
        } catch {
          // 项目层无 cwd 时跳过；缺席是可见的（layers 里就没有这一层）。
        }
      }
      return { roots: rootsFor(cwd), layers };
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
          lines.push(`- [${h.date}] ${h.text}`);
          lines.push(`  └ source=${h.target}/${h.shard} path=${h.path} line=${h.line}`);
        }
        if (value.truncated === true) {
          lines.push("");
          lines.push("（命中被 limit 截断；如需更多请提高 limit 或收窄 query。）");
        }
        return textBlock(lines.join("\n"));
      },
    },
    async execute(args, exec) {
      return searchMemory(args?.query, {
        target: args?.target,
        shard: args?.shard,
        limit: args?.limit,
        cwd: cwdOf(exec),
      });
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
            "The fact, as ONE line, without a leading `- [date]` prefix (the plugin adds it). Roughly under 2000 characters.",
        },
        target: {
          type: "string",
          enum: ["global", "project"],
          description:
            "global = true across projects (user preferences, tooling gotchas). project = only about this repository, stored inside the repo at .dsh-memory/. Defaults to project when a working directory exists, otherwise global.",
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
        return textBlock(
          `已写入 ${value.target}/${value.shard}\n  path=${value.path} line=${value.line}\n  entry=${value.entry}\n  该分片现有 ${value.totalEntries} 条。${note}`,
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
      });
    },
  };
}

/**
 * 全部工具定义。
 *
 * @returns {object[]} 三个 ToolDefinition。
 */
export function allTools() {
  return [memoryListTool(), memorySearchTool(), memoryAddTool()];
}
