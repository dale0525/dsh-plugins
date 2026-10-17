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
 * The card renders the host's `Config` schema through the shared `ConfigForm`.
 * Scalar fields are rendered automatically from the describe mirror; this half
 * supplies only the vision-catalog dropdowns (replacing the route fields via
 * `renderControl`) and the catalog status banners in `children`.
 *
 * Two catalogs feed this card, and they are not interchangeable:
 *
 *  - The VISION list comes from this plugin's own same-origin route
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
    var UI = require("@logictan/dsh-plugins-shared-client");

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
    };

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
     * `configForms.get(NS)`; `describe` is the schema mirror obtained from
     * `configForms.describe()`; `ctx` is the scoped context supplying the live
     * model directory.
     */
    function DesktopAgentSettingsCard(props) {
      if (props.view === "summary") return copy.summary;

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

      var catalog = useVisionCatalog(ctx);
      var host = useHostCatalog(ctx);

      /** Whether the user chose to type the route instead of picking it. */
      var manualState = React.useState(false);
      var manual = manualState[0];
      var setManual = manualState[1];

      var writable = snapshot.writable === true;
      var current = snapshot && snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};

      var groups = catalog.value.groups || [];
      var provider = typeof current.visionProvider === "string" ? current.visionProvider : "";
      var model = typeof current.visionModel === "string" ? current.visionModel : "";
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

      var routeLost = (provider !== "" || model !== "") && selected === null;
      var pickable = catalog.value.status === "ready" && providers.length > 0;
      var usePicker = pickable && !manual && !routeLost;

      function renderControl(field) {
        if (!usePicker) {
          return undefined;
        }

        if (field.key === "visionProvider") {
          return React.createElement(UI.Select, {
            value: provider,
            disabled: !writable,
            label: "视觉 provider",
            placeholder: copy.inherit,
            options: [{ value: "", label: copy.inherit }].concat(
              providers.map(function (id) {
                return { value: id, label: id };
              }),
            ),
            onChange: function (value) {
              var ops = [
                value === "" ? { op: "unset", path: ["visionProvider"] } : { op: "set", path: ["visionProvider"], value: value },
                { op: "unset", path: ["visionModel"] },
                { op: "unset", path: ["visionReasoningEffort"] },
              ];
              void scope.mutate(ops, snapshot.revision);
            },
          });
        }

        if (field.key === "visionModel") {
          return React.createElement(UI.Select, {
            value: selected === null ? "" : model,
            disabled: !writable || provider === "",
            label: "视觉 model",
            placeholder: copy.inherit,
            options: [{ value: "", label: copy.inherit }].concat(
              modelsForProvider.map(function (entry) {
                return { value: entry.id, label: entry.name || entry.id };
              }),
            ),
            onChange: function (value) {
              var ops = [
                value === "" ? { op: "unset", path: ["visionModel"] } : { op: "set", path: ["visionModel"], value: value },
                { op: "unset", path: ["visionReasoningEffort"] },
              ];
              void scope.mutate(ops, snapshot.revision);
            },
          });
        }

        if (field.key === "visionReasoningEffort") {
          var hostEntry = matchModel(host.groups, provider, model);
          var reasoning = (hostEntry && hostEntry.reasoning) || null;
          var effortOptions = reasoning ? reasoning.efforts || [] : [];
          if (effortOptions.length > 0) {
            var currentEffort = typeof current.visionReasoningEffort === "string" ? current.visionReasoningEffort : "";
            var effortValue = currentEffort || reasoning.defaultEffort || "";
            return React.createElement(UI.Select, {
              value: effortValue,
              disabled: !writable,
              label: "视觉 reasoning effort",
              placeholder: copy.inherit,
              options: [{ value: "", label: copy.inherit }].concat(
                effortOptions.map(function (effort) {
                  return { value: effort.id, label: effort.name || effort.id };
                }),
              ),
              onChange: function (value) {
                var ops = [
                  value === ""
                    ? { op: "unset", path: ["visionReasoningEffort"] }
                    : { op: "set", path: ["visionReasoningEffort"], value: value },
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
            label: "视觉 reasoning effort",
            placeholder: copy.inherit,
            options: [{ value: "", label: copy.inherit }],
            onChange: function () {},
          });
        }

        return undefined;
      }

      var children = [];

      if (catalog.value.status === "loading") {
        children.push(React.createElement(UI.Banner, { key: "catalog-status", kind: "info" }, copy.catalogLoading));
      } else if (catalog.value.status === "error") {
        children.push(React.createElement(UI.Banner, { key: "catalog-status", kind: "error" }, copy.catalogError));
      } else if (providers.length === 0) {
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

      children.push(
        React.createElement("div", { key: "route-fallback", className: "dsp-field-hint" }, copy.catalogFallback),
      );

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
     * provide never activates, and the Web UI's boot audit turns that into a hard
     * failure for the WHOLE page ("web boot: N entries did not activate"), not
     * just for this card. Nested, a host without the settings UI loses only this
     * card.
     *
     * The nested context inherits the services declared here (`slots`,
     * `remote`, `remote.session`), so the card is handed the scoped context and
     * can reach both the form and the model directory through it.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.inject(["configForms"], function (scoped) {
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
