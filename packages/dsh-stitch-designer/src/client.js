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
    var UI = require("@logictan/dsh-plugins-shared-client");

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
        ? React.createElement(UI.Banner, { kind: "ok" }, "已配置（值不回读）。来源: " + (status.source || "file"))
        : React.createElement(UI.Banner, { kind: "error" }, "未配置。设置后 15 个 mcp__stitch__* 工具即可用。");

      return React.createElement(
        UI.SettingsCard,
        {
          title: "Stitch API Key",
        },
        statusLine,
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px" } },
          React.createElement(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            React.createElement(UI.TextField, {
              type: "password",
              value: value,
              placeholder: configured ? "已设置（留空则不改）" : "粘贴 AQ. 开头的 key",
              autoComplete: "off",
              disabled: pending,
              onValueChange: function (next) {
                setValue(next);
              },
            }),
          ),
          React.createElement(
            UI.Button,
            { variant: "primary", disabled: pending || value === "", onClick: save },
            pending ? "保存中…" : "保存",
          ),
          React.createElement(
            UI.Button,
            { variant: "secondary", disabled: pending || !configured, onClick: clear },
            "清除",
          ),
        ),
        React.createElement(
          UI.Banner,
          { kind: "info" },
          "key 来自 https://stitch.withgoogle.com（头像 → Stitch Settings → API key）。存于 $DSH_HOME/.credentials.yaml 的 STITCH_API_KEY，不写入插件配置行，因此不会以明文出现在 cordis.patch.yml。",
        ),
        message
          ? React.createElement(
              UI.Banner,
              { kind: message.indexOf("失败") >= 0 ? "error" : "info" },
              message,
            )
          : null,
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
