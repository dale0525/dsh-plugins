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
     * Switching goes through `uiWorkspace.openWorkspace`, which connects the
     * target Workspace and then navigates into it. Connecting reuses an
     * existing blank Session for that Workspace when one exists, so opening
     * the same worktree twice does not pile up empty Sessions.
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

      /** Open a Session whose cwd is `path`, and put the user in it. */
      var switchTo = function (path) {
        setOpen(false)
        setNotice(null)
        // A Session's cwd is immutable, so this always lands on a new Session;
        // the draft cannot follow it, so it is cleared deliberately.
        if (hasDraft && inputActions) inputActions.setDraft('')
        return workspaces
          .create({ path: path })
          .then(function (workspace) {
            // `openWorkspace` navigates; `connectWorkspace` only connects and
            // would leave the user staring at the composer they started in.
            return uiWorkspace.openWorkspace(workspace.workspaceId)
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

    /* ------------------------------------------------- workspace row markers */

    /** Stylesheet id guarding the single injection of the row-marker CSS. */
    var ROW_CSS_ID = 'worktree-session/rows.css'

    /**
     * The branch glyph, carried as a mask so the row's own colour still applies.
     *
     * Same artwork as `IconBranchOutlineRegular` (16x16, 1px `currentColor`
     * strokes). A mask rather than a background image because the workspace row
     * tints its icon when it is the active one, and a baked-in colour would
     * lose that.
     */
    var BRANCH_MASK =
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\' fill=\'none\' stroke=\'%23000\' stroke-width=\'1\'%3E' +
      '%3Cpath d=\'M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564\'/%3E' +
      '%3Cpath d=\'M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944\'/%3E' +
      '%3Ccircle cx=\'12.4502\' cy=\'3.3079\' r=\'1.56962\'/%3E' +
      '%3Ccircle cx=\'12.4502\' cy=\'12.6921\' r=\'1.56962\'/%3E%3C/svg%3E")'

    /**
     * Replace a worktree row's folder glyph with the branch glyph.
     *
     * The sidebar renders a workspace row as plain markup: it has no plugin
     * slot, and a Workspace carries no icon of its own. So a worktree's row can
     * only be told apart by marking the element and restyling it. The marker
     * rides on the row itself, and the rule is scoped to the row's first child
     * — the icon slot — because the sidebar's class names are build-local
     * hashes that this plugin cannot name.
     */
    var ROW_CSS = [
      '[data-dsh-worktree]>span:first-child{background-color:currentColor;',
      '-webkit-mask:' + BRANCH_MASK + ' center/16px 16px no-repeat;',
      'mask:' + BRANCH_MASK + ' center/16px 16px no-repeat}',
      '[data-dsh-worktree]>span:first-child>svg{display:none}',
    ].join('')

    /** Attribute this plugin stamps on a workspace row that is a worktree. */
    var ROW_ATTR = 'data-dsh-worktree'

    /**
     * Mark every sidebar workspace row whose directory is a linked worktree.
     *
     * Rows are addressed by their `data-row-key` (`workspace:<id>`), which is
     * the only stable handle the row exposes. Whether a directory is a worktree
     * is the host's answer, not a guess from the path, so this reuses the same
     * per-directory status read the picker and the badge share.
     * @param workspaces - the client Workspace service, for its snapshot.
     * @returns a disposer, or undefined when there is no DOM to mark.
     */
    function applyWorkspaceRowMarkers(workspaces) {
      if (typeof document === 'undefined') return undefined

      if (document.querySelector('style[data-plugin-css="' + ROW_CSS_ID + '"]') === null) {
        var tag = document.createElement('style')
        tag.dataset.plugin = 'worktree-session'
        tag.dataset.pluginCss = ROW_CSS_ID
        tag.textContent = ROW_CSS
        document.head.appendChild(tag)
      }

      var mark = function () {
        var snapshot = workspaces.list.getSnapshot()
        var items = (snapshot && snapshot.items) || []
        var rows = document.querySelectorAll('[data-row-key^="workspace:"]')
        for (var i = 0; i < rows.length; i += 1) {
          var row = rows[i]
          var key = row.getAttribute('data-row-key') || ''
          var workspaceId = key.slice('workspace:'.length)
          var item = undefined
          for (var j = 0; j < items.length; j += 1) {
            if (items[j].workspaceId === workspaceId) item = items[j]
          }
          if (item === undefined) continue
          markRow(row, item.path)
        }
      }

      /** Stamp or clear one row once the host has answered for its directory. */
      var markRow = function (row, path) {
        loadStatus(path).then(
          function (status) {
            var entry = (status.worktrees || []).find(function (candidate) {
              return candidate.path === path
            })
            var wanted = entry !== undefined && !entry.isMain
            // The observer re-runs this on every DOM change, so an unchanged
            // row must not be rewritten: the write would invalidate style for
            // every row on every keystroke in the composer.
            if (wanted === (row.getAttribute(ROW_ATTR) !== null)) return
            if (wanted) row.setAttribute(ROW_ATTR, 'branch')
            else row.removeAttribute(ROW_ATTR)
          },
          function () {
            // An unreadable directory is not evidence of a worktree.
            if (row.getAttribute(ROW_ATTR) !== null) row.removeAttribute(ROW_ATTR)
          },
        )
      }

      mark()
      // Expanding a workspace, renaming it, or a fresh snapshot all rebuild the
      // rows, so the pass re-runs whenever the list's DOM changes. Attribute
      // writes are deliberately not observed, or marking a row would re-enter.
      // The observation is app-wide, so passes are coalesced to one per tick:
      // typing in the composer re-renders continuously, and a full row scan per
      // mutation would be real work for no new information.
      var scheduled = false
      var schedule = function () {
        if (scheduled) return
        scheduled = true
        queueMicrotask(function () {
          scheduled = false
          mark()
        })
      }
      var observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      return function () {
        observer.disconnect()
      }
    }

    /**
     * Register the picker at the left of the composer tool row.
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
        // A worktree's sidebar row is plain markup with no plugin seat, so it
        // is marked and restyled rather than rendered by a slot.
        scoped.effect(
          function () {
            return applyWorkspaceRowMarkers(scoped.workspaces)
          },
          'worktree-session: workspace row markers',
        )
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
      })
    }

    return {
      name: '@logictan/dsh-worktree-session',
      inject: ['slots', 'locale'],
      apply: apply,
    }
  },
})
