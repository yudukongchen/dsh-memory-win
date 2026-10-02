/**
 * 挂载测试：用**假 ctx** 验证 `apply()` 与宿主的接线是否符合真实契约。
 *
 * 为什么需要这一层：单元测试只能证明纯逻辑对，证明不了"接上去能跑"。
 * 参考插件里最常见的失效恰恰在接线处（`spawn EPERM` 抛穿、路由注册失败、
 * 回调签名不符），而那些问题单测抓不到。
 *
 * 这里断言的三条契约是**实读 DSH bundle 得到的**，不是照 TypeScript 声明猜的：
 *  1. `systemPrompt.section({ name, order, text })`，`text` 可以是函数；
 *  2. `tools.register()` 收原始 `ToolDefinition`：`parameters` 是 **JSON Schema**，
 *     `execute()` 返回**普通 JSON 值**，`output.render(args, value)` 产出 ContentBlock[]；
 *  3. `tools.guard(fn)` 的返回值是**拒绝原因字符串**（或 `undefined` 放行）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { apply, inject, name as pluginName } from "../index.js";
import { SECTION_NAME } from "../lib/map.js";
import { PROJECT_DIR_NAME } from "../lib/paths.js";

const savedDshHome = process.env.DSH_HOME;
let sandbox;
let fakeHome;
let projectCwd;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "dsh-memory-win-mount-"));
  fakeHome = join(sandbox, "dshhome");
  projectCwd = join(sandbox, "repo");
  process.env.DSH_HOME = fakeHome;
});

afterEach(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* 忽略 Windows 占用 */
  }
});

/**
 * 造一个记录调用的假 cordis 上下文。
 *
 * @param {{withTools?:boolean, withGuard?:boolean}} [options] - 是否提供 tools / guard。
 * @returns {object} 假 ctx 与录到的注册项。
 */
function fakeCtx(options = {}) {
  const { withTools = true, withGuard = true } = options;
  const record = { sections: [], tools: [], guards: [], listeners: [], cleaned: 0 };

  const tools = withTools
    ? {
        register(definition) {
          record.tools.push(definition);
          return () => {
            record.cleaned += 1;
          };
        },
        ...(withGuard
          ? {
              guard(fn) {
                record.guards.push(fn);
                return () => {
                  record.cleaned += 1;
                };
              },
            }
          : {}),
      }
    : undefined;

  const ctx = {
    effect(factory) {
      const dispose = factory();
      return typeof dispose === "function" ? dispose : () => {};
    },
    on(event, listener) {
      record.listeners.push({ event, listener });
      return () => {
        record.cleaned += 1;
      };
    },
    get(key) {
      return key === "tools" ? tools : undefined;
    },
    systemPrompt: {
      section(definition) {
        record.sections.push(definition);
        return () => {
          record.cleaned += 1;
        };
      },
    },
    tools,
  };
  return { ctx, record };
}

test("插件元数据符合宿主约定", () => {
  assert.equal(pluginName, "dsh-memory-win");
  // tools 刻意不进 inject：工具注册表缺席时插件仍应能注入地图。
  assert.deepEqual(inject, ["systemPrompt"]);
});

test("apply 注册一个提示词段，name 与 SECTION_NAME 一致", () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  assert.equal(record.sections.length, 1);
  assert.equal(record.sections[0].name, SECTION_NAME);
  assert.equal(typeof record.sections[0].order, "number");
  assert.equal(Number.isFinite(record.sections[0].order), true, "order 必须有限");
});

test("注册的四个工具名与 schema 形状正确", () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);

  assert.deepEqual(
    record.tools.map((t) => t.name).sort(),
    ["memory_add", "memory_correct", "memory_list", "memory_search"],
  );

  for (const tool of record.tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.description.length > 40, true, `${tool.name} 的 description 应足够说明用途`);
    // 契约 2：parameters 必须是 object 根 JSON Schema
    assert.equal(tool.parameters.type, "object", `${tool.name}.parameters 必须是 object 根`);
    assert.equal(typeof tool.parameters.properties, "object");
    // 契约 2：output 必须有 schema 与 render
    assert.equal(tool.output.schema.type, "object", `${tool.name}.output.schema 必须是 object 根`);
    assert.equal(typeof tool.output.render, "function");
    assert.equal(typeof tool.execute, "function");
  }
});

test("只读工具不声明必填参数，写入工具必填 fact", () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const byName = Object.fromEntries(record.tools.map((t) => [t.name, t]));

  assert.equal(byName.memory_list.parameters.required, undefined);
  assert.deepEqual(byName.memory_search.parameters.required, ["query"]);
  assert.deepEqual(byName.memory_add.parameters.required, ["fact"]);
  // target 的取值必须被枚举约束住，避免模型自由发挥
  assert.deepEqual(byName.memory_add.parameters.properties.target.enum, ["global", "project"]);
});

test("端到端：通过工具写入、列出、检索，render 产出可读文本", async () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const byName = Object.fromEntries(record.tools.map((t) => [t.name, t]));
  const exec = { agent: { session: { header: { cwd: projectCwd } } } };

  // 写入（不传 target → 有 cwd 时默认 project）
  const added = await byName.memory_add.execute({ fact: "本项目用 pwsh 跑测试", shard: "env" }, exec);
  assert.equal(added.ok, true);
  assert.equal(added.target, "project");
  assert.equal(added.duplicate, false);

  // 契约 2 的关键验证：execute 返回普通对象，render 必须能独立渲染出文本
  const addBlocks = byName.memory_add.output.render({}, added);
  assert.equal(Array.isArray(addBlocks), true);
  assert.equal(addBlocks[0].type, "text");
  assert.match(addBlocks[0].text, /已写入/);
  assert.match(addBlocks[0].text, /env/);

  // 列出
  const listed = await byName.memory_list.execute({}, exec);
  const project = listed.layers.find((l) => l.target === "project");
  assert.equal(project.total, 1);
  assert.equal(project.shards[0].name, "env");
  const listBlocks = byName.memory_list.output.render({}, listed);
  assert.match(listBlocks[0].text, /项目记忆/);

  // 检索（命中带路径与行号，供 read 取原文）
  const found = await byName.memory_search.execute({ query: "pwsh" }, exec);
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].line > 0, true);
  assert.equal(typeof found.hits[0].path, "string");
  const searchBlocks = byName.memory_search.output.render({ query: "pwsh" }, found);
  assert.match(searchBlocks[0].text, /line=\d+/);

  // 空命中也要渲染成人能读的提示，而不是空串
  const empty = await byName.memory_search.execute({ query: "绝不存在的词" }, exec);
  assert.deepEqual(empty.hits, []);
  const emptyBlocks = byName.memory_search.output.render({ query: "绝不存在的词" }, empty);
  assert.match(emptyBlocks[0].text, /未命中/);
});

test("端到端：同一事实换日期时工具返回可执行的拒绝说明", async () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const add = record.tools.find((t) => t.name === "memory_add");
  const exec = { agent: { session: { header: { cwd: projectCwd } } } };

  await add.execute({ fact: "同一结论", shard: "s", date: "2026-01-01" }, exec);
  const again = await add.execute({ fact: "同一结论", shard: "s", date: "2026-01-05" }, exec);
  assert.equal(again.ok, false);

  // 拒绝原因必须是"给模型看的可执行清单"，含既有日期与 confirm 出口
  const blocks = add.output.render({}, again);
  assert.match(blocks[0].text, /2026-01-01/);
  assert.match(blocks[0].text, /confirm: true/);

  // 带 confirm 后可写入
  const confirmed = await add.execute({ fact: "同一结论", shard: "s", date: "2026-01-05", confirm: true }, exec);
  assert.equal(confirmed.ok, true);
});

test("端到端：无 cwd 的会话写入回落到 global 而不是报错", async () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const add = record.tools.find((t) => t.name === "memory_add");
  const added = await add.execute({ fact: "没有工作目录时的全局事实" }, {});
  assert.equal(added.target, "global");
});

test("端到端：memory_search 给出 id，memory_correct 用它取代旧结论", async () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const byName = Object.fromEntries(record.tools.map((t) => [t.name, t]));
  const exec = { agent: { session: { header: { cwd: projectCwd } } } };

  // 先写入一条"后来被推翻"的结论
  await byName.memory_add.execute({ fact: "项目层守卫不用单独覆盖", shard: "guard", date: "2026-01-01" }, exec);

  // memory_search 必须给出 id —— 它是 memory_correct 的唯一锚点
  const found = await byName.memory_search.execute({ query: "守卫" }, exec);
  assert.equal(found.hits.length, 1);
  const id = found.hits[0].id;
  assert.match(id, /^[0-9a-f]{4}$/, "search 结果应带 id");
  const searchText = byName.memory_search.output.render({ query: "守卫" }, found)[0].text;
  assert.match(searchText, new RegExp(`id=${id}`), "render 应把 id 显式给模型");

  // 用该 id 修正
  const corrected = await byName.memory_correct.execute(
    { id, reason: "defect", replacement: "项目层必须单独覆盖，两条守卫路径都要挂" },
    exec,
  );
  assert.equal(corrected.ok, true);
  assert.equal(corrected.reason, "defect");
  assert.equal(corrected.superseded.id, id);

  const rendered = byName.memory_correct.output.render({}, corrected)[0].text;
  assert.match(rendered, /已修正（defect）/);
  // 必须明确告知"旧条目已不再可用" —— 否则模型可能以为还能检索到它
  assert.match(rendered, /不再注入提示词、也不再被 memory_search 命中/);
  assert.match(rendered, new RegExp(`失效条目 #${id}`));

  // 旧结论必须已经检索不到，且不再出现在地图里
  const after = await byName.memory_search.execute({ query: "项目层守卫不用单独覆盖" }, exec);
  assert.equal(after.hits.length, 0, "被取代的结论不得再被检索命中");

  const mapped = byName.memory_list.execute
    ? await byName.memory_list.execute({}, exec)
    : undefined;
  assert.equal(mapped.layers.find((l) => l.target === "project").total, 1);
});

test("端到端：memory_correct 的 retract 分支渲染", async () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const byName = Object.fromEntries(record.tools.map((t) => [t.name, t]));
  const exec = { agent: { session: { header: { cwd: projectCwd } } } };

  await byName.memory_add.execute({ fact: "这条以后不再成立", shard: "r", date: "2026-01-01" }, exec);
  const id = (await byName.memory_search.execute({ query: "不再成立" }, exec)).hits[0].id;
  const result = await byName.memory_correct.execute({ id, reason: "retract" }, exec);

  assert.equal(result.retracted, true);
  const rendered = byName.memory_correct.output.render({}, result)[0].text;
  assert.match(rendered, /已撤回（retract）/);
  assert.match(rendered, /现余 0 条有效记忆/);
});

test("端到端：memory_list entries=true 给出 id，补住「搜不到就无法修正」的缺口", async () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const byName = Object.fromEntries(record.tools.map((t) => [t.name, t]));
  const exec = { agent: { session: { header: { cwd: projectCwd } } } };

  await byName.memory_add.execute({ fact: "一条与关键词无关的记忆：HMR 只监听 patch 文件", shard: "hmr", date: "2026-01-01" }, exec);

  // 关键词检索根本找不到它 —— 这正是缺口所在
  const missed = await byName.memory_search.execute({ query: "守卫 路径" }, exec);
  assert.equal(missed.hits.length, 0, "前置：该条目确实搜不到");

  // 地图（默认）也不含条目 id
  const map = await byName.memory_list.execute({}, exec);
  assert.equal(map.layers.find((l) => l.target === "project").entries, undefined, "默认只给分片级地图");

  // entries=true 才能拿到 id
  const browsed = await byName.memory_list.execute({ entries: true }, exec);
  const projectLayer = browsed.layers.find((l) => l.target === "project");
  assert.equal(projectLayer.entries.length, 1, "entries=true 应列出全部条目");
  const id = projectLayer.entries[0].id;
  assert.match(id, /^[0-9a-f]{4}$/);

  const rendered = byName.memory_list.output.render({}, browsed)[0].text;
  assert.match(rendered, new RegExp(`#${id}`), "render 应给出 id");
  assert.match(rendered, /id 可用于 memory_correct/);

  // 用浏览得到的 id 完成修正
  const corrected = await byName.memory_correct.execute(
    { id, reason: "defect", replacement: "HMR 只监听 profile 的 patch 文件" },
    exec,
  );
  assert.equal(corrected.ok, true);
});

test("memory_correct 的 schema 形状：id/reason 必填，reason 受枚举约束", () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const correct = record.tools.find((t) => t.name === "memory_correct");

  assert.deepEqual(correct.parameters.required, ["id", "reason"]);
  assert.deepEqual(correct.parameters.properties.reason.enum, ["defect", "overturned", "correction", "retract"]);
  assert.equal(correct.parameters.properties.id.type, "string");
  assert.equal(correct.parameters.properties.target.enum.join(","), "global,project");
  assert.equal(correct.output.schema.type, "object");
  assert.equal(typeof correct.output.render, "function");
});

test("段文本函数产出地图，且不同 cwd 得到不同项目层", () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const section = record.sections[0];

  const a = section.text({ agent: { session: { header: { cwd: join(sandbox, "repo-a") } } } });
  const b = section.text({ agent: { session: { header: { cwd: join(sandbox, "repo-b") } } } });
  assert.equal(typeof a, "string");
  assert.match(a, /长期记忆/);

  // 空态也必须注入纪律块：否则模型不知道记忆功能存在，也就永远不会写下第一条。
  assert.match(a, /还没有任何记忆/, "空记忆时也要给出第一条的写入指引");
  assert.equal(typeof b, "string");
});

test("段文本函数在 cwd 缺失时声明项目层不可用，而不是静默少一层", () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const text = record.sections[0].text({});
  assert.match(text, /没有工作目录/);
});

test("段文本函数永不抛错（渲染失败也必须降级为可见提示）", () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  // 传入一个 getter 会抛的畸形上下文，模拟宿主对象形状变化
  const evil = {
    get agent() {
      throw new Error("boom");
    },
  };
  const text = record.sections[0].text(evil);
  assert.equal(typeof text, "string");
  assert.match(text, /dsh-memory-win/);
});

test("两条守卫路径**同时**挂载（不是二选一）", () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  // 回归：早期实现是 if (tools.guard) 用 guard; else 用 pre-execute —— 二选一，
  // 导致 DSH 有 guard 时项目层分支从不执行、<repo>/.agent-memory 的直写不被拦。
  // 该绕过硬真实宿主实测确认后改成两条都挂。
  assert.equal(record.guards.length, 1, "应注册单调守卫");
  assert.equal(record.listeners.length, 1, "同时应挂 pre-execute waterfall");
  assert.equal(record.listeners[0].event, "tools/pre-execute");
});

test("同步 guard 覆盖**全局层**：命中即返回拒绝原因字符串", () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const guard = record.guards[0];
  const memoryFile = join(fakeHome, "memory-win", "global", "x.md");

  // 契约 3：返回值是拒绝原因字符串
  const denied = guard({ name: "write", arguments: { file_path: memoryFile } });
  assert.equal(typeof denied, "string");
  assert.match(denied, /memory_add/);

  // 放行：非 write/edit
  assert.equal(guard({ name: "read", arguments: { file_path: memoryFile } }), undefined);
  // 放行：不相关路径
  assert.equal(guard({ name: "write", arguments: { file_path: join(projectCwd, "a.txt") } }), undefined);
  // 放行：畸形参数不得抛错（同步守卫抛错会变成拒绝执行）
  assert.equal(guard({ name: "write", arguments: {} }), undefined);
  assert.equal(guard({}), undefined);
  assert.equal(guard(undefined), undefined);
});

test("同步 guard 也覆盖**项目层**（exec.agent 提供 cwd 时）", () => {
  const { ctx, record } = fakeCtx();
  apply(ctx);
  const guard = record.guards[0];

  // 这正是上面那条回归缺陷的现场：项目层文件在修复前会被放行。
  const projectMemory = join(projectCwd, PROJECT_DIR_NAME, "default.md");
  const withAgent = {
    name: "write",
    arguments: { file_path: projectMemory },
    agent: { session: { header: { cwd: projectCwd } } },
  };
  const denied = guard(withAgent);
  assert.equal(typeof denied, "string", "项目层直写必须被同步 guard 拦住");
  assert.match(denied, /memory_add/);

  // 拿不到 cwd 时只检查全局层、不猜路径（项目层交由 waterfall 兜底）
  assert.equal(guard({ name: "write", arguments: { file_path: projectMemory } }), undefined);

  // 别的仓库的项目层目录不属于本会话，不应被拦
  const otherRepo = join(sandbox, "other-repo", PROJECT_DIR_NAME, "x.md");
  assert.equal(guard({ name: "write", arguments: { file_path: otherRepo }, agent: withAgent.agent }), undefined);
});

test("waterfall 路径同样覆盖项目层，且在守卫异常时无副作用放行", async () => {
  const { ctx, record } = fakeCtx({ withGuard: false });
  apply(ctx);
  assert.equal(record.guards.length, 0, "无 guard() 时不注册单调守卫");
  assert.equal(record.listeners.length, 1, "仍必须挂 waterfall");

  const guard = record.listeners[0].listener;
  let nextCalled = 0;
  const next = async () => {
    nextCalled += 1;
    return { kind: "allow" };
  };

  const projectMemory = join(projectCwd, PROJECT_DIR_NAME, "default.md");
  const decision = await guard(
    { name: "edit", arguments: { file_path: projectMemory }, agent: { session: { header: { cwd: projectCwd } } } },
    next,
  );
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /memory_add/);

  // 放行时必须调用 next()
  await guard({ name: "write", arguments: { file_path: join(projectCwd, "ok.txt") } }, next);
  assert.equal(nextCalled, 1);

  // 守卫内部抛错也必须放行（否则守卫故障会打死整个工具面）。
  // 放行的表现就是"照常走到 next"，而不是返回任意哨兵值。
  const boom = await guard(
    {
      name: "write",
      arguments: {
        get file_path() {
          throw new Error("boom");
        },
      },
    },
    next,
  );
  assert.deepEqual(boom, { kind: "allow" }, "守卫异常时应无副作用地放行到 next");
  assert.equal(nextCalled, 2);
});

test("宿主完全没有 tools 服务时，只注册注入段而不报错", () => {
  const { ctx, record } = fakeCtx({ withTools: false });
  apply(ctx);
  assert.equal(record.sections.length, 1);
  assert.equal(record.tools.length, 0);
  assert.equal(record.guards.length, 0);
  // 仍然要产出可用的段文本
  assert.match(record.sections[0].text({}), /长期记忆/);
});
