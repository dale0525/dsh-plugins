/**
 * Browser half: the checkpoint ceiling knob inside the Plugins page.
 *
 * This file is already in the client module loader's protocol — it is not a
 * module and imports nothing. `build.mjs` copies it to `lib/client.js`
 * verbatim, which is why `package.json` exports `./client` at that path.
 *
 * The card is registered into the `plugins.row.config` slot under
 * `<bundle>#ctx-mem-bridge`, the same key the Plugins page derives from the
 * bundle that declares the row (see `src/bridge.js` for the row itself).
 */
window.__ModuleLoader__.load({
  id: "@logictan/dsh-ctx-mem",
  factory: function (require) {
    var React = require("react");

    /** Settings namespace the host half registers (`SETTINGS_NAMESPACE`). */
    var NS = "ctx-mem";
    /** The patch row this card configures (`src/bridge.js`'s `name`). */
    var ROW_ID = "ctx-mem-bridge";
    /**
     * Bundle package names whose row `ROW_ID` this card configures.
     *
     * The page keys a row's configuration by the package that declares the row.
     * This plugin reaches a profile in one of two shapes — as a dependency of
     * this repository's aggregate bundle, or installed on its own — and the key
     * differs between them. Both are registered; the key whose bundle is not
     * installed never renders, because the page dispatches only the keys its
     * own bundles declare.
     *
     * This half only reaches the browser at all because the bridge row is a
     * BARE package name: `dsh-client-modules` locates `dsh.client` from the
     * row's specifier and accepts no subpath. See `src/bridge.js`.
     */
    var BUNDLE_NAMES = ["@logictan/dsh-plugins-all", "@logictan/dsh-ctx-mem"];

    var copy = {
      summary: "上下文检查点的渲染上限（token）",
      heading: "检查点渲染上限",
      intro:
        "压缩产出的检查点最多渲染多少 token。这是纯上限：预算通常由被压缩区域自身的价格决定，只有它异常偏大时这个值才会生效。",
      knob:
        "调小它会提前触发分档降级（T1 → T2 → T3），命令与错误的保真度逐档下降——硬事实（路径、命令、报错）本身不会丢失，只是每条保留的字符数变少。",
      restart: "保存后需重启 DSH 生效。",
      label: "上限",
      unit: "token",
      save: "保存",
      saving: "保存中…",
      reset: "恢复默认",
      overridden: "已覆盖组合默认值",
      loading: "读取中…",
      unwritable: "当前连接不写回本机设置，无法保存。",
    };

    var wrapStyle = {
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      maxWidth: "560px",
      color: "var(--dsw-alias-label-primary)",
      fontSize: "13px",
      lineHeight: 1.6,
    };
    var headingStyle = { fontSize: "14px", fontWeight: 600 };
    var hintStyle = { color: "var(--dsw-alias-label-tertiary)" };
    var rowStyle = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
    var inputStyle = {
      width: "132px",
      padding: "6px 8px",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "6px",
      background: "var(--dsw-alias-bg-layer-1)",
      color: "inherit",
      font: "inherit",
      fontVariantNumeric: "tabular-nums",
    };
    var buttonStyle = {
      padding: "6px 12px",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "6px",
      background: "var(--dsw-alias-bg-layer-1)",
      color: "inherit",
      font: "inherit",
      cursor: "pointer",
    };
    var primaryButtonStyle = Object.assign({}, buttonStyle, {
      border: "1px solid var(--dsw-alias-button-primary-fill)",
      background: "var(--dsw-alias-button-primary-fill)",
      color: "var(--dsw-alias-label-primary-foreground)",
    });
    var errorStyle = { color: "var(--dsw-alias-state-error-primary)" };
    var badgeStyle = {
      padding: "1px 6px",
      borderRadius: "999px",
      background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))",
      color: "var(--dsw-alias-label-secondary)",
      fontSize: "12px",
    };

    /** The overridden value for the one field this card owns, or undefined. */
    function overridden(snapshot) {
      var user = snapshot && snapshot.user;
      if (user === null || typeof user !== "object") return undefined;
      return Object.prototype.hasOwnProperty.call(user, "maxCheckpointTokens");
    }

    /** The accepted value for the one field this card owns, or undefined. */
    function accepted(snapshot) {
      var value = snapshot && snapshot.value;
      if (value === null || typeof value !== "object") return undefined;
      return typeof value.maxCheckpointTokens === "number" ? value.maxCheckpointTokens : undefined;
    }

    /**
     * The row's configuration card.
     *
     * `scope` is the settings namespace bound on this plugin's own fiber by
     * {@link apply}; the card only reads its snapshot and routes explicit user
     * choices back through it.
     */
    function CtxMemSettingsCard(props) {
      var scope = props.scope;
      var subscribe = React.useCallback(
        function (onChange) {
          return scope.subscribe(onChange);
        },
        [scope],
      );
      var getSnapshot = React.useCallback(
        function () {
          return scope.getSnapshot();
        },
        [scope],
      );
      var snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

      var [draft, setDraft] = React.useState(null);
      var [busy, setBusy] = React.useState(false);
      var [error, setError] = React.useState(null);

      var current = accepted(snapshot);
      var dirty = draft !== null && draft !== "" && Number(draft) !== current;

      if (props.view === "summary") return copy.summary;

      /** Persist the draft, or clear the override when it is empty. */
      function save() {
        if (!dirty || busy) return;
        var next = Number(draft);
        if (!Number.isInteger(next) || next < 1) {
          setError("上限必须是 ≥ 1 的整数。");
          return;
        }
        setError(null);
        setBusy(true);
        scope.set("maxCheckpointTokens", next).then(
          function () {
            setBusy(false);
            setDraft(null);
          },
          function (cause) {
            setBusy(false);
            setError(String((cause && cause.message) || cause));
          },
        );
      }

      /** Drop the override so the field re-inherits the composition base. */
      function reset() {
        if (busy) return;
        setError(null);
        setDraft(null);
        setBusy(true);
        scope.unset("maxCheckpointTokens").then(
          function () {
            setBusy(false);
          },
          function (cause) {
            setBusy(false);
            setError(String((cause && cause.message) || cause));
          },
        );
      }

      var writable = snapshot.writable === true;
      var value = draft !== null ? draft : current === undefined ? "" : String(current);

      return React.createElement(
        "div",
        { style: wrapStyle },
        React.createElement("div", { style: headingStyle }, copy.heading),
        React.createElement("div", null, copy.intro),
        React.createElement("div", { style: hintStyle }, copy.knob),
        React.createElement(
          "div",
          { style: rowStyle },
          React.createElement("span", { style: hintStyle }, copy.label),
          React.createElement("input", {
            type: "number",
            min: 1,
            step: 1,
            style: inputStyle,
            value: value,
            disabled: !writable || busy,
            placeholder: copy.loading,
            "aria-label": copy.label,
            onChange: function (event) {
              setDraft(event.target.value);
            },
            onKeyDown: function (event) {
              if (event.key === "Enter") save();
            },
          }),
          React.createElement("span", { style: hintStyle }, copy.unit),
          React.createElement(
            "button",
            {
              type: "button",
              style: dirty && writable && !busy ? primaryButtonStyle : buttonStyle,
              disabled: !dirty || !writable || busy,
              onClick: save,
            },
            busy ? copy.saving : copy.save,
          ),
          React.createElement(
            "button",
            {
              type: "button",
              style: buttonStyle,
              disabled: !writable || busy || !overridden(snapshot),
              onClick: reset,
            },
            copy.reset,
          ),
          overridden(snapshot) ? React.createElement("span", { style: badgeStyle }, copy.overridden) : null,
        ),
        error !== null ? React.createElement("div", { style: errorStyle }, error) : null,
        !writable && snapshot.status === "ready" ? React.createElement("div", { style: errorStyle }, copy.unwritable) : null,
        React.createElement("div", { style: hintStyle }, copy.restart),
      );
    }

    /**
     * Client plugin body: bind the settings namespace and register the card.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      var scope = ctx.settingsScope.bind({ namespace: NS });
      BUNDLE_NAMES.forEach(function (bundle) {
        ctx.slots.inject("plugins.row.config", function () {
          return ctx.slots.register(
            {
              name: "plugins.row.config",
              key: bundle + "#" + ROW_ID,
              inject: function () {
                return { scope: scope };
              },
            },
            CtxMemSettingsCard,
          );
        });
      });
    }

    return { name: "dsh-ctx-mem", inject: ["slots", "settingsScope"], apply: apply };
  },
});
