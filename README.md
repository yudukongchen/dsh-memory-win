# dsh-memory-win

DSH 桌面版（Windows 优先）的长期记忆插件 —— **纯本地、零依赖、零 shell、零外部服务**。

> 这是 **demo**，详细设计后续补充。当前实现刻意最小化，但核心机制与安全边界是完整的、有测试覆盖的。

---

## 1. 为什么写它

现有四个记忆插件（`dsh-memory`、`dsh-auto-memory`、`dsh-memory-evolve`、`hindsight`）默认面向 Linux/macOS，在 Windows 上表现不好。把四份审查报告交叉后，问题归为**三类**（并非都是"硬编码 shell"）：

| 类别 | 具体形态 | 出处 |
|---|---|---|
| **路径 / 环境** | 根目录在**模块加载期**求值：`const HOME = process.env.HOME ?? ""`。Windows 上 `HOME` 通常未设（用 `USERPROFILE`）⇒ 空串 ⇒ 全局层路径变成 `/.dsh/memory/topics`，**整体静默失效** | dsh-memory A3 |
| | `update.js` 用 `process.env.HOME ?? ''`，退化成**相对路径** `.dsh`，随 CWD 漂移 | dsh-memory-evolve B8 |
| **shell 依赖** | 硬编码 `/bin/zsh`，且 `execFile` 的同步抛出**未被捕获** ⇒ 钩子抛穿、进程崩溃（实测 `spawn EPERM` 起） | dsh-memory A1 |
| | `sh -c` + `child.on('error')` 静默吞错 ⇒ 通知**永远不触发** | dsh-memory-evolve C10 |
| | `process.kill(-pid)` 依赖 POSIX 进程组 ⇒ Windows 上承诺的"进程树终止"不成立 | dsh-memory-evolve B7 |
| **外部进程语义** | 注入回调里每步 `spawnSync('git', ...)`，失败**静默** catch ⇒ 分支隔离静默失效 | dsh-memory-evolve B2/B3 |

**关键推论**：只要做到「零 shell、零外部进程、路径全走 `node:path` + `homedir()`/`DSH_HOME` 且**调用时求值**」，就已经绕开上述全部三类失效 —— 因此本插件**不需要为 Windows 写任何 `if (platform)` 分支**。

注：`dsh-memory-evolve` 是四个里唯一真做了跨平台处理的（`process.platform` 分支），所以问题不能一概而论；它的 `memoryDir` 解析（`DSH_HOME || homedir()`）是四个里唯一写对的。

---

## 2. 采用的机制（以及来自谁）

核心取舍来自 `dsh-memory`：**注入的只有地图，正文永远按需检索。**

```
~/.dsh/memory-win/global/*.md           ← 全局层（跨项目通用）
<repo>/.dsh-memory/*.md                 ← 项目层（随仓库走，默认被 .gitignore 忽略）
```

每个 `*.md` 是一个**主题分片**，首行可选关键词头，正文是条目：

```markdown
<!-- windows-paths · pwsh git-bash 路径 引号 -->

## 坑

- [2026-09-28] pwsh 里读文件用 Get-Content -Raw；不要用 cat
- [2026-10-01] git bash 下路径要写成 /e/Game 而不是 E:/Game
```

条目格式是唯一硬约定：`- [YYYY-MM-DD] 事实`。日期经 **UTC 回读校验**（`new Date("2026-13-45")` 会进位到 2027-02-14 而不是 Invalid Date，只判 `NaN` 会把这类错误放行）。

### 注入档位：地图档

| 状态 | 注入内容 |
|---|---|
| 某层条目 ≤ 8 | 逐条**内联**（小层内联比让模型多跑一次检索更值），并标注档位 |
| 某层条目 > 8 | 每片一行：`片名：N 条 ｜ 最新日期 ｜ 路径 ｜ 关键词` |
| 完全为空 | 仍注入**纪律块**：否则模型不知道记忆功能存在，就永远不会有第一条 |

**头行只有档位、没有统计数字。** 统计（`记忆合计 N 片 / M 条`）刻意放在**段尾**：头行在系统提示词最前面，一放"N 片 / M 条"这种每写一条就变的数字，整个前缀就失去缓存。这条纪律来自 `dsh-memory` 的实测（写一条记忆后子代理首轮 `cacheRead` 从 85% 掉回 0%）。

### 三个工具

| 工具 | 作用 |
|---|---|
| `memory_list` | 列出两层的地图（片名 / 条数 / 最新日期 / 关键词 / 路径） |
| `memory_search` | 按关键词跨层检索，**命中带文件与行号** → 直接用 `read offset=` 取原文 |
| `memory_add` | 追加一条，经格式 / 日期 / 凭据三项校验 + 原子写 |

`memory_search` 是**纯 JavaScript 子串匹配**（空格分词为 AND 语义，中文无需分词），不调用任何模型、不做向量检索 —— 因此**零额外 LLM 成本**。

---

## 3. 安全与稳健性（明确边界）

| 机制 | 说明 |
|---|---|
| **凭据扫描** | 8 类模式（`sk-` / `sk-ant-` / `AKIA` / `gh[pousr]_` / `xox[bpars]-` / 私钥块 / `Bearer` / 凭据赋值）。命中即 **deny**，且**只报模式名与行号，绝不回显匹配值** —— 否则拒绝原因会把凭据复制进模型上下文与日志 |
| **写入守卫** | 拦住用原生 `write`/`edit` 直改记忆文件，引导改用 `memory_add` |
| **路径逃逸** | `shard` 名称拒绝 `..`、分隔符与 Windows 保留字符，并做解析后的包含性复核 |
| **原子写** | 同目录临时文件（带 pid + 随机数）→ `rename` 覆盖 |
| **并发** | 每文件一条 promise 串行链 + **写前重读**。20 个并发追加的回归测试断言一条不丢 |
| **fail-visible** | 注入渲染失败、项目层不可用等情形都**留下可见痕迹**，不静默返回空 |

### 声明清楚的限制

1. **守卫只覆盖原生 `write`/`edit`。** `pwsh`、MCP 工具、其它插件都能绕过。**它是防手滑，不是防对抗。**
2. **两条守卫路径覆盖面不同**：`tools.guard()`（单调、不可被后续监听者放行）回调只拿到 `execution`、没有可靠的 cwd，因此**只拦全局层**；项目层由 `tools/pre-execute` waterfall 覆盖。两者一起挂，取并集。
3. **跨进程并发写不做锁。** 串行化是**进程内**的（DSH 插件跑在宿主进程内，这在桌面版是成立的）。锁文件方案被刻意放弃 —— `dsh-memory-evolve` 的 pid 存活探测锁在 Windows 上语义不可靠。
4. **不做 shell 解析。** 不解析 `pwsh` 的重定向目标去判断"是否在改记忆"。这类启发式在 Windows 上收益低且正是误报来源。
5. **无浏览器半身 / 无设置面板。** 开关与 UI 后续再补。
6. **不做向量检索、不做后台巩固、不调用模型。** 这是刻意的取舍，不是未完成。
7. **未在真实 DSH 宿主内做端到端验证**（见下节）。

---

## 4. 验证结果

### 已验证

```
$ node test/run.mjs
# tests 66
# pass 66
# fail 0
```

66 个用例，全部通过，覆盖：

- **纯函数**（15）：日期合法性（含闰年与 `2026-13-45` 进位陷阱）、凭据扫描（含"不得回显凭据"断言）、`{{` 中和、条目解析行号、代码围栏跳过、去重语义
- **路径**（10）：`DSH_HOME` 优先级、**`HOME` 缺失时绝不为空串**、slug 跨平台稳定、`displayPath` 相对化、shard 路径逃逸拒绝
- **存储**（19）：建片、追加、完全重复与"同事实换日期"的区分、凭据/日期/多行拒绝、两层隔离、**20 路并发追加一条不丢**、链槽位复用
- **注入档位**（9）：空态纪律块、小层内联、超阈值切地图、**头行不含数字**、统计在段尾、`{{` 中和、无 cwd 时声明不可用
- **挂载**（13）：段注册、三工具 schema 形状、`execute` 返回值 → `render` 一致、**守卫只拦 write/edit 且异常时无副作用放行**、无 `tools` 服务时仍能注入

其中「挂载」层断言的三条宿主契约（`systemPrompt.section` 的 `text` 可传函数、`tools.register` 收**原始 JSON Schema** 且 `execute` 返回普通 JSON 值由 `output.render` 转换、`tools.guard` 返回拒绝原因字符串）是**实读 DSH 运行时 bundle 得到的**，不是照 TypeScript 声明推测的。

### 未验证（明确声明）

- **未在真实 DSH 宿主内挂载运行。** 本机 `node v18.16.0`、DSH desktop profile 未做改动。上述挂载测试用的是**假 ctx**，它验证的是"接线形状符合契约"，**不等于宿主内实际生效**。
- 未验证真实会话里的注入时序与 KV cache 实际命中率。
- 未验证多会话并发（当前只有单进程内的并发回归测试）。

### 环境事实（踩到的两个坑，值得记录）

1. **`node --test test/` 在受限沙箱下会 `spawn EPERM`。** 它把每个文件 fork 成子进程并用管道收 stdio，而沙箱禁止子进程管道通信 —— 表现是**四个测试文件全报 `spawn EPERM`、一条断言都跑不到**，看起来像测试失败，实际是运行器跑不起来。因此改用 `test/run.mjs` 在**同进程内**依次 import，断言与结果完全一致。
2. **沙箱临时目录会被重映射**（`$env:TEMP` 实际解析到 `...\Temp\dsh-<random>\...`）。测试因此全部使用 `mkdtempSync`，不依赖固定路径。

---

## 5. 怎么用

```powershell
# 1) 跑测试
cd dsh-memory-win
node test/run.mjs

# 2) 装进桌面版 profile（需要时再执行；会改动 ~/.dsh/profiles/desktop）
dsh plugin --profile desktop add "file:E:\Game\github\dsh-memory-win"
```

或手工在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-memory-win
      name: 'dsh-memory-win'
      config: {}
```

然后把包放进 `~/.dsh/profiles/desktop/node_modules/`，重启桌面版。

**桌面版是启动型 profile，改动后必须重启才生效。**

### 数据位置

| 层 | 路径 |
|---|---|
| 全局 | `%DSH_HOME%`（默认 `C:\Users\<你>\.dsh`）`\memory-win\global\*.md` |
| 项目 | `<会话工作目录>\.dsh-memory\*.md` |

项目层放在仓库内、且默认被 `.gitignore` 忽略（`dsh-memory-win/.gitignore` 只覆盖自身仓库；**使用者的仓库需自行忽略 `.dsh-memory/`**）。

---

## 6. 代码结构

```
index.js             插件挂载：section + 三工具 + 双路守卫
lib/paths.js         路径与 slug —— Windows 适配核心，全部调用时求值
lib/format.js        纯函数：条目格式、日期校验、凭据扫描、去重、{{ 中和
lib/engine.js        存储：分层、扫描、检索、原子追加、并发串行化
lib/map.js           地图档注入渲染
lib/tools.js         三个 ToolDefinition
lib/guard.js         write/edit 直写守卫（两条路径共用判定）
lib/context.js       cwd 提取（守卫与工具共用一份，避免两处漂移）
test/                66 个用例 + 同进程运行器
```

分层原则：**纯判定与 I/O 分离**。`lib/format.js` 完全不碰文件系统，因此判定内核可以被穷举测试 —— 参考插件把这类判定与文件读写混在同一个巨型文件里（`dsh-auto-memory` 的 `index.js` 1.08 MB），导致"想测判定"必须先把整个宿主上下文搭起来。

---

## 7. 已知限制与后续

**本 demo 有意没做的**：设置面板与开关、`memory_update`/`delete`（修订既有条目）、片级关键词的自动生成、子代理检索路由、跨进程锁、多语言、以及 `README` 之外的详细设计文档。

**后续补充设计时需要回答的问题**：

1. 条目修订的语义（`replace` 整条替换有真实的数据丢失史 —— `dsh-memory-evolve` 的 `memory-consolidate` 自述"更正一条多段记忆时只写了新句子，其余段落整条丢失"）。是否需要行级编辑而非整条替换？
2. 关键词头由谁维护、何时自动生成。
3. 记忆容量策略：当前**无上限**。`dsh-memory-evolve` 因三轨全量注入导致提示词成本线性增长，本插件靠"地图档"避免了这一点，但地图本身仍随分片数线性增长。
4. 是否需要 `dsh.client` 半身（设置面板）。

---

MIT.
