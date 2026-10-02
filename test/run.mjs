/**
 * 测试运行器：把每个测试文件在**同一进程内**依次 import。
 *
 * 为什么不用 `node --test test/`：它把每个文件 fork 成子进程并用管道收 stdio。
 * 在受限沙箱（本机 Windows 桌面版默认档）下，子进程的管道通信会直接 EPERM，
 * 于是**四个测试文件全部报 `spawn EPERM`，一条断言都跑不到** —— 那看起来像测试
 * 失败，实际是运行器跑不起来。这属于"显示正常但不成立"的同一类问题，
 * 所以这里改成进程内直跑，结果与断言完全一致，且任何环境都能跑。
 *
 * 用法：`node test/run.mjs`
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const files = readdirSync(here)
  .filter((n) => n.endsWith(".test.js"))
  .sort();

if (files.length === 0) {
  console.error("没有找到任何测试文件");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  // 依次 import：每个文件的顶层 test() 都会注册到同一个进程内 runner。
  await import(pathToFileURL(join(here, file)).href);
}

// node:test 在没有 --test 时也会自动跑已注册的用例；这里只等它汇总完。
process.on("exit", (code) => {
  failed = code;
});

export { failed };
