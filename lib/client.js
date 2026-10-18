// dsh-memory-win browser half — the 记忆视图 (memory view) settings section.
//
// Built in the DSH lazy-CJS bundle format: executing this file only registers a
// factory; styles, locale and the slot registration run when the browser
// materializes the module.
//
// Read-only by design (0.3.0 requirements): a collapsible list of the global
// layer plus every registered workspace; the initial list performs NO memory
// reads (the host's /layers route only lists directories), and a layer's
// shards are fetched only when the user presses 展开. There is no edit, delete
// or archive browsing here — the five tools and memory_cleanup remain the only
// write / read-deep paths.
//
// The row source is the host route, never a browser-side guess: whatever
// `knownWorkspacePaths()` returns is what the panel draws, so the panel, the
// background cleanup and the tool descriptions always agree on the workspace
// set.

window.__ModuleLoader__.load({
  id: "dsh-memory-win",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    var BASE = "/api/dsh-memory-win";
    var LAYERS_PATH = BASE + "/layers";
    var SHARDS_PATH = BASE + "/shards";
    var HEADER = "x-dsh-memory-win";
    var API_VERSION = 1;
    var STYLE_ID = "dsh-memory-win-style";

    var CSS = [
      ".dmw_section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}",
      ".dmw_title{font-size:15px;line-height:22px;font-weight:600;margin:0}",
      ".dmw_status{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}",
      ".dmw_noticeError{color:var(--dsw-alias-state-error-primary,#ff6464);margin:0;font-size:12px;line-height:18px;word-break:break-word}",
      ".dmw_list{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}",
      ".dmw_item{flex-direction:column;gap:4px;display:flex}",
      ".dmw_row{border-radius:8px;align-items:center;gap:10px;padding:8px 10px;display:flex}",
      ".dmw_row:hover{background:var(--dsw-alias-bg-layer-1)}",
      ".dmw_actions{align-items:center;gap:6px;flex:0 0 auto;display:flex}",
      ".dmw_identity{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}",
      ".dmw_name{text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;overflow:hidden}",
      ".dmw_meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;word-break:break-all}",
      ".dmw_btn{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#4b4d52);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#b8bbc2);font:inherit;font-size:13px;line-height:18px;white-space:nowrap;cursor:pointer}",
      ".dmw_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#3a3b3f);color:var(--dsw-alias-label-primary,#fff)}",
      ".dmw_btn:disabled{cursor:not-allowed;opacity:.55}",
      ".dmw_body{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;flex-direction:column;gap:4px;padding:8px 10px;display:flex}",
      ".dmw_entry{font-size:13px;line-height:20px;display:flex;gap:8px;align-items:baseline}",
      ".dmw_entryDate{color:var(--dsw-alias-label-tertiary);flex:0 0 auto;font-size:12px}",
      ".dmw_entryId{color:var(--dsw-alias-label-tertiary);flex:0 0 auto;font-size:12px}",
      ".dmw_entryText{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}",
      ".dmw_shard{font-size:13px;line-height:20px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}",
      ".dmw_shardName{flex:0 0 auto;font-weight:600}",
      ".dmw_shardMeta{color:var(--dsw-alias-label-tertiary);flex:0 0 auto;font-size:12px}",
      ".dmw_shardKw{flex:1;min-width:120px;color:var(--dsw-alias-label-secondary,#b8bbc2);font-size:12px;word-break:break-word}",
    ].join("");

    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-memory-win";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * Same-origin GET against this plugin's host routes.
     *
     * A transport failure must reject with the host's error code carried out: a
     * 403 (trust gate) resolving into a body the caller then reads as "empty
     * memory" is the silent-failure shape this project refuses everywhere else —
     * an empty list must never pretend to be a success.
     */
    function get(path) {
      return fetch(path, {
        method: "GET",
        credentials: "same-origin",
        headers: { [HEADER]: "1" },
      }).then(function (response) {
        return response
          .json()
          .catch(function () {
            return { error: "internal" };
          })
          .then(function (payload) {
            if (!response.ok) {
              var error = new Error("HTTP " + response.status);
              error.code = payload && payload.error ? String(payload.error) : "internal";
              error.status = response.status;
              throw error;
            }
            return payload;
          });
      });
    }

    /**
     * 记忆视图：全局层 + 已登记工作区的只读折叠列表。
     *
     * @param props - composed slot props: the locale binder `t`.
     */
    function MemoryViewSection(props) {
      var t = props.t;

      var [rows, setRows] = useState(null);
      var [failed, setFailed] = useState(null);
      // 每行的展开状态，键 = rowKey。undefined = 收起；否则 { loading, error, payload }。
      var [views, setViews] = useState({});

      function setView(key, patch) {
        setViews(function (previous) {
          var next = Object.assign({}, previous);
          if (patch === null) delete next[key];
          else next[key] = Object.assign({}, next[key], patch);
          return next;
        });
      }

      useEffect(
        function () {
          get(LAYERS_PATH)
            .then(function (payload) {
              if (!payload || payload.ok !== true) throw new Error("layers");
              if (payload.apiVersion !== API_VERSION) {
                setFailed(t("apiMismatch"));
                return;
              }
              setRows([payload.global].concat(payload.workspaces || []));
              setFailed(null);
            })
            .catch(function (error) {
              setFailed(String(error && error.message ? error.message : error));
            });
        },
        [t],
      );

      function describeError(code) {
        var key = "error." + String(code || "generic");
        var text = t(key);
        return text === key ? t("error.generic") : text;
      }

      function expand(key) {
        setView(key, { loading: true });
        get(SHARDS_PATH + "?workspace=" + encodeURIComponent(key))
          .then(function (payload) {
            if (!payload || payload.ok !== true) {
              setView(key, { loading: false, error: describeError(payload && payload.error) });
              return;
            }
            setView(key, { loading: false, error: null, payload: payload });
          })
          .catch(function (error) {
            setView(key, { loading: false, error: describeError(error && error.code) });
          });
      }

      function collapse(key) {
        setView(key, null);
      }

      /** 展开后的层内容：只画服务端判定好的档位，客户端不再判阈值。 */
      function layerBody(payload) {
        if (payload.mode === "empty") {
          return h("p", { className: "dmw_status", key: "empty" }, t("emptyLayer"));
        }
        if (payload.mode === "inline") {
          return h(
            "div",
            { className: "dmw_body", key: "inline" },
            (payload.entries || []).map(function (entry) {
              return h("div", { className: "dmw_entry", key: entry.shard + "#" + entry.id }, [
                h("span", { className: "dmw_entryDate", key: "date" }, entry.date),
                h("span", { className: "dmw_entryId", key: "id" }, "#" + entry.id),
                h("span", { className: "dmw_entryText", key: "text" }, entry.text),
              ]);
            }),
          );
        }
        return h(
          "div",
          { className: "dmw_body", key: "map" },
          (payload.shardList || []).map(function (shard) {
            var meta = t("shardCount", { n: shard.count });
            if (shard.latest) meta += " · " + shard.latest;
            return h("div", { className: "dmw_shard", key: shard.name }, [
              h("span", { className: "dmw_shardName", key: "name" }, shard.name),
              h("span", { className: "dmw_shardMeta", key: "meta" }, meta),
              h("span", { className: "dmw_shardKw", key: "kw" }, shard.keywords === "" ? t("keywordsUnset") : shard.keywords),
            ]);
          }),
        );
      }

      /** 行主标签：全局行恒叫「全局记忆」，工作区行用目录名（重名靠副行路径区分）。 */
      function rowLabel(row) {
        return row.workspace === "global" ? t("globalRow") : row.title;
      }

      if (failed !== null) {
        return h("div", { className: "dmw_section" }, [
          h("h2", { className: "dmw_title", key: "title" }, t("nav")),
          h("p", { className: "dmw_noticeError", key: "failed" }, t("hostUnavailable", { reason: failed })),
        ]);
      }

      if (rows === null) {
        return h("div", { className: "dmw_section" }, [
          h("h2", { className: "dmw_title", key: "title" }, t("nav")),
          h("p", { className: "dmw_status", key: "loading" }, t("loading")),
        ]);
      }

      var children = [
        h("h2", { className: "dmw_title", key: "title" }, t("nav")),
        h("p", { className: "dmw_status", key: "hint" }, t("hint")),
      ];

      children.push(
        h(
          "ul",
          { className: "dmw_list", key: "list" },
          rows.map(function (row) {
            var key = row.workspace;
            var view = views[key];
            var expanded = view !== undefined && view.payload !== undefined;
            var loading = view !== undefined && view.loading === true;

            var body = null;
            if (loading) {
              body = h("p", { className: "dmw_status", key: "loading" }, t("loadingLayer"));
            } else if (view !== undefined && view.error) {
              body = h("p", { className: "dmw_noticeError", key: "error" }, view.error);
            } else if (expanded) {
              body = layerBody(view.payload);
            }

            return h("li", { className: "dmw_item", key: key }, [
              h("div", { className: "dmw_row", key: "row" }, [
                h("span", { className: "dmw_identity", key: "identity" }, [
                  h("span", { className: "dmw_name", key: "name" }, rowLabel(row)),
                  h("span", { className: "dmw_meta", key: "meta" }, row.path),
                ]),
                h("div", { className: "dmw_actions", key: "actions" }, [
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dmw_btn",
                      disabled: view === undefined || loading,
                      "aria-label": t("collapseNamed", { name: rowLabel(row) }),
                      onClick: function () {
                        collapse(key);
                      },
                      key: "collapse",
                    },
                    t("collapse"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dmw_btn",
                      disabled: expanded || loading,
                      "aria-label": t("expandNamed", { name: rowLabel(row) }),
                      onClick: function () {
                        expand(key);
                      },
                      key: "expand",
                    },
                    t("expand"),
                  ),
                ]),
              ]),
              body,
            ]);
          }),
        ),
      );

      return h("div", { className: "dmw_section" }, children);
    }

    /** Dictionary namespace owned by this plugin. */
    var NS = "dsh-memory-win";

    /** Simplified Chinese dictionary and key source of truth. */
    var zh = {
      nav: "记忆视图",
      hint: "只读浏览。列表来自工作区登记表，初始不读取任何记忆；点「展开」才查询该层。修改请用对话里的 memory_* 工具。",
      loading: "正在读取列表…",
      loadingLayer: "正在读取该层记忆…",
      collapse: "折叠",
      expand: "展开",
      collapseNamed: "折叠 {name}",
      expandNamed: "展开 {name}",
      globalRow: "全局记忆",
      emptyLayer: "该层暂无记忆。",
      shardCount: "{n} 条",
      keywordsUnset: "（关键词未设置）",
      hostUnavailable: "读不到宿主状态（{reason}）：请确认插件已随宿主加载，然后刷新页面。",
      apiMismatch: "插件前后端版本不一致：请重启 DSH 后再试。",
      "error.missing-workspace": "缺少工作区参数。",
      "error.unknown-workspace": "该工作区不在登记表里，已拒绝查询。",
      "error.unreadable": "该层目录读取失败。",
      "error.forbidden": "请求被宿主信任门拒绝。",
      "error.internal": "读取失败，请查看 DSH 日志。",
      "error.generic": "操作失败，请查看 DSH 日志。",
    };

    /** English dictionary checked against the Chinese key set. */
    var en = {
      nav: "Memory View",
      hint: "Read-only browse. The list comes from the workspace registry and reads no memory up front; a layer's shards are fetched only when you press Expand. Editing stays in the memory_* tools.",
      loading: "Loading list…",
      loadingLayer: "Loading this layer…",
      collapse: "Collapse",
      expand: "Expand",
      collapseNamed: "Collapse {name}",
      expandNamed: "Expand {name}",
      globalRow: "Global memory",
      emptyLayer: "No memory in this layer yet.",
      shardCount: "{n} entries",
      keywordsUnset: "(no keywords set)",
      hostUnavailable: "Cannot read host state ({reason}) — check that the plugin loaded, then refresh.",
      apiMismatch: "The plugin's two halves disagree on the API version — restart DSH and try again.",
      "error.missing-workspace": "Missing workspace argument.",
      "error.unknown-workspace": "That workspace is not in the registry; query refused.",
      "error.unreadable": "Could not read that layer's directory.",
      "error.forbidden": "Refused by the host trust gate.",
      "error.internal": "Read failed — check the DSH log.",
      "error.generic": "Failed — check the DSH log.",
    };

    /** Services required by the Settings registration. */
    var inject = ["slots", "locale"];

    /** Contribute the memory-view page. */
    function apply(ctx) {
      ctx.effect(
        function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        },
        "dsh-memory-win: dictionaries",
      );
      var t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "memory-view",
            order: 30,
            label: function () {
              return t("nav");
            },
            locale: NS,
          },
          MemoryViewSection,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__test = { zh: zh, en: en };
    return module.exports;
  },
});
