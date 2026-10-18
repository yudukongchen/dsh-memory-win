/**
 * 客户端冒烟（0.3.0 记忆视图）：桩 __ModuleLoader__ + 桩 React + 桩 fetch。
 *
 * 存在的理由（与 dsh-archived 的 client-smoke 同源）：客户端半边没有任何一层
 * 其它测试碰得到 —— 宿主测试测路由，挂载测试测 apply 接线，而"面板在数据到了
 * 之后画什么、按钮的禁用态对不对、错误是不是被画成空列表"只有渲染一遍才知道。
 *
 * 重点回归（对应本需求的四条验收）：
 * - 初始只发一次 /layers，**不发 /shards**（"初始不查询"）；
 * - 点「展开」才发该层的 /shards（带 workspace 参数）；点「折叠」清掉视图；
 * - 路由失败（ok:false / 传输错误）显示错误文案，**不画成空列表**；
 * - 内联档显示完整正文；地图档显示片行；档位由服务端判定，客户端不重复判阈值。
 *
 * 用法：node tools/client-smoke.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, "..", "lib", "client.js");

const failures = [];
function check(label, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

// --- minimal React shim ------------------------------------------------------
// Hook state persists across renders so the test can render, let the effects'
// promises settle, and render again — that is how the real page fills in.
let hooks = [];
let cursor = 0;
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
  },
  useState(initial) {
    const index = cursor++;
    if (hooks[index] === undefined) hooks[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks[index],
      (value) => {
        hooks[index] = typeof value === "function" ? value(hooks[index]) : value;
      },
    ];
  },
  useMemo(factory) {
    cursor += 1;
    return factory();
  },
  useEffect(fn, deps) {
    const index = cursor++;
    const previous = hooks[index];
    const changed = previous === undefined || deps === undefined || previous.some((dep, i) => dep !== deps[i]);
    if (changed) {
      hooks[index] = deps === undefined ? [] : [...deps];
      fn();
    }
  },
};

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = {
        id,
        exports: factory((name) => {
          if (name === "react") return React;
          throw new Error(`unexpected require(${name})`);
        }),
      };
    },
  },
};
// 样式注入路径要一个 document（真实浏览器里由宿主提供）。
globalThis.document = {
  head: { appendChild() {} },
  createElement(tagName) {
    return { tagName, dataset: {}, textContent: "" };
  },
  querySelector() {
    return null;
  },
};

// --- fake fetch ----------------------------------------------------------------
const repoA = "C:\\repos\\alpha";
const calls = [];
let shardsReply = null; // 每次 /shards 的固定回复（对象或 Error）

function reply(response, payload) {
  return Promise.resolve({
    ok: response,
    status: response ? 200 : 403,
    json: () => Promise.resolve(payload),
  });
}

globalThis.fetch = (path, init) => {
  calls.push({ path, init });
  if (path.startsWith("/api/dsh-memory-win/layers")) {
    return reply(true, {
      ok: true,
      apiVersion: 1,
      global: { workspace: "global", title: "global", path: "C:\\dshhome\\memory-win\\global" },
      workspaces: [{ workspace: repoA, title: "alpha", path: repoA }],
    });
  }
  if (path.startsWith("/api/dsh-memory-win/shards")) {
    if (shardsReply instanceof Error) return Promise.reject(shardsReply);
    return reply(true, shardsReply);
  }
  return Promise.reject(new Error("unexpected fetch " + path));
};

const source = readFileSync(clientPath, "utf8");
// eslint-disable-next-line no-new-func — the bundle format is a plain script.
new Function("window", "document", "fetch", source)(globalThis.window, globalThis.document, globalThis.fetch);

check("client.js 以 lazy-CJS 注册了模块", loaded !== null && loaded.id === "dsh-memory-win");
check("导出 apply / inject（宿主半身契约）", typeof loaded.exports.apply === "function" && Array.isArray(loaded.exports.inject));
check("inject 声明 slots 与 locale", loaded.exports.inject.includes("slots") && loaded.exports.inject.includes("locale"));

// --- locale -------------------------------------------------------------------
const dict = loaded.exports.__test.zh;
const en = loaded.exports.__test.en;
const zhKeys = Object.keys(dict).sort();
check(
  "中英词典键集合完全一致（宿主语言切换不出现裸 key）",
  JSON.stringify(Object.keys(en).sort()) === JSON.stringify(zhKeys),
);
for (const key of ["nav", "collapse", "expand", "globalRow", "error.forbidden", "error.unknown-workspace"]) {
  check(`词典含 ${key}`, typeof dict[key] === "string");
}
const t = (key, args) => {
  let text = dict[key] ?? key;
  for (const [k, v] of Object.entries(args ?? {})) text = text.replaceAll(`{${k}}`, String(v));
  return text;
};

// --- apply 的注册形态 -----------------------------------------------------------
{
  const registered = { dictionaries: 0, slots: [] };
  const ctx = {
    effect(factory) {
      const dispose = factory();
      return typeof dispose === "function" ? dispose : () => {};
    },
    locale: {
      register(ns, pack) {
        registered.dictionaries += 1;
        registered.ns = ns;
        registered.pack = pack;
      },
      bind(ns) {
        registered.bound = ns;
        return t;
      },
    },
    slots: {
      inject(name, factory) {
        // factory 在宿主里于插槽被装配时求值；这里立即调用，捕获 register 的入参。
        registered.slotName = name;
        factory();
      },
      register(def, component) {
        registered.def = def;
        registered.component = component;
      },
    },
  };
  loaded.exports.apply(ctx);
  check("词典注册进 dsh-memory-win 命名空间", registered.ns === "dsh-memory-win" && registered.pack.zh === dict);
  check("locale.bind 用了同一命名空间", registered.bound === "dsh-memory-win");
  check("挂到 settings.section 插槽，id 为 memory-view", registered.slotName === "settings.section" && registered.def?.id === "memory-view");
  check("插槽 label 走词典", registered.def?.label() === dict.nav);
  check("组件引用正确", typeof registered.component === "function");

  // props：宿主把 bind 出的 t 作为 prop 传进组件（与 archived 的 compose 形态一致）
  const Section = registered.component;

  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  // 每次渲染都从头消耗 hook 游标（React 的规矩），桩必须照做。
  const render = () => {
    cursor = 0;
    return Section({ t });
  };

  // --- 渲染 1：/layers 未回 ⇒ loading，且没有画列表 -------------------------------
  hooks = [];
  let tree = render();
  const text1 = JSON.stringify(tree);
  check("初始渲染显示 loading", text1.includes(dict.loading));
  await settle();

  // --- 渲染 2：列表到了 ⇒ 两行 + 每行两个按钮；且**只调用过 /layers** --------------
  tree = render();
  calls.length = 0; // 只关心后续
  const text2 = JSON.stringify(tree);
  check("列表行含全局行与工作区行", text2.includes(dict.globalRow) && text2.includes("alpha"));
  check("每行文案里有折叠与展开", text2.includes(dict.collapse) && text2.includes(dict.expand));
  function countButtons(node) {
    let n = 0;
    const walk = (x) => {
      if (x === null || x === undefined) return;
      if (typeof x !== "object") return;
      if (x.type === "button") n += 1;
      const kids = x.props?.children;
      if (Array.isArray(kids)) kids.forEach(walk);
      else if (kids && typeof kids === "object") walk(kids);
    };
    walk(node);
    return n;
  }
  check("两行 ⇒ 折叠/展开共 4 个按钮", countButtons(tree) === 4);
  check("初始阶段只发过 /layers（零 /shards）", !calls.some((c) => c.path.includes("shards")));

  // 布局回归：按钮组在行的**右侧** —— div.dmw_row 的直接子节点顺序必须是 identity 在前、actions 在后。
  {
    const li = tree.props.children[2].props.children[0];
    const row = Array.isArray(li.props.children) ? li.props.children[0] : li.props.children;
    const classes = (row.props.children ?? []).map((k) => k?.props?.className);
    check(
      "行内布局：identity 在左、actions（按钮）在右",
      classes[0] === "dmw_identity" && classes[1] === "dmw_actions",
      classes.join(" → "),
    );
  }

  // 收集每行按钮的 onClick / disabled（按渲染顺序：全局折叠, 全局展开, A折叠, A展开）
  const items = tree.props.children[2].props.children;
  const rowButtons = (li) => {
    const out = [];
    const walk = (x) => {
      if (x === null || x === undefined || typeof x !== "object") return;
      if (x.type === "button") out.push(x);
      const kids = x.props?.children;
      if (Array.isArray(kids)) kids.forEach(walk);
      else if (kids && typeof kids === "object") walk(kids);
    };
    walk(li);
    return out;
  };

  // --- 点「展开」（全局行）⇒ 只在这一次发 /shards?workspace=global -----------------
  shardsReply = { ok: true, apiVersion: 1, workspace: "global", mode: "inline", dir: "x", total: 2, shards: 1, entries: [
    { shard: "g", id: "a3f1", date: "2026-09-30", text: "旧的一条" },
    { shard: "g", id: "b7c2", date: "2026-10-02", text: "这是一条超过一百六十个字符的很长的正文用来验证UI不做截断所以它必须完整出现在这里而不是被切掉尾巴" + "尾".repeat(60) },
  ] };
  const before = calls.length;
  rowButtons(items[0])[1].props.onClick();
  await settle();
  tree = render();
  const shardCalls = calls.slice(before).filter((c) => c.path.includes("/shards"));
  check("展开触发一次 /shards 且带 workspace=global", shardCalls.length === 1 && shardCalls[0].path.includes("workspace=global"));
  const text3 = JSON.stringify(tree);
  check("内联档画出完整长正文（无截断）", text3.includes("尾".repeat(60)));
  check("内联档画 id 与日期", text3.includes("#a3f1") && text3.includes("2026-09-30"));

  // --- 展开态：折叠可用、展开禁用 ---------------------------------------------------
  let buttons = rowButtons(tree.props.children[2].props.children[0]);
  check("展开后：折叠按钮可用", buttons[0].props.disabled === false);
  check("展开后：展开按钮禁用", buttons[1].props.disabled === true);

  // --- 点「折叠」⇒ 视图清掉、内容消失 ----------------------------------------------
  buttons[0].props.onClick();
  await settle();
  tree = render();
  check("折叠后内联内容不再渲染", !JSON.stringify(tree).includes("#a3f1"));
  buttons = rowButtons(tree.props.children[2].props.children[0]);
  check("折叠后：折叠禁用 / 展开可用", buttons[0].props.disabled === true && buttons[1].props.disabled === false);

  // --- 路由 ok:false（白名单拒绝）⇒ 画错误文案，不画空列表 --------------------------
  shardsReply = { ok: false, error: "unknown-workspace" };
  buttons = rowButtons(tree.props.children[2].props.children[1]); // 工作区 A 的按钮
  buttons[1].props.onClick();
  await settle();
  tree = render();
  const text4 = JSON.stringify(tree);
  check("业务错误显示本地化文案", text4.includes(dict["error.unknown-workspace"]));

  // --- 传输错误 ⇒ 同样画错误，绝不静默变空层 -------------------------------------
  buttons = rowButtons(tree.props.children[2].props.children[1]);
  shardsReply = new Error("HTTP 403"); // 必须在 onClick 之前换：fetch 在点击的同步段取回复
  buttons[1].props.onClick();
  await settle();
  tree = render();
  const text5 = JSON.stringify(tree);
  check("传输失败也画错误而非空态", text5.includes(dict["error.generic"]));
  check("错误态下折叠按钮回到可用（能收起错误）", rowButtons(tree.props.children[2].props.children[1])[0].props.disabled === false);

  // --- 地图档形态 -------------------------------------------------------------------
  shardsReply = { ok: true, apiVersion: 1, workspace: repoA, mode: "map", dir: "x", total: 9, shards: 1, shardList: [
    { name: "many", count: 9, latest: "2026-10-09", keywords: "路由词" },
    { name: "nokw", count: 2, latest: "", keywords: "" },
  ] };
  buttons = rowButtons(tree.props.children[2].props.children[1]);
  buttons[1].props.onClick();
  await settle();
  tree = render();
  const text6 = JSON.stringify(tree);
  check("地图档画片名与条数", text6.includes("many") && text6.includes(t("shardCount", { n: 9 })));
  check("空关键词画「（关键词未设置）」而不是空白", text6.includes(dict.keywordsUnset));
}

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("all client checks passed");
