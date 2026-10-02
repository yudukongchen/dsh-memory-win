/**
 * 打包脚本：产出可安装的 tarball，并把它放到 DSH 的 plugin-tarballs 目录。
 *
 * ## 为什么需要它（本项目最贵的一个坑）
 *
 * profile 用的是 `nodeLinker: hoisted`，`file:` **目录**依赖会被 pnpm 解析成
 * `{directory, type: directory}` 并做**拷贝快照**（不是符号链接）。于是：
 *
 * - 改仓库源码，宿主**看不到**；
 * - `install_bundle` 也**不会**刷新它 —— 目录 spec 没变，pnpm 判定"已满足"，
 *   返回 `changed:false` 且不重拷文件。
 *
 * 后果是"改了却看不到效果"会**伪装成代码缺陷**。本项目连续两轮把部署未同步
 * 误判为插件 bug，直到对 profile 里那份文件取哈希才定性。
 *
 * tarball 依赖带 integrity 哈希。**但实测确认：仅替换同文件名的 tarball 没用** ——
 * 依赖 spec（路径）未变时，pnpm 会报 `downloaded 1` 却**不重写 node_modules**，
 * 等于坑只是从"目录依赖"换成了"tarball 依赖"。
 *
 * 所以**每次改动源码都必须升 `package.json` 的 `version`**：文件名一变，spec 就变，
 * pnpm 才会真的重装。本脚本会在版本号未变时给出警告。
 *
 * 用法：
 *   node scripts/pack.mjs            # 打包 + 复制到 plugin-tarballs
 *   node scripts/pack.mjs --no-copy  # 只打包，留在仓库 dist/ 下
 *
 * @module dsh-memory-win/scripts/pack
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const dist = join(repo, "dist");

const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const fileName = `${pkg.name}-${pkg.version}.tgz`;
const noCopy = process.argv.includes("--no-copy");

mkdirSync(dist, { recursive: true });

// npm 的默认 cache 在用户目录（沙箱下不可写），指到仓库内的临时目录即可。
const cache = join(repo, ".npm-cache");

const args = ["pack", "--pack-destination", dist, "--loglevel", "notice"];
if (existsSync(cache)) rmSync(cache, { recursive: true, force: true });

execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
  cwd: repo,
  stdio: "inherit",
  env: { ...process.env, npm_config_cache: cache },
});

const built = join(dist, fileName);
if (!existsSync(built)) {
  console.error(`打包失败：未找到 ${built}`);
  process.exit(1);
}

console.log(`\n已打包：${built}`);

if (noCopy) {
  rmSync(cache, { recursive: true, force: true });
  process.exit(0);
}

// 放到 DSH 的 plugin-tarballs，与 dsh-our-free-model 并列
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const target = join(dshHome, "plugin-tarballs", fileName);

// 关键检查：同文件名的 tarball 覆盖**不会**让 pnpm 刷新（spec 未变）。
// 与其让使用者撞上"改了没生效"，不如在这里直接把话说清楚。
if (existsSync(target)) {
  const same = readFileSync(target).equals(readFileSync(built));
  if (!same) {
    console.warn(
      [
        "",
        `⚠️  ${target}`,
        "    已存在同名但**内容不同**的 tarball。",
        "    覆盖它**不会**让 pnpm 重装 —— 依赖 spec（路径）没变，它只会报 downloaded 却不改写 node_modules。",
        "    请先升 package.json 的 version，再重新打包。",
        "",
      ].join("\n"),
    );
  }
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(built, target);
console.log(`已复制：${target}`);

rmSync(cache, { recursive: true, force: true });

console.log(
  [
    "",
    `版本：${pkg.version}`,
    "接下来：",
    `  1) dsh plugin --profile desktop add "file:${target.replace(/\\/g, "/")}"`,
    "  2) 重启桌面版",
    "",
    "注意：改源码后必须**先升 version** 再执行本脚本，否则文件名不变、pnpm 会跳过重装。",
  ].join("\n"),
);
