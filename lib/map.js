/**
 * 地图档渲染：注入系统提示词的**只有地图**，正文永远按需检索。
 *
 * 这是 dsh-memory "map" 档的取舍，本插件沿用并收紧两点：
 *
 * 1. **头行只放档位，不放统计数字。** dsh-memory 用实测（写一条记忆后子代理首轮
 *    cacheRead 从 85% 掉回 0%）证明：头行在系统提示词最前面，一放"N 片 / M 条"
 *    这种**每写一条就变**的数字，整个前缀就失去缓存。统计一律挪到段尾。
 *    本插件在地图层与纪律块的分工上照此执行。
 * 2. **小层内联阈值从 12 收紧到 8。** 内联的目的是"少让模型跑一次检索"，但当一层
 *    只有 8 条时内联的收益已经很小，而代价是每轮固定开销。取 8 是两者之间的
 *    保守选择，且对外显式导出为常量便于后续调参。
 *
 * @module dsh-memory-win/lib/map
 */

import { INLINE_MAX_ENTRIES, listLayer } from "./engine.js";
import { neutralizePromptVars, oneLine } from "./format.js";

/** 注入段的名称（与 index.js 注册的 section name 保持一致）。 */
export const SECTION_NAME = "dsh-memory-win:map";

/** 单条内联文本的截断长度。 */
const INLINE_TEXT_MAX = 160;

/**
 * 渲染一层。
 *
 * @param {object} layer - `listLayer()` 的结果。
 * @param {string} label - 层标题（中文）。
 * @returns {string} markdown 片段；无内容时返回空串。
 */
function renderLayer(layer, label) {
  if (layer.shards.length === 0 || layer.total === 0) return "";

  const inline = layer.total <= INLINE_MAX_ENTRIES;
  const lines = [`### ${label}`];

  if (inline) {
    // 条目少：逐条内联比让模型多跑一次检索更值。头部显式标注档位，
    // 避免同一份注入里出现两种措辞让模型以为有两套检索方式。
    lines.push(`<!-- 本层条目少（${layer.total} 条），已逐条内联；细分片路径 ${layer.dirPath} -->`);
    for (const shard of layer.shards) {
      for (const entry of shard.entries) {
        // id 一并内联：内联档下模型不必再跑一次 memory_search 就能修正这条，
        // 代价约每条 6 字符，远低于一次检索往返。
        lines.push(`- [${entry.date}] #${entry.id} ${oneLine(entry.text).slice(0, INLINE_TEXT_MAX)}`);
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
          : ` ｜ 关键词：${oneLine(shard.keywords).slice(0, 160)}`;
      lines.push(`- ${shard.name}：${shard.entries.length} 条 ｜ 最新 ${shard.latest || "—"} ｜ ${shard.path}${kw}`);
    }
  }

  return lines.join("\n");
}

/**
 * 渲染完整注入段。
 *
 * 任何一层失败（例如项目层没有 cwd）都只是**该层缺席**，绝不让整个提示词组装失败 ——
 * 这是与"静默失效"相反的一条纪律：缺席是可见的（段里会写"项目层不可用"），
 * 而不是悄悄少一层让人以为记忆是空的。
 *
 * **两层都为空时仍然注入**：这一段还承担"纪律块"的职责，若空态整段消失，
 * 模型就不知道记忆功能存在，也就永远不会写下第一条。空态文案是常量，
 * 不随记忆增长变化，因此不损害前缀缓存。
 *
 * @param {{cwd?:string}} [options] - 会话信息。
 * @returns {string} 注入文本（永不为空串）。
 */
export function renderMap(options = {}) {
  const cwd = typeof options.cwd === "string" && options.cwd.trim() !== "" ? options.cwd : undefined;
  const blocks = [];

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
  blocks.push("## 长期记忆（地图档 · 正文按需检索）");

  if (globalBlock === "" && projectBlock === "") {
    blocks.push("<!-- 目前还没有任何记忆。有值得复用的结论、用户偏好或踩坑成因时，用 memory_add 写入第一条。 -->");
  } else {
    if (globalBlock !== "") blocks.push(globalBlock);
    if (projectBlock !== "") blocks.push(projectBlock);
  }

  if (projectUnavailable) {
    blocks.push("### 项目记忆\n<!-- 当前会话没有工作目录，项目层不可用；只有全局层生效。 -->");
  }

  // ── 纪律块：把"怎么取回/怎么写/怎么改"写成确定的动作 ──────────────────────
  blocks.push(
    [
      "### 取回 · 写入 · 修正",
      "- **取回**：`memory_search` 传任务关键词 → 命中行给出 `id`/`date`/`path`/`line` → 用 `read` 按 `offset`/`limit` 取原文。",
      "  命中 3 条以上、或跨 2 片以上时派检索子代理，只让它回「事实 + 文件与行号」，原文留在子代理上下文里。",
      "- **写入**：`memory_add` 追加一条，`target` 选 `global`（跨项目通用）或 `project`（只与当前仓库有关），",
      "  `shard` 选主题分片。钩子会校验格式、日期与凭据；被拒时按错误信息改。",
      "- **修正**：`memory_correct` 取代一条**已经错了**的记忆，`id` 取自 `memory_search`、`reason` 取四类之一：",
      "  `defect`（发现缺陷）｜`overturned`（之前结论被推翻）｜`correction`（用户纠正你）｜`retract`（不再成立且无新结论）。",
      "  旧条目会被就地标记为历史：**不再注入、也不再被检索命中** —— 所以不要用 `memory_add` 绕过它，",
      "  否则错的结论会继续留在上下文里误导后续判断。",
      "- **该记**：可复用的结论、用户偏好、坑与成因、环境事实。**不该记**：过程叙述、一次性的命令输出。",
      "- **诚实边界**：本层是地图，不是全文 —— 没在下面的内容需要你自己检索，不要凭地图臆测。",
    ].join("\n"),
  );

  // ── 段尾统计：变化点尽量靠后，保护前缀缓存 ────────────────────────────────
  const shardCount = (globalLayer?.shards.length ?? 0) + (projectLayer?.shards.length ?? 0);
  const entryCount = (globalLayer?.total ?? 0) + (projectLayer?.total ?? 0);
  blocks.push(`<!-- 记忆合计 ${shardCount} 片 / ${entryCount} 条 · 全局层 ${globalLayer?.dirPath ?? "(不可用)"} -->`);

  return neutralizePromptVars(blocks.join("\n\n"));
}
