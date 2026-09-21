/**
 * Browser half: the compression knobs inside the Plugins page.
 *
 * This file is already in the client module loader's protocol — it is not a
 * module and imports nothing. `build.mjs` copies it to `lib/client.js`
 * verbatim, which is why `package.json` exports `./client` at that path.
 *
 * The card is registered into the `plugins.row.config` slot under
 * `<bundle>#ctx-mem-bridge`, the same key the Plugins page derives from the
 * bundle that declares the row (see `src/bridge.js` for the row itself).
 *
 * The field list mirrors `SettingsSection` in `src/config.js`; the two are kept
 * in step by hand because this half ships as plain browser code.
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
      summary: "上下文压缩的可调参数",
      heading: "压缩参数",
      intro:
        "这些参数决定压缩何时触发、保留多少近期原文，以及检查点与填空产出的规模。留空表示继承组合配置或引擎默认值。",
      inherit: "继承默认",
      on: "开",
      off: "关",
      save: "保存",
      saving: "保存中…",
      reset: "恢复默认",
      overridden: "已覆盖",
      unwritable: "当前连接不写回本机设置，无法保存。",
      restart: "保存后需重启 DSH 生效。",
    };

    /** Editable fields, in render order. `kind` picks the control. */
    var FIELDS = [
      {
        key: "thresholdRatio",
        label: "触发阈值",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.01,
        hint: "上下文占用达到窗口的这个比例时触发压缩（默认 0.8）。调低会更早压缩。",
      },
      {
        key: "retainRatio",
        label: "保留尾巴（比例）",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.01,
        hint: "保留最近多少比例的上下文原文（默认 0.16）。与「保留尾巴（token）」二选一。",
      },
      {
        key: "retainTokens",
        label: "保留尾巴（token）",
        kind: "number",
        min: 0,
        step: 1,
        hint: "按绝对 token 数保留近期原文；0 = 硬切断，一条逐字尾巴都不留。设置它会取代比例。",
      },
      {
        key: "maxCheckpointTokens",
        label: "检查点上限",
        kind: "number",
        min: 1,
        step: 1,
        unit: "token",
        hint: "压缩产出的检查点最多渲染多少 token。纯上限：只有区域价格异常偏大时才生效。",
      },
      {
        key: "maxTokens",
        label: "填空调用上限",
        kind: "number",
        min: 1,
        step: 1,
        unit: "token",
        hint: "填空模型调用的 token 上限（默认 8192）。报错 truncated at the token cap 时调大。",
      },
      {
        key: "language",
        label: "产出语言",
        kind: "select",
        options: [
          { value: "zh", label: "中文" },
          { value: "en", label: "English" },
        ],
      },
      {
        key: "fillEnabled",
        label: "填空调用",
        kind: "boolean",
        hint: "关闭后零模型调用，只产出骨架，不含四节因果。",
      },
      {
        key: "fillProvider",
        label: "填空路由 provider",
        kind: "text",
        hint: "与 model 一起填才生效；都留空 = 用会话当前路由。",
      },
      { key: "fillModel", label: "填空路由 model", kind: "text" },
    ];

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
    var fieldStyle = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
    var labelStyle = { minWidth: "132px" };
    var controlStyle = {
      padding: "6px 8px",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "6px",
      background: "var(--dsw-alias-bg-layer-1)",
      color: "inherit",
      font: "inherit",
      fontVariantNumeric: "tabular-nums",
    };
    var inputStyle = Object.assign({ width: "132px" }, controlStyle);
    var textStyle = Object.assign({ width: "200px" }, controlStyle);
    var selectStyle = Object.assign({ minWidth: "132px" }, controlStyle);
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

    function has(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }

    function objectLayer(snapshot, which) {
      var layer = snapshot && snapshot[which];
      return layer !== null && typeof layer === "object" ? layer : {};
    }

    /** The schema-resolved section the Host last accepted. */
    function accepted(snapshot) {
      return objectLayer(snapshot, "value");
    }

    /** The raw user layer; a key's presence here is what marks it overridden. */
    function userLayer(snapshot) {
      return objectLayer(snapshot, "user");
    }

    function overridden(snapshot, key) {
      return has(userLayer(snapshot), key);
    }

    /** The effective value for a field, as the string a control holds. */
    function stored(snapshot, key) {
      var value = accepted(snapshot)[key];
      return value === undefined || value === null ? "" : String(value);
    }

    /**
     * Parse a draft string into the value to store.
     * @throws {Error} when the draft does not satisfy the field's schema.
     */
    function parse(field, raw) {
      if (field.kind === "text" || field.kind === "select") return raw;
      if (field.kind === "boolean") {
        if (raw !== "true" && raw !== "false") throw new Error(field.label + "只能取开或关。");
        return raw === "true";
      }
      var value = Number(raw);
      if (!isFinite(value)) throw new Error(field.label + "必须是数字。");
      if (field.step === 1 && !Number.isInteger(value)) throw new Error(field.label + "必须是整数。");
      if (field.min !== undefined && value < field.min) throw new Error(field.label + "不能小于 " + field.min + "。");
      if (field.max !== undefined && value > field.max) throw new Error(field.label + "不能大于 " + field.max + "。");
      return value;
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

      var [draft, setDraft] = React.useState({});
      var [busy, setBusy] = React.useState(false);
      var [error, setError] = React.useState(null);

      if (props.view === "summary") return copy.summary;

      var writable = snapshot.writable === true;
      var current = accepted(snapshot);

      /** Record one field's draft, leaving the others untouched. */
      function edit(key, value) {
        setDraft(function (previous) {
          var next = {};
          for (var name in previous) if (has(previous, name)) next[name] = previous[name];
          next[key] = value;
          return next;
        });
      }

      // Every field whose draft no longer matches what is stored. A draft that
      // is an empty string means "clear the override", which is a real edit
      // whenever a value is currently in effect.
      var edits = [];
      var invalid = null;
      FIELDS.forEach(function (field) {
        if (!has(draft, field.key)) return;
        var raw = draft[field.key];
        if (raw === "") {
          // A blank draft is an edit whenever a value is currently in effect:
          // it is the only way to discard the draft and show the inherited
          // value again. Unsetting a field that carries no user-layer override
          // is a no-op, but it still clears the draft, which is the point.
          if (current[field.key] !== undefined) edits.push({ field: field, raw: raw });
          return;
        }
        var value;
        try {
          value = parse(field, raw);
        } catch (cause) {
          if (invalid === null) invalid = String((cause && cause.message) || cause);
          return;
        }
        if (value !== current[field.key]) edits.push({ field: field, raw: raw, value: value });
      });

      var anyOverridden = FIELDS.some(function (field) {
        return overridden(snapshot, field.key);
      });
      var dirty = edits.length > 0;
      var blocked = busy || invalid !== null;

      /** Persist every edit, in order, one write at a time. */
      function save() {
        if (!dirty || blocked) return;
        var ops = edits.map(function (item) {
          return { key: item.field.key, value: item.raw === "" ? null : item.value };
        });
        // `retainRatio` and `retainTokens` are mutually exclusive in the host
        // engine, so one save may leave only one of them stated. The field the
        // user just typed wins; when both are typed in the same save the
        // absolute form wins, matching the engine's own precedence.
        var statingTokens = ops.some(function (op) {
          return op.key === "retainTokens" && op.value !== null;
        });
        var statingRatio = ops.some(function (op) {
          return op.key === "retainRatio" && op.value !== null;
        });
        var cleared = statingTokens ? "retainRatio" : statingRatio ? "retainTokens" : null;
        if (cleared !== null) {
          // Drop the loser's stated value before deciding whether an unset is
          // also needed: on a fresh pair neither key is overridden yet, and the
          // filter alone is what keeps them from both landing.
          ops = ops.filter(function (op) {
            return op.key !== cleared;
          });
          if (overridden(snapshot, cleared)) ops.push({ key: cleared, value: null });
        }

        setError(null);
        setBusy(true);
        var chain = Promise.resolve();
        ops.forEach(function (op) {
          chain = chain.then(function () {
            return op.value === null ? scope.unset(op.key) : scope.set(op.key, op.value);
          });
        });
        chain.then(
          function () {
            setBusy(false);
            setDraft({});
          },
          function (cause) {
            setBusy(false);
            setError(String((cause && cause.message) || cause));
          },
        );
      }

      /** Drop every override so the fields re-inherit the composition values. */
      function reset() {
        if (busy) return;
        var keys = FIELDS.filter(function (field) {
          return overridden(snapshot, field.key);
        }).map(function (field) {
          return field.key;
        });
        if (keys.length === 0) return;
        setError(null);
        setDraft({});
        setBusy(true);
        var chain = Promise.resolve();
        keys.forEach(function (key) {
          chain = chain.then(function () {
            return scope.unset(key);
          });
        });
        chain.then(
          function () {
            setBusy(false);
          },
          function (cause) {
            setBusy(false);
            setError(String((cause && cause.message) || cause));
          },
        );
      }

      var children = [
        React.createElement("div", { key: "heading", style: headingStyle }, copy.heading),
        React.createElement("div", { key: "intro" }, copy.intro),
      ];

      FIELDS.forEach(function (field) {
        var raw = has(draft, field.key) ? draft[field.key] : stored(snapshot, field.key);
        var disabled = !writable || busy;
        var control;
        if (field.kind === "number") {
          control = React.createElement("input", {
            type: "number",
            min: field.min,
            max: field.max,
            step: field.step,
            style: inputStyle,
            value: raw,
            disabled: disabled,
            placeholder: copy.inherit,
            "aria-label": field.label,
            onChange: function (event) {
              edit(field.key, event.target.value);
            },
            onKeyDown: function (event) {
              if (event.key === "Enter") save();
            },
          });
        } else if (field.kind === "text") {
          control = React.createElement("input", {
            type: "text",
            style: textStyle,
            value: raw,
            disabled: disabled,
            placeholder: copy.inherit,
            "aria-label": field.label,
            onChange: function (event) {
              edit(field.key, event.target.value);
            },
            onKeyDown: function (event) {
              if (event.key === "Enter") save();
            },
          });
        } else {
          var options =
            field.kind === "select"
              ? field.options
              : [
                  { value: "true", label: copy.on },
                  { value: "false", label: copy.off },
                ];
          control = React.createElement(
            "select",
            {
              style: selectStyle,
              value: raw,
              disabled: disabled,
              "aria-label": field.label,
              onChange: function (event) {
                edit(field.key, event.target.value);
              },
            },
            [React.createElement("option", { key: "", value: "" }, copy.inherit)].concat(
              options.map(function (option) {
                return React.createElement("option", { key: option.value, value: option.value }, option.label);
              }),
            ),
          );
        }

        children.push(
          React.createElement(
            "div",
            { key: field.key, style: fieldStyle },
            React.createElement("span", { style: labelStyle }, field.label),
            control,
            field.unit ? React.createElement("span", { style: hintStyle }, field.unit) : null,
            overridden(snapshot, field.key) ? React.createElement("span", { style: badgeStyle }, copy.overridden) : null,
          ),
        );
        if (field.hint) {
          children.push(
            React.createElement("div", { key: field.key + "-hint", style: hintStyle }, field.hint),
          );
        }
      });

      children.push(
        React.createElement(
          "div",
          { key: "actions", style: rowStyle },
          React.createElement(
            "button",
            {
              type: "button",
              style: dirty && writable && !blocked ? primaryButtonStyle : buttonStyle,
              disabled: !dirty || !writable || blocked,
              onClick: save,
            },
            busy ? copy.saving : copy.save,
          ),
          React.createElement(
            "button",
            {
              type: "button",
              style: buttonStyle,
              disabled: !writable || busy || !anyOverridden,
              onClick: reset,
            },
            copy.reset,
          ),
        ),
      );
      if (invalid !== null) {
        children.push(React.createElement("div", { key: "invalid", style: errorStyle }, invalid));
      }
      if (error !== null) {
        children.push(React.createElement("div", { key: "error", style: errorStyle }, error));
      }
      if (!writable && snapshot.status === "ready") {
        children.push(React.createElement("div", { key: "unwritable", style: errorStyle }, copy.unwritable));
      }
      children.push(React.createElement("div", { key: "restart", style: hintStyle }, copy.restart));

      return React.createElement("div", { style: wrapStyle }, children);
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
