# dsh-memory-win

DSH 桌面版（Windows 优先）的长期记忆插件：纯本地、零依赖、不走 shell、不调用模型。

- 版本 **0.4.3**，单测 **209 例**（`node test/run.mjs`）+ 真实 Cordis 生命周期回归 + 客户端冒烟 33 项 + 宿主契约检查 6 项（`npm test` 串跑）。
- 已装入本机 desktop profile，在真实宿主里跑过 14 轮实测。
- 实现刻意最小化，但核心机制与安全边界完整、有测试覆盖，仍然算 **demo**。

功能实施进度、逐轮实测证据、踩坑复盘写在仓库外的
[功能实施进度文档](../dsh-memory-win功能实施进度.md)。本文件只说清四件事：为什么再写一个、
机制是什么、怎么装怎么用、边界在哪里。

---

## 0.3.1 修复说明

记忆视图出现 HTTP 404 时，宿主实际报错为 `cannot get property "webServer" without inject`。
旧代码直接访问未声明依赖的服务。现在由独立的 `ctx.inject(["webServer"], ...)` 作用域挂载路由。
服务稍后就绪时会自动挂载；服务移除或插件卸载时会清理路由。无 Web 服务时，记忆工具仍可加载。
这条缝隙由新增的 `tools/view-lifecycle.mjs` 钉死：读 app.asar 里的**真实 Cordis** 驱动插件
生命周期并发真实 HTTP 请求（假 ctx 不模拟宿主的拒绝行为，是这次漏检的根因）。

安装 0.3.1 后，从托盘菜单退出 DSH，再启动并打开“设置 → 记忆视图”。
验证结果与现有测试限制见第 7 节（宿主内实测与仍未验证）。

## 0.3.2 变更说明

- 记忆视图行内按钮组从左侧移到右侧（名称与路径在左、折叠/展开在右，与 dsh-archived 的行布局一致），
  client 冒烟新增布局断言钉住子节点顺序。
- 全局层 `dsh-dirs`、`dsh-plugin-dev` 两片补上关键词头。这两片诞生于片级关键词功能（0.1.2）之前，
  而 `memory_add` 不允许改已存在分片的首行，只能手工重写首行 —— 重写后用插件自己的
  `listLayer`/`searchMemory` 复核了解析与命中。UI 里此前的「（关键词未设置）」是实态的诚实投影，
  不是页面 bug（空关键词刻意显式写出而不是省略）。

## 0.4.0 变更说明：压缩守护（备份 + 收敛）

宿主自带会话压缩（`@deepseek-ai/dsh-compaction-basic`，挂在 `dsh-base`，默认按上下文
**80%** 触发）。本版不另造触发器，只补宿主不做、而需求要的两件事：

1. **压缩前备份会话**：监听到 `compaction/start`（压缩事务的持久锁）就把会话日志拷一份
   到 `$DSH_HOME/memory-win/session-backups/<sessionId>/`，命名
   `<会话名称>_YYYYMMDD_HHmmss`，三件套：`.jsonl.zstd`（原始字节）+ `.jsonl`（可 grep 的
   明文，只到压缩起点）+ `.meta.json`。
2. **压缩后达标校验**：`compaction/end` 后量一次 `contextBreakdown.messageTokens`，
   超过 `compactTargetTokens`（默认 16000）就补**一次**收敛压缩 —— 含宿主那次，
   一个压缩周期最多两次。

两条配套事实（都实测过，写在这里免得再推一遍）：

- **阈值不在本插件里**：`80%`/`800k` 由宿主那条 `compaction-basic` 的 `thresholdRatio`
  决定。**怎么改，取决于那条 compaction-basic 在哪个作用域生效**（0.4.2 修正，见下）：

  | profile | 生效实例在哪 | 怎么改 |
  |---|---|---|
  | web / desktop（`dsh-web-app`） | **每个 agent preset 内部**（`isolate: {compaction: true}`）；宿主平面那条被 `disabled: true` | 覆写 preset 的 `config.plugins`（跟网页版预设编辑器保存出来的形状一致）：把 `thresholdRatio: 0.75` 加到 preset 里那条 `compaction-basic` 上 |
  | headless 等极简 profile | 顶层（`dsh-base` 那行） | 直接 `- id: compaction-basic` + `config: { thresholdRatio: 0.75 }` |

  ⚠️ **别照抄成 `- id: compaction-basic` 就以为改上了**：在 web profile 上那个 id 指的是
  **被停用的宿主平面条目**，patch 会静默落到它身上、运行时毫无变化
  （`dsh --dump-config` 里能看到 `disabled: true` 与 config 并存 —— 看着像成功）。
  本机实测过两种：错的写法 `thresholdRatio` 只出现在停用条目上；正确写法下它出现在
  preset 内的实例上（1M 窗口 → 750k = `min(750k, W−O−65536)`）。

- **"16k"只能指"消息历史"，不能指整个请求**：压缩永远不缩系统提示词 / 工具声明 /
  会话前缀，本机实测信封（system 1,837 + tools 7,949）≈ **9.8k tokens**，
  所以"整个请求 ≤16k"物理上做不到。目标口径取 `messageTokens`。

详见第 2.8 节；配置键见第 5 节。

## 0.4.2 修复说明：压缩守护在 web profile 上曾整块静默失效

0.4.0 的压缩守护把五个服务写在**同一个** `ctx.inject([...])` 里
（`sessions` / `compaction` / `tokenMeter` / `sessionProjections` / `sessionTitle`）。
这在 web profile 上等于**整块不挂**：

- `dsh-web-app` 把宿主平面的 `compaction-basic` 打了 `disabled: true`，真正生效的压缩
  后端挂在**每个 agent preset 内部**（`isolate: {compaction: true}`）；
- 本插件挂在**根作用域** ⇒ `compaction` 永远不就绪 ⇒ 回调永不执行 ⇒
  **连只需要 `sessions` 的"压缩前备份"半边也一起没了**，而且不报错。

实测（2026-10-22，dsh `0.2.1-rc.2` + web profile）：

| 观测 | 结果 |
|---|---|
| 探针逐个试五个服务 | `sessions` / `tokenMeter` / `sessionProjections` / `sessionTitle` 就绪，**`compaction` 不就绪** |
| 真实发生的压缩 | 会话 `session-91031863` 于 07:29:33 / 07:33:30 / 07:33:48 压缩三次 |
| 备份落点 | `$DSH_HOME/memory-win/session-backups/` **连目录都没建** |

修法：**两半边各自声明依赖**。

| 半边 | 需要 | 拿不到时 |
|---|---|---|
| 备份（`registerCompactBackup`） | `sessions`（`tokenMeter` / `sessionTitle` / `sessionProjections` 都是可选读取） | 几乎不会缺席 |
| 收敛（`registerCompactConvergence`） | `compaction` | **只少这一个半边**，备份照常工作 |

"到底装上没有"现在看得见：`logEnabled: true` 时两半边各写一行
`compact_guard_half half=backup` / `half=converge` —— **缺哪一行就是哪半边没装上**。
在 web profile 上预期只有 `backup`；收敛半边要等它被挂进 preset 作用域，或宿主把压缩
服务重新暴露到根作用域（见第 7.3 节）。

---

## 0.4.3 变更说明：收敛专用形态（`convergeOnly`）

0.4.2 之后还剩一个空：**收敛半边在 web profile 上找不到 `compaction` 服务**。
原因不是"挂错地方"，而是那条服务被隔离在 preset 的 `cordis:group(compaction)` 子树里。

纯 Cordis 实测（`ctx.isolate('compaction')` 后 provide 一个假服务）：

```
组内 ctx.get('compaction') = 拿得到 ✓
兄弟 ctx.get('compaction') = undefined ✗
根   ctx.get('compaction') = undefined ✗
```

⇒ 结论很反直觉：**把插件挂在 preset 的 plugins 层（跟 persona / tool-fs 并列）照样拿不到**；
唯一拿得到的位置是那条 `compaction` 组**自己的 config 列表**。可完整形态挂在这里会重名注册
工具/提示词段/路由（`tool "memory_list" is already registered`）—— 一个模块挂两处必须分工。

所以 0.4.3 加了**收敛专用形态**：`apply(ctx, { convergeOnly: true })` 时只挂
`agent/pre-step` 上的"压缩后达标校验 + 一次补压"监听，**工具、提示词段、守卫、清理、
记忆视图一概不碰**，也**不调用 `initConfig`**（模块级配置是单例，两份都初始化会互相覆盖；
它按需读取，那几项由完整形态初始化）。

挂法（profile 的 `cordis.patch.yml`，在**你在用的那个 preset** 的 compaction 组里加一行）：

```yaml
- id: preset-standard                      # 你实际在用的 preset
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # …（原有条目照抄，别漏）
      - id: compaction
        name: cordis:group
        group: true
        isolate: { compaction: true, toolResultPruner: true }
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
          - id: dsh-memory-win-converge     # ← 这一行是新增的
            name: 'dsh-memory-win'
            config:
              convergeOnly: true
          # …（command-compact / tool-result-pruner 照旧）
```

⚠️ **别把完整形态（不带 `convergeOnly`）挂进 preset**：工具重名注册会直接报错，而且
"只有这个 preset 的会话有记忆"是静默的退化。根上那份继续管工具 / 注入 / 备份 / 清理 / 视图。

两处**共用同一份模块状态**：根上那份的 `session/event` 记下"压缩发生了"，组里那份的
`agent/pre-step` 读它、超标就补一次 —— 事件是跨作用域广播的，正好接上。

生效范围是**这个 preset 的所有会话**（新建的和老会话都算，老会话下一轮就带上），
不需要逐会话开启。

---

## 1 为什么再写一个

现有四个记忆插件（`dsh-memory`、`dsh-auto-memory`、`dsh-memory-evolve`、`hindsight`）默认面向
Linux/macOS，在 Windows 上有三类失效：

| 类别 | 形态 | 后果 |
|---|---|---|
| 路径 / 环境 | 根目录在模块加载期求值：`const HOME = process.env.HOME ?? ""`。Windows 上通常未设 `HOME`，取到空串 | 全局层路径变成 `/.dsh/memory/topics`，整块静默失效 |
| shell 依赖 | 硬编码 `/bin/zsh` 且 `execFile` 的同步抛出未捕获；`sh -c` 的错误被静默吞掉；`process.kill(-pid)` 依赖 POSIX 进程组 | 钩子抛穿导致进程崩溃；通知永不触发；承诺的进程树终止不成立 |
| 外部进程语义 | 注入回调里每步 `spawnSync('git', ...)`，失败被静默 catch | 分支隔离静默失效 |

四条失效的成因不同，但都能被同一个约束绕开：

> 零 shell、零外部进程；路径全部走 `node:path` 与 `homedir()`/`DSH_HOME`，并且在**调用时**求值。

满足这三条，就不需要为 Windows 写任何 `if (platform)` 分支。

补充一点：`dsh-memory-evolve` 是四个里唯一真做了跨平台分支的，它的 `memoryDir` 解析
（`DSH_HOME || homedir()`）也是唯一写对的，所以问题不能一概而论。

---

## 2 机制

核心取舍来自 `dsh-memory`：**注入的只有地图，正文永远按需检索。**

```
%DSH_HOME%\memory-win\global\*.md    ← 全局层（跨项目通用）
<会话 cwd>\.agent-memory\*.md         ← 项目层（随仓库走，默认被 .gitignore 忽略）
```

每个 `*.md` 是一个主题分片，首行可选关键词头，正文是条目：

```markdown
<!-- windows-paths · pwsh git-bash 路径 引号 -->

## 坑

- [2026-09-28] pwsh 里读文件用 Get-Content -Raw；不要用 cat
- [2026-10-01] git bash 下路径要写成 /c/项目 而不是 C:/项目
```

条目格式 `- [YYYY-MM-DD] 事实` 是唯一的硬约定。日期经 UTC 回读校验：
`new Date("2026-13-45")` 会进位成 2027-02-14 而不是 `Invalid Date`，只判 `NaN` 会放行这类错误。

项目层目录名不带产品前缀，因为里面只有明文 markdown，任何 agent（Claude Code、Codex、Cursor）
都能直接读，不需要认识 DSH。保留前导点是仓库里工具数据目录的通行惯例，隐藏不等于不可读。

### 2.1 注入档位

| 某层状态 | 注入内容 |
|---|---|
| 条目 ≤ `inlineThreshold`（默认 8） | 逐条内联，含 `#id` 便于直接修正；每条正文截断到 `inlineTextMax`（默认 160 字符） |
| 条目 > 阈值 | 每片一行：`片名：N 条 ｜ 最新日期 ｜ 片路径 ｜ 关键词` |
| 完全为空 | 仍注入纪律块，否则模型不知道记忆存在，永远不会有第一条 |

段尾统计注释（`记忆合计 N 片 / M 条 · 归档 K 件 · 全局层 <绝对路径>`）放在**最后**，
头行只放档位、不放数字。原因：前缀缓存。写一条记忆就变一次的数字放在系统提示词最前面，
整个前缀会失效。这条纪律来自 `dsh-memory` 的实测：写入后子代理首轮 `cacheRead` 从 85% 掉到 0%。

即使这样，写入步本身仍会 miss 一次（实测 `uncached` 十万级）。根治要靠路由声明
`systemPromptUpdate: 'in-history'`，让变更快照追加在缓存历史之后；本机用的
`our-free-model` 路由没有该声明，由 `patches/` 补丁加两层守护断言维持。细节见进度文档 §3.26。

### 2.2 修正，不只是追加

每条活条目有一个由「日期 + 正文」派生的 4 位 id。`memory_correct` 用它取代一条已经错了的记忆：

| `reason` | 用在哪 |
|---|---|
| `defect` | 之前记的结论或实现本身是坏的 |
| `overturned` | 当时对，现在证明不成立 |
| `correction` | 用户纠正了你 |
| `retract` | 结论不再成立，且没有新结论 |

语义是保留历史 + 让旧结论失效：

```markdown
<!-- - [2026-09-30] 项目层守卫不用单独覆盖，tools.guard 就够了 -->
- [2026-10-02] 项目层必须单独覆盖：tools.guard 回调原来只查了全局层 [fix:overturned of #bc32]
```

旧条目就地注释，行号不变，但**不再进地图、也不再被 `memory_search` 命中**。只追加新条目是不够的：
旧结论会继续留在上下文里误导后续判断。

取 id 有两条路：`memory_search` 命中即给 id；关键词搜不到时用 `memory_list { entries: true }`
列出全部条目及 id。修订只能走 `memory_correct`，用 `write`/`edit` 直改记忆文件会被守卫拒绝。

### 2.3 路径的两种形态

| 出处 | `path` 含义 |
|---|---|
| 注入地图、`memory_list` | 层内相对路径（就是 `片名.md`），省字符：实测分片行平均从 134 降到 68 |
| `memory_search`、`memory_list entries=true` | 绝对路径，直接喂给 `read` |

相对路径会被解析到会话 cwd 下导致读不到文件，所以取文件必须给绝对路径。
地图档下项目层的层目录不在注入里，需要绝对路径就走后两个工具。

### 2.4 片级关键词

`memory_add` 接受可选 `keywords`，写进新建分片的首行，进地图的 `关键词：…` 段。
这是模型不打开分片就能路由的唯一线索。已存在的分片传 `keywords` 会被拒绝：
首行无法靠追加改写。新建分片不带 `keywords` 只给 warning，不阻断。

不做自动提取：实测朴素 n-gram + TF-IDF 在低条目量语料上只会产出「不再」「要用」这类实词碎片，
把 `mkdtempSync`、`spawn EPERM` 这些真正有路由价值的标识符压掉。噪声比显示「（未设置）」更糟。

### 2.5 长内容：文档加指针

一条记忆只能是单行、且不超过 `factBodyMax`（默认 2000 字符），所以复盘、排查过程、长清单塞不进记忆。
正解是文件做正本、记忆做路由，这条已写进注入纪律块：

- 原文写进仓库普通文档（如 `docs/postmortem-<主题>.md`），写别处不受守卫限制。
- 记忆里只留一行：结论 + 症状关键词 + 文档路径。关键词要写全，否则将来搜不到这行。
- 复述时 `memory_search` 命中该行，再 `read` 全文。

同一套分工也适用于 `grill-with-docs` 产出的术语表和 ADR：术语表本身不进记忆条目（每个术语 3 行，
塞不进单行），只留一条指针，别名写进 `keywords`。注意粒度取舍：别名放 `keywords` 会让整片条目都命中，
放条目正文才精确命中该条。术语表提交进 git 所以跨机器也在，而 `.agent-memory/` 默认被忽略，
**记忆指针带不走**，重要项目的指针要一并提交或写进仓库文档。

两个数字不要混：

| | 配置键 | 默认 | 超限行为 |
|---|---|---|---|
| 写入上限 | `factBodyMax` | 2000 | 拒绝写入，错误信息可执行 |
| 显示上限 | `inlineTextMax` | 160 | 注入里截断，正文完整落盘；0.1.4 起写入返回值带 warning |

两个阈值只有 `lib/config.js` 一个定义处，渲染与提醒取同一个数，且都先用同一个 `oneLine()`
压平空白后再计长。启动时交叉校验 `inlineTextMax ≤ factBodyMax`，否则提醒永远不会触发。

### 2.6 容量策略：归档

0.1.x 唯一会随时间单调恶化的缺口：地图随分片数线性增长，而被取代的条目与撤回后残留的空分片
不占地图、却占文件体积。做法一句话：把已经不是活记忆的东西搬出分片。

| 会被搬走 | 不会被搬走 |
|---|---|
| 被 `memory_correct` 取代或撤回、且失效满 `cleanupDays`（默认 3）天的条目。判据 `失效日期 ≤ 今天 − N`，含边界 | 活条目。哪怕很老、从没被检索过 |
| 因此变成 0 有效条目的空分片（连关键词头一起归档，文件删除） | 宽限期内的历史；宽限期内被检索命中过的失效条目（再等一轮） |

关键设计：

- **活条目永不动**是刻意的。「很少有人问」不等于「没用了」，按检索频率自动归档活分片等于悄悄改变提示词内容。
- 搬走的是原样的行，所以归档是可逆的纯文本操作，需要复原就把行贴回原分片。
- 归档落在每层自己的目录：`<层目录>/archive/<分片名>.md`，同一分片多次清理追加到同一文件。
- 归档不进注入、不被检索命中，地图段尾只报一个件数。要清单跑 `memory_cleanup`。
- 触发时机：当天首次启动后延迟 `cleanupDelaySeconds`（默认 10）秒跑一次，去重依据每层 `.state.json`
  里的 `lastCleanup`，当天重启多少次都不会重复清理。延迟是给宿主装配提示词留出时间，避免和在途写入抢文件。
- 后台清理拿不到 cwd，按 `storages/workspace.json` 里登记过的路径逐个清项目层。那是宿主内部格式，
  读不懂就只清全局层，不猜目录、不报错。
- **没有任何分片的层什么都不写**：不创建 `.agent-memory/`、不写 `.state.json`。0.2.1 曾给每个已知工作区
  都写状态文件，等于在用户从没本插件碰过的仓库里凭空建一个隐藏目录，且全程无报错（见 6.1）。
- `memory_cleanup` 的 `force` 默认 `true`，显式调用就是显式意图；传 `false` 才受「当天只跑一次」约束。

### 2.7 效果日志（0.2.5）

旁路日志，默认关，用 profile 的 `config: { logEnabled: true }` 打开，改完重启。
回答两类问题：注入体积在怎么变，缓存命中怎么样。

落点 `<全局层上级>\logs\debug.jsonl`，每事件一行 JSON，单文件 1 MB 轮转出 `debug.prev.jsonl`（只留一份）。
它与全局层平级，层目录 `readdir` 只取 `*.md`，所以日志不进地图、不被归档扫描读到。

| 事件 | 何时写 | 关键字段 |
|---|---|---|
| `inject` | 每轮装配 | `chars` 总长、`parts` 分项、`modes` 各层档位、`cwd` |
| `inject_error` | 渲染抛错 | 错误消息（过中和与凭据扫描才落盘） |
| `search` | `memory_search` 返回 | `query`、`hits`（零命中照记）、`shards`；不记正文和 id |
| `add` | `memory_add` 返回 | `hour`、`hourCount`、`target`/`shard` |
| `correct` | `memory_correct` 返回 | `reason`、`id`、层与分片 |
| `cleanup` | `memory_cleanup` 返回 | `ran`、`archived`、`entries`、`removedShards` |
| `usage` | 每轮响应 | tokens 四元组、`hitRate`、`seqRef` 回指最近一次 inject |
| `guard_deny` | 守卫拒绝直写 | `tool`、`path` |
| `config_error` | 启动配置非法且日志开着 | 错误消息（仍照常拒绝启动） |

口径要点：

- `hitRate = cacheRead / (uncached + cacheRead + cacheWrite)`，与设置页「缓存命中 N%」同一个分母，
  实读宿主源码确认，日志与 UI 永远对得上。
- `memory_list` 不记；被校验拒绝的 `memory_add` 不计入 `hourCount`，「次数」指完成的调用。
- `attempt` 与同 `(session, turn, step)` 的 `message` 是替换关系，聚合优先只用 `message` 行。
- `seqRef` 是时间相邻级关联，inject 侧拿不到会话 id，多会话并行时可能指错；会话归属以事件自己的
  `session` 字段为准。
- `hourCount` 的正本就是 JSONL：进程内第一次碰到某个自然小时时回读两份日志数出种子，状态文件零改动。
- 三条失效纪律：写失败静默停写（不重试不报错，不给注定失败的磁盘每轮刷屏）；所有日志入口永不抛；
  关闭时零副作用（不建目录、不读文件）。

### 2.8 压缩守护：压缩前备份 + 压缩后收敛（0.4.0，0.4.2 修依赖拆分）

⚠️ **两半边是分开装配的**（0.4.2）：备份只 `inject(["sessions"])`，收敛单独
`inject(["compaction"])`。原因见「0.4.2 修复说明」—— `compaction` 在 web profile 里只在
agent preset 的隔离作用域内存在，写在一个 inject 里会让**整块**守护（含备份）静默死掉。

而收敛半边要真正就绪，还得用 `convergeOnly: true` 把它挂进 preset 的 **compaction 组**里
（0.4.3，见「0.4.3 变更说明」）：服务被 `isolate: {compaction: true}` 关在那条子树内，
组外（含根、含 preset 的其它插件）都拿不到。

自查方式：`logEnabled: true` 时看 `compact_guard_half` 那两行。

宿主的压缩是**表层替换**：被遮蔽的事件原样留在 `session.v4.jsonl.zstd` 里，回放仍能重现。
所以"怕压缩丢信息"这个理由不成立，本插件做备份是另外两个目的：

1. **日志不可读**：`session.v4.jsonl.zstd` 是**逐帧** zstd，grep 搜不进去。压缩把历史从
   上下文里拿掉后，想再翻那一段就只能靠工具解码 —— 于是顺手留一份明文 `.jsonl`；
2. **压缩点是天然快照时机**：750k 触发的那一刻正是"此刻之前的内容值得留档"的判定点。

落点 `$DSH_HOME/memory-win/session-backups/<sessionId>/`，刻意**不在工作区**（否则仓库内
grep 会命中重复内容）也**不在 `sessions/` 下**（否则会被会话列表/导出扫成"又一个会话"）。
命名 `<会话名称>_YYYYMMDD_HHmmss`（本地时间、秒级），标题经清洗：Windows 保留字符、
控制符、`CON`/`NUL` 这类保留名、超 60 字符都处理；同一秒重复压缩追加 `-2`。

| 文件 | 内容 |
|---|---|
| `<名称>.jsonl.zstd` | 原始日志的逐字节拷贝（无损、可放回去重放） |
| `<名称>.jsonl` | 解码后的明文，**只保留压缩起点之前**的记录（可 grep） |
| `<名称>.meta.json` | 会话 id / 标题 / compactionId / 起点 seq / 压缩前 token / 时间 |

三个实现决定值得说明：

- **备份不需要另开临时会话。** 它是一次 `flush` + 文件拷贝，无模型参与；而摘要本身由
  宿主 `ctx.compaction` 用**进程内**辅助调用完成，会逐字节回放系统提示词/工具/被遮蔽区
  以命中 provider 的 KV 热前缀缓存。另开会话既丢掉这份缓存、又改不了父会话的表层
  （`compactRegion/compactNow` 作用对象是 `agent.session`），技术上就是死路。
- **收敛是"补一次"，不是"自己触发"。** 触发器仍是宿主 `agent/pre-step` 里的压力检查；
  本插件只在自己的 `agent/pre-step` 监听器里看一眼，超标才补一次 `compactRegion`。
  判据是"观测到过 `compaction/end` 且还没补过"而不是"刚压完"，所以注册顺序反过来也正确 ——
  只是补压会晚一个 step。宿主缺席时本模块整体不生效，不会把会话卡在半路。
- **坏帧按空输出判定。** 本机实测 Node 22 的 `zstdDecompressSync` 对截断帧、全 `0xFF`、
  skippable 帧**都不抛异常**，一律返回空 Buffer。只看 `catch` 计失败的话，一份被截断的
  日志会"看起来解码成功" —— 所以"有载荷却解出空"才算可疑帧。

日志事件（`logEnabled: true` 时）：`compact_guard_half`（**两半边各一行**，用来看哪半边
装上了）、`compact_backup`、`compact_verify`、`compact_converge`、
`compact_converge_error`、`compact_failed`、`compact_start`（本插件自己发起的那次）、
`compact_guard_error`。

---

## 3 五个工具

| 工具 | 作用 |
|---|---|
| `memory_list` | 列出两层地图（片名 / 条数 / 最新日期 / 关键词 / 路径 + 归档件数）；`entries: true` 列出全部条目及 id |
| `memory_search` | 按关键词跨层检索，命中带 `id` / 文件 / 行号，直接用 `read offset=` 取原文 |
| `memory_add` | 追加一条，经格式 / 日期 / 凭据三项校验后原子写；新建分片可带 `keywords` |
| `memory_correct` | 取代一条已错的记忆，旧条目就地失效 |
| `memory_cleanup` | 容量策略：把失效条目与空分片搬进归档目录，报出搬了什么、去了哪 |

`memory_search` 是纯 JavaScript 子串匹配，空格分词为 AND 语义，中文不需要分词。
不调模型、不做向量检索，因此零额外 LLM 成本。

---

## 4 安装与升级

```powershell
cd dsh-memory-win
node test/run.mjs                                              # 跑单测（npm test 会连客户端冒烟与契约检查一起跑）
node scripts/pack.mjs                                          # 打包并复制到 ~/.dsh/plugin-tarballs/
dsh plugin --profile desktop add "file:C:/Users/<你>/.dsh/plugin-tarballs/dsh-memory-win-0.3.2.tgz"
```

首次装入还要再启用一次 bundle，`dsh plugin add` 只装依赖、不挂载：

```
plugin_manager { action: "install_bundle", target: "dsh-memory-win" }
```

返回 `{"stage":"enable","changed":true,"application":"restart-required"}` 即成功。
升级不必重复这步：`dsh.profile.bundles` 是持久状态，升版本后它仍在列表里。
拿不准可以先 `list_bundles` 核对，本插件应显示 `installed: true, removable: true` 并带 `rows`。

### 4.1 必须用 tarball，且每次都要升版本号

profile 用 `nodeLinker: hoisted`，`file:` **目录**依赖会被 pnpm 做成拷贝快照，不是符号链接。
实测：改了仓库源码，宿主看不到；`install_bundle` 也不刷新，因为 spec 未变、pnpm 判定已满足。
这个坑伪装成代码缺陷，本项目连续两轮把「部署未同步」误判成插件 bug，直到对 profile 里那份文件取哈希才定性。

换成 tarball 后同样的跳过还会发生：替换**同文件名**的 tarball 再 `add`，pnpm 报 `downloaded 1`，
但 `node_modules` 里的文件没被改写。所以：

```powershell
# 改完源码的固定流程
# 1) 升 package.json 的 version（必须，否则 add 静默跳过）
node scripts/pack.mjs
dsh plugin --profile desktop add "file:C:/Users/<你>/.dsh/plugin-tarballs/dsh-memory-win-<新版本>.tgz"
# 重启桌面版
```

怀疑「改了没生效」时，直接对 profile 里那份文件取哈希与源码比对，不要反复重装或重启。
比对范围是 `index.js` / `package.json` / `cordis.patch.yml` / `lib/*.js` 这 16 个运行期文件
（0.3.0 起新增 `lib/view.js`、`lib/client.js`）。
`README.md` 也在 tarball 里，改文案后若要让已安装副本同步，同样得走一遍升版本 → pack → add。

### 4.2 启停开关热生效

启用后「设置 → 插件」里会出现 dsh-memory-win 一行，带开关。这是 DSH 原生的插件启停，
绑定 loader 条目的 `disabled` 选项（`pluginManager.setBundleEnabled`），插件侧不需要任何代码。

实测点过开与关：关闭时地图段消失、`list_plugins` 条目 189 → 188、四个 `memory_*` 工具卸载；
重新打开后全部恢复、条目数精确回到 189。开与关都热生效、重启后状态保持、往返不留残留。
**关闭不等于卸载，也不删数据**：tarball 依赖、`node_modules` 文件、记忆分片都完好。

不要用 `install_bundle` 重新打开插件。那条路径里有
`if (Object.hasOwn(before, name)) return 'restart-required'`，bundle 已在 `dependencies` 里，
于是白白要求一次重启。设置里的开关没有这个覆盖。

内置 bundle 带 `readOnlyReason` 的是锁定的，只有 `removable: true` 且有 `rows` 的条目可切换。
这也是必须先 `install_bundle` 而不是手工往 `cordis.patch.yml` 插一行的原因：手工插的行不在
bundle 注册表里，可能拿不到可用开关。

### 4.3 数据位置

| 位置 | 路径 |
|---|---|
| 全局层 | `%DSH_HOME%\memory-win\global\*.md`（`DSH_HOME` 默认 `C:\Users\<你>\.dsh`） |
| 项目层 | `<会话工作目录>\.agent-memory\*.md` |
| 归档 | `<层目录>\archive\<分片名>.md`，每层各一个 |
| 状态 | `<层目录>\.state.json`，每层各一个：检索命中记录 + 当天清理标记，不是记忆正文 |
| 效果日志 | `<全局层上级>\logs\debug.jsonl`，仅 `logEnabled: true` 时存在 |

项目层默认被 `.gitignore` 忽略，本仓库的 `.gitignore` 只覆盖自身，使用者的仓库需自行忽略 `.agent-memory/`。

### 4.4 改配置或改源码后要重启

profile 的 HMR 只监听 patch 文件，不监听插件模块文件。改 `lib/*.js` 或改 `config:` 段都必须重启桌面版。
改完不重启，纪律块和工具描述里的新文案不会出现在系统提示词里。

### 4.5 从 `.dsh-memory` 升级

项目层目录已从 `.dsh-memory/` 改名为 `.agent-memory/`。旧目录不会自动迁移，插件只读新目录，
不迁移等于项目层记忆「消失」。文件格式完全一致，手工搬一次：

```powershell
Rename-Item .dsh-memory .agent-memory
```

不自动迁移是刻意的：往用户仓库里悄悄改名或移动文件属于不可逆操作，而「旧目录还在、新目录为空」
这个状态是可见的（`memory_list` 报 0 条），不是静默失效。

---

## 5 配置

0.1.x 的所有阈值都是硬编码常量。现在它们收敛到 `lib/config.js`，入口是 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-memory-win
  name: 'dsh-memory-win'
  config:
    inlineTextMax: 200
    cleanupDays: 7
```

只写要改的键，其余自动取默认。这是插件自己补的，不是宿主合并的：宿主对这条 patch 做的是
**整段替换** bundle insert 的 `config: {}`（`applyEntryPatches` 里非 insert patch 走 `target[key] = value`），
然后把该值作为第二个参数交给插件（`cordis/src/fiber.ts` 的 `runtime.callback(this.ctx, this.config)`）。
配置层的形状由这条契约决定，而不是反过来。

| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `inlineTextMax` | 160 | 1–100000 | 内联档每条正文的显示上限，超了截断并提醒 |
| `factBodyMax` | 2000 | 1–1000000 | 单条正文的写入上限，超了拒绝；必须 ≥ `inlineTextMax` |
| `inlineThreshold` | 8 | 1–10000 | 某层条目数不超过它时逐条内联 |
| `keywordsMaxChars` | 120 | 1–10000 | 片级关键词长度上限 |
| `globalSubpath` | `["memory-win","global"]` | 非空字符串数组 | 全局层在 `DSH_HOME` 下的子路径 |
| `projectDir` | `.agent-memory` | 非空单行串 | 项目层目录名，相对会话 cwd |
| `archiveDir` | `archive` | 非空单行串 | 归档目录名，相对各层目录 |
| `stateFile` | `.state.json` | 非空单行串 | 状态文件名，不能与 `archiveDir` 同名 |
| `cleanupDays` | 3 | 1–10000 | 失效满几天后可归档（含边界） |
| `cleanupDelaySeconds` | 10 | 0–86400 | 当天首次启动后延迟几秒触发清理 |
| `cleanupEnabled` | `true` | 布尔 | 是否启用容量策略 |
| `logEnabled` | `false` | 布尔 | 效果日志开关，改完要重启 |
| `maxProjectLayers` | 20 | 0–10000 | 一次后台清理最多处理多少个已知工作区 |
| `credentialPatterns` | `null` | 对象或 `null` | `{ 模式名: 正则字符串 }`，整段替换内置 8 类 |
| `archivePointer` | 见源码 | 非空串 | 纪律块里解释归档的那句文本 |
| `compactGuardEnabled` | `true` | 布尔 | 压缩守护总开关（备份 + 收敛，0.4.0） |
| `compactBackupEnabled` | `true` | 布尔 | 压缩前是否备份会话日志 |
| `compactBackupPlaintext` | `true` | 布尔 | 备份是否额外落可 grep 的 `.jsonl`（体积约为 zstd 的 3 倍） |
| `compactBackupKeep` | 3 | 1–100 | 每会话保留几份备份（按份删，不会留半份） |
| `compactBackupDir` | `""` | 任意单行串 | 备份根目录；空串 = `<DSH_HOME>/memory-win/session-backups` |
| `compactConvergeEnabled` | `true` | 布尔 | 压缩后超标是否补一次收敛（每周期最多一次） |
| `compactTargetTokens` | 16000 | 0–10000000 | 收敛目标：`messageTokens` 软目标；`0` = 只校验不收敛 |

启动时校验，配错直接拒绝启动，不会带着半截配置跑。除类型、范围、路径逃逸外还有两条交叉约束：
`inlineTextMax > factBodyMax` 抛错（提醒永远不会触发）；`stateFile === archiveDir` 抛错（状态文件被当成归档目录）。

没有配置编辑面板：DSH 不会为任意插件渲染配置表单（0.3.0 起有的只是第 8 节那个只读浏览页）。

---

## 6 安全边界

| 机制 | 说明 |
|---|---|
| 凭据扫描 | 内置 8 类模式（`sk-`、`sk-ant-`、`AKIA`、`gh[pousr]_`、`xox[bpars]-`、私钥块、`Bearer`、凭据赋值）。命中即拒绝，且只报模式名与行号，不回显匹配值，否则拒绝原因会把凭据复制进上下文与日志。`memory_correct` 的 `replacement` 同样过闸 |
| 写入守卫 | 拦住用原生 `write`/`edit` 直改记忆文件，引导改用 `memory_add` / `memory_correct` |
| 路径逃逸 | `shard` 名拒绝 `..`、分隔符与 Windows 保留字符，并做解析后的包含性复核；`globalSubpath`/`projectDir`/`archiveDir` 这些配置项走同样校验 |
| 保留语法 | 正文不得含 `-->`（会提前闭合取代注释），也不得自带行尾 `[fix:… of #…]` |
| 取代不得回填 | 拒绝替换日期早于被取代者的条目，避免时间线倒挂；同日取代允许，旧条目此时已被注释、不再是活条目，不产生环 |
| 归档只搬失效条目 | 活条目永不搬走，搬走的行原样保留，可手工贴回 |
| 原子写 | 同目录临时文件（带 pid 与随机数）→ `rename` 覆盖 |
| 并发 | 每文件一条 promise 串行链加写前重读，分片与 `.state.json` 共用 `lib/fs-utils.js`；20 路并发追加的回归断言一条不丢 |
| fail-visible | 注入渲染失败、项目层不可用都留下可见痕迹；配置非法拒绝启动，不静默返回空 |

### 6.1 明确声明的限制

1. **守卫只覆盖原生 `write`/`edit`。** `pwsh`、MCP 工具、其它插件都能绕过。它防手滑，不防对抗。
2. **两条守卫路径同时挂载、取并集。** `tools.guard()` 与 `tools/pre-execute` waterfall 都注册，
   共用同一判定 `directWriteDenial()`。早期实现写成二选一，由于 DSH 有 `tools.guard`，项目层那条分支
   从不执行，`.agent-memory/*.md` 的直写完全不被拦，在真实宿主里实测到写入成功落盘才修掉。
   教训：单调性更强不等于覆盖面更广。
3. **项目层守卫只保护会话 cwd 下的 `.agent-memory`。** 子目录里若有 `.agent-memory`，在父目录会话里
   写它不会被拦。这是设计后果；要支持多项目根得改成保护工作区树下所有 `.agent-memory`。
4. **跨进程并发写不做锁。** 串行化只在进程内（DSH 插件跑在宿主进程内，桌面版成立）。
   锁文件方案刻意放弃：pid 存活探测在 Windows 上语义不可靠。多会话并发写同一分片没有实测。
5. **不做 shell 解析。** 不解析 `pwsh` 的重定向目标判断「是否在改记忆」，这类启发式在 Windows 上收益低、误报多。
6. **不做向量检索、不做后台巩固、不调用模型。** 刻意的取舍，不是未完成。
7. **长内容不是记忆的形态。** 单行加写入上限是条目格式的硬约束：多行会破坏 `- [日期] 事实` 结构、
   破坏去重与取代。复盘和长清单走「文档 + 指针」。把这类文档手工写进记忆目录同样会被守卫拦
   （守卫拦的是落到记忆目录的原生 `write`/`edit`，包括新建文件），所以文档要放仓库普通路径。
8. **归档件不会被自动读回。** 不进注入、不被检索命中，这正是搬走的意义。要读旧结论得
   `memory_cleanup` 拿路径再 `read`，或手工贴回分片，没有「归档检索」这种半自动通道。
9. **后台清理的项目层依赖宿主 `storages/workspace.json`。** 那是宿主内部格式，格式若变则后台清理
   只覆盖全局层：读不懂就少扫一层，不猜目录、不报错。当次会话所在工作区走 cwd，不受此限。
10. **配置只能改 profile 的 `cordis.patch.yml`，改完要重启**（见 4.4）。

---

## 7 验证状态

### 7.1 单测 185 例

`node test/run.mjs`。`node --test test/` 在受限沙箱下会 `spawn EPERM`：它把每个文件 fork 成子进程
并用管道收 stdio，而沙箱禁止子进程管道，表现是整个运行器跑不起来、看起来像测试失败。同进程依次
import 结果完全一致。

| 测试文件 | 用例 | 覆盖 |
|---|---:|---|
| `format.test.js` | 23 | 日期合法性与进位陷阱、凭据扫描（含不得回显）、`{{` 中和、行号、去重语义、id 稳定性与唯一性、取代元数据、正文保留语法 |
| `paths.test.js` | 10 | `DSH_HOME` 优先级、`HOME` 缺失时绝不为空串、cwd 缺失时失败关闭、slug 跨平台稳定、shard 路径逃逸 |
| `config.test.js` | 15 | 解析顺序、未知键前向兼容、非法一律抛、交叉约束、配置值真的被行为层读到、凭据模式表整段替换与标志剥离 |
| `engine.test.js` | 43 | 建片与追加、两层隔离、20 路并发不丢、取代全套语义、片路径相对化与绝对化分工、关键词四种情形、超长正文必须回 warning |
| `cleanup.test.js` | 19 | 只搬已失效且过宽限期的条目、活条目永不归档、空分片删除、当天只跑一次、从 `workspace.json` 发现工作区、读不懂时降级 |
| `map.test.js` | 10 | 空态纪律块、纪律块含「长内容 → 文档 + 指针」、档位切换、头行不含数字、`{{` 中和 |
| `log.test.js` | 12 | 关时零写盘、每事件一行合法 JSONL、1 MB 轮转、小时种子回读、写失败即停写、命中率与 UI 同分母、分项校验和闭合 |
| `mount.test.js` | 32 | 段注册、五工具 schema、两条守卫路径同时挂载、`memory_correct` 端到端、非法配置拒绝启动、效果日志接线（包装不改变返回值、关时注入逐字节不变） |
| `write-alarm.test.js` | 5 | 真写入后首条 usage 超阈值告警一次并复位；duplicate 与空跑不置位 |
| `adapter-patch.test.js` | 1 | 读真实已装的 our-free-model 副本断言 chat wire 声明 `systemPromptUpdate:'in-history'`；补丁被覆盖时该测试变红，错误消息即重放链 |
| `view.test.js` | 15 | 记忆视图路由接线、初始列表零查询、两档渲染（完整正文/片行）、archive 与历史行不进视图、workspace 白名单与同码拒绝、信任门与 405/403 留痕 |

挂载层断言的三条宿主契约（`systemPrompt.section` 的 `text` 可传函数、`tools.register` 收原始 JSON Schema
且 `execute` 返回普通 JSON 值由 `output.render` 转换、`tools.guard` 返回拒绝原因字符串）实读 DSH 运行时
bundle 得到，不是照 TypeScript 声明推测。

### 7.2 宿主内实测

真实会话内跑了 14 轮，第 3 轮出过一次四工具全丢（`inject` 缺 `tools` 加宿主跑陈旧拷贝），当轮修掉；
第 14 轮（0.3.x 记忆视图）首装即 404（D8：点号读未声明的 `ctx.webServer` 被 Cordis 拒绝），
0.3.1 修后实测通过。其余各轮全部通过。净结果：所有已交付功能都在真实宿主里实测过，
共暴露并修复 6 个真实缺陷（守卫只覆盖一层、`inject` 静默丢工具、部署未同步、同日不可取代、
0.2.1 在无记忆的仓库里凭空建目录、0.3.0 未声明服务访问被拒）。逐轮做法与证据表见
进度文档 §3.x，本文件不重复。

几个关键结论：

| 项 | 结果 |
|---|---|
| 全局层根目录解析 | 本机 `HOME` 未设，仍解析到 `%USERPROFILE%\.dsh\memory-win\global`，证明「调用时求值 + `homedir()` 兜底」两条都生效 |
| 检索行号 | `memory_search` 给 `line=3`/`line=4`，实读文件条目正好在那两行。「检索 → 按行号取原文」这条主工作流在真实文件上成立 |
| 写入守卫 | 全局层与项目层的原生 `write` 都被拒；写子目录下的 `.agent-memory` 不拦，那是限制 3 的正确行为 |
| 效果日志对账 | `inject.chars` 与同代码重渲染逐字节一致；`usage` 行与宿主 `tokenUsage` 投影逐字段相等（设置页同一数据源），分母与 UI 一致 |
| 一次写入的缓存代价 | 写入前 `hitRate 0.9951` → 写入后首步 `0.0262` → 下一步恢复 `0.9985`。注入长度前后都是 1890，长度不变、内容变了照样全 miss，前缀缓存按内容寻址。量级结论：一次记忆写入约等于一步全 miss |
| 归档动作 | 探针条目（失效满 3 天）在重启约 10 秒后被整片搬进 `archive/`，原分片删除，同层活分片未动，地图脚注报 `归档 1 件` |

`path` 一致性的取数纪律是：只认文件与同源数据（日志 JSONL、宿主投影、同代码重渲染三者对账），
不采信「工具说自己成功了」。

### 7.3 仍未验证

- **收敛半边的"补压"行为待真实压缩观测（0.4.3）**：`compaction` 只在 preset 的
  `cordis:group(compaction)` 子树里，所以要走 `convergeOnly: true` 把**收敛专用实例**挂进
  那个组（专利形态见「0.4.3 变更说明」）。装好后判据是效果日志里出现
  `compact_guard_half half=converge`；真正的"补压"只在宿主压完仍高于
  `compactTargetTokens`（默认 16000）时才发生，本机尚无该场景的自然样本。
  ⚠️ 已实测**不可行**的两条路：把完整形态挂进 preset（工具重名报错）、
  把插件挂在 preset 的 plugins 层（拿不到服务，纯 Cordis 实验见上）。
- ~~0.3.0 记忆视图宿主内实测未做~~ **✅ 已闭合（0.3.1，第 14 轮）**：首装即 404（缺陷 D8：直接点号读
  未声明的 `ctx.webServer` 被 Cordis 拒绝），改子作用域后重启实测通过——设置页显示全局层 +
  6 个登记工作区、展开取数与两档渲染正常、按钮禁用态正确、无 HTTP 错误。逐轮证据见进度文档
  §3.28。0.3.2 的按钮右移与补关键词属 UI 顺序与数据内容，
  随下次重启顺带目视确认。
- **本机单测基线 179 / 185**：6 项失败（adapter-patch 1、cleanup 1、log 2、mount 2）在未修改基线上
  同样失败、用例名一致，正常权限重跑结果相同——**不能全部归因沙箱权限，归因待查**。
  涉及读真实已装适配器与其它工作区的用例，疑似本机环境状态漂移；记忆视图未触碰这些行为。
  （0.4.2 后在 Linux 上跑全量是 **201 / 208**：同一批 6 项 + `paths` 里那条硬编码
  `E:\Game\repo` 的用例；这 7 项**单文件跑全过**——`mount` 33/33、`log` 12/12、
  `cleanup` 19/19、`compact-guard` 22/22 ⇒ 属于跨文件测试污染 + Windows 专属断言，
  不是功能缺陷。）
- 效果日志的四个边缘分支只有单测覆盖：1 MB 轮转、写失败停写、`attempt` 流、`config_error`。
  都要刻意构造故障或超量才会在真实磁盘上发生。
- `write_alarm` 的触发分支同理，宿主内不可自然触发。
- in-history 的「新图战胜旧图」是 n=1 行为探针，旧图并存对遵从度的影响没有多样本测量。
- 悬崖处 `cacheRead` 恒为 8,192 的上游成因未证实（两个会话同值、全部观测是 64 的倍数），
  本地只有观测，不确知网关是否有最小缓存块或上报粒度语义。
- 归档在真实数据量下省多少体积没测，只验了动作正确。

### 7.4 环境事实

1. 沙箱临时目录会被重映射（`$env:TEMP` 实际指向随机子目录），测试全部用 `mkdtempSync`，不依赖固定路径。
2. 沙箱禁止写 `~/.dsh`（工作区之外），`dsh plugin add` 与 `install_bundle` 都要放宽权限后才能执行；普通桌面版用户无此限制。
3. 系统日期早于某些文档落款时，写入「明天」的条目被正确拒绝，反向验证了未来日期守卫。
4. `dsh plugin add` 的进程有时会挂住不退出（依赖与 lockfile 已写好、无子进程残留），确认输出后结束它即可；
   偶发最后写 `package.json` 报 `EPERM rename`，重跑一次即成功。
5. **同一文件绝不能嵌套两层写入串行链，会自死锁。** 0.2 初版把读-改-写写成外层 op 里 await 同文件内层 op，
   内层排在外面自己后面，promise 永不 settle：`memory_add` 整个挂住，Node 报
   `Promise resolution is still pending but the event loop has already resolved`。修法是取消嵌套，
   由 `lib/fs-utils.js` 的 `writeAtomically` 负责唯一一次落盘。现象看起来像 fs 被沙箱挡住，实际是纯逻辑死锁，
   定性靠给 op 打点，不靠猜沙箱。
6. 网关会偶发把整段前缀驱逐：相邻两步之间出现 `cacheRead=0 / hitRate=0`，下一步立即恢复。内容与注入都没变，
   是服务端丢了缓存。这类整段 miss 不在 `write_alarm` 覆盖面内（告警只在写入置位后的那一步判读）。
   判读口径：看 usage 行配对的 inject/add 事件，没有事件变化的整段 miss 归因上游，不追插件。

---

## 8 记忆视图（0.3.0）

「设置 → 记忆视图」是只读浏览页，双半边形态照 dsh-archived：

- **宿主半边**（`lib/view.js`）：两条 GET exact 路由挂在 `webServer` 上。
  - `GET /api/dsh-memory-win/layers`：初始列表 = 全局层 + `knownWorkspacePaths()` 登记的工作区。
    一次分片都不读，响应里刻意没有条数字段——"有没有记忆"是展开时才算的事。
  - `GET /api/dsh-memory-win/shards?workspace=<绝对路径|global>`：展开时查单层。档位判定在
    服务端做，与注入地图共用 `config.inlineThreshold`：内联档逐条给**完整正文**（注入截 160，
    UI 不截），地图档逐片给片名/条数/最新日期/关键词。失效历史行、`archive/`、`.state.json`
    一律不出现——复用 `parseEntries` 的跳过，不是新判定。
- **浏览器半边**（`lib/client.js`）：lazy-CJS 单文件挂 `settings.section` 插槽（id `memory-view`），
  由 package.json 的 `dsh.client` 声明、宿主按约定加载，patch 里不用另登记。每行左侧是名称与路径、
  右侧「折叠」「展开」两个常显按钮（0.3.2 起）、按状态禁用其一；点「展开」才请求该层，
  收起即弃、再展开即重读。路由失败或业务错误显示本地化文案，不会画成空列表。
  词典 zh/en 走 `ctx.locale.register`。

安全边界与其余部分同源：

- `workspace` 白名单。查询路径必须命中登记表；大小写不敏感比较只用于认工作区，命中后
  用登记表的权威路径解析层目录。未登记与不存在给同一个错误码，访问者探测不出目录结构。
- 信任门照抄 archived 的实测结论：回环硬条件；`Origin`/`sec-fetch-site` 出现即权威、
  不能被标头推翻；两者都缺（桌面应用自带管线）时要 `x-dsh-memory-win: 1`。拒绝留痕。
- 只读即只读：没有 POST 路由，修改仍只有五个 `memory_*` 工具。
- `webServer` 通过独立的 `ctx.inject(["webServer"], …)` 子作用域等待就绪（0.3.1）：
  有 Web 服务时挂路由，没有时只是"浏览页没有"，注入与工具照常。与 `tools` 缺席必须抛错的
  分工不同——后者是插件的存在意义。注意**不能**直接点号读未声明的服务：Cordis 会抛
  `cannot get property "webServer" without inject`（0.3.0 的 404 就是这么来的，见修复说明）。

定位边界：列表与展开内容都不做分页与搜索，浏览页看结构，取内容走 `memory_search`。

测试：`test/view.test.js`（15 例：接线、零查询初始列表、两档渲染、白名单、信任门）、
`tools/view-lifecycle.mjs`（真实 Cordis 生命周期 + 真实 HTTP：修复前 404、修复后 200，
服务迟到/移除/重现/卸载清理各过一遍）、`tools/client-smoke.mjs`（33 项：桩 React/fetch
走全交互路径，含按钮在右的布局断言）、`tools/compat-check.mjs`（6 项：读本机 app.asar 验
`webServer` exact 路由、`settings.section` list 插槽与 locale 契约，DSH 升级后先跑它）。

---

## 9 代码结构

```
index.js          挂载：initConfig + section + 五工具（包装 execute 记日志）+ 双路守卫
                  + 当天首次清理定时器 + session/event usage 订阅 + 记忆视图路由接线
                  + 压缩守护接线（0.4.0，五个宿主服务走独立注入作用域）
                  （inject: ["systemPrompt","tools"]；webServer / compaction 各自独立作用域等待就绪）
lib/config.js     配置层：默认值、解析顺序、启动校验、凭据模式表
lib/paths.js      路径与 slug，全部调用时求值；含日期窗口工具
lib/format.js     纯函数：条目格式 / 日期 / 凭据 / 去重 / id / 取代元数据 / {{ 中和 / 截断提醒
lib/fs-utils.js   文件读写唯一实现处：安全读、原子写、按文件串行链
lib/state.js      每层 .state.json：命中记录、清理标记、归档判定纯函数
lib/engine.js     存储：分层、扫描、检索、原子追加与取代、容量策略
lib/log.js        效果日志：JSONL 追加、轮转、停写、小时种子、命中率；所有入口永不抛
lib/map.js        地图档渲染 + 分项统计 + 注入纪律块
lib/view.js       记忆视图宿主半边（0.3.0）：两条 GET 只读路由、信任门、白名单、档位判定
lib/client.js     记忆视图浏览器半边（0.3.0）：lazy-CJS 单文件，settings.section 只读面板
lib/session-backup.js  压缩前备份（0.4.0）：落点/命名清洗、逐帧 zstd 解码、
                  按 seq 截出压缩前明文、按份保留
lib/compact-guard.js   压缩守护（0.4.0）：compaction/start → 备份，compaction/end →
                  messageTokens 校验 → 最多补一次 compactRegion 收敛
lib/tools.js      五个 ToolDefinition
lib/guard.js      直写守卫（两条路径共用判定与日志包装）
lib/context.js    cwd 提取，守卫与工具共用一份
scripts/pack.mjs  打包并复制到 ~/.dsh/plugin-tarballs/
tools/            view-lifecycle（真实 Cordis 生命周期回归）+ host-cordis（asar 读取助手）
                  + client-smoke（桩 React/fetch）+ compat-check（读 app.asar 验宿主契约）
                  + verify-compaction-backup（宿主重启后的只读体检：半挂没挂 / 备份合规与否）
test/             204 个用例 + 同进程运行器
```

分层原则是纯判定与 I/O 分离。`lib/format.js` 完全不碰文件系统，`normalizeConfig` 也是纯函数，
判定内核可以被穷举测试。参考插件把判定与读写混在同一个巨型文件里（`dsh-auto-memory` 的 `index.js`
1.08 MB），想测判定就得先把整个宿主上下文搭起来。

另一条纪律：`config.js` 不 import `format.js`（否则循环依赖）。内置凭据模式表由 `format.js` 在模块
求值时反向登记进配置层，扫描侧统一走 `credentialPatternList()`，「默认 8 类」与「配置替换表」只有一个出口。

---

## 9 有意没做的

`memory_delete`、关键词自动生成、子代理检索路由的程序化强制、跨进程锁、多语言、
归档内容的自动读回、记忆视图里的编辑能力（0.3.0 的浏览页刻意只读，改动仍只有五个工具），
以及本 README 之外的详细设计文档。

后续要回答的问题：

1. 配置编辑面板与关键词编辑 UI。0.3.0 的「记忆视图」是只读浏览，配置仍只有改 patch 一条路
   （见第 5 节）。
2. 一条条目被多次取代后的版本链检索。`fix` 只记直接前驱，要回答「改过几次、为什么」得顺链回溯，
   目前靠 `read` 全文人工追溯。归档后这条链会跨文件，成本上升。
3. 条目修订是否需要行级编辑。当前「取代」语义已避开整条替换的数据丢失风险。
4. 外部判定钩子：接一段纯 Node 脚本判断「这条值不值得记」，不要走 shell。
5. 召回增强：同义词、前缀、OR 兜底，或命中 0 条时自动放宽重试一次。纯 JS 可实现，不需要向量库。
   这是「长上下文遗漏细节」剩下的真短板，另一半靠写入侧自觉。
6. 归档的检索通道。要「需要时也能搜到旧结论」，先要回答「何时该把归档重新纳入召回」，
   那不是存储问题，是证据强度问题：旧结论只该作为历史参考。

---

MIT.
