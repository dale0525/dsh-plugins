/**
 * Browser half: the SSH host table and its per-host passwords, on the Plugins page.
 *
 * This file is already in the client module loader's protocol — it is not a
 * module and imports nothing. `build.mjs` copies it to `lib/client.js` verbatim,
 * which is why `package.json` exports `./client` at that path.
 *
 * Two things about the card are deliberate:
 *
 *  - **The host table is edited here, not by the shared form.** `ConfigForm`
 *    renders scalars and string lists; it has no control for an array of
 *    objects, so the `hosts` field is skipped by the schema walk and this card
 *    owns the table. It still writes through the same Host-owned form
 *    (`scope.mutate([{op:'set', path:['hosts'], value}])`), so revision fencing
 *    and persistence stay with the Host, and the whole array is written in one
 *    edit rather than per field.
 *
 *  - **Passwords never travel in that value.** Each host's password is a
 *    credential (`SSH_PASSWORD_<ALIAS>`) written through `remote.credentials`,
 *    which is write-only across the wire: `describe` reports whether a value
 *    exists and never returns it, so the inputs are never pre-filled. Storing
 *    them as config fields would put the plaintext in `cordis.patch.yml`, which
 *    config sync exports verbatim.
 *
 * `configForms` and `remote.credentials` are injected NESTED rather than
 * declared in this plugin's `inject` list: a plugin that waits on a service its
 * host does not provide never activates, which would turn "no settings UI" into
 * "the whole browser half is gone".
 */
window.__ModuleLoader__.load({
  id: "@logictan/dsh-ssh",
  factory: function (require) {
    var React = require("react");
    var UI = require("@logictan/dsh-plugins-shared-client");

    /** Loader entry id this card's form is keyed by; equals the host half's `export const name`. */
    var NS = "dsh-ssh";
    /** The patch row this card configures (cordis.patch.yml). */
    var ROW_ID = "dsh-ssh";
    /**
     * Bundle package names whose row `ROW_ID` this card configures.
     *
     * The page keys a row's configuration by the package that declares the row,
     * and this plugin reaches a profile in one of two shapes — as a dependency
     * of this repository's aggregate bundle, or installed on its own. Both keys
     * are registered; the one whose bundle is not installed never renders.
     */
    var BUNDLE_NAMES = ["@logictan/dsh-plugins-all", "@logictan/dsh-ssh"];

    /**
     * Credential reference holding one host's password.
     *
     * Must equal `passwordRef` in the host half (`src/config.js`). Duplicated
     * rather than imported because this file is a loader factory with no module
     * graph; the duplication is one fold, and the authoritative table (including
     * the collision check on that fold) still lives on the host.
     */
    function passwordRef(alias) {
      return "SSH_PASSWORD_" + String(alias).toUpperCase().replace(/[^A-Z0-9]/g, "_");
    }

    var copy = {
      heading: "SSH 主机",
      intro:
        "每台主机一个 alias：Agent 就用这个名字指代主机（ssh_exec / ssh_upload / ssh_download）。密码存在凭据库里，不写入插件配置行。",
      add: "添加主机",
      remove: "删除",
      save: "保存主机表",
      discard: "放弃修改",
      saving: "保存中…",
      saved: "已保存。",
      failed: "保存失败：",
      dirty: "有未保存的修改。",
      unwritable: "当前连接不写回本机设置，无法保存。",
      empty: "还没有主机。点「添加主机」开始。",
      alias: "alias",
      host: "host",
      port: "端口",
      username: "用户名",
      passwordHeading: "密码",
      passwordIntro:
        "每台主机一份密码，存于 $DSH_HOME/.credentials.yaml 的 SSH_PASSWORD_<ALIAS>，值不回读。",
      passwordPlaceholder: "输入密码",
      passwordSet: "已设置（不回读）",
      passwordUnset: "未设置",
      passwordSave: "保存密码",
      passwordClear: "清除密码",
      passwordSaved: "密码已保存。",
      passwordCleared: "密码已清除。",
      passwordReadFailed: "读取密码状态失败：",
      saveTableFirst: "这些主机的 alias 还没保存，先保存主机表再设置密码。",
      duplicateAlias: "alias 重复：",
      badAlias: "alias 只能用字母、数字、. - _，且以字母或数字开头：",
      missingField: "host 和用户名不能为空：",
      badPort: "端口必须是 1-65535 的整数：",
    };

    /**
     * Project the stored value into editable rows.
     *
     * @param value - the `hosts` array from the settings form.
     * @returns one row per host, with the defaults the host half applies.
     */
    function rowsOf(value) {
      if (!Array.isArray(value)) return [];
      return value.map(function (entry) {
        var row = entry && typeof entry === "object" ? entry : {};
        return {
          alias: typeof row.alias === "string" ? row.alias : "",
          host: typeof row.host === "string" ? row.host : "",
          port: row.port === undefined || row.port === null || row.port === "" ? 22 : Number(row.port),
          username: typeof row.username === "string" ? row.username : "",
        };
      });
    }

    /** Structural equality over the row shape (the dirty predicate). */
    function sameRows(a, b) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i += 1) {
        if (
          a[i].alias !== b[i].alias ||
          a[i].host !== b[i].host ||
          Number(a[i].port) !== Number(b[i].port) ||
          a[i].username !== b[i].username
        ) {
          return false;
        }
      }
      return true;
    }

    /**
     * Validate the staged table, returning the first problem per row.
     *
     * The host half re-validates and reports the same rules, so this is not a
     * second source of truth — it is the same rule applied while the user can
     * still see what they typed.
     *
     * @param rows - the staged rows.
     * @returns a list of problems; empty means saveable.
     */
    function problemsOf(rows) {
      var problems = [];
      var seen = {};
      rows.forEach(function (row, index) {
        var at = "第 " + (index + 1) + " 行";
        var alias = String(row.alias).trim();
        if (alias === "" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) {
          problems.push(copy.badAlias + at);
        } else if (seen[alias.toLowerCase()] === true) {
          problems.push(copy.duplicateAlias + alias);
        } else {
          seen[alias.toLowerCase()] = true;
        }
        if (String(row.host).trim() === "" || String(row.username).trim() === "") {
          problems.push(copy.missingField + at);
        }
        var port = Number(row.port);
        if (!(port >= 1 && port <= 65535) || Math.floor(port) !== port) problems.push(copy.badPort + at);
      });
      return problems;
    }

    /**
     * The configuration card on the plugin's Plugins-page row.
     *
     * @param props - `{scope, describe, ctx}` from the slot.
     * @returns the card element.
     */
    function SshSettingsCard(props) {
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

      /** Staged rows; `null` means "nothing staged, show what the Host stored". */
      var draftState = React.useState(null);
      var draft = draftState[0];
      var setDraft = draftState[1];
      var messageState = React.useState("");
      var message = messageState[0];
      var setMessage = messageState[1];
      var savingState = React.useState(false);
      var saving = savingState[0];
      var setSaving = savingState[1];

      /** Password presence per alias, plus the typed value per alias. */
      var statusState = React.useState({});
      var statuses = statusState[0];
      var setStatuses = statusState[1];
      var typedState = React.useState({});
      var typed = typedState[0];
      var setTyped = typedState[1];
      var busyState = React.useState({});
      var busy = busyState[0];
      var setBusy = busyState[1];

      var stored = rowsOf(snapshot.value && snapshot.value.hosts);
      var rows = draft === null ? stored : draft;
      var dirty = draft !== null && !sameRows(draft, stored);
      var writable = snapshot.writable === true;
      var problems = problemsOf(rows);
      var savedAliases = stored
        .map(function (row) {
          return String(row.alias).trim();
        })
        .filter(function (alias) {
          return alias !== "";
        });

      /**
       * Read every host's password presence.
       *
       * `describe` is the only read half of the credential seam and it never
       * returns a value, so this is presence, not content.
       */
      var readStatuses = React.useCallback(
        function (aliases) {
          if (!ctx || !ctx.remote || !ctx.remote.credentials) return;
          var refs = aliases.map(passwordRef);
          if (refs.length === 0) {
            setStatuses({});
            return;
          }
          ctx.remote.credentials
            .describe(refs)
            .then(function (response) {
              if (!response || response.ok === false) {
                setMessage(copy.passwordReadFailed + ((response && response.error && response.error.message) || "未知错误"));
                return;
              }
              var next = {};
              aliases.forEach(function (alias) {
                var info = response.value[passwordRef(alias)];
                next[alias] = { configured: Boolean(info && info.configured) };
              });
              setStatuses(next);
            })
            .catch(function (error) {
              setMessage(copy.passwordReadFailed + ((error && error.message) || error));
            });
        },
        [ctx],
      );

      var aliasKey = savedAliases.join("\u0000");
      React.useEffect(
        function () {
          readStatuses(aliasKey === "" ? [] : aliasKey.split("\u0000"));
        },
        [aliasKey, readStatuses],
      );

      // Keep presence in step with the credential store: the seam emits this
      // after a write commits and after every file reload, so a password set
      // from another tab (or by config sync) shows up without a reload.
      React.useEffect(
        function () {
          if (!ctx || !ctx.remote || typeof ctx.remote.$on !== "function") return undefined;
          var off = ctx.remote.$on("credentials/reference-updated", function () {
            readStatuses(aliasKey === "" ? [] : aliasKey.split("\u0000"));
          });
          return function () {
            if (typeof off === "function") off();
          };
        },
        [aliasKey, readStatuses, ctx],
      );

      function editRow(index, patch) {
        var next = rows.map(function (row) {
          return { alias: row.alias, host: row.host, port: row.port, username: row.username };
        });
        next[index] = Object.assign({}, next[index], patch);
        setDraft(next);
        setMessage("");
      }

      function addRow() {
        var next = rows.map(function (row) {
          return { alias: row.alias, host: row.host, port: row.port, username: row.username };
        });
        next.push({ alias: "", host: "", port: 22, username: "" });
        setDraft(next);
        setMessage("");
      }

      function removeRow(index) {
        var next = rows
          .filter(function (_row, at) {
            return at !== index;
          })
          .map(function (row) {
            return { alias: row.alias, host: row.host, port: row.port, username: row.username };
          });
        setDraft(next);
        setMessage("");
      }

      function save() {
        if (problems.length > 0) return;
        setSaving(true);
        setMessage("");
        var value = rows.map(function (row) {
          return {
            alias: String(row.alias).trim(),
            host: String(row.host).trim(),
            port: Number(row.port),
            username: String(row.username).trim(),
          };
        });
        scope
          .mutate([{ op: "set", path: ["hosts"], value: value }], snapshot.revision)
          .then(function (accepted) {
            if (!accepted) {
              setMessage(copy.failed + "宿主拒绝了这次写入。");
              return;
            }
            setDraft(null);
            setMessage(copy.saved);
          })
          .catch(function (error) {
            setMessage(copy.failed + ((error && error.message) || error));
          })
          .then(function () {
            setSaving(false);
          });
      }

      function savePassword(alias) {
        var value = typed[alias] || "";
        if (value === "") return;
        setBusy(Object.assign({}, busy, Object.fromEntries([[alias, true]])));
        setMessage("");
        ctx.remote.credentials
          .set(passwordRef(alias), value)
          .then(function (response) {
            if (response && response.ok === false) {
              setMessage(copy.failed + ((response.error && response.error.message) || "未知错误"));
              return;
            }
            var nextTyped = Object.assign({}, typed);
            delete nextTyped[alias];
            setTyped(nextTyped);
            setMessage(copy.passwordSaved);
            readStatuses(savedAliases);
          })
          .catch(function (error) {
            setMessage(copy.failed + ((error && error.message) || error));
          })
          .then(function () {
            var nextBusy = Object.assign({}, busy);
            delete nextBusy[alias];
            setBusy(nextBusy);
          });
      }

      function clearPassword(alias) {
        setBusy(Object.assign({}, busy, Object.fromEntries([[alias, true]])));
        setMessage("");
        ctx.remote.credentials
          .unset(passwordRef(alias))
          .then(function (response) {
            if (response && response.ok === false) {
              setMessage(copy.failed + ((response.error && response.error.message) || "未知错误"));
              return;
            }
            setMessage(copy.passwordCleared);
            readStatuses(savedAliases);
          })
          .catch(function (error) {
            setMessage(copy.failed + ((error && error.message) || error));
          })
          .then(function () {
            var nextBusy = Object.assign({}, busy);
            delete nextBusy[alias];
            setBusy(nextBusy);
          });
      }

      var tableChildren = [
        rows.length === 0
          ? React.createElement(UI.Banner, { key: "empty", kind: "info" }, copy.empty)
          : React.createElement(
              "div",
              { key: "rows", style: { display: "flex", flexDirection: "column", gap: "12px" } },
              rows.map(function (row, index) {
                return React.createElement(
                  "div",
                  {
                    key: index,
                    style: {
                      display: "grid",
                      gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) 80px minmax(0,1fr) auto",
                      gap: "8px",
                      alignItems: "end",
                    },
                  },
                  React.createElement(
                    UI.Field,
                    { label: index === 0 ? copy.alias : undefined },
                    React.createElement(UI.TextField, {
                      value: String(row.alias),
                      placeholder: "nas",
                      disabled: !writable || saving,
                      onValueChange: function (next) {
                        editRow(index, { alias: next });
                      },
                    }),
                  ),
                  React.createElement(
                    UI.Field,
                    { label: index === 0 ? copy.host : undefined },
                    React.createElement(UI.TextField, {
                      value: String(row.host),
                      placeholder: "192.168.1.10",
                      disabled: !writable || saving,
                      onValueChange: function (next) {
                        editRow(index, { host: next });
                      },
                    }),
                  ),
                  React.createElement(
                    UI.Field,
                    { label: index === 0 ? copy.port : undefined },
                    React.createElement(UI.TextField, {
                      value: String(row.port),
                      inputMode: "numeric",
                      disabled: !writable || saving,
                      // Kept as typed, not coerced: `Number("")` is 0 and
                      // `Number("22a")` is NaN, and either would rewrite the box
                      // mid-keystroke. Validation and the saved value coerce.
                      onValueChange: function (next) {
                        editRow(index, { port: next });
                      },
                    }),
                  ),
                  React.createElement(
                    UI.Field,
                    { label: index === 0 ? copy.username : undefined },
                    React.createElement(UI.TextField, {
                      value: String(row.username),
                      placeholder: "root",
                      disabled: !writable || saving,
                      onValueChange: function (next) {
                        editRow(index, { username: next });
                      },
                    }),
                  ),
                  React.createElement(
                    UI.Button,
                    {
                      variant: "icon",
                      disabled: !writable || saving,
                      "aria-label": copy.remove,
                      title: copy.remove,
                      onClick: function () {
                        removeRow(index);
                      },
                    },
                    "×",
                  ),
                );
              }),
            ),
        React.createElement(
          "div",
          { key: "actions", style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "12px" } },
          React.createElement(
            UI.Button,
            { variant: "secondary", disabled: !writable || saving, onClick: addRow },
            copy.add,
          ),
          React.createElement(
            UI.Button,
            { variant: "primary", disabled: !writable || saving || !dirty || problems.length > 0, onClick: save },
            saving ? copy.saving : copy.save,
          ),
          dirty
            ? React.createElement(
                UI.Button,
                {
                  variant: "ghost",
                  disabled: saving,
                  onClick: function () {
                    setDraft(null);
                    setMessage("");
                  },
                },
                copy.discard,
              )
            : null,
        ),
        problems.length > 0
          ? React.createElement(UI.Banner, { key: "problems", kind: "error" }, problems.join("；"))
          : dirty
            ? React.createElement(UI.Banner, { key: "dirty", kind: "warn" }, copy.dirty)
            : null,
        !writable && snapshot.status === "ready"
          ? React.createElement(UI.Banner, { key: "unwritable", kind: "warn" }, copy.unwritable)
          : null,
      ];

      var passwordChildren =
        savedAliases.length === 0
          ? null
          : React.createElement(
              UI.SettingsCard,
              { title: copy.passwordHeading, description: copy.passwordIntro },
              dirty ? React.createElement(UI.Banner, { kind: "warn" }, copy.saveTableFirst) : null,
              React.createElement(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: "12px" } },
                savedAliases.map(function (alias) {
                  var status = statuses[alias];
                  var configured = Boolean(status && status.configured);
                  var pending = busy[alias] === true;
                  return React.createElement(
                    UI.Field,
                    {
                      key: alias,
                      label: alias,
                      description: configured ? copy.passwordSet : copy.passwordUnset,
                    },
                    React.createElement(
                      "div",
                      { style: { display: "flex", alignItems: "center", gap: "8px" } },
                      React.createElement(
                        "div",
                        { style: { flex: 1, minWidth: 0 } },
                        React.createElement(UI.SecretField, {
                          value: typed[alias] || "",
                          configured: configured,
                          disabled: pending,
                          placeholder: copy.passwordPlaceholder,
                          autoComplete: "off",
                          "aria-label": alias + " " + copy.passwordPlaceholder,
                          onValueChange: function (next) {
                            var copyTyped = Object.assign({}, typed);
                            copyTyped[alias] = next;
                            setTyped(copyTyped);
                          },
                          onKeyDown: function (event) {
                            if (event.key === "Enter") savePassword(alias);
                          },
                        }),
                      ),
                      React.createElement(
                        UI.Button,
                        {
                          variant: "primary",
                          disabled: pending || (typed[alias] || "") === "",
                          onClick: function () {
                            savePassword(alias);
                          },
                        },
                        copy.passwordSave,
                      ),
                      React.createElement(
                        UI.Button,
                        {
                          variant: "secondary",
                          disabled: pending || !configured,
                          onClick: function () {
                            clearPassword(alias);
                          },
                        },
                        copy.passwordClear,
                      ),
                    ),
                  );
                }),
              ),
            );

      if (props.view === "summary") return copy.intro;

      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "16px" } },
        React.createElement(
          UI.ConfigForm,
          {
            namespace: NS,
            form: scope,
            describe: describe,
            title: copy.heading,
            description: copy.intro,
          },
          tableChildren,
          message ? React.createElement(UI.Banner, { kind: message.indexOf(copy.failed) === 0 ? "error" : "info" }, message) : null,
        ),
        passwordChildren,
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
              SshSettingsCard,
            );
          });
        });
      });
    }

    return {
      name: "dsh-ssh",
      inject: ["slots", "remote"],
      apply: apply,
    };
  },
});
