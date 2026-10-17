/**
 * Browser half: the browser-agent configuration card inside the Plugins page.
 *
 * This file is already in the client module loader's protocol — it is not a
 * module and imports nothing. `build.mjs` copies it to `lib/client.js`
 * verbatim, which is why `package.json` exports `./client` at that path.
 *
 * The card is registered into the `plugins.row.config` slot under
 * `<bundle>#browser-agent`, the key the Plugins page derives from the bundle
 * that declares the row.
 *
 * The card renders the schema in `src/config.js` via `UI.ConfigForm`: labels,
 * descriptions, inputs and persistence are handled automatically from the schema
 * mirror, while this half owns only the credential section and route catalog picker.
 *
 * As of the 0.1.7-alpha.1 settings redesign the settings service is
 * `configForms`, not `settingsScope`: a form is addressed by loader ENTRY ID
 * (`configForms.get(entryId)`) rather than bound by namespace, and the shared
 * describe mirror is reached through `configForms.describe()`. The service is
 * injected NESTED inside `apply` rather than declared in `inject`, so a host
 * without the settings UI loses only this card instead of failing the page's
 * boot audit.
 */
window.__ModuleLoader__.load({
  id: "@logictan/dsh-browser-agent",
  factory: function (require) {
    var React = require("react");
    var UI = require("@logictan/dsh-plugins-shared-client");

    /**
     * Loader entry id this card's form is keyed by.
     *
     * `configForms.get(entryId)` addresses the entry the Host serves, and
     * `dsh-settings` keys that entry by profile entry id — which the repo
     * convention pins to the host half's `export const name`. It is the same
     * string the mirror rows carry as `ns`, which is how the secret sidecar
     * below is found.
     */
    var NS = "browser-agent";
    /** The patch row this card configures (cordis.patch.yml). */
    var ROW_ID = "browser-agent";
    /**
     * Bundle package names whose row `ROW_ID` this card configures.
     *
     * The page keys a row's configuration by the package that declares the row.
     * This plugin reaches a profile in one of two shapes — as a dependency of
     * this repository's aggregate bundle, or installed on its own — and the key
     * differs between them. Both are registered; the key whose bundle is not
     * installed never renders, because the page dispatches only the keys its
     * own bundles declare.
     */
    var BUNDLE_NAMES = ["@logictan/dsh-plugins-all", "@logictan/dsh-browser-agent"];

    /**
     * Credential reference holding the TypeSafe API key.
     *
     * Must equal `API_KEY_REF` in the host half (`src/index.js`). The key is a
     * credential rather than a config field so it never lands in
     * `cordis.patch.yml` — which `dsh-config-manager` exports verbatim — while
     * still travelling with config sync through the `credentialsStatus` section.
     */
    var API_KEY_REF = "BROWSER_AGENT_TYPESAFE_KEY";

    var copy = {
      summary: "浏览器 Agent 的参数",
      heading: "浏览器 Agent",
      intro:
        "插件直连本机 Chrome 的调试端口：TypeSafe 决定动作，DSH 自己的模型填写输入框的值。留空表示继承默认值。",
      inherit: "继承默认",
      unwritable: "当前连接不写回本机设置，无法保存。",
      secretSet: "已设置（不回读）",
      keyLabel: "TypeSafe Key",
      keyHint:
        "来自 https://console.typesafe.ai/keys。存于 $DSH_HOME/.credentials.yaml 的 " +
        API_KEY_REF +
        "，不写入插件配置行，因此不会以明文出现在 cordis.patch.yml；随配置同步走 credentials 分区。",
      keySet: "已配置（值不回读）。",
      keyUnset: "未配置。设置后 browser_agent 工具才可用。",
      keySave: "保存密钥",
      keyClear: "清除密钥",
      keyPlaceholder: "粘贴新的 key",
      keyReading: "读取中…",
      keySaved: "已保存。",
      keyCleared: "已清除。",
      catalogLoading: "正在读取模型目录…",
      catalogError: "模型目录读取失败，可切换为手填。",
      catalogPartial: "部分 provider 读取失败，列表可能不完整。",
      catalogEmpty: "目录里没有模型，可切换为手填。",
      effortNone: "该模型没有 reasoning effort",
      manual: "手填",
      picker: "从目录选择",
      routeMissing: "已存的路由不在当前目录中（provider 读取失败或模型已下线），已切换为手填。",
    };

    /**
     * Load the live model directory once, and reload when the Host announces a
     * change to the adapters or the settings document.
     *
     * The directory is the ONLY source for the route: provider ids, model ids
     * and each model's reasoning efforts all come from the same envelope, so a
     * second source would drift. A failed load must not disable the card — the
     * route can always be typed by hand — so a failure only changes the status
     * line and the manual fallback.
     */
    function useModelCatalog(ctx) {
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
            return ctx.remote.session.modelCatalog();
          })
          .then(
            function (response) {
              if (mine !== generation.current) return;
              if (response && response.ok) {
                setValue({
                  status: "ready",
                  groups: response.value.groups || [],
                  failures: (response.value.failures || []).length,
                });
              } else {
                setValue({ status: "error", groups: [], failures: 0 });
              }
            },
            function () {
              if (mine !== generation.current) return;
              setValue({ status: "error", groups: [], failures: 0 });
            },
          );
      }, [ctx]);

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

    /** Every model in the catalog, flattened with its provider. */
    function modelsOf(groups) {
      var models = [];
      groups.forEach(function (group) {
        (group.models || []).forEach(function (model) {
          models.push({ provider: group.id, model: model });
        });
      });
      return models;
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
     * The TypeSafe API-key section.
     *
     * The key is write-only across the wire: `credentials.describe` reports
     * whether a value exists and never returns it, so the input is never
     * pre-filled. That is a property of the credential seam, not a UI choice —
     * and it is why this section needs no `configForms`.
     *
     * @param props - `ctx` is the scoped context carrying `remote.credentials`.
     */
    function TypesafeKeySection(props) {
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
            setMessage(copy.keySaved);
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
            setMessage(copy.keyCleared);
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
      var statusLine =
        status === null
          ? React.createElement(UI.Banner, { kind: "info" }, copy.keyReading)
          : configured
            ? React.createElement(UI.Banner, { kind: "ok" }, copy.keySet)
            : React.createElement(UI.Banner, { kind: "error" }, copy.keyUnset);

      var control = React.createElement(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "8px" } },
        React.createElement(
          "div",
          { style: { flex: 1, minWidth: 0 } },
          React.createElement(UI.TextField, {
            type: "password",
            value: value,
            disabled: pending,
            placeholder: configured ? copy.secretSet : copy.keyPlaceholder,
            autoComplete: "off",
            "aria-label": copy.keyLabel,
            onValueChange: function (next) {
              setValue(next);
            },
            onKeyDown: function (event) {
              if (event.key === "Enter") save();
            },
          }),
        ),
        React.createElement(
          UI.Button,
          {
            variant: "primary",
            disabled: pending || value === "",
            loading: pending,
            onClick: save,
          },
          copy.keySave,
        ),
        React.createElement(
          UI.Button,
          {
            variant: "secondary",
            disabled: pending || !configured,
            onClick: clear,
          },
          copy.keyClear,
        ),
      );

      return React.createElement(
        "div",
        { key: "typesafe-key", style: { display: "flex", flexDirection: "column", gap: "8px" } },
        statusLine,
        React.createElement(
          UI.Field,
          {
            label: copy.keyLabel,
            hint: copy.keyHint,
          },
          control,
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

    /**
     * The row's configuration card.
     *
     * `scope` is the configuration form `apply` obtained for this entry from
     * `configForms.get(NS)`; `describe` is the schema mirror obtained from
     * `configForms.describe()`; `ctx` is the scoped context supplying the live
     * model directory and credential service.
     */
    function BrowserAgentSettingsCard(props) {
      var scope = props.scope;
      var describe = props.describe;
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

      var catalog = useModelCatalog(ctx);

      /** Whether the user chose to type the route instead of picking it. */
      var manualState = React.useState(false);
      var manual = manualState[0];
      var setManual = manualState[1];

      if (props.view === "summary") return copy.summary;

      var writable = snapshot.writable === true;
      var current = snapshot && snapshot.value ? snapshot.value : {};

      var groups = catalog.value.groups || [];
      var models = modelsOf(groups);
      var provider = typeof current.textProvider === "string" ? current.textProvider : "";
      var model = typeof current.textModel === "string" ? current.textModel : "";
      var selected = matchModel(groups, provider, model);

      var providers = [];
      groups.forEach(function (group) {
        if (providers.indexOf(group.id) === -1) providers.push(group.id);
      });
      var modelsForProvider = models.filter(function (entry) {
        return entry.provider === provider;
      });

      var routeLost = (provider !== "" || model !== "") && selected === null;
      var pickable = catalog.value.status === "ready" && providers.length > 0;
      var usePicker = pickable && !manual && !routeLost;

      function renderControl(field) {
        if (!usePicker) {
          return undefined;
        }

        if (field.key === "textProvider") {
          return React.createElement(UI.Select, {
            value: provider,
            disabled: !writable,
            label: "填空 provider",
            placeholder: copy.inherit,
            options: [{ value: "", label: copy.inherit }].concat(
              providers.map(function (id) {
                return { value: id, label: id };
              }),
            ),
            onChange: function (value) {
              var ops = [
                value === "" ? { op: "unset", path: ["textProvider"] } : { op: "set", path: ["textProvider"], value: value },
                { op: "unset", path: ["textModel"] },
                { op: "unset", path: ["textReasoningEffort"] },
              ];
              void scope.mutate(ops, snapshot.revision);
            },
          });
        }

        if (field.key === "textModel") {
          return React.createElement(UI.Select, {
            value: selected === null ? "" : model,
            disabled: !writable || provider === "",
            label: "填空 model",
            placeholder: copy.inherit,
            options: [{ value: "", label: copy.inherit }].concat(
              modelsForProvider.map(function (entry) {
                return { value: entry.model.id, label: entry.model.name || entry.model.id };
              }),
            ),
            onChange: function (value) {
              var ops = [
                value === "" ? { op: "unset", path: ["textModel"] } : { op: "set", path: ["textModel"], value: value },
                { op: "unset", path: ["textReasoningEffort"] },
              ];
              void scope.mutate(ops, snapshot.revision);
            },
          });
        }

        if (field.key === "textReasoningEffort") {
          var reasoning = (selected && selected.reasoning) || null;
          var effortOptions = reasoning ? reasoning.efforts || [] : [];
          if (effortOptions.length > 0) {
            var currentEffort = typeof current.textReasoningEffort === "string" ? current.textReasoningEffort : "";
            var effortValue = currentEffort || reasoning.defaultEffort || "";
            return React.createElement(UI.Select, {
              value: effortValue,
              disabled: !writable,
              label: "填空 reasoning effort",
              placeholder: copy.inherit,
              options: [{ value: "", label: copy.inherit }].concat(
                effortOptions.map(function (effort) {
                  return { value: effort.id, label: effort.name || effort.id };
                }),
              ),
              onChange: function (value) {
                var ops = [
                  value === ""
                    ? { op: "unset", path: ["textReasoningEffort"] }
                    : { op: "set", path: ["textReasoningEffort"], value: value },
                ];
                void scope.mutate(ops, snapshot.revision);
              },
            });
          }
          if (reasoning) {
            return React.createElement("div", { className: "dsp-field-hint" }, copy.effortNone);
          }
          return React.createElement(UI.Select, {
            value: "",
            disabled: true,
            label: "填空 reasoning effort",
            placeholder: copy.inherit,
            options: [{ value: "", label: copy.inherit }],
            onChange: function () {},
          });
        }

        return undefined;
      }

      var children = [];

      children.push(
        React.createElement("hr", {
          key: "key-sep",
          style: { border: "none", borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "4px 0" },
        }),
      );
      children.push(React.createElement(TypesafeKeySection, { key: "typesafe-key", ctx: ctx }));

      if (catalog.value.status === "loading") {
        children.push(React.createElement(UI.Banner, { key: "catalog-status", kind: "info" }, copy.catalogLoading));
      } else if (catalog.value.status === "error") {
        children.push(React.createElement(UI.Banner, { key: "catalog-status", kind: "error" }, copy.catalogError));
      } else if (models.length === 0) {
        children.push(React.createElement(UI.Banner, { key: "catalog-status", kind: "info" }, copy.catalogEmpty));
      } else if (catalog.value.failures > 0) {
        children.push(React.createElement(UI.Banner, { key: "catalog-status", kind: "warn" }, copy.catalogPartial));
      }

      if (catalog.value.status === "ready" && routeLost) {
        children.push(React.createElement(UI.Banner, { key: "route-missing", kind: "warn" }, copy.routeMissing));
      }

      if (pickable) {
        children.push(
          React.createElement(
            "div",
            { key: "route-mode", style: { display: "flex", alignItems: "center", gap: "8px" } },
            React.createElement(
              UI.Button,
              {
                variant: "secondary",
                size: "sm",
                onClick: function () {
                  setManual(!manual);
                },
              },
              manual ? copy.picker : copy.manual,
            ),
          ),
        );
      }

      if (!writable && snapshot.status === "ready") {
        children.push(React.createElement(UI.Banner, { key: "unwritable", kind: "warn" }, copy.unwritable));
      }

      return React.createElement(
        UI.ConfigForm,
        {
          namespace: NS,
          form: scope,
          describe: describe,
          title: copy.heading,
          description: copy.intro,
          renderControl: renderControl,
        },
        children,
      );
    }

    /**
     * Client plugin body: bind the configuration form and register the card.
     *
     * `configForms` is injected NESTED rather than declared in this plugin's
     * `inject` list. A plugin that waits on a service the profile does not
     * provide never activates, and the Web UI's boot audit turns that into a
     * hard failure for the WHOLE page ("web boot: N entries did not activate"),
     * not just for this card. Nested, a host without the settings UI loses only
     * this card — which is the same trade `dsh-market` makes.
     *
     * The nested context inherits the services declared here (`slots`,
     * `remote`), so the card is handed the scoped context and can reach both the
     * form and the model directory through it.
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
              BrowserAgentSettingsCard,
            );
          });
        });
      });
    }

    return {
      name: "dsh-browser-agent",
      inject: ["slots", "remote", "remote.session"],
      apply: apply,
    };
  },
});
