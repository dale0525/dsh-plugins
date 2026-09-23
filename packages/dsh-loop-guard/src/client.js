/**
 * Browser half: the guard's tuning knobs inside the Plugins page.
 *
 * This file is already in the client module loader's protocol — it is not a
 * module and imports nothing. `build.mjs` copies it to `lib/client.js`
 * verbatim, which is why `package.json` exports `./client` at that path.
 *
 * The card is registered into the `plugins.row.config` slot under
 * `<bundle>#loop-guard`, the key the Plugins page derives from the bundle that
 * declares the row and the row id as its patch declares it.
 *
 * The field list mirrors `Config` in `src/index.ts`; the two are kept in step
 * by hand because this half ships as plain browser code.
 *
 * ## Why the settings service is a NESTED inject, and why it is `configForms`
 *
 * Two separate lessons, both learned the hard way:
 *
 *  1. Naming the settings service in this plugin's own `inject` parks the WHOLE
 *     browser half — and because the page's boot audit turns one pending entry
 *     into a thrown error, it takes the entire Web UI down with it
 *     (`web boot: N entries did not activate`). A host that lacks the service
 *     must cost the guard its configuration CARD, not its mount.
 *  2. The service was renamed. `dsh-client-ui-settings` provided
 *     `settingsScope` up to 0.1.6-alpha.2 and provides `configForms` from
 *     0.1.7-alpha.1; the old name exists nowhere in the newer tree. The method
 *     moved with it: `settingsScope.bind({ namespace })` became
 *     `configForms.get(entryId)`, because a form is now keyed by the LOADER
 *     ENTRY id — which for this row is `loop-guard`, the same string the old
 *     namespace used. Everything the card reads off the returned controller
 *     (snapshot, subscribe, set, unset) is unchanged.
 */
window.__ModuleLoader__.load({
  id: "@logictan/dsh-loop-guard",
  factory: function (require) {
    var React = require("react");

    /** Settings namespace the host half registers. */
    var NS = "loop-guard";
    /**
     * The patch row this card configures (`src/index.ts`'s `name`).
     *
     * Since the 0.1.7-alpha.1 settings redesign the row id is ALSO the
     * namespace: a configuration form is keyed by the loader entry id, and this
     * row's entry id is exactly this string. The two constants stay separate
     * because they answer different questions — one names the settings form,
     * the other the slot key — but they must remain equal.
     */
    var ROW_ID = "loop-guard";
    /**
     * Bundle package names whose row `ROW_ID` this card configures.
     *
     * The page keys a row's configuration by the package that declares the row.
     * This plugin reaches a profile in one of two shapes — as a dependency of
     * this repository's aggregate bundle, or installed on its own — and the key
     * differs between them. Both are registered; the key whose bundle is not
     * installed never renders, because the page dispatches only the keys its own
     * bundles declare.
     *
     * This half only reaches the browser at all because the row is a BARE
     * package name: `dsh-client-modules` locates `dsh.client` from the
     * specifier of the loader row that mounts it and accepts no subpath.
     */
    var BUNDLE_NAMES = ["@logictan/dsh-plugins-all", "@logictan/dsh-loop-guard"];

    var copy = {
      summary: "思考循环守护的灵敏度与熔断行为",
      heading: "思考循环守护",
      intro:
        "模型陷入「只想不做」的退化循环时，这些参数决定它在第几次停滞调用上反应、判定多严格，以及是否在流中途截断。" +
        "留空表示沿用组合配置（cordis.patch.yml 里的值）或插件默认值。",
      inherit: "继承默认",
      save: "保存",
      saving: "保存中…",
      reset: "恢复默认",
      overridden: "已覆盖",
      unwritable: "当前连接不写回本机设置，无法保存。",
      live: "保存后即刻生效，无需重启。",
    };

    /** Editable fields, in render order. `kind` picks the control. */
    var FIELDS = [
      {
        group: "跨调用判定（调用结束后）",
      },
      {
        key: "maxThinkingSteps",
        label: "停滞调用次数",
        kind: "number",
        min: 2,
        step: 1,
        hint: "连续多少次「停滞调用」后反应。默认 3；调到 2 更灵敏。",
      },
      {
        key: "minReasoningChars",
        label: "最短推理长度",
        kind: "number",
        min: 256,
        step: 1,
        unit: "字符",
        hint: "单次调用的推理至少这么长才参与判定。默认 2048。",
      },
      {
        key: "similarityThreshold",
        label: "复述相似度",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.01,
        hint: "上一步的推理有多少重现才算「复述」。0 关闭该规则。默认 0.8。",
      },
      {
        key: "escalate",
        label: "命中后动作",
        kind: "select",
        options: [
          { value: "warn", label: "warn（只提示）" },
          { value: "steer", label: "steer（注入纠正，默认）" },
          { value: "cancel", label: "cancel（中止回合）" },
        ],
      },
      {
        key: "maxFires",
        label: "最多反应次数",
        kind: "number",
        min: 1,
        step: 1,
        hint: "同一个 agent 最多反应多少次。默认 4。",
      },
      {
        key: "cancelCause",
        label: "取消原因",
        kind: "text",
        hint: "escalate 为 cancel 时写入的取消原因。默认 thinking-loop。",
      },
      {
        group: "流内切断（调用进行中）",
      },
      {
        key: "maxRepeatedText",
        label: "相同 chunk 数",
        kind: "number",
        min: 0,
        step: 1,
        hint: "连续多少个完全相同的可见输出 chunk 就切断。0 关闭。默认 60。",
      },
      {
        key: "maxRepeatedCycleChars",
        label: "可见输出周期上限",
        kind: "number",
        min: 0,
        step: 1,
        unit: "字符",
        hint: "可见输出尾部最长重复周期。0 关闭。默认 512——低于真实周期会静默失效。",
      },
      {
        key: "minRepeatedCycleChars",
        label: "可见输出最短重复",
        kind: "number",
        min: 2,
        step: 1,
        unit: "字符",
        hint: "可见输出尾部至少要重复多长才判定。默认 256。",
      },
      {
        key: "maxRepeatedReasoningCycleChars",
        label: "推理周期上限",
        kind: "number",
        min: 0,
        step: 1,
        unit: "字符",
        hint: "推理尾部最长重复周期——这条终止「永不结束的回合」。0 关闭。默认 512。",
      },
      {
        key: "minRepeatedReasoningCycleChars",
        label: "推理最短重复",
        kind: "number",
        min: 2,
        step: 1,
        unit: "字符",
        hint: "推理尾部至少要重复多长才判定。默认 512。",
      },
      {
        key: "maxRepeatedReasoningLineChars",
        label: "推理重复行阈值",
        kind: "number",
        min: 0,
        step: 1,
        unit: "字符",
        hint: "推理里「重复行」累计到多少字符就切断——抓没有周期的短语池重排。0 关闭。默认 2048。",
      },
      {
        key: "minRepeatedReasoningLineCoverage",
        label: "重复行占比",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.01,
        hint: "重复行占比要达到多少才判定。默认 0.6。",
      },
      {
        group: "切断后的行为",
      },
      {
        key: "breakCode",
        label: "日志错误码",
        kind: "text",
        hint: "日志里标注的错误码。默认 REPETITIVE_OUTPUT。",
      },
      {
        key: "breakCorrection",
        label: "注入纠正提示",
        kind: "boolean",
        hint: "切断时注入一条提示，让模型回到原任务。默认开。",
      },
      {
        key: "resumeAfterBreak",
        label: "切断后自动续跑",
        kind: "boolean",
        hint: "不等你发话就自己往下走。仅在关掉「注入纠正提示」时有用（开着时提示本身就会把任务推下去）。默认关。",
      },
      {
        group: "响应体损坏时重试",
      },
      {
        key: "retryRequestFailures",
        label: "自动重试损坏响应",
        kind: "boolean",
        hint: "模型返回的响应体 JSON 解析失败（本轮运行失败）时自动重发同一请求。默认开。",
      },
      {
        key: "maxRequestRetries",
        label: "重试上限",
        kind: "number",
        min: 0,
        step: 1,
        hint: "同一次尝试最多重发几次，超出交给下游恢复。默认 2。",
      },
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
    var groupStyle = {
      marginTop: "4px",
      paddingTop: "8px",
      borderTop: "1px solid var(--dsw-alias-border-l2)",
      fontWeight: 600,
      color: "var(--dsw-alias-label-secondary)",
    };
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

    /** The editable fields only — the group rows carry no `key`. */
    var KEYS = FIELDS.filter(function (field) {
      return field.key !== undefined;
    });

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
     * `apply`; the card only reads its snapshot and routes explicit user choices
     * back through it.
     */
    function LoopGuardSettingsCard(props) {
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
      KEYS.forEach(function (field) {
        if (!has(draft, field.key)) return;
        var raw = draft[field.key];
        if (raw === "") {
          // A blank draft is an edit whenever a value is currently in effect:
          // it is the only way to discard the draft and show the inherited
          // value again.
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

      var anyOverridden = KEYS.some(function (field) {
        return overridden(snapshot, field.key);
      });
      var dirty = edits.length > 0;
      var blocked = busy || invalid !== null;

      /** Persist every edit, in order, one write at a time. */
      function save() {
        if (!dirty || blocked) return;
        setError(null);
        setBusy(true);
        var chain = Promise.resolve();
        edits.forEach(function (item) {
          chain = chain.then(function () {
            return item.raw === ""
              ? scope.unset(item.field.key)
              : scope.set(item.field.key, item.value);
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
        var keys = KEYS.filter(function (field) {
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

      FIELDS.forEach(function (field, position) {
        if (field.key === undefined) {
          children.push(
            React.createElement("div", { key: "group-" + position, style: groupStyle }, field.group),
          );
          return;
        }
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
                  { value: "true", label: "开" },
                  { value: "false", label: "关" },
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
      children.push(React.createElement("div", { key: "live", style: hintStyle }, copy.live));

      return React.createElement("div", { style: wrapStyle }, children);
    }

    /**
     * Client plugin body: register the card once the settings service is up.
     *
     * The settings service is requested through a NESTED inject so a host
     * without it loses only the card — see the file header.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.inject(["configForms"], function (scoped) {
        var scope = scoped.configForms.get(NS);
        BUNDLE_NAMES.forEach(function (bundle) {
          scoped.slots.inject("plugins.row.config", function () {
            return scoped.slots.register(
              {
                name: "plugins.row.config",
                key: bundle + "#" + ROW_ID,
                inject: function () {
                  return { scope: scope };
                },
              },
              LoopGuardSettingsCard,
            );
          });
        });
      });
    }

    return { name: "dsh-loop-guard", inject: ["slots"], apply: apply };
  },
});
