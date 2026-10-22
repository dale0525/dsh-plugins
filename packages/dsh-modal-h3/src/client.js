/**
 * Browser half: the account-pool card on the plugin's Plugins-page row.
 *
 * This file is already in the client module loader's protocol — it is not a
 * module and imports nothing. `build.mjs` copies it to `lib/client.js` verbatim,
 * which is why `package.json` exports `./client` at that path.
 *
 * Two things about the card are deliberate:
 *
 *  - **The pool is write-only across the wire.** `credentials.describe` reports
 *    whether a value exists and never returns it, so the textarea is never
 *    pre-filled. What the card CAN do is validate what the user pastes before it
 *    saves: the pool is hand-copied JSON, and catching a missing `token_secret`
 *    here is the difference between one save and a failed generation later.
 *
 *  - **The JSON is parsed here, not on the host.** The host half already parses
 *    it on every call and refuses to run on a broken pool, so this is not a
 *    second source of truth — it is the same rule applied one step earlier, at
 *    the only moment the user can still see what they typed.
 *
 * `remote.credentials` is injected NESTED inside the card registration rather
 * than declared in this plugin's `inject` list. A plugin that waits on a service
 * its host does not provide never activates at all, so a declared dependency
 * would turn "this host has no credential provider" into "the whole browser half
 * is gone".
 */
window.__ModuleLoader__.load({
  id: "@logictan/dsh-modal-h3",
  factory: function (require) {
    var React = require("react");
    var UI = require("@logictan/dsh-plugins-shared-client");

    /** Loader entry id this card's row is keyed by; equals the host half's `export const name`. */
    var ROW_ID = "modal-h3";
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
    var BUNDLE_NAMES = ["@logictan/dsh-plugins-all", "@logictan/dsh-modal-h3"];
    /** Credential reference holding the whole account pool. */
    var ACCOUNTS_REF = "MODAL_H3_ACCOUNTS";

    /**
     * Parse the pool JSON, returning the account names it declares.
     *
     * Deliberately duplicated from `src/pool.js` instead of imported: this file
     * is a loader factory with no module graph, so it cannot import the host
     * half. The duplication is bounded to "is this paste usable, and what does
     * it contain" — the authoritative validation still runs on the host.
     *
     * @param text - the pasted value.
     * @returns `{names, errors}`.
     */
    function inspectPool(text) {
      if (typeof text !== "string" || text.trim() === "") {
        return { names: [], errors: ["请粘贴账号池 JSON"] };
      }
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return { names: [], errors: ["不是合法 JSON: " + ((e && e.message) || e)] };
      }
      var tokens = Array.isArray(parsed) ? parsed : parsed && parsed.tokens;
      if (!Array.isArray(tokens)) {
        return { names: [], errors: ['缺少 tokens 数组：期望 {"tokens": [{name, token_id, token_secret}, ...]}'] };
      }
      if (tokens.length === 0) return { names: [], errors: ["tokens 为空：至少需要一个账号"] };
      var errors = [];
      var names = [];
      var seen = {};
      tokens.forEach(function (entry, index) {
        var at = "tokens[" + index + "]";
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          errors.push(at + " 不是对象");
          return;
        }
        var name = typeof entry.name === "string" ? entry.name.trim() : "";
        if (name === "") errors.push(at + ".name 缺失或为空");
        else if (seen[name] === true) errors.push(at + ".name 重复：" + name);
        if (typeof entry.token_id !== "string" || entry.token_id.trim() === "") {
          errors.push(at + ".token_id 缺失或为空");
        }
        if (typeof entry.token_secret !== "string" || entry.token_secret.trim() === "") {
          errors.push(at + ".token_secret 缺失或为空");
        }
        if (name === "" || seen[name] === true) return;
        seen[name] = true;
        names.push(name);
      });
      return { names: names, errors: errors };
    }

    /**
     * The account-pool card on the plugin's Plugins-page row.
     *
     * @param props - `{ctx}` from the slot.
     * @returns the card element.
     */
    function ModalH3Card(props) {
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
          .describe([ACCOUNTS_REF])
          .then(function (response) {
            if (!response.ok) {
              setMessage("读取失败: " + ((response.error && response.error.message) || "未知错误"));
              return;
            }
            setStatus(response.value[ACCOUNTS_REF] || null);
          })
          .catch(function (e) {
            setMessage("读取失败: " + ((e && e.message) || e));
          });
      }

      React.useEffect(function () {
        read();
        var off = ctx.remote.$on("credentials/reference-updated", function (ref) {
          if (ref === ACCOUNTS_REF) read();
        });
        return function () {
          if (typeof off === "function") off();
        };
      }, []);

      var inspected = inspectPool(value);
      var valid = value.trim() !== "" && inspected.errors.length === 0;

      function save() {
        if (!valid) return;
        setPending(true);
        setMessage("");
        ctx.remote.credentials
          .set(ACCOUNTS_REF, value)
          .then(function (response) {
            if (response && response.ok === false) {
              setMessage("保存失败: " + ((response.error && response.error.message) || "未知错误"));
              return;
            }
            setValue("");
            setMessage("已保存 " + inspected.names.length + " 个账号。token 只存本机，随配置同步走 credentials 分区。");
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
          .unset(ACCOUNTS_REF)
          .then(function (response) {
            if (response && response.ok === false) {
              setMessage("清除失败: " + ((response.error && response.error.message) || "未知错误"));
              return;
            }
            setMessage("已清除。视频工具仍会注册，但任何生成都会因缺账号失败。");
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
        : React.createElement(UI.Banner, { kind: "error" }, "未配置。填入至少一个 Modal 账号后 mcp__modal_h3__* 工具才能生成。");

      var preview = null;
      if (value.trim() !== "") {
        preview =
          inspected.errors.length > 0
            ? React.createElement(
                UI.Banner,
                { kind: "error" },
                "解析出 " + inspected.errors.length + " 个问题：" + inspected.errors.join("；"),
              )
            : React.createElement(
                UI.Banner,
                { kind: "info" },
                "将保存 " +
                  inspected.names.length +
                  " 个账号：" +
                  inspected.names.join("、") +
                  (inspected.names.length > 1
                    ? "。多个账号可并行：每个账号同时只跑一个生成。"
                    : "。单个账号同时只能跑一个生成。"),
              );
      }

      return React.createElement(
        UI.SettingsCard,
        { title: "Modal 账号池" },
        statusLine,
        React.createElement(UI.TextArea, {
          value: value,
          placeholder: configured
            ? '{"tokens": [...]} — 留空则不改'
            : '{"tokens": [{"name": "acc1", "token_id": "ak-...", "token_secret": "..."}]}',
          rows: 6,
          disabled: pending,
          spellCheck: false,
          onValueChange: function (next) {
            setValue(next);
          },
        }),
        preview,
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" } },
          React.createElement(
            UI.Button,
            { variant: "primary", disabled: pending || !valid, onClick: save },
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
          "token 来自 https://modal.com/settings/tokens。整份账号池存于 $DSH_HOME/.credentials.yaml 的 " +
            ACCOUNTS_REF +
            "，不写入插件配置行，因此不会以明文出现在 cordis.patch.yml。生成时只作为环境变量传给子进程，不落盘。",
        ),
        message
          ? React.createElement(UI.Banner, { kind: message.indexOf("失败") >= 0 ? "error" : "info" }, message)
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
              ModalH3Card,
            );
          });
        });
      });
    }

    return {
      name: "dsh-modal-h3",
      inject: ["slots", "remote"],
      apply: apply,
    };
  },
});
