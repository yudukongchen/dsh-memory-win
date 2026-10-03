# 补丁与重放链：our-free-model 的 in-history 声明

## 这是什么

`our-free-model-in-history-1.3.1.patch` —— 给第三方插件 `dsh-our-free-model` 的
`resolveModel()` 按 wire 声明 `systemPromptUpdate: 'in-history'`：
chat / responses wire 声明、messages wire 不声明（后者把所有 system 合并进顶层
字段、排在历史之前，追加快照救不了缓存，声明反而是假承诺）。

效果：memory 写入导致的 prompt 变更**追加在已缓存历史之后**，而不是从 system
节点 0 起全量重算。实测（2026-10-04，两段式）：写入步 uncached **110,613 → 5,267**、
次步 hitRate 0.9873 → 0.9904、网关接受中段 system。实验全记录见仓库根的
`../dsh-memory-win功能实施进度.md` §3.26。

- 基线提交：`0e2483f`（version 1.3.1，与已装 tarball **全量哈希逐字节等价**）
- 补丁规模：`src/adapter.js` +16 行（一个 helper + 两处 spread）

## 为什么需要"重放"

1. 该包是**第三方的**（远端 `github.com/yudukongchen/dsh-our-free-model`），装在
   `~/.dsh/profiles/desktop/node_modules/`；上游更新（1.3.2 起带签名自更新）会覆盖补丁。
2. **同名 tarball 覆盖不会让 pnpm 重装**（依赖 spec 未变，只报 downloaded 不改写
   node_modules）—— 所以长期方案是上游 PR，本地链路是 PR 合入前的过渡。

## 重放链（补丁丢失/被覆盖时按序执行）

```text
1. 基线工作树：  git -C <克隆> worktree add --detach <scratch>/ufm-131 0e2483f
2. 应用补丁：    git -C <worktree> apply <本仓库>/patches/our-free-model-in-history-1.3.1.patch
3. 打包：        npm pack --cache <scratch>/npm-cache   （沙箱内默认 npm-cache 不可写，必须重定向）
4. 先备份：      plugin-tarballs/dsh-our-free-model-1.3.1.tgz.bak-<date>
                 node_modules/dsh-our-free-model/src/adapter.js.bak
5. 替换：        覆盖同名 tgz + 直接复制 patched src/adapter.js 进 node_modules
                 （第三方包**不动版本号** —— 版本号是上游的，升它等于宣布 fork）
6. 重启桌面版，然后 node test/run.mjs：adapter-patch 测试转绿即成功
```

## 覆盖探测（双层守护断言）

- **层 1 · 字段断言**：`test/adapter-patch.test.js` 每次跑测试都读**真实已装副本**、
  构造 stub state 直调 `resolveModel()`；补丁被上游更新抹掉时该测试红，错误消息即上面的重放链。
- **层 2 · 效果告警**：`lib/log.js` 的 `write_alarm` 事件 —— 真写入（add/correct/
  cleanup-有归档）之后第一条 usage 若 `uncached > 10,000` 即落告警并复位。
  守的是**实际效果**：字段还在、语义变了（网关规则漂移）也能兜住。需 `logEnabled: true`。

## 上游 PR

实验通过后向上游提 PR（与官方 `dsh-llm-deepseek` 同语义的字段声明）。合入后本补丁退役，
重放链仅留作历史，层 1/层 2 测试**保留**（PR 被拒或未合入期间它们就是补丁的看守）。
