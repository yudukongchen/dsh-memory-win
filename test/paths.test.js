/**
 * `lib/paths.js` 测试 —— 本插件的 Windows 适配核心。
 *
 * 重点验证两件事：① 根目录解析**永不返回空串或相对路径**；② slug 跨平台稳定。
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import {
  PROJECT_DIR_NAME,
  displayPath,
  dshHome,
  globalRoot,
  isAbsoluteAny,
  projectRoot,
  shardPath,
  slugOf,
} from "../lib/paths.js";

const savedDshHome = process.env.DSH_HOME;

afterEach(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
});

test("dshHome 优先 DSH_HOME", () => {
  process.env.DSH_HOME = "E:\\fake-dsh";
  assert.equal(dshHome(), resolve("E:\\fake-dsh"));
});

test("dshHome 在 DSH_HOME 缺失/空白时回落 homedir —— 绝不为空串", () => {
  // 这是 dsh-memory 的核心 Windows 缺陷：它用 process.env.HOME，Windows 上通常未设，
  // 于是得到空串、全局层静默失效。本实现必须对这种输入免疫。
  for (const value of [undefined, "", "   "]) {
    if (value === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = value;

    const home = dshHome();
    assert.notEqual(home, "", "根目录不能是空串");
    assert.equal(isAbsoluteAny(home), true, `必须是绝对路径，实际 ${home}`);
    assert.equal(home.startsWith(homedir()), true, "应落在用户主目录下");
  }
});

test("globalRoot 是绝对路径且位于 DSH_HOME 下", () => {
  process.env.DSH_HOME = "E:\\fake-dsh";
  const root = globalRoot();
  assert.equal(isAbsoluteAny(root), true);
  assert.equal(root.startsWith(resolve("E:\\fake-dsh")), true);
});

test("projectRoot 落在仓库内的 .agent-memory，cwd 缺失时失败关闭", () => {
  const root = projectRoot("E:\\Game\\repo");
  assert.equal(root, join(resolve("E:\\Game\\repo"), PROJECT_DIR_NAME));
  // 去掉产品前缀（便于其它 agent 读取），但保留前导点作为隐藏目录 ——
  // 这是仓库里"工具产生的数据目录"的通行惯例（.git / .vscode / .claude）。
  // 隐藏不等于不可读：别的 agent 用绝对路径或 ls -a 一样能读。
  assert.equal(PROJECT_DIR_NAME, ".agent-memory");
  assert.equal(PROJECT_DIR_NAME.startsWith("."), true, "应为隐藏目录");
  assert.equal(/dsh/i.test(PROJECT_DIR_NAME), false, "不应带产品前缀");

  // 失败关闭而不是"回落到全局层"——静默回落正是失效的来源。
  assert.equal(projectRoot(undefined), undefined);
  assert.equal(projectRoot(""), undefined);
  assert.equal(projectRoot("   "), undefined);
});

test("slugOf 跨平台稳定且可读", () => {
  assert.equal(slugOf("E:\\Game\\github"), "game-github");
  assert.equal(slugOf("/home/me/code/repo"), "home-me-code-repo");
  assert.equal(slugOf("E:\\Game\\github\\"), "game-github", "尾部斜杠不影响");
  assert.equal(slugOf("C:\\Users\\me\\a b"), "users-me-a b");
  // Windows 保留字符不得进入文件名
  assert.equal(/[:*?"<>|]/.test(slugOf("E:\\a:b*c?d")), false);
});

test("slugOf 不产生路径分隔符", () => {
  for (const p of ["E:\\Game\\github", "/home/me/repo", "D:\\x\\y\\z"]) {
    const s = slugOf(p);
    assert.equal(s.includes("/"), false, `${p} → ${s} 不应含 /`);
    assert.equal(s.includes("\\"), false, `${p} → ${s} 不应含 \\`);
  }
});

test("displayPath 把项目内路径转为相对，项目外保持绝对", () => {
  const cwd = "E:\\Game\\repo";
  assert.equal(displayPath("E:\\Game\\repo\\.agent-memory\\default.md", cwd), ".agent-memory/default.md");
  assert.equal(displayPath("E:\\Game\\repo", cwd), ".");
  // 记忆目录在仓库外（全局层）时保持绝对，方便模型直接拿去 read
  const outside = "C:\\Users\\me\\.dsh\\memory-win\\global\\a.md";
  assert.equal(displayPath(outside, cwd), outside);
  assert.equal(displayPath(outside, undefined), outside);
});

test("shardPath 允许正常名称", () => {
  const dir = resolve("E:\\Game\\repo\\.agent-memory");
  assert.equal(shardPath(dir, "default"), join(dir, "default.md"));
  assert.equal(shardPath(dir, "windows-paths"), join(dir, "windows-paths.md"));
  assert.equal(shardPath(dir, "构建 坑"), join(dir, "构建 坑.md"));
  assert.equal(shardPath(dir, "a.md"), join(dir, "a.md"), "重复扩展名不应变成 a.md.md");
});

test("shardPath 拒绝路径逃逸与非法名", () => {
  const dir = resolve("E:\\Game\\repo\\.agent-memory");
  for (const bad of ["..", ".", "../evil", "a/b", "a\\b", "", "   "]) {
    assert.throws(() => shardPath(dir, bad), undefined, `应拒绝 shard 名 ${JSON.stringify(bad)}`);
  }
  // 冒号在 Windows 上是 ADS 分隔符，不能进文件名
  assert.throws(() => shardPath(dir, "a:b"));
});

test("isAbsoluteAny 识别各平台绝对路径", () => {
  assert.equal(isAbsoluteAny("E:\\x"), true);
  assert.equal(isAbsoluteAny("/x"), true);
  assert.equal(isAbsoluteAny("\\\\server\\share"), true);
  assert.equal(isAbsoluteAny("x/y"), false);
  assert.equal(isAbsoluteAny(""), false);
});
