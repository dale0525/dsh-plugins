/**
 * Browser half: the desktop-agent configuration card inside the Plugins page.
 *
 * This file is already in the client module loader's protocol — it is not a
 * module and imports nothing. `build.mjs` copies it to `lib/client.js`
 * verbatim, which is why `package.json` exports `./client` at that path.
 *
 * The card is registered into the `plugins.row.config` slot under
 * `<bundle>#desktop-agent`, the key the Plugins page derives from the bundle
 * that declares the row.
 *
 * The field list mirrors the schema in `src/config.js`; the two are kept in step
 * by hand because this half ships as plain browser code.
 *
 * Two catalogs feed this card, and they are not interchangeable:
 *
 *  - The VISION list comes from this plugin's own loopback route
 *    (`/api/dsh-desktop-agent/vision-models`). It has to: the host's
 *    `session.modelCatalog` does not carry `inputModalities` at all — its
 *    builder maps a fixed set of fields off the resolved model info and drops
 *    that one — so the card cannot tell a seeing model from a blind one by
 *    asking it.
 *  - The HOST catalog still supplies each model's reasoning efforts, which it
 *    does carry, so the effort dropdown stays exactly as rich as the host makes
 *    it without this card inventing a second source for it.
 *
 * The settings service is `configForms`, addressed by loader ENTRY ID
 * (`configForms.get(entryId)`) rather than bound by namespace. It is injected
 * NESTED inside `apply` rather than declared in `inject`, so a host without the
 * settings UI loses only this card instead of failing the page's boot audit.
 */
window.__ModuleLoader__.load({
  id: "@logictan/dsh-desktop-agent",
  factory: function (require) {
    var React = require("react");

    /** Loader entry id this card's form is keyed by. */
    var NS = "desktop-agent";
    /** The patch row this card configures (cordis.patch.yml). */
    var ROW_ID = "desktop-agent";
    /**
     * Bundle package names whose row `ROW_ID` this card configures.
     *
     * The page keys a row's configuration by the package that declares the row.
     * This plugin reaches a profile in one of two shapes — as a dependency of
     * this repository's aggregate bundle, or installed on its own — and the key
     * differs between them. Both are registered; the key whose bundle is not
     * installed never renders, because the page dispatches only the keys its own
     * bundles declare.
     */
    var BUNDLE_NAMES = ["@logictan/dsh-plugins-all", "@logictan/dsh-desktop-agent"];
    /** This plugin's own vision-catalog route. */
    var VISION_MODELS_API = "/api/dsh-desktop-agent/vision-models";

    var copy = {
      summary: "桌面 Agent 的参数",
      heading: "桌面 Agent",
      intro:
        "用截图作为主要感知、通过 Cua Driver 操作桌面窗口。留空表示继承默认值。需先在 profile 挂载 computer-use 的 cua-driver-native provider。",
      inherit: "继承默认",
      save: "保存",
      saving: "保存中…",
      reset: "恢复默认",
      overridden: "已覆盖",
      unwritable: "当前连接不写回本机设置，无法保存。",
      catalogLoading: "正在读取视觉模型目录…",
      catalogError: "视觉模型目录读取失败，可切换为手填。",
      catalogPartial: "部分 provider 读取失败，列表可能不完整。",
      catalogEmpty: "没有声明支持图像的模型，可切换为手填。",
      catalogFallback: "无图像能力的模型会退回 AX 元素表通道。",
      effortNone: "该模型没有 reasoning effort",
      manual: "手填",
      picker: "从目录选择",
      routeMissing: "已存的路由不在当前目录中（provider 读取失败或模型已下线），已切换为手填。",
      deliveryBackground: "后台投递（默认）",
      deliveryForeground: "前台投递（画布/游戏）",
    };

    /**
     * Editable fields, in render order. `kind` picks the control.
     *
     * The three vision-route keys are rendered together below the catalog picker
     * and are listed here only so that override detection, save, and reset see
     * them.
     */
    var FIELDS = [
      {
        key: "maxSteps",
        label: "步数上限",
        kind: "number",
        min: 1,
        step: 1,
        hint: "一次任务最多执行多少个动作，默认 40。",
      },
      {
        key: "maxImageDimension",
        label: "截图长边上限",
        kind: "number",
        min: 200,
        step: 1,
        hint: "送给模型的截图最长边（像素），默认 1568。调小可省 token，但太小会看不清控件。",
      },
      {
        key: "deliveryMode",
        label: "投递方式",
        kind: "select",
        options: [
          { value: "background", label: copy.deliveryBackground },
          { value: "foreground", label: copy.deliveryForeground },
        ],
        hint: "后台投递不抢焦点；游戏等自绘表面会过滤按 pid 路由的事件，需要前台投递。",
      },
    ];

    /** The three vision route fields, rendered together below the catalog. */
    var ROUTE_KEYS = ["visionProvider", "visionModel", "visionReasoningEffort"];

    var wrapStyle = {
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      maxWidth: "620px",
      color: "var(--dsw-alias-label-primary)",
      fontSize: "13px",
      lineHeight: 1.6,
    };
    var headingStyle = { fontSize: "14px", fontWeight: 600 };
    var hintStyle = { color: "var(--dsw-alias-label-tertiary)" };
    var rowStyle = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
    var fieldStyle = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
    var labelStyle = { minWidth: "140px" };
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
    var textStyle = Object.assign({ width: "260px" }, controlStyle);
    var selectStyle = Object.assign({ minWidth: "200px" }, controlStyle);
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
      if (field.kind === "text") return raw;
      if (field.kind === "select") return raw;
      var value = Number(raw);
      if (!isFinite(value)) throw new Error(field.label + "必须是数字。");
      if (field.step === 1 && !Number.isInteger(value)) throw new Error(field.label + "必须是整数。");
      if (field.min !== undefined && value < field.min) throw new Error(field.label + "不能小于 " + field.min + "。");
      if (field.max !== undefined && value > field.max) throw new Error(field.label + "不能大于 " + field.max + "。");
      return value;
    }

    /**
     * Load this plugin's own vision-capable model list.
     *
     * A failed load must not disable the card — the route can always be typed by
     * hand — so a failure only changes the status line and the manual fallback.
     */
    function useVisionCatalog(ctx) {
      var state = React.useState({ status: "loading", groups: [], failures: 0 });
      var value = state[0];
      var setValue = state[1];
      var generation = React.useRef(0);

      var load = React.useCallback(function () {
        var mine = ++generation.current;
        setValue(function (previous) {
          return { status: "loading", groups: previous.groups, failures: previous.failures };
        });
        Promise.resolve()
          .then(function () {
            return fetch(VISION_MODELS_API, { method: "GET", headers: { accept: "application/json" } });
          })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .then(
            function (body) {
              if (mine !== generation.current) return;
              setValue({
                status: "ready",
                groups: (body && body.groups) || [],
                failures: ((body && body.failures) || []).length,
              });
            },
            function () {
              if (mine !== generation.current) return;
              setValue({ status: "error", groups: [], failures: 0 });
            },
          );
      }, []);

      React.useEffect(
        function () {
          load();
          var offAdapters = ctx.remote.$on("llm/adapters-updated", load);
          var offSettings = ctx.remote.$on("settings/document-updated", load);
          return function () {
            offAdapters();
            offSettings();
          };
        },
        [ctx, load],
      );

      return { value: value, reload: load };
    }

    /**
     * Load the host's model directory, which is where reasoning efforts live.
     *
     * Only the effort list is taken from here: the vision filter comes from this
     * plugin's own route, because this catalog cannot express it.
     */
    function useHostCatalog(ctx) {
      var state = React.useState({ groups: [] });
      var value = state[0];
      var setValue = state[1];

      React.useEffect(
        function () {
          var live = true;
          function load() {
            Promise.resolve()
              .then(function () {
                return ctx.remote.session.modelCatalog();
              })
              .then(
                function (response) {
                  if (!live) return;
                  if (response && response.ok) setValue({ groups: response.value.groups || [] });
                },
                function () {},
              );
          }
          load();
          var offAdapters = ctx.remote.$on("llm/adapters-updated", load);
          return function () {
            live = false;
            offAdapters();
          };
        },
        [ctx],
      );

      return value;
    }

    /** The catalog entry matching a stored route, when it is still present. */
    function matchModel(groups, provider, model) {
      var found = null;
      groups.forEach(function (group) {
        if (group.id !== provider) return;
        (group.models || []).forEach(function (entry) {
          if (entry.id === model) found = entry;
        });
      });
      return found;
    }

    /**
     * The row's configuration card.
     *
     * `scope` is the configuration form `apply` obtained for this entry from
     * `configForms.get(NS)`; `ctx` is the scoped context it was obtained on,
     * which supplies both catalogs.
     */
    function DesktopAgentSettingsCard(props) {
      var scope = props.scope;
      var ctx = props.ctx;

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

      var catalog = useVisionCatalog(ctx);
      var host = useHostCatalog(ctx);

      var draftState = React.useState({});
      var draft = draftState[0];
      var setDraft = draftState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      /** Whether the user chose to type the route instead of picking it. */
      var manualState = React.useState(false);
      var manual = manualState[0];
      var setManual = manualState[1];

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

      /**
       * Stage several fields at once.
       *
       * Picking a provider clears the model and the effort, because both belong
       * to the previous provider and would otherwise be saved as a route the
       * Host cannot resolve.
       */
      function editMany(patch) {
        setDraft(function (previous) {
          var next = {};
          for (var name in previous) if (has(previous, name)) next[name] = previous[name];
          for (var key in patch) if (has(patch, key)) next[key] = patch[key];
          return next;
        });
      }

      var allFields = FIELDS.concat([
        { key: "visionProvider", label: "视觉 provider", kind: "text" },
        { key: "visionModel", label: "视觉 model", kind: "text" },
        { key: "visionReasoningEffort", label: "视觉 reasoning effort", kind: "text" },
      ]);

      /** Whether a field currently carries a user override. */
      function isOverridden(field) {
        return overridden(snapshot, field.key);
      }

      // Every field whose draft no longer matches what is stored. A draft that
      // is an empty string means "clear the override", which is a real edit
      // whenever a value is currently in effect.
      var edits = [];
      var invalid = null;
      allFields.forEach(function (field) {
        if (!has(draft, field.key)) return;
        var raw = draft[field.key];
        if (raw === "") {
          if (isOverridden(field)) edits.push({ field: field, raw: raw });
          return;
        }
        var value;
        try {
          value = parse(field, raw);
        } catch (cause) {
          if (invalid === null) invalid = String((cause && cause.message) || cause);
          return;
        }
        if (String(value) !== String(current[field.key])) edits.push({ field: field, raw: raw, value: value });
      });

      var anyOverridden = allFields.some(isOverridden);
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
            return item.raw === "" ? scope.unset(item.field.key) : scope.set(item.field.key, item.value);
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
        var keys = allFields
          .filter(function (field) {
            return isOverridden(field);
          })
          .map(function (field) {
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

      /** The draft for a key, or the stored value. */
      function rawOf(key) {
        return has(draft, key) ? draft[key] : stored(snapshot, key);
      }

      var children = [
        React.createElement("div", { key: "heading", style: headingStyle }, copy.heading),
        React.createElement("div", { key: "intro" }, copy.intro),
      ];

      FIELDS.forEach(function (field) {
        var disabled = !writable || busy;
        var control;
        if (field.kind === "select") {
          control = React.createElement(
            "select",
            {
              style: selectStyle,
              value: rawOf(field.key),
              disabled: disabled,
              "aria-label": field.label,
              onChange: function (event) {
                edit(field.key, event.target.value);
              },
            },
            field.options.map(function (option) {
              return React.createElement("option", { key: option.value, value: option.value }, option.label);
            }),
          );
        } else if (field.kind === "number") {
          control = React.createElement("input", {
            type: "number",
            min: field.min,
            max: field.max,
            step: field.step,
            style: inputStyle,
            value: rawOf(field.key),
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
          control = React.createElement("input", {
            type: "text",
            style: textStyle,
            value: rawOf(field.key),
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
        }

        children.push(
          React.createElement(
            "div",
            { key: field.key, style: fieldStyle },
            React.createElement("span", { style: labelStyle }, field.label),
            control,
            isOverridden(field) ? React.createElement("span", { style: badgeStyle }, copy.overridden) : null,
          ),
        );
        if (field.hint) {
          children.push(React.createElement("div", { key: field.key + "-hint", style: hintStyle }, field.hint));
        }
      });

      children.push(
        React.createElement("hr", {
          key: "route-sep",
          style: { border: "none", borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "4px 0" },
        }),
      );
      children.push(React.createElement("div", { key: "route-heading", style: headingStyle }, "视觉模型路由"));
      children.push(
        React.createElement(
          "div",
          { key: "route-hint", style: hintStyle },
          "每步决策用哪个模型看图。全空 = 用会话当前模型；会话模型不支持图像时自动走 AX 元素表。",
        ),
      );

      var groups = catalog.value.groups || [];
      var provider = rawOf("visionProvider");
      var model = rawOf("visionModel");
      var selected = matchModel(groups, provider, model);
      var providers = [];
      groups.forEach(function (group) {
        if (providers.indexOf(group.id) === -1) providers.push(group.id);
      });
      var modelsForProvider = [];
      groups.forEach(function (group) {
        if (group.id !== provider) return;
        (group.models || []).forEach(function (entry) {
          modelsForProvider.push(entry);
        });
      });

      // The dropdown is usable only when the catalog loaded AND a provider is
      // available. A stored route the catalog no longer offers (a provider that
      // failed to load, or a model removed upstream) is never silently
      // rewritten: the card falls back to manual entry and says so.
      var pickable = catalog.value.status === "ready" && providers.length > 0;
      var usePicker = pickable && !manual;

      if (catalog.value.status === "loading") {
        children.push(React.createElement("div", { key: "catalog-status", style: hintStyle }, copy.catalogLoading));
      } else if (catalog.value.status === "error") {
        children.push(React.createElement("div", { key: "catalog-status", style: errorStyle }, copy.catalogError));
      } else if (providers.length === 0) {
        children.push(React.createElement("div", { key: "catalog-status", style: hintStyle }, copy.catalogEmpty));
      } else if (catalog.value.failures > 0) {
        children.push(React.createElement("div", { key: "catalog-status", style: hintStyle }, copy.catalogPartial));
      }

      if (usePicker) {
        children.push(
          React.createElement(
            "div",
            { key: "route-provider", style: fieldStyle },
            React.createElement("span", { style: labelStyle }, "provider"),
            React.createElement(
              "select",
              {
                style: selectStyle,
                value: provider,
                disabled: !writable || busy,
                "aria-label": "视觉 provider",
                onChange: function (event) {
                  // The previous model and effort belong to the previous
                  // provider, so they are cleared together with it.
                  editMany({ visionProvider: event.target.value, visionModel: "", visionReasoningEffort: "" });
                },
              },
              [React.createElement("option", { key: "", value: "" }, copy.inherit)].concat(
                providers.map(function (id) {
                  return React.createElement("option", { key: id, value: id }, id);
                }),
              ),
            ),
            overridden(snapshot, "visionProvider")
              ? React.createElement("span", { style: badgeStyle }, copy.overridden)
              : null,
          ),
        );
        children.push(
          React.createElement(
            "div",
            { key: "route-model", style: fieldStyle },
            React.createElement("span", { style: labelStyle }, "model"),
            React.createElement(
              "select",
              {
                style: selectStyle,
                value: selected === null ? "" : model,
                disabled: !writable || busy || provider === "",
                "aria-label": "视觉 model",
                onChange: function (event) {
                  editMany({ visionModel: event.target.value, visionReasoningEffort: "" });
                },
              },
              [React.createElement("option", { key: "", value: "" }, copy.inherit)].concat(
                modelsForProvider.map(function (entry) {
                  return React.createElement("option", { key: entry.id, value: entry.id }, entry.name || entry.id);
                }),
              ),
            ),
            overridden(snapshot, "visionModel") ? React.createElement("span", { style: badgeStyle }, copy.overridden) : null,
          ),
        );

        // The effort list comes from the HOST catalog, which does carry it; the
        // vision route above only decides which models may appear at all.
        var hostEntry = matchModel(host.groups, provider, model);
        var reasoning = (hostEntry && hostEntry.reasoning) || null;
        var effortOptions = reasoning ? reasoning.efforts || [] : [];
        if (effortOptions.length > 0) {
          var effortValue = rawOf("visionReasoningEffort") || reasoning.defaultEffort || "";
          children.push(
            React.createElement(
              "div",
              { key: "route-effort", style: fieldStyle },
              React.createElement("span", { style: labelStyle }, "reasoning effort"),
              React.createElement(
                "select",
                {
                  style: selectStyle,
                  value: effortValue,
                  disabled: !writable || busy,
                  "aria-label": "视觉 reasoning effort",
                  onChange: function (event) {
                    edit("visionReasoningEffort", event.target.value);
                  },
                },
                [React.createElement("option", { key: "", value: "" }, copy.inherit)].concat(
                  effortOptions.map(function (effort) {
                    return React.createElement("option", { key: effort.id, value: effort.id }, effort.name || effort.id);
                  }),
                ),
              ),
              overridden(snapshot, "visionReasoningEffort")
                ? React.createElement("span", { style: badgeStyle }, copy.overridden)
                : null,
            ),
          );
        } else if (reasoning) {
          children.push(
            React.createElement("div", { key: "route-effort", style: hintStyle }, "reasoning effort：" + copy.effortNone),
          );
        }

        if (selected === null && (provider !== "" || model !== "")) {
          children.push(React.createElement("div", { key: "route-missing", style: hintStyle }, copy.routeMissing));
        }
      } else {
        // Manual entry, also the fallback when the catalog failed: the card must
        // stay usable when a provider is unreachable.
        ROUTE_KEYS.forEach(function (key) {
          var label = key === "visionProvider" ? "provider" : key === "visionModel" ? "model" : "reasoning effort";
          children.push(
            React.createElement(
              "div",
              { key: "route-" + key, style: fieldStyle },
              React.createElement("span", { style: labelStyle }, label),
              React.createElement("input", {
                type: "text",
                style: textStyle,
                value: rawOf(key),
                disabled: !writable || busy,
                placeholder: copy.inherit,
                "aria-label": "视觉 " + label,
                onChange: function (event) {
                  edit(key, event.target.value);
                },
                onKeyDown: function (event) {
                  if (event.key === "Enter") save();
                },
              }),
              overridden(snapshot, key) ? React.createElement("span", { style: badgeStyle }, copy.overridden) : null,
            ),
          );
        });
      }

      if (pickable) {
        children.push(
          React.createElement(
            "div",
            { key: "route-mode", style: rowStyle },
            React.createElement(
              "button",
              {
                type: "button",
                style: buttonStyle,
                onClick: function () {
                  setManual(!manual);
                },
              },
              manual ? copy.picker : copy.manual,
            ),
          ),
        );
      }

      children.push(React.createElement("div", { key: "route-fallback", style: hintStyle }, copy.catalogFallback));

      if (invalid !== null) children.push(React.createElement("div", { key: "invalid", style: errorStyle }, invalid));
      if (error !== null) children.push(React.createElement("div", { key: "error", style: errorStyle }, error));
      if (!writable && snapshot.status === "ready") {
        children.push(React.createElement("div", { key: "unwritable", style: errorStyle }, copy.unwritable));
      }

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

      return React.createElement("div", { style: wrapStyle }, children);
    }

    /**
     * Client plugin body: bind the configuration form and register the card.
     *
     * `configForms` is injected NESTED rather than declared in this plugin's
     * `inject` list. A plugin that waits on a service the profile does not
     * provide never activates, and the Web UI's boot audit turns that into a hard
     * failure for the WHOLE page ("web boot: N entries did not activate"), not
     * just for this card. Nested, a host without the settings UI loses only this
     * card.
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
                  return { scope: scope, ctx: scoped };
                },
              },
              DesktopAgentSettingsCard,
            );
          });
        });
      });
    }

    return {
      name: "dsh-desktop-agent",
      inject: ["slots", "remote", "remote.session"],
      apply: apply,
    };
  },
});
