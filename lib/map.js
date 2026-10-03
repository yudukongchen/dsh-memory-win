/**
 * 地图档渲染：注入系统提示词的**只有地图**，正文永远按需检索。
 *
 * 这是 dsh-memory "map" 档的取舍，本插件沿用并收紧两点：
 *
 * 1. **头行只放档位，不放统计数字。** dsh-memory 用实测（写一条记忆后子代理首轮
 *    cacheRead 从 85% 掉回 0%）证明：头行在系统提示词最前面，一放"N 片 / M 条"
 *    这种**每写一条就变**的数字，整个前缀就失去缓存。统计一律挪到段尾。
 *    本插件在地图层与纪律块的分工上照此执行。
 * 2. **小层内联阈值来自 config（默认 8）。** 内联的目的是"少让模型跑一次检索"，
 *    但当一层只有 8 条时内联的收益已经很小，而代价是每轮固定开销。取 8 是两者之间的
 *    保守选择；0.2.0 起它可以在 profile 的 `config: { inlineThreshold }` 里调。
 *
 * @module dsh-memory-win/lib/map
 */

import { configNum, configValue } from "./config.js";
import { listLayer } from "./engine.js";
import { neutralizePromptVars, oneLine } from "./format.js";

/** 注入段的名称（与 index.js 注册的 section name 保持一致）。 */
export const SECTION_NAME = "dsh-memory-win:map";

/**
 * 渲染一层。
 *
 * @param {object} layer - `listLayer()` 的结果。
 * @param {string} label - 层标题（中文）。
 * @returns {string} markdown 片段；无内容时返回空串。
 */
function renderLayer(layer, label) {
  if (layer.shards.length === 0 || layer.total === 0) return "";

  const inlineMax = configNum("inlineThreshold");
  const displayMax = configNum("inlineTextMax");
  const inline = layer.total <= inlineMax;
  const lines = [`### ${label}`];

  if (inline) {
    // 条目少：逐条内联比让模型多跑一次检索更值。头部显式标注档位，
    // 避免同一份注入里出现两种措辞让模型以为有两套检索方式。
    lines.push(`<!-- 本层条目少（${layer.total} 条），已逐条内联；细分片路径 ${layer.dirPath} -->`);
    for (const shard of layer.shards) {
      for (const entry of shard.entries) {
        // id 一并内联：内联档下模型不必再跑一次 memory_search 就能修正这条，
        // 代价约每条 6 字符，远低于一次检索往返。
        lines.push(`- [${entry.date}] #${entry.id} ${oneLine(entry.text).slice(0, displayMax)}`);
      }
    }
  } else {
    // 地图档：每片一行。片名说"这片叫什么"，关键词说"这片讲什么"。
    for (const shard of layer.shards) {
      if (shard.entries.length === 0) continue;
      // 关键词为空时**显式写出"未设置"**，而不是悄悄省略这一段。
      // 省略会让"这片没有检索线索"变成不可见 —— 模型只能靠片名猜，用户也看不出
      // 该去补关键词。这是与 dsh-memory 的一处有意差异：它同样省略空关键词，
      // 于是关键词头形同虚设时没有任何信号。
      const kw =
        shard.keywords === ""
          ? " ｜ 关键词：（未设置）"
          : ` ｜ 关键词：${oneLine(shard.keywords).slice(0, configNum("keywordsMaxChars"))}`;
      lines.push(`- ${shard.name}：${shard.entries.length} 条 ｜ 最新 ${shard.latest || "—"} ｜ ${shard.path}${kw}`);
    }
  }

  return lines.join("\n");
}

/**
 * 渲染完整注入段 + **分项统计**（0.2.5 效果日志用）。
 *
 * 任何一层失败（例如项目层没有 cwd）都只是**该层缺席**，绝不让整个提示词组装失败 ——
 * 这是与"静默失效"相反的一条纪律：缺席是可见的（段里会写"项目层不可用"），
 * 而不是悄悄少一层让人以为记忆是空的。
 *
 * **两层都为空时仍然注入**：这一段还承担"纪律块"的职责，若空态整段消失，
 * 模型就不知道记忆功能存在，也就永远不会写下第一条。空态文案是常量，
 * 不随记忆增长变化，因此不损害前缀缓存。
 *
 * 统计与文本**同一次装配产出**，避免"为了量长度再渲染一遍"（那次渲染可能读到
 * 已经变化的记忆）。分项口径：
 *
 * - `chars`：最终返回串的总长（过完 `neutralizePromptVars` 之后）；
 * - `parts.discipline` / `parts.global` / `parts.project`：三块正文的中和后长度；
 * - `parts.other`：头行、空态/不可用注记、段尾统计**与全部块间分隔符** ——
 *   四项相加恒等于 `chars`（回归测试会断言这个校验和）；
 * - `modes`：各层档位 `inline` / `map` / `empty` / `unavailable`。
 *
 * @param {{cwd?:string}} [options] - 会话信息。
 * @returns {{text:string, stats:{chars:number, parts:object, modes:object}}} 注入文本与统计。
 */
export function renderMapWithStats(options = {}) {
  const cwd = typeof options.cwd === "string" && options.cwd.trim() !== "" ? options.cwd : undefined;
  /** @type {{role:string, text:string}[]} 各块带角色，便于分项统计。 */
  const parts = [];
  const push = (role, text) => {
    if (text !== "") parts.push({ role, text });
  };

  let globalLayer;
  try {
    globalLayer = listLayer("global", cwd);
  } catch {
    globalLayer = undefined;
  }

  let projectLayer;
  let projectUnavailable = false;
  if (cwd === undefined) {
    projectUnavailable = true;
  } else {
    try {
      projectLayer = listLayer("project", cwd);
    } catch {
      projectUnavailable = true;
    }
  }

  const globalBlock = globalLayer === undefined ? "" : renderLayer(globalLayer, "全局记忆");
  const projectBlock = projectLayer === undefined ? "" : renderLayer(projectLayer, "项目记忆");

  // ── 头行：只有档位，没有统计数字（prefix cache） ──────────────────────────
  // 即便两层都还空着也要注入：这一段同时承担"纪律块"的职责 —— 若记忆为空时整段
  // 消失，模型就既不知道记忆功能存在、也不知道该在收尾时写入，于是永远不会有第一条。
  // 空态文案刻意是**常量**，不随记忆增长而变，因此不影响前缀缓存。
  push("head", "## 长期记忆（地图档 · 正文按需检索）");

  if (globalBlock === "" && projectBlock === "") {
    push("empty", "<!-- 目前还没有任何记忆。有值得复用的结论、用户偏好或踩坑成因时，用 memory_add 写入第一条。 -->");
  } else {
    push("global", globalBlock);
    push("project", projectBlock);
  }

  if (projectUnavailable) {
    push("unavailable", "### 项目记忆\n<!-- 当前会话没有工作目录，项目层不可用；只有全局层生效。 -->");
  }

  // ── 纪律块：把"怎么取回/怎么写/怎么改/怎么清理"写成确定的动作 ──────────────
  push(
    "discipline",
    [
      "### 取回 · 写入 · 修正 · 归档",
      "- **取回**：`memory_search` 传任务关键词 → 命中行给出 `id`/`date`/`path`/`line` → 用 `read` 按 `offset`/`limit` 取原文。",
      "  它的 `path` 是**绝对路径**，可直接喂给 `read`（地图里的片路径则是层内相对）。",
      "  命中 3 条以上、或跨 2 片以上时派检索子代理，只让它回「事实 + 文件与行号」，原文留在子代理上下文里。",
      "- **写入**：`memory_add` 追加一条，`target` 选 `global`（跨项目通用）或 `project`（只与当前仓库有关），",
      "  `shard` 选主题分片。钩子会校验格式、日期与凭据；被拒时按错误信息改。",
      `  正文保持在 ${configNum("inlineTextMax")} 字符内（内联档的显示上限），超了会在注入里被截断；写入上限是 ${configNum("factBodyMax")}。`,
      "  新建分片时请带上 `keywords`（几个能区分的词）—— 它写进首行并显示在上面的地图里，",
      "  是不打开这片就能判断其内容的唯一线索；已存在的分片不接受 `keywords`。",
      "- **长内容**（复盘 / 排查过程 / 长清单）：记忆一条只能是单行，塞不下就别塞 —— 把原文写进仓库普通文档",
      "  （如 `docs/postmortem-<主题>.md`，写它不受记忆守卫限制），记忆里只留**一行指针**：",
      "  `根因/结论 + 症状关键词 + 文档路径`；复述时先 `memory_search` 命中该行、再 `read` 取全文 —— 关键词要写全，否则搜不到。",
      "- **修正**：`memory_correct` 取代一条**已经错了**的记忆，`id` 取自 `memory_search`、`reason` 取四类之一：",
      "  `defect`（发现缺陷）｜`overturned`（之前结论被推翻）｜`correction`（用户纠正你）｜`retract`（不再成立且无新结论）。",
      "  旧条目会被就地标记为历史：**不再注入、也不再被检索命中** —— 所以不要用 `memory_add` 绕过它，",
      "  否则错的结论会继续留在上下文里误导后续判断。",
      `- **归档**：失效条目与空分片会在**失效满 ${configNum("cleanupDays")} 天**后由当天的首次清理搬进`,
      `  「层目录/${configValue("archiveDir")}/」（软件当天首次启动约 ${configNum("cleanupDelaySeconds")} 秒后自动跑一次），`,
      `  归档**不进注入、也不会被检索命中**。要看清单或立刻跑一次用 \`memory_cleanup\`；`,
      "  它只搬**已经失效**的条目 —— 活条目永远不会被搬走，所以「很久没被问到」不等于「没用了」。",
      "- **该记**：可复用的结论、用户偏好、坑与成因、环境事实。**不该记**：过程叙述（见上「长内容」）、一次性的命令输出。",
      "- **诚实边界**：本层是地图，不是全文 —— 没在下面的内容需要你自己检索，不要凭地图臆测。",
    ].join("\n"),
  );

  // ── 段尾统计：变化点尽量靠后，保护前缀缓存 ────────────────────────────────
  const shardCount = (globalLayer?.shards.length ?? 0) + (projectLayer?.shards.length ?? 0);
  const entryCount = (globalLayer?.total ?? 0) + (projectLayer?.total ?? 0);
  const archivedCount = (globalLayer?.archived ?? 0) + (projectLayer?.archived ?? 0);
  // 归档件数放在脚注：它是**低频变化**的数字（清理时才变），且不占前言。
  const archivedNote = archivedCount === 0 ? "" : ` · 归档 ${archivedCount} 件（不参与注入，见 memory_cleanup）`;
  push(
    "foot",
    `<!-- 记忆合计 ${shardCount} 片 / ${entryCount} 条${archivedNote} · 全局层 ${globalLayer?.dirPath ?? "(不可用)"} -->`,
  );

  const text = neutralizePromptVars(parts.map((p) => p.text).join("\n\n"));

  // ── 分项统计（校验和必须闭合） ────────────────────────────────────────────
  const lengthOf = (role) => {
    const block = parts.find((p) => p.role === role);
    return block === undefined ? 0 : neutralizePromptVars(block.text).length;
  };
  const discipline = lengthOf("discipline");
  const global = lengthOf("global");
  const project = lengthOf("project");
  // other 独立计算（头行/注记/脚注 + 每个块间一个 "\n\n"），不从总数倒减 ——
  // 倒减会让校验和恒真，测试就抓不到装配错误了。
  const other =
    parts
      .filter((p) => p.role !== "discipline" && p.role !== "global" && p.role !== "project")
      .reduce((sum, p) => sum + neutralizePromptVars(p.text).length, 0) +
    2 * Math.max(0, parts.length - 1);

  const stats = {
    chars: text.length,
    parts: { discipline, global, project, other },
    modes: {
      global: layerMode(globalLayer, globalBlock, false),
      project: layerMode(projectLayer, projectBlock, projectUnavailable),
    },
  };
  return { text, stats };
}

/**
 * 渲染完整注入段（只取文本；统计版见 `renderMapWithStats`）。
 *
 * @param {{cwd?:string}} [options] - 会话信息。
 * @returns {string} 注入文本（永不为空串）。
 */
export function renderMap(options = {}) {
  return renderMapWithStats(options).text;
}

/**
 * 某层的注入档位（日志口径）。
 *
 * @param {object|undefined} layer - `listLayer()` 结果（`undefined` = 该层不可用）。
 * @param {string} block - 该层渲染出的文本块（空串 = 没有内容）。
 * @param {boolean} unavailable - 该层是否已声明不可用。
 * @returns {'inline'|'map'|'empty'|'unavailable'} 档位。
 */
function layerMode(layer, block, unavailable) {
  if (unavailable || layer === undefined) return "unavailable";
  if (block === "") return "empty";
  return layer.total <= configNum("inlineThreshold") ? "inline" : "map";
}
