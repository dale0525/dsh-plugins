/**
 * Browser half: the in-session Stitch preview panel and the API-key card.
 *
 * This file is already in the client module loader's protocol — it is not a
 * module and imports nothing. `build.mjs` copies it to `lib/client.js`
 * verbatim, which is why `package.json` exports `./client` at that path.
 *
 * Two independent surfaces share this bundle:
 *
 *  - the preview panel, registered into `conversation.session.header.actions`;
 *  - the API-key card, registered into `plugins.row.config` under
 *    `<bundle>#stitch-designer`.
 *
 * `remote.credentials` is injected NESTED inside the card registration rather
 * than declared in this plugin's `inject` list. A plugin that waits on a
 * service its host does not provide never activates at all, and both surfaces
 * live in one bundle — so a missing credential provider would take the panel
 * down with the card. Nested, it costs only the card.
 *
 * The panel's HTTP contract is `src/routes.js`: `GET /stitch/api/state` and
 * `GET /stitch/api/html/<id>`, plus the cached `/stitch/screens/*.png` and
 * `/stitch/html/*.html` files.
 */
window.__ModuleLoader__.load({
  id: "@logictan/dsh-stitch-designer",
  factory: function (require) {
    var React = require("react");

    /** Loader entry id this card's row is keyed by; equals the host half's `export const name`. */
    var ROW_ID = "stitch-designer";
    /**
     * Bundle package names whose row `ROW_ID` this card configures.
     *
     * The Plugins page keys a row's configuration by the package that declares
     * the row, and this plugin reaches a profile in one of two shapes — as a
     * dependency of this repository's aggregate bundle, or installed on its
     * own. Both keys are registered; the one whose bundle is not installed
     * never renders, because the page dispatches only the keys its own bundles
     * declare.
     */
    var BUNDLE_NAMES = ["@logictan/dsh-plugins-all", "@logictan/dsh-stitch-designer"];
    /**
     * Credential reference holding the Stitch API key.
     *
     * The key is NOT a plugin config field: `role('secret')` config values are
     * written into the profile's `cordis.patch.yml` in plaintext, which is how
     * the previous generation leaked keys into config-sync snapshots. A
     * credential lives in `$DSH_HOME/.credentials.yaml` and is carried by the
     * `credentialsStatus` sync section instead.
     */
    var API_KEY_REF = "STITCH_API_KEY";

    var CSS_ID = "stitch-designer/panel.css";
    var css = [
      ".std-root{position:relative;display:inline-flex;align-items:center}",
      ".std-trigger{min-height:28px;display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-secondary, inherit);font-size:12px;line-height:18px;cursor:pointer}",
      ".std-trigger:hover,.std-trigger:focus-visible{color:var(--dsw-alias-label-primary, inherit);background:var(--dsw-alias-fill-l2, rgba(128,128,128,.08))}",
      ".std-dot{width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,#4285F4,#34A853);flex:none}",
      ".std-panel{position:fixed;top:calc(var(--dsw-header-h, 48px) + 8px);right:16px;z-index:1000;width:min(460px, calc(100vw - 32px));max-height:min(680px, calc(100vh - 96px));display:flex;flex-direction:column;background:var(--dsw-specific-menu, #1b1b1f);border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));border-radius:12px;box-shadow:var(--dsw-shadow-lv3, 0 8px 30px rgba(0,0,0,.35));overflow:hidden}",
      ".std-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));font-size:13px;font-weight:600}",
      ".std-head-actions{display:flex;gap:6px;align-items:center}",
      ".std-btn{padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-tertiary, inherit);font-size:12px;cursor:pointer}",
      ".std-btn:hover{color:var(--dsw-alias-label-primary, inherit)}",
      ".std-btn:disabled{opacity:.5;cursor:default}",
      ".std-select{padding:3px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:var(--dsw-specific-menu, #1b1b1f);color:var(--dsw-alias-label-primary, inherit);font-size:12px;line-height:18px;max-width:100%}",
      ".std-body{overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2, rgba(128,128,128,.4))}",
      ".std-meta{font-size:11px;color:var(--dsw-alias-label-tertiary, inherit);display:flex;gap:10px;flex-wrap:wrap;padding:0 2px}",
      ".std-tag{padding:1px 8px;border-radius:99px;background:var(--dsw-alias-fill-l2, rgba(128,128,128,.1));font-size:11px;color:var(--dsw-alias-label-secondary, inherit)}",
      ".std-img-wrap{display:flex;justify-content:center;background:var(--dsw-alias-fill-l2, rgba(128,128,128,.06));border-radius:10px;padding:8px;min-height:120px}",
      ".std-img{max-width:100%;max-height:min(480px, calc(100vh - 240px));border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.25)}",
      ".std-thumbs{display:flex;gap:8px;overflow-x:auto;padding:2px 0;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2, rgba(128,128,128,.4))}",
      ".std-thumb{width:56px;height:96px;object-fit:cover;border-radius:6px;border:2px solid transparent;cursor:pointer;flex:none;opacity:.75;transition:opacity .15s}",
      ".std-thumb:hover{opacity:1}",
      ".std-thumb-on{border-color:var(--dsw-alias-accent, #4285F4);opacity:1}",
      ".std-empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-tertiary, inherit);font-size:13px;line-height:1.6}",
      ".std-hint{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-fill-l2, rgba(128,128,128,.07));font-size:12px;color:var(--dsw-alias-label-secondary, inherit);line-height:1.6}",
      ".std-err{padding:10px 12px;text-align:center;color:var(--dsw-alias-danger-fg, #ef4444);font-size:12px}",
      ".std-card{display:flex;flex-direction:column;gap:10px;padding:4px 0;font-size:13px}",
      ".std-card-row{display:flex;align-items:center;gap:8px}",
      ".std-input{flex:1;min-width:0;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));background:var(--dsw-alias-fill-l1, transparent);color:var(--dsw-alias-label-primary, inherit);font-size:12px;line-height:18px}",
      ".std-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary, inherit)}",
      ".std-ok{color:var(--dsw-alias-success-fg, #22c55e)}",
      ".std-bad{color:var(--dsw-alias-danger-fg, #ef4444)}"
    ].join("");

    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "stitch-designer";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    //#region preview panel

    /**
     * The session-header Stitch preview panel.
     *
     * Reads `GET /stitch/api/state` and renders the newest cached screenshot,
     * a project picker, and a thumbnail strip. The Host does the caching and the
     * index-lag fallback; this half only presents what it is given.
     */
    function DesignerPanel() {
      var open = React.useState(false);
      var opened = open[0];
      var setOpened = open[1];
      var state = React.useState(null);
      var data = state[0];
      var setData = state[1];
      var err = React.useState("");
      var errorText = err[0];
      var setErr = err[1];
      var sel = React.useState("");
      var selectedId = sel[0];
      var setSelectedId = sel[1];
      var idx = React.useState(0);
      var currentIdx = idx[0];
      var setCurrentIdx = idx[1];
      var busy = React.useState(false);
      var loading = busy[0];
      var setLoading = busy[1];

      function refresh(projectId) {
        setErr("");
        setLoading(true);
        var q = projectId ? "?projectId=" + encodeURIComponent(projectId) : "";
        fetch("/stitch/api/state" + q, { cache: "no-store" })
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          })
          .then(function (d) {
            if (d.ok) {
              setData(d);
              setCurrentIdx(0);
            } else {
              setErr(d.error || "未知错误");
            }
          })
          .catch(function (e) {
            setErr((e && e.message) || String(e));
          })
          .then(function () {
            setLoading(false);
          });
      }

      function toggle() {
        var next = !opened;
        setOpened(next);
        if (next) refresh(selectedId || (data && data.projectId));
      }

      function onProjectChange(e) {
        var id = e.target.value;
        setSelectedId(id);
        setCurrentIdx(0);
        refresh(id);
      }

      function exportHtml(screenId) {
        fetch("/stitch/api/html/" + screenId, { cache: "no-store" })
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          })
          .then(function (d) {
            if (d.ok && d.html) window.open(d.html, "_blank");
            else alert("导出失败: " + (d.error || "未知错误"));
          })
          .catch(function (e) {
            alert("导出失败: " + ((e && e.message) || e));
          });
      }

      var trigger = React.createElement(
        "button",
        {
          className: "std-trigger",
          title: "AI 设计（Stitch 预览）",
          "aria-label": "AI 设计预览",
          "aria-expanded": opened,
          onClick: toggle,
        },
        React.createElement("span", { className: "std-dot" }),
        "AI 设计",
      );

      var body;
      if (opened) {
        if (errorText) {
          body = React.createElement("div", { className: "std-err" }, "加载失败: " + errorText);
        } else if (data === null) {
          body = React.createElement("div", { className: "std-empty" }, "加载中…");
        } else {
          var projectOptions = (data.projects || []).map(function (p) {
            return React.createElement(
              "option",
              { key: p.id, value: p.id },
              (p.title || "项目 " + String(p.id).slice(-6)) + (p.id === data.projectId ? " ✓" : ""),
            );
          });
          var projectPicker = React.createElement(
            "div",
            { className: "std-meta", style: { alignItems: "center", gap: 6 } },
            React.createElement("span", { className: "std-tag" }, "项目"),
            React.createElement(
              "select",
              {
                className: "std-select",
                value: selectedId || data.projectId || "",
                onChange: onProjectChange,
                style: { flex: 1, minWidth: 0 },
              },
              React.createElement("option", { value: "" }, "选择项目…"),
              projectOptions,
            ),
          );

          var screens = data.screens || [];
          var total = screens.length;
          var cur = currentIdx < total ? screens[currentIdx] : screens[0];
          var meta = React.createElement(
            "div",
            { className: "std-meta" },
            React.createElement("span", { className: "std-tag" }, data.projectTitle || "项目 " + String(data.projectId || "").slice(-6)),
            total > 0 ? React.createElement("span", { className: "std-tag" }, "共 " + total + " 张") : null,
            cur ? React.createElement("span", { className: "std-tag" }, cur.deviceType || "MOBILE") : null,
            cur ? React.createElement("span", { className: "std-tag" }, (cur.width || "") + "×" + (cur.height || "")) : null,
            cur && cur.title ? React.createElement("span", { className: "std-tag" }, cur.title) : null,
          );

          var preview;
          if (cur && cur.preview) {
            preview = React.createElement(
              "div",
              { className: "std-img-wrap" },
              React.createElement("img", {
                className: "std-img",
                src: cur.preview + "?t=" + Date.now(),
                alt: "设计预览",
                onClick: function () {
                  window.open(cur.preview, "_blank");
                },
              }),
            );
          } else {
            preview = React.createElement(
              "div",
              { className: "std-empty" },
              "该项目还没有设计。在对话里告诉我需求（如：帮我设计一个回收小程序首页，APP 端）→ 生成后这里实时预览。或在上方切换查看其他项目。",
            );
          }

          var thumbs = null;
          if (total > 1) {
            thumbs = React.createElement(
              "div",
              { className: "std-thumbs" },
              screens.map(function (s, i) {
                return React.createElement("img", {
                  key: s.id || i,
                  className: "std-thumb" + (i === currentIdx ? " std-thumb-on" : ""),
                  src: s.preview + "?t=" + Date.now(),
                  alt: s.title || "设计 " + (i + 1),
                  onClick: function () {
                    setCurrentIdx(i);
                  },
                });
              }),
            );
          }

          var actions = null;
          if (cur) {
            actions = React.createElement(
              "div",
              { className: "std-meta", style: { marginTop: 4 } },
              React.createElement(
                "button",
                {
                  className: "std-btn",
                  onClick: function () {
                    exportHtml(cur.id);
                  },
                },
                "📄 导出 1:1 HTML 源码",
              ),
              React.createElement(
                "button",
                {
                  className: "std-btn",
                  onClick: function () {
                    window.open(cur.preview, "_blank");
                  },
                },
                "🔍 查看大图",
              ),
            );
          }

          var hint = React.createElement(
            "div",
            { className: "std-hint" },
            "💡 怎么用：在对话里告诉我设计需求（APP / Web / 软件界面均可）→ 生成后这里实时预览。不满意就在对话里说哪里要改（如「颜色换浅一点、品类改成四个」）→ 我改完点刷新看新版。每个设计都自带 1:1 HTML 源码，点上方「导出 1:1 HTML 源码」即可获取。",
          );

          body = React.createElement(React.Fragment, null, projectPicker, meta, preview, thumbs, actions, hint);
        }
      }

      return React.createElement(
        "div",
        { className: "std-root" },
        trigger,
        opened
          ? React.createElement(
              "div",
              { className: "std-panel", role: "dialog", "aria-label": "AI 设计预览" },
              React.createElement(
                "div",
                { className: "std-head" },
                React.createElement("span", null, "AI 设计 · Stitch 预览"),
                React.createElement(
                  "span",
                  { className: "std-head-actions" },
                  React.createElement(
                    "button",
                    {
                      className: "std-btn",
                      disabled: loading,
                      onClick: function () {
                        refresh(selectedId || (data && data.projectId));
                      },
                    },
                    loading ? "刷新中…" : "刷新",
                  ),
                  React.createElement(
                    "button",
                    { className: "std-btn", onClick: function () { setOpened(false); } },
                    "关闭",
                  ),
                ),
              ),
              React.createElement("div", { className: "std-body" }, body),
            )
          : null,
      );
    }

    //#endregion

    //#region API key card

    /**
     * The Stitch API-key card on the plugin's Plugins-page row.
     *
     * The key is write-only across the wire: `describe` reports whether a value
     * exists and never returns it, so the input is never pre-filled. That is a
     * property of the credential seam, not a UI choice — and it is why this
     * card needs no `configForms`: the only setting this plugin has is a
     * credential, which the credential API already owns.
     */
    function StitchKeyCard(props) {
      var ctx = props.ctx;
      var st = React.useState(null);
      var status = st[0];
      var setStatus = st[1];
      var val = React.useState("");
      var value = val[0];
      var setValue = val[1];
      var msg = React.useState("");
      var message = msg[0];
      var setMessage = msg[1];
      var busy = React.useState(false);
      var pending = busy[0];
      var setPending = busy[1];

      function read() {
        return ctx.remote.credentials
          .describe([API_KEY_REF])
          .then(function (response) {
            if (!response.ok) {
              setMessage("读取失败: " + ((response.error && response.error.message) || "未知错误"));
              return;
            }
            setStatus(response.value[API_KEY_REF] || null);
          })
          .catch(function (e) {
            setMessage("读取失败: " + ((e && e.message) || e));
          });
      }

      React.useEffect(function () {
        read();
        var off = ctx.remote.$on("credentials/reference-updated", function (ref) {
          if (ref === API_KEY_REF) read();
        });
        return function () {
          if (typeof off === "function") off();
        };
      }, []);

      function save() {
        if (value === "") return;
        setPending(true);
        setMessage("");
        ctx.remote.credentials
          .set(API_KEY_REF, value)
          .then(function (response) {
            if (response && response.ok === false) {
              setMessage("保存失败: " + ((response.error && response.error.message) || "未知错误"));
              return;
            }
            setValue("");
            setMessage("已保存。密钥只存本机，随配置同步走 credentials 分区。");
            return read();
          })
          .catch(function (e) {
            setMessage("保存失败: " + ((e && e.message) || e));
          })
          .then(function () {
            setPending(false);
          });
      }

      function clear() {
        setPending(true);
        setMessage("");
        ctx.remote.credentials
          .unset(API_KEY_REF)
          .then(function (response) {
            if (response && response.ok === false) {
              setMessage("清除失败: " + ((response.error && response.error.message) || "未知错误"));
              return;
            }
            setMessage("已清除。");
            return read();
          })
          .catch(function (e) {
            setMessage("清除失败: " + ((e && e.message) || e));
          })
          .then(function () {
            setPending(false);
          });
      }

      var configured = status && status.configured === true;
      var statusLine = configured
        ? React.createElement("div", { className: "std-note std-ok" }, "已配置（值不回读）。来源: " + (status.source || "file"))
        : React.createElement("div", { className: "std-note std-bad" }, "未配置。设置后 15 个 mcp__stitch__* 工具即可用。");

      return React.createElement(
        "div",
        { className: "std-card" },
        React.createElement("div", { className: "std-note" }, "Stitch API Key"),
        statusLine,
        React.createElement(
          "div",
          { className: "std-card-row" },
          React.createElement("input", {
            className: "std-input",
            type: "password",
            value: value,
            placeholder: configured ? "已设置（留空则不改）" : "粘贴 AQ. 开头的 key",
            autoComplete: "off",
            disabled: pending,
            onChange: function (e) {
              setValue(e.target.value);
            },
          }),
          React.createElement(
            "button",
            { className: "std-btn", disabled: pending || value === "", onClick: save },
            pending ? "保存中…" : "保存",
          ),
          React.createElement(
            "button",
            { className: "std-btn", disabled: pending || !configured, onClick: clear },
            "清除",
          ),
        ),
        React.createElement(
          "div",
          { className: "std-note" },
          "key 来自 https://stitch.withgoogle.com（头像 → Stitch Settings → API key）。存于 $DSH_HOME/.credentials.yaml 的 STITCH_API_KEY，不写入插件配置行，因此不会以明文出现在 cordis.patch.yml。",
        ),
        message ? React.createElement("div", { className: "std-note" }, message) : null,
      );
    }

    //#endregion

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.slots.inject("conversation.session.header.actions", function () {
          return ctx.slots.register(
            {
              name: "conversation.session.header.actions",
              id: "stitch-designer",
              order: 40,
            },
            DesignerPanel,
          );
        });
      }, "stitch-designer: preview panel");

      // Nested: a host without a credential provider loses only this card.
      ctx.inject(["remote.credentials"], function (scoped) {
        BUNDLE_NAMES.forEach(function (bundle) {
          scoped.slots.inject("plugins.row.config", function () {
            return scoped.slots.register(
              {
                name: "plugins.row.config",
                key: bundle + "#" + ROW_ID,
                inject: function () {
                  return { ctx: scoped };
                },
              },
              StitchKeyCard,
            );
          });
        });
      });
    }

    return {
      name: "dsh-stitch-designer",
      inject: ["slots", "remote"],
      apply: apply,
    };
  },
});
