/**
 * 守护断言第一层（Q18）：已装 our-free-model 适配器必须声明
 * `systemPromptUpdate: 'in-history'`（B 路径的前提字段），且 messages wire 不声明。
 *
 * 防两种失效：
 * 1. 上游更新（含 1.3.2 起的签名自更新）覆盖了本地补丁；
 * 2. 上游改写了 resolveModel 结构、字段不再生效。
 *
 * 通过**读取真实已装副本**（DSH_HOME 的 profiles 下各 profile 的 node_modules）并构造 stub state
 * 直调 resolveModel，断言失败时的提示给出补丁重放链。
 *
 * 走 fallback 分支（catalog 置空）刻意为之：`systemPromptUpdateFor` 按 id 判 wire，
 * 与上游目录内容解耦 —— 目录刷新不该造成这个守卫的误报。
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const REPLAY =
  "补丁疑似被上游更新覆盖 → 重放链：git -C dsh-our-free-model worktree（基线 0e2483f）" +
  " → git apply dsh-memory-win/patches/our-free-model-in-history-1.3.1.patch" +
  " → npm pack → 覆盖 ~/.dsh/plugin-tarballs/dsh-our-free-model-*.tgz → 重装 profile";

/**
 * 定位已装适配器：扫 DSH_HOME 的 profiles 下各 profile 的 node_modules/dsh-our-free-model/src/adapter.js。
 *
 * @returns {string|undefined} 绝对路径。
 */
function findInstalledAdapter() {
  const profiles = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles");
  if (!existsSync(profiles)) return undefined;
  for (const name of readdirSync(profiles)) {
    const candidate = join(profiles, name, "node_modules", "dsh-our-free-model", "src", "adapter.js");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

test("已装适配器声明 systemPromptUpdate:'in-history'（chat wire），messages wire 不声明", async () => {
  const adapterPath = findInstalledAdapter();
  assert.ok(adapterPath, `未找到已装 our-free-model 适配器（profiles/*/node_modules/…）——${REPLAY}`);

  const { FreeModelAdapter } = await import(pathToFileURL(adapterPath).href);
  // catalog 置空：两个断言都走 fallback 分支，只验 systemPromptUpdateFor 的 wire 判定。
  const adapter = new FreeModelAdapter({
    state: () => ({ catalog: [], membership: {}, settings: { defaultMaxTokens: 32768 }, attributionUserAgent: "guard" }),
    recordUsage: () => {},
  });

  const chat = await adapter.resolveModel("our-free-model", "mimo-v2.6-flash-free");
  assert.equal(
    chat.systemPromptUpdate,
    "in-history",
    `mimo（chat wire）必须声明 in-history —— ${REPLAY}`,
  );

  const claudeWire = await adapter.resolveModel("our-free-model", "union-alpha");
  assert.equal(
    claudeWire.systemPromptUpdate,
    undefined,
    "union-alpha（messages wire）不应声明：合并进顶层 system 的快照救不了缓存，声明反而是假承诺",
  );
});
