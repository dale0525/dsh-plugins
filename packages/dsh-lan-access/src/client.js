/**
 * Browser half: the access card on the Plugins page.
 *
 * This file is already in the client module loader's protocol — it is not a
 * module and imports nothing. `build.mjs` copies it to `lib/client.js` verbatim,
 * which is why `package.json` exports `./client` at that path.
 *
 * Three things about the card are deliberate:
 *
 *  - **The schema renders the switches; the card renders only what a schema
 *    cannot.** `port`, `auth` and `enabled` are ordinary config fields, so
 *    `ConfigForm` draws them with the same controls, spacing and dark-mode
 *    behaviour as every other plugin. The password is not one of them — it is a
 *    credential (see the host half), and the addresses are live facts from the
 *    OS, so both live in the card's children slot.
 *
 *  - **The password is write-only.** `remote.credentials.describe` reports
 *    whether a value exists and never returns it, so the input is never
 *    pre-filled and the card can only ever say "已设置 / 未设置".
 *
 *  - **The addresses are read from the host, not guessed.** A browser on
 *    `127.0.0.1` cannot see the machine's LAN IP, and a guess would send the
 *    user to an address nothing answers on.
 *
 * `configForms` and `remote.credentials` are injected NESTED rather than
 * declared in this plugin's `inject` list: a plugin that waits on a service its
 * host does not provide never activates, which would turn "no settings UI" into
 * "the whole browser half is gone".
 */
window.__ModuleLoader__.load({
  id: "@logictan/dsh-lan-access",
  factory: function (require) {
    var React = require("react");
    var UI = require("@logictan/dsh-plugins-shared-client");

    /** Loader entry id this card's form is keyed by; equals the host half's `export const name`. */
    var NS = "dsh-lan-access";
    /** The patch row this card configures (cordis.patch.yml). */
    var ROW_ID = "dsh-lan-access";
    /**
     * Bundle package names whose row `ROW_ID` this card configures.
     *
     * The page keys a row's configuration by the package that declares the row,
     * and this plugin reaches a profile in one of two shapes — as a dependency
     * of this repository's aggregate bundle, or installed on its own. Both keys
     * are registered; the one whose bundle is not installed never renders.
     */
    var BUNDLE_NAMES = ["@logictan/dsh-plugins-all", "@logictan/dsh-lan-access"];

    /**
     * Credential reference holding the access password.
     *
     * Must equal `PASSWORD_REF` in the host half (`src/config.js`). Duplicated
     * rather than imported because this file is a loader factory with no module
     * graph.
     */
    var PASSWORD_REF = "DSH_LAN_ACCESS_PASSWORD";

    /** The status route the host half registers on the host listener. */
    var STATUS_PATH = "/dsh-lan-access/status";

    var copy = {
      heading: "局域网访问",
      intro:
        "让同一局域网里的其他设备（以及本机的 127.0.0.1）通过一个端口打开 DSH 网页。端口与鉴权方式都由这里决定，宿主的 webserver 配置不需要改动。",
      passwordHeading: "访问密码",
      passwordIntro:
        "密码存在凭据库里（" +
        PASSWORD_REF +
        "），不写进插件配置行，也不会随配置同步导出。留空则任何浏览器都进不来。",
      passwordPlaceholder: "输入访问密码",
      passwordSet: "已设置（不回读）",
      passwordUnset: "未设置 —— 选择「需要密码」时谁也进不去",
      passwordSave: "保存密码",
      passwordClear: "清除密码",
      passwordSaved: "密码已保存。",
      passwordCleared: "密码已清除。",
      passwordEmpty: "密码不能为空；要取消鉴权请把鉴权方式改成「不需要密码」。",
      passwordReadFailed: "读取密码状态失败：",
      addressHeading: "访问地址",
      addressIntro: "在局域网设备上用下面任意一个地址打开；本机用 127.0.0.1 那个。",
      addressNone: "还没有读到地址。",
      addressStopped: "本插件当前没有监听（检查上面的「启用局域网访问」）。",
      addressLoopback: "本机",
      addressLan: "局域网",
      addressCopy: "复制",
      addressCopied: "已复制",
      copyFailed: "复制失败，请手动选中：",
      readFailed: "读取访问状态失败：",
      reload: "重新读取",
      portConflict: "端口与宿主监听端口相同，本机 127.0.0.1 会绕过本插件的鉴权。请换一个端口。",
      portInvalid: "端口必须是 1-65535 的整数。",
    };

    /**
     * Render one address row with a copy button.
     *
     * The URL is shown as text rather than a link: opening it in the current tab
     * would navigate away from the settings page the user is configuring, and a
     * `target="_blank"` link is a new browser tab that may land on another
     * machine's DSH.
     */
    function AddressRow(props) {
      var copiedState = React.useState(false);
      var copied = copiedState[0];
      var setCopied = copiedState[1];
      var label = props.label;
      var url = props.url;

      function copy() {
        var clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
        if (!clipboard || typeof clipboard.writeText !== "function") {
          // No clipboard API on an insecure origin, which is the normal case
          // here: the whole point is a plain-HTTP LAN address.
          return;
        }
        clipboard.writeText(url).then(
          function () {
            setCopied(true);
            setTimeout(function () {
              setCopied(false);
            }, 1500);
          },
          function () {
            setCopied(false);
          },
        );
      }

      return React.createElement(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "8px" } },
        React.createElement(
          "span",
          { style: { flex: "0 0 auto", minWidth: "44px", opacity: 0.65, fontSize: "12px" } },
          label,
        ),
        React.createElement(
          "code",
          {
            style: {
              flex: 1,
              minWidth: 0,
              overflowWrap: "anywhere",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "12px",
            },
          },
          url,
        ),
        React.createElement(
          UI.Button,
          { variant: "secondary", onClick: copy },
          copied ? copy.addressCopied : copy.addressCopy,
        ),
      );
    }

    /**
     * The card.
     *
     * @param props.scope - the Host-owned form for this plugin's row.
     * @param props.describe - the settings describe mirror.
     * @param props.ctx - the client context (for `remote.credentials`).
     * @param props.view - `"summary"` on the collapsed row, `"page"` when open.
     */
    function LanAccessCard(props) {
      var scope = props.scope;
      var ctx = props.ctx;

      var snapshot = React.useSyncExternalStore(
        React.useCallback(
          function (listener) {
            return scope.subscribe(listener);
          },
          [scope],
        ),
        React.useCallback(
          function () {
            return scope.getSnapshot();
          },
          [scope],
        ),
      );

      var statusState = React.useState(null);
      var status = statusState[0];
      var setStatus = statusState[1];
      var statusErrorState = React.useState("");
      var statusError = statusErrorState[0];
      var setStatusError = statusErrorState[1];
      var passwordState = React.useState("");
      var password = passwordState[0];
      var setPassword = passwordState[1];
      var configuredState = React.useState(false);
      var configured = configuredState[0];
      var setConfigured = configuredState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var messageState = React.useState("");
      var message = messageState[0];
      var setMessage = messageState[1];
      var failedState = React.useState(false);
      var failed = failedState[0];
      var setFailed = failedState[1];

      var writable = snapshot.writable === true;
      var value = snapshot.value || {};

      /** Read the live listener facts from the host half. */
      var readStatus = React.useCallback(function () {
        return fetch(STATUS_PATH, { headers: { accept: "application/json" } })
          .then(function (response) {
            if (!response.ok) throw new Error(String(response.status));
            return response.json();
          })
          .then(function (body) {
            setStatus(body);
            setStatusError("");
          })
          .catch(function (error) {
            setStatus(null);
            setStatusError(copy.readFailed + ((error && error.message) || error));
          });
      }, []);

      React.useEffect(
        function () {
          readStatus();
        },
        [readStatus, snapshot.value, snapshot.revision],
      );

      /** Read whether a password is stored. Presence only — never the value. */
      var readPasswordState = React.useCallback(
        function () {
          if (!ctx || !ctx.remote || !ctx.remote.credentials) return;
          ctx.remote.credentials
            .describe([PASSWORD_REF])
            .then(function (response) {
              if (!response || response.ok === false) {
                setMessage(copy.passwordReadFailed + ((response && response.error && response.error.message) || "未知错误"));
                return;
              }
              var info = response.value[PASSWORD_REF];
              setConfigured(Boolean(info && info.configured));
            })
            .catch(function (error) {
              setMessage(copy.passwordReadFailed + ((error && error.message) || error));
            });
        },
        [ctx],
      );

      React.useEffect(
        function () {
          readPasswordState();
        },
        [readPasswordState],
      );

      // Presence tracks the store: the seam emits this after a write commits and
      // after each file reload, so a password set elsewhere shows up here.
      React.useEffect(
        function () {
          if (!ctx || !ctx.remote || typeof ctx.remote.$on !== "function") return undefined;
          var off = ctx.remote.$on("credentials/reference-updated", readPasswordState);
          return function () {
            if (typeof off === "function") off();
          };
        },
        [readPasswordState, ctx],
      );

      function savePassword() {
        if (!ctx || !ctx.remote || !ctx.remote.credentials) return;
        if (password === "") {
          setFailed(true);
          setMessage(copy.passwordEmpty);
          return;
        }
        setBusy(true);
        ctx.remote.credentials
          .set(PASSWORD_REF, password)
          .then(function (response) {
            if (response && response.ok === false) {
              setFailed(true);
              setMessage(copy.passwordHeading + "：" + ((response.error && response.error.message) || "保存失败"));
              return;
            }
            setPassword("");
            setFailed(false);
            setMessage(copy.passwordSaved);
            readPasswordState();
          })
          .catch(function (error) {
            setFailed(true);
            setMessage(copy.passwordHeading + "：" + ((error && error.message) || error));
          })
          .then(function () {
            setBusy(false);
          });
      }

      function clearPassword() {
        if (!ctx || !ctx.remote || !ctx.remote.credentials) return;
        setBusy(true);
        ctx.remote.credentials
          .unset(PASSWORD_REF)
          .then(function (response) {
            if (response && response.ok === false) {
              setFailed(true);
              setMessage(copy.passwordHeading + "：" + ((response.error && response.error.message) || "清除失败"));
              return;
            }
            setPassword("");
            setFailed(false);
            setMessage(copy.passwordCleared);
            readPasswordState();
          })
          .catch(function (error) {
            setFailed(true);
            setMessage(copy.passwordHeading + "：" + ((error && error.message) || error));
          })
          .then(function () {
            setBusy(false);
          });
      }

      /**
       * The two port problems worth naming before the user saves.
       *
       * A port equal to the host's own listener cannot work: binding
       * `0.0.0.0:P` succeeds while the host holds `127.0.0.1:P`, but the OS then
       * answers loopback from the more specific listener, so `127.0.0.1:P` would
       * bypass this plugin's gate entirely. The host half refuses it; saying so
       * here is what saves the round trip.
       */
      var port = Number(value.port);
      var portProblem = "";
      if (value.port !== undefined && value.port !== "" && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        portProblem = copy.portInvalid;
      } else if (status !== null && status.hostPort !== undefined && port === status.hostPort) {
        portProblem = copy.portConflict;
      }

      var addresses = status && Array.isArray(status.addresses) ? status.addresses : [];
      var listening = status !== null && status.listening === true;
      var livePort = status !== null && status.port !== undefined ? status.port : port;

      var addressChildren = [];
      if (statusError !== "") {
        addressChildren.push(React.createElement(UI.Banner, { key: "err", kind: "error" }, statusError));
      } else if (status === null) {
        addressChildren.push(React.createElement(UI.Skeleton, { key: "loading" }));
      } else if (!listening) {
        addressChildren.push(React.createElement(UI.Banner, { key: "stopped", kind: "warn" }, copy.addressStopped));
      } else {
        var rows = [React.createElement(AddressRow, { key: "lo", label: copy.addressLoopback, url: "http://127.0.0.1:" + livePort + "/" })];
        addresses.forEach(function (address) {
          rows.push(
            React.createElement(AddressRow, {
              key: address,
              label: copy.addressLan,
              url: "http://" + address + ":" + livePort + "/",
            }),
          );
        });
        addressChildren.push(
          React.createElement("div", { key: "rows", style: { display: "flex", flexDirection: "column", gap: "8px" } }, rows),
        );
        if (addresses.length === 0) {
          addressChildren.push(React.createElement(UI.Banner, { key: "none", kind: "info" }, copy.addressNone));
        }
      }

      var children = [
        React.createElement(
          UI.Field,
          {
            key: "password",
            label: copy.passwordHeading,
            description: configured ? copy.passwordSet : copy.passwordUnset,
          },
          React.createElement(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "8px" } },
            React.createElement(
              "div",
              { style: { flex: 1, minWidth: 0 } },
              React.createElement(UI.SecretField, {
                value: password,
                configured: configured,
                disabled: busy || !writable,
                placeholder: copy.passwordPlaceholder,
                autoComplete: "new-password",
                "aria-label": copy.passwordPlaceholder,
                onValueChange: function (next) {
                  setPassword(next);
                  setMessage("");
                  setFailed(false);
                },
                onKeyDown: function (event) {
                  if (event.key === "Enter") savePassword();
                },
              }),
            ),
            React.createElement(
              UI.Button,
              { variant: "primary", disabled: busy || !writable || password === "", onClick: savePassword },
              copy.passwordSave,
            ),
            React.createElement(
              UI.Button,
              { variant: "secondary", disabled: busy || !writable || !configured, onClick: clearPassword },
              copy.passwordClear,
            ),
          ),
        ),
        portProblem !== ""
          ? React.createElement(UI.Banner, { key: "port", kind: "error" }, portProblem)
          : null,
        message !== ""
          ? React.createElement(UI.Banner, { key: "msg", kind: failed ? "error" : "info" }, message)
          : null,
        !writable && snapshot.status === "ready"
          ? React.createElement(UI.Banner, { key: "ro", kind: "warn" }, "当前连接不写回本机设置，无法保存。")
          : null,
      ];

      var addressCard = React.createElement(
        UI.SettingsCard,
        {
          title: copy.addressHeading,
          description: copy.addressIntro,
          key: "addresses",
        },
        addressChildren,
        React.createElement(
          "div",
          { style: { marginTop: "8px" } },
          React.createElement(UI.Button, { variant: "ghost", onClick: readStatus }, copy.reload),
        ),
      );

      if (props.view === "summary") {
        if (status !== null && status.listening === true) {
          return "端口 " + livePort + " · " + (status.auth === "none" ? "不需要密码" : "需要密码");
        }
        return copy.intro;
      }

      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "16px" } },
        React.createElement(
          UI.ConfigForm,
          {
            namespace: NS,
            form: scope,
            describe: props.describe,
            title: copy.heading,
            description: copy.intro,
          },
          children,
        ),
        addressCard,
      );
    }

    /**
     * Client plugin body: bind the configuration form and register the card.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.inject(["configForms", "remote.credentials"], function (scoped) {
        var scope = scoped.configForms.get(NS);
        var describe = scoped.configForms.describe();
        BUNDLE_NAMES.forEach(function (bundle) {
          scoped.slots.inject("plugins.row.config", function () {
            return scoped.slots.register(
              {
                name: "plugins.row.config",
                key: bundle + "#" + ROW_ID,
                inject: function () {
                  return { scope: scope, describe: describe, ctx: scoped };
                },
              },
              LanAccessCard,
            );
          });
        });
      });
    }

    return {
      name: "dsh-lan-access",
      inject: ["slots", "remote"],
      apply: apply,
    };
  },
});
