/**
 * 配置读取层（0.2.0 起）：把原先散落在各文件里的**行为阈值**收敛到一个入口。
 *
 * ## 为什么需要它
 *
 * 0.1.x 的阈值全是硬编码常量，散落在四处：`format.js` 的 `INLINE_TEXT_MAX`（160）、
 * `validateFactBody` 的 2000、`engine.js` 的 `INLINE_MAX_ENTRIES`（8）、
 * `format.js` 的 8 类凭据模式与 120 字符关键词上限。要调任何一个都得改源码、重打包、
 * 重启桌面版（README 环境事实 E5：HMR 不监听插件模块文件）。
 *
 * 更麻烦的是**交叉约束只能靠人肉保证**：`inlineTextMax` 一旦被调到大于 `factBodyMax`，
 * "写入侧截断提醒"就永远不可能触发 —— 因为超限的正文在写入校验那一步已经被拒了。
 * 这类约束现在由本模块在启动时显式校验。
 *
 * ## 三道职责（刻意保持"薄"）
 *
 * 1. **唯一出口**：其它模块不再直接持有阈值，而是 `configNum("inlineTextMax")`；
 * 2. **解析顺序**：内置默认 < profile patch 的 `config:` 段。顺序写死在本文件，
 *    不允许后来者乱序；
 * 3. **启动时校验**：类型、范围与交叉约束，非法即抛（fail-visible，不静默回落）。
 *
 * ## 与 DSH 的实际契约（实读宿主运行时得到，不是照类型声明推测）
 *
 * profile 的 `cordis.patch.yml` 里那条 `- id: dsh-memory-win / config: {...}` 会
 * **整段替换** bundle patch 里 insert 的 `config: {}`（`applyEntryPatches` 对非 insert
 * patch 做 `target[key] = value`）。Cordis 随后把该值作为**第二个参数**交给
 * `apply(ctx, config)`（`Fiber` 里是 `runtime.callback(this.ctx, this.config)`）。
 *
 * 因此：**只要是"部分配置"，未写的键由本模块补默认值** —— 不要指望宿主替你合并。
 *
 * ## 为什么不导出 schemastery 的 `Config` schema
 *
 * 宿主侧确实支持 `export const Config`（内部用 `@deepseek-ai/schemastery` 校验），但：
 * ① 那会让"校验/默认值"分处两地（宿主一遍、本模块一遍），正是本项目在守卫覆盖面
 * （README 第 3 节限制 2）与 160 截断上吃过两次亏的形态；
 * ② 本插件是零依赖的，`credentialPatterns` 这类含正则的值还要靠 `Schema.any()`
 * 绕过去，等于把语义押在第三方 schema 库的行为上。
 * 所以校验全部留在本模块，是**纯函数**、可穷举测试，且不依赖宿主版本。
 *
 * @module dsh-memory-win/lib/config
 */

/**
 * 默认值表。**唯一的默认值定义处。**
 *
 * 键名用 camelCase，与 `cordis.patch.yml` 里其它插件（`reasoningEffort`、
 * `defaultPreset`…）的写法保持一致。
 */
export const CONFIG_DEFAULTS = Object.freeze({
  /** 内联档每条正文的**显示**上限（字符）。超了只截断 + 提醒，正文仍完整落盘。 */
  inlineTextMax: 160,
  /** 单条正文的**写入**上限（字符）。超了直接拒绝。必须 ≥ `inlineTextMax`。 */
  factBodyMax: 2000,
  /** 某层条目数不超过它时，地图里逐条内联；超过则切"每片一行"的地图档。 */
  inlineThreshold: 8,
  /** 片级关键词上限（字符）。地图档每条片行只有 ~68 字符，关键词不该喧宾夺主。 */
  keywordsMaxChars: 120,
  /** 全局层在 DSH 主目录下的子路径（`a/b` → `a\b`）。 */
  globalSubpath: ["memory-win", "global"],
  /** 项目层目录名（相对会话 cwd）。 */
  projectDir: ".agent-memory",
  /** 归档目录名（相对各层目录）。归档不参与注入、也不会被默认检索命中。 */
  archiveDir: "archive",
  /** 每层状态文件名（相对各层目录），承载检索命中记录与当天清理标记。 */
  stateFile: ".state.json",

  /**
   * 容量策略：**已失效条目**在多少天后可以被物理归档。
   *
   * 语义是"取代/撤回发生的日期距今天 ≥ N 天"（`date < today - N`），
   * 不是"条目创建日期"。默认 3，最小 1（`0` 会让刚取代完的历史立刻被搬走，
   * 使取代的可追溯性名存实亡）。
   */
  cleanupDays: 3,
  /** 启动后多少秒触发当天首次清理。0 = 立即（测试用）。 */
  cleanupDelaySeconds: 10,
  /** 是否启用容量策略（当天首次清理 + `memory_cleanup` 手动触发）。 */
  cleanupEnabled: true,
  /**
   * 一次清理最多处理多少个**已知工作区**的项目层。
   *
   * 后台清理拿不到"当前会话的 cwd"（触发时可能还没有会话），所以它按
   * `storages/workspace.json` 里登记过的路径逐个清理项目层。这个上限是防呆：
   * 工作区很多时不要让一次清理扫一整个磁盘树。
   */
  maxProjectLayers: 20,

  /**
   * 凭据扫描模式：`{ 模式名: 正则源码字符串 }`，整段替换内置的 8 类。
   *
   * 用**字符串**而不是 `RegExp`：配置来自 YAML/JSON，那里没有正则字面量；
   * 且字符串能被纯函数层直接比较与测试。`g`/`y` 标志会被剥掉（它们带 `lastIndex`
   * 状态，复用同一个正则会让 `test()` 在多次调用间忽真忽假 —— 这正是"看起来正常
   * 但不成立"的一类）。
   *
   * 只想关掉某一类时，把它从这张表里删掉即可（替换语义，不做逐类合并）。
   */
  credentialPatterns: null, // null = 用 lib/format.js 里的内置 8 类

  /** 归档的路由说明。**这段文本是纪律块与 README 的同一份正本。** */
  archivePointer:
    "归档 = 已失效条目与空分片的物理去处；正本在「层目录/归档目录」下、不在注入里，需要时用 memory_cleanup 查看清单",
});

/** 数值型键的合法区间，兼作启动校验表。 */
const NUMERIC_BOUNDS = Object.freeze({
  inlineTextMax: [1, 100000],
  factBodyMax: [1, 1000000],
  inlineThreshold: [1, 10000],
  keywordsMaxChars: [1, 10000],
  cleanupDays: [1, 10000],
  cleanupDelaySeconds: [0, 86400],
  maxProjectLayers: [0, 10000],
});

/** 必须是非空单行字符串的键。 */
const STRING_KEYS = Object.freeze(["projectDir", "archiveDir", "stateFile"]);

/** 解析后的当前配置。模块级唯一状态，只在 `initConfig` 里整体替换。 */
let current = normalizeConfig(undefined);

/**
 * 把任意原始配置规范化成一份**完整**配置。
 *
 * 纯函数、不碰文件系统、不改入参 —— 因此可以被穷举测试，也符合 README 第 6 节的
 * 分层原则（判定与 I/O 分离）。
 *
 * 未知键**保留**（前向兼容：旧版插件读新版配置不该炸，反之亦然），但不参与校验。
 *
 * @param {object|undefined} raw - `config:` 段的原始值。
 * @returns {object} 完整配置（新对象）。
 * @throws {Error} 类型、范围或交叉约束非法时抛出，消息面向"改配置的人"可执行。
 */
export function normalizeConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(`配置非法：config 必须是一个对象，收到 ${Array.isArray(raw) ? "数组" : typeof raw}`);
  }
  const given = raw ?? {};
  const out = { ...CONFIG_DEFAULTS, ...given };

  for (const key of Object.keys(NUMERIC_BOUNDS)) {
    const [min, max] = NUMERIC_BOUNDS[key];
    const value = out[key];
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`配置非法：${key} 必须是整数，收到 ${JSON.stringify(value)}`);
    }
    if (value < min || value > max) {
      throw new Error(`配置非法：${key}=${value} 超出允许范围 [${min}, ${max}]`);
    }
  }

  if (typeof out.cleanupEnabled !== "boolean") {
    throw new Error(`配置非法：cleanupEnabled 必须是 true/false，收到 ${JSON.stringify(out.cleanupEnabled)}`);
  }

  for (const key of STRING_KEYS) {
    const value = out[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`配置非法：${key} 必须是非空字符串，收到 ${JSON.stringify(value)}`);
    }
    if (value.includes("\n") || value.includes("\0")) {
      throw new Error(`配置非法：${key} 不能包含换行或 NUL`);
    }
  }

  // globalSubpath 是路径片段数组；拒绝分隔符、`..` 与保留字符，避免配置把记忆
  // 写到层目录之外（shard 名与 cwd 都有同样的防线，配置不该是漏的那个）。
  if (!Array.isArray(out.globalSubpath) || out.globalSubpath.length === 0) {
    throw new Error('配置非法：globalSubpath 必须是非空字符串数组（例 ["memory-win", "global"]）');
  }
  for (const part of out.globalSubpath) {
    if (typeof part !== "string" || part.trim() === "") {
      throw new Error(`配置非法：globalSubpath 的片段必须是非空字符串，收到 ${JSON.stringify(part)}`);
    }
    if (/[\\/]/.test(part) || part === "." || part === ".." || /[:*?"<>|]/.test(part)) {
      throw new Error(`配置非法：globalSubpath 片段不能含分隔符、. / .. 或 Windows 保留字符：${part}`);
    }
  }

  if (out.credentialPatterns !== null && out.credentialPatterns !== undefined) {
    if (typeof out.credentialPatterns !== "object" || Array.isArray(out.credentialPatterns)) {
      throw new Error("配置非法：credentialPatterns 必须是 { 模式名: 正则字符串 } 或 null");
    }
    const names = Object.keys(out.credentialPatterns);
    if (names.length === 0) {
      throw new Error("配置非法：credentialPatterns 不能是空对象（等于关掉全部凭据扫描）；要保留内置表请写 null");
    }
    for (const name of names) {
      const source = out.credentialPatterns[name];
      if (typeof source !== "string" || source.trim() === "") {
        throw new Error(`配置非法：credentialPatterns["${name}"] 必须是非空正则字符串`);
      }
      try {
        compilePattern(source);
      } catch (error) {
        throw new Error(`配置非法：credentialPatterns["${name}"] 不是合法正则：${String(error?.message ?? error)}`);
      }
    }
  }

  if (typeof out.archivePointer !== "string" || out.archivePointer.trim() === "") {
    throw new Error("配置非法：archivePointer 必须是非空字符串");
  }

  // ── 交叉约束（0.1.x 只能靠人肉保证的那几条） ─────────────────────────────
  if (out.inlineTextMax > out.factBodyMax) {
    throw new Error(
      `配置非法：inlineTextMax (${out.inlineTextMax}) 不能大于 factBodyMax (${out.factBodyMax})；` +
        "否则「写入侧截断提醒」永远不可能触发 —— 超过显示上限的正文会先在写入校验里被拒。",
    );
  }
  if (out.stateFile === out.archiveDir) {
    throw new Error("配置非法：stateFile 与 archiveDir 不能同名（状态文件会被当成归档目录）");
  }

  return out;
}

/**
 * 用一份原始配置初始化（或重置）配置层。
 *
 * 由 `index.js` 的 `apply(ctx, config)` 在挂载时调用一次。抛错即**拒绝启动**，
 * 与 README 第 3 节"fail-visible"一致：配错了要看得见，不要带着半截配置跑。
 *
 * @param {object|undefined} raw - profile patch 的 `config:` 段。
 * @returns {object} 生效的完整配置。
 * @throws {Error} 配置非法时抛出（消息含键名、收到的值与合法范围）。
 */
export function initConfig(raw) {
  current = normalizeConfig(raw);
  refreshPatterns();
  return current;
}

/**
 * 一份配置的浅拷贝快照（测试、`memory_cleanup` 回显与地图脚注用）。
 *
 * @returns {object} 当前生效配置。
 */
export function configSnapshot() {
  return { ...current };
}

/**
 * 取一个配置键。**所有模块的唯一出口。**
 *
 * @param {string} key - 配置键。
 * @returns {*} 生效值。
 * @throws {Error} 键不存在时抛出（拼错键名要立刻可见，不要静默拿到 undefined）。
 */
export function configValue(key) {
  if (!(key in CONFIG_DEFAULTS)) throw new Error(`未知配置键：${String(key)}`);
  return current[key];
}

/**
 * `configValue` 的数值便捷包装（让调用点更短，也把"这里要的是数字"写清楚）。
 *
 * @param {string} key - 数值型配置键。
 * @returns {number} 生效值。
 */
export function configNum(key) {
  return Number(configValue(key));
}

/** 生效的凭据模式表（`null` = 还没接入内置表）。 */
let configuredPatterns = null;

/** 内置模式表（由 format.js 登记）。 */
let builtinPatterns = null;

/**
 * 生效配置的**凭据模式表**：`[模式名, RegExp][]`。
 *
 * 未配置时由 `lib/format.js` 提供内置 8 类（通过 `setDefaultCredentialPatterns`），
 * 因此扫描侧只有一个来源，不会各自持有副本。
 *
 * @returns {[string, RegExp][]} 模式表。
 * @throws {Error} 配置层尚未接入内置表时抛出。
 */
export function credentialPatternList() {
  if (configuredPatterns === null) {
    throw new Error("配置层尚未接入内置凭据模式表（应先 import lib/format.js）");
  }
  return configuredPatterns;
}

/**
 * 由 `lib/format.js` 在模块求值时登记内置的 8 类模式。
 *
 * 这个"反向登记"是为了避免循环 import：`config.js` 不能 import `format.js`
 * （`format.js` 要 import `config.js` 拿阈值）。
 *
 * @param {[string, RegExp][]} patterns - 内置模式表。
 */
export function setDefaultCredentialPatterns(patterns) {
  builtinPatterns = patterns;
  refreshPatterns();
}

/**
 * 按当前配置重算生效模式表。`initConfig` 与 `setDefaultCredentialPatterns`
 * 都会调用它，因此两个来源任意先后到达都能得到正确结果。
 */
function refreshPatterns() {
  const custom = current.credentialPatterns;
  if (custom === null || custom === undefined) {
    configuredPatterns = builtinPatterns;
    return;
  }
  configuredPatterns = Object.entries(custom).map(([name, source]) => [name, compilePattern(source)]);
}

/**
 * 把配置里的正则字符串编译成 `RegExp`，并**剥掉有状态的标志**。
 *
 * `g` 与 `y` 会把 `lastIndex` 带到下一次 `test()` 调用上，同一个正则第二次匹配
 * 可能返回 false —— 凭据扫描于是"偶尔漏一次"。这里直接去掉这两个标志。
 * 支持 `/pattern/flags` 形态与裸源码两种写法。
 *
 * @param {string} source - 正则源码。
 * @returns {RegExp} 无状态标志的正则。
 */
export function compilePattern(source) {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(String(source));
  const body = m ? m[1] : String(source);
  const flags = (m ? m[2] : "").replace(/[gy]/g, "");
  return new RegExp(body, flags);
}
