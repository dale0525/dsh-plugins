/**
 * Browser half: the API-key card on the plugin's Plugins-page row.
 *
 * This file is already in the client module loader's protocol — it is not a
 * module and imports nothing. `build.mjs` copies it to `lib/client.js`
 * verbatim, which is why `package.json` exports `./client` at that path.
 *
 * `remote.credentials` is injected NESTED inside the card registration rather
 * than declared in this plugin's `inject` list. A plugin that waits on a
 * service its host does not provide never activates at all, so a declared
 * dependency would turn "this host has no credential provider" into "the whole
 * browser half is gone".
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

    var CSS_ID = "stitch-designer/key-card.css";
    var css = [
      ".std-card{display:flex;flex-direction:column;gap:10px;padding:4px 0;font-size:13px}",
      ".std-card-row{display:flex;align-items:center;gap:8px}",
      ".std-btn{padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-tertiary, inherit);font-size:12px;cursor:pointer}",
      ".std-btn:hover{color:var(--dsw-alias-label-primary, inherit)}",
      ".std-btn:disabled{opacity:.5;cursor:default}",
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

    function apply(ctx) {
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
