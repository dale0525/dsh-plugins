/**
 * dsh-worktree-session — browser half.
 *
 * Registers one compact control at the left of the composer tool row: a
 * worktree picker that shows which checkout the current Session works in and
 * offers to switch to the main checkout, to an existing linked worktree, or to
 * a brand-new one. The choice belongs here because a Session's working
 * directory is fixed when the Session is created — "work in a worktree" means
 * "open a Session whose cwd is that worktree", never "move this one".
 *
 * The host half owns git; this half only reads `GET /api/dsh-worktree/status`
 * and posts to `POST /api/dsh-worktree/create`.
 */

window.__ModuleLoader__.load({
  id: '@logictan/dsh-worktree-session',
  factory: function (require) {
    var React = require('react')
    var Primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace owning this plugin's copy. */
    var NS = 'worktreeSession'

    var zh = {
      'entry.main': '主检出',
      'entry.loading': '读取中',
      'entry.failed': '读取失败',
      'entry.label': '工作目录',
      'menu.title': '选择工作目录',
      'menu.main': '主检出',
      'menu.new': '新建工作树',
      'menu.creating': '正在创建…',
      'menu.failed': '操作失败：{message}',
      'menu.draft': '输入框有内容，切换工作目录会清空它。再点一次确认。',
      'menu.unavailable': '无法读取工作目录状态，点击重试',
      'badge.title': '工作树 {name}',
    }

    var en = {
      'entry.main': 'Main checkout',
      'entry.loading': 'Loading',
      'entry.failed': 'Unavailable',
      'entry.label': 'Working directory',
      'menu.title': 'Choose working directory',
      'menu.main': 'Main checkout',
      'menu.new': 'New worktree',
      'menu.creating': 'Creating…',
      'menu.failed': 'Failed: {message}',
      'menu.draft': 'The composer has text; switching clears it. Click again to confirm.',
      'menu.unavailable': 'Could not read the working directory status; click to retry',
      'badge.title': 'Worktree {name}',
    }

    /** API paths, mirroring the host half's `API`. */
    var API = {
      status: '/api/dsh-worktree/status',
      create: '/api/dsh-worktree/create',
    }

    /** GET the worktree status for one directory. */
    function fetchStatus(cwd) {
      return fetch(API.status + '?cwd=' + encodeURIComponent(cwd), {
        headers: { accept: 'application/json' },
      }).then(function (response) {
        if (!response.ok) throw new Error('status ' + response.status)
        return response.json()
      })
    }

    /**
     * Marker for a status read that failed, as distinct from one still running.
     *
     * `null` means "not answered yet", so a failed read has to be its own value:
     * collapsing the two into `null` left the control reading "loading" forever
     * with no hint that anything was wrong.
     */
    var FAILED = { failed: true }

    /**
     * One status read per directory, shared by every Session in it.
     *
     * The sidebar badge renders once per Session row, and rows in one checkout
     * all ask the same question — without this, a workspace with ten Sessions
     * would issue ten identical requests per render pass.
     *
     * A failed read is not cached as a success: the promise stays rejected, so
     * each caller decides how to show it and an explicit reload can retry.
     */
    var statusCache = new Map()

    function loadStatus(cwd) {
      var pending = statusCache.get(cwd)
      if (pending === undefined) {
        pending = fetchStatus(cwd)
        statusCache.set(cwd, pending)
      }
      return pending
    }

    /** Resolve one directory's worktree status into component state. */
    function useStatus(cwd) {
      var state = React.useState(null)
      var status = state[0]
      var setStatus = state[1]

      React.useEffect(
        function () {
          if (!cwd) {
            setStatus(null)
            return undefined
          }
          var cancelled = false
          loadStatus(cwd).then(
            function (value) {
              if (!cancelled) setStatus(value)
            },
            function () {
              if (!cancelled) setStatus(FAILED)
            },
          )
          return function () {
            cancelled = true
          }
        },
        [cwd],
      )
      return status
    }

    /** POST a worktree creation for one directory. */
    function postCreate(cwd) {
      return fetch(API.create, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: cwd }),
      }).then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw new Error(body && body.error ? body.error : 'status ' + response.status)
          return body
        })
      })
    }

    /**
     * One worktree picker.
     *
     * Switching reuses `uiWorkspace.connectWorkspace`, the same reuse-or-create
     * path the Workspace picker uses: it lands on an existing blank Session for
     * the target Workspace when one exists, so opening the same worktree twice
     * does not pile up empty Sessions.
     *
     * `t` is framework-injected (the registration declares `locale`).
     */
    function WorktreeEntry(props) {
      var t = props.t
      var sessionId = props.sessionId
      var workspaces = props.workspaces
      var uiWorkspace = props.uiWorkspace

      // A blank Session has no `cwd` of its own yet, so its owning Workspace's
      // path stands in — that is the directory a new worktree is created from,
      // and the wrong answer would put it in the wrong repository.
      var sessionCwd = props.useSessions(function (state) {
        if (!sessionId || !state || !state.byId) return undefined
        var row = state.byId[sessionId]
        return row ? row.cwd : undefined
      })
      var workspacePath = props.useWorkspaces(function (state) {
        if (!state || !Array.isArray(state.items)) return undefined
        var direct = state.items.find(function (item) {
          return Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId)
        })
        return direct ? direct.path : undefined
      })
      var cwd = sessionCwd || workspacePath || undefined

      var input = props.useInput(function (state) {
        return state
      })
      var inputActions = props.inputActions

      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var statusState = React.useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var noticeState = React.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var confirmState = React.useState(false)
      var confirmSwitch = confirmState[0]
      var setConfirmSwitch = confirmState[1]
      var retryState = React.useState(0)
      var retry = retryState[0]
      var setRetry = retryState[1]

      // Reload on directory change and on open (a worktree may have been
      // created outside DSH meanwhile).
      React.useEffect(
        function () {
          if (!cwd) {
            setStatus(null)
            return undefined
          }
          var cancelled = false
          // Opening re-reads: a worktree may have been created outside DSH.
          if (open) statusCache.delete(cwd)
          loadStatus(cwd).then(
            function (value) {
              if (!cancelled) setStatus(value)
            },
            function () {
              if (!cancelled) setStatus(FAILED)
            },
          )
          return function () {
            cancelled = true
          }
        },
        [cwd, open, retry],
      )

      var failed = status === FAILED
      var worktrees = (status && !failed && status.isRepo && status.worktrees) || []
      var main = worktrees[0]
      var others = worktrees.slice(1).filter(function (entry) {
        return !entry.prunable
      })
      var current = worktrees.find(function (entry) {
        return entry.path === cwd
      })
      var isWorktree = current !== undefined && !current.isMain

      var draft = (input && input.draft) || ''
      var attachmentCount = (input && input.attachmentIds && input.attachmentIds.length) || 0
      var hasDraft = draft.trim() !== '' || attachmentCount > 0

      /** Open (or reuse) a Session whose cwd is `path`. */
      var switchTo = function (path) {
        setOpen(false)
        setNotice(null)
        // A Session's cwd is immutable, so this always lands on a new Session;
        // the draft cannot follow it, so it is cleared deliberately.
        if (hasDraft && inputActions) inputActions.setDraft('')
        return workspaces
          .create({ path: path })
          .then(function (workspace) {
            return uiWorkspace.connectWorkspace(workspace.workspaceId)
          })
          .catch(function (error) {
            setNotice(t('menu.failed', { message: String(error && error.message ? error.message : error) }))
          })
      }

      var createAndSwitch = function () {
        setBusy(true)
        setNotice(null)
        postCreate(cwd)
          .then(function (created) {
            return switchTo(created.path)
          })
          .catch(function (error) {
            setNotice(t('menu.failed', { message: String(error && error.message ? error.message : error) }))
          })
          .finally(function () {
            setBusy(false)
          })
      }

      var handleSelect = function (id) {
        // Both paths mint a Session with a new cwd, so both discard the draft.
        // Asking once, here, keeps "create" from silently eating typed text
        // while "switch" asks.
        if (hasDraft && !confirmSwitch) {
          setConfirmSwitch(true)
          setNotice(t('menu.draft'))
          return
        }
        setConfirmSwitch(false)
        if (id === '__new__') {
          createAndSwitch()
          return
        }
        switchTo(id)
      }

      // The notice rides at the top as a non-selectable heading row.
      var items = notice ? [{ type: 'label', id: '__notice__', text: notice }] : []
      if (main) {
        items.push({ id: main.path, label: t('menu.main') })
      }
      for (var i = 0; i < others.length; i += 1) {
        items.push({ id: others[i].path, label: others[i].name })
      }

      var footer = !failed && status && status.isRepo
        ? [
            {
              id: '__new__',
              label: busy ? t('menu.creating') : t('menu.new'),
              icon: React.createElement(Primitives.IconPlusOutlineRegular, null),
              disabled: busy,
            },
          ]
        : []

      var triggerLabel = failed
        ? t('entry.failed')
        : !status
          ? t('entry.loading')
          : !status.isRepo
            ? t('entry.label')
            : isWorktree
              ? current.name
              : t('entry.main')

      return React.createElement(Primitives.Menu, {
        open: open,
        // The built-in check marks whichever row is the current checkout.
        selectedId: cwd,
        anchor: React.createElement(
          Primitives.Button,
          {
            variant: 'ghost',
            size: 'sm',
            icon: React.createElement(Primitives.IconBranchOutlineRegular, null),
            // A failed read keeps the control live: clicking it retries.
            disabled: !cwd || busy || (!failed && (!status || !status.isRepo)),
            title: failed ? t('menu.unavailable') : t('menu.title'),
            'aria-label': failed ? t('menu.unavailable') : t('menu.title'),
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            onClick: function () {
              setConfirmSwitch(false)
              setNotice(null)
              if (failed) {
                // Drop the failed read so the effect issues a fresh request.
                statusCache.delete(cwd)
                setStatus(null)
                setRetry(retry + 1)
                return
              }
              setOpen(!open)
            },
          },
          triggerLabel,
        ),
        items: items,
        footer: footer,
        onSelect: handleSelect,
        onClose: function () {
          setOpen(false)
        },
      })
    }

    /**
     * The sidebar badge marking a Session that works in a linked worktree.
     *
     * A Session's `cwd` is the only durable evidence of which checkout it uses,
     * so the badge asks the host about that directory and stays silent for the
     * main checkout — a marker on every row would say nothing. A failed read
     * (`FAILED`) carries no `isRepo` either, so it falls into the same silence:
     * the badge never guesses that a Session is in a worktree.
     */
    function WorktreeBadge(props) {
      var t = props.t
      var sessionId = props.sessionId

      var cwd = props.useSessions(function (state) {
        if (!sessionId || !state || !state.byId) return undefined
        var row = state.byId[sessionId]
        return row ? row.cwd : undefined
      })
      var status = useStatus(cwd)

      if (!cwd || !status || !status.isRepo) return null
      var entry = (status.worktrees || []).find(function (item) {
        return item.path === cwd
      })
      if (entry === undefined || entry.isMain) return null

      return React.createElement(
        'span',
        {
          'aria-label': t('badge.title', { name: entry.name }),
          title: t('badge.title', { name: entry.name }),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            marginRight: '4px',
            color: 'var(--dsw-alias-text-secondary, currentColor)',
            flexShrink: 0,
          },
        },
        React.createElement(Primitives.IconBranchOutlineRegular, null),
      )
    }

    /**
     * Register the picker at the left of the composer tool row, and the badge
     * beside each worktree Session's name.
     *
     * The workspace services are required through a nested `inject` rather than
     * the plugin's own `inject` list: a plugin whose `inject` cannot be
     * satisfied never activates, and on the client a single such entry fails
     * the whole boot audit. This way a build without the workspace UI simply
     * has no picker.
     */
    function apply(ctx) {
      ctx.effect(
        function () {
          return ctx.locale.register(NS, { zh: zh, en: en })
        },
        'worktree-session: dictionaries',
      )
      ctx.inject(['workspaces', 'uiWorkspace'], function (scoped) {
        scoped.slots.inject('conversation.input.left', function () {
          return scoped.slots.register(
            {
              name: 'conversation.input.left',
              id: 'worktree-entry',
              order: 10,
              locale: NS,
              inject: function () {
                return { workspaces: scoped.workspaces, uiWorkspace: scoped.uiWorkspace }
              },
            },
            WorktreeEntry,
          )
        })
        scoped.slots.inject('sidebar.session.row.leading', function () {
          return scoped.slots.register(
            {
              name: 'sidebar.session.row.leading',
              id: 'worktree-badge',
              order: 10,
              locale: NS,
            },
            WorktreeBadge,
          )
        })
      })
    }

    return {
      name: '@logictan/dsh-worktree-session',
      inject: ['slots', 'locale'],
      apply: apply,
    }
  },
})
