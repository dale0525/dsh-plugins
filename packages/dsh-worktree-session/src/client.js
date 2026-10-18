/**
 * dsh-worktree-session — browser half.
 *
 * Registers one compact control at the left of the composer tool row: a
 * worktree picker that shows which checkout the current Session works in and
 * offers to switch to the main checkout, to an existing linked worktree, or to
 * start a new one.
 *
 * "New worktree" does not create anything yet. A Session's `cwd` is immutable,
 * so the branch cannot be named before the user has said what the task is; the
 * choice is recorded on the current blank Session instead, and the host half
 * creates the branch from the first message and moves the Session's working
 * directory into it. This half only reads `GET /api/dsh-worktree/status` and
 * posts to `POST /api/dsh-worktree/prepare`.
 *
 * The sidebar then tells the two kinds apart without asking anyone: a Session
 * whose working directory differs from the `cwd` it was created in is running
 * its tools in a worktree, and gets a branch glyph instead of the document one.
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
      'entry.pending': '工作树待创建',
      'menu.title': '选择工作目录',
      'menu.main': '主检出',
      'menu.new': '新建工作树',
      'menu.deferred': '首条消息后按任务命名并创建',
      'menu.needsBlank': '只有新对话可以新建工作树',
      'menu.failed': '操作失败：{message}',
      'menu.draft': '输入框有内容，切换工作目录会清空它。再点一次确认。',
      'menu.unavailable': '无法读取工作目录状态，点击重试',
    }

    var en = {
      'entry.main': 'Main checkout',
      'entry.loading': 'Loading',
      'entry.failed': 'Unavailable',
      'entry.label': 'Working directory',
      'entry.pending': 'Worktree pending',
      'menu.title': 'Choose working directory',
      'menu.main': 'Main checkout',
      'menu.new': 'New worktree',
      'menu.deferred': 'Named and created after the first message',
      'menu.needsBlank': 'A worktree can only be started from a new conversation',
      'menu.failed': 'Failed: {message}',
      'menu.draft': 'The composer has text; switching clears it. Click again to confirm.',
      'menu.unavailable': 'Could not read the working directory status; click to retry',
    }

    /** API paths, mirroring the host half's `API`. */
    var API = {
      status: '/api/dsh-worktree/status',
      prepare: '/api/dsh-worktree/prepare',
    }

    /** GET the worktree status for one directory, and one Session's pending intent. */
    function fetchStatus(cwd, sessionId) {
      var url = API.status + '?cwd=' + encodeURIComponent(cwd)
      if (sessionId) url += '&sessionId=' + encodeURIComponent(sessionId)
      return fetch(url, {
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
     * would issue ten identical requests per render pass. The answer also
     * carries the Session's own pending intent, so it is keyed by both.
     *
     * A failed read is not cached as a success: the promise stays rejected, so
     * each caller decides how to show it and an explicit reload can retry.
     */
    var statusCache = new Map()

    function cacheKey(cwd, sessionId) {
      return cwd + '\u0000' + (sessionId || '')
    }

    function loadStatus(cwd, sessionId) {
      var key = cacheKey(cwd, sessionId)
      var pending = statusCache.get(key)
      if (pending === undefined) {
        pending = fetchStatus(cwd, sessionId)
        statusCache.set(key, pending)
      }
      return pending
    }

    /** POST one Session's pending worktree intent. */
    function postPrepare(sessionId, from) {
      return fetch(API.prepare, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, from: from }),
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
     * Switching to an existing checkout goes through `uiWorkspace.openWorkspace`,
     * which connects the target Workspace and then navigates into it. Connecting
     * reuses an existing blank Session for that Workspace when one exists, so
     * opening the same worktree twice does not pile up empty Sessions.
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
      var session = props.useSessions(function (state) {
        if (!sessionId || !state || !state.byId) return undefined
        return state.byId[sessionId]
      })
      var sessionCwd = session ? session.cwd : undefined
      var blank = session ? session.blank === true : false
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
          if (open) statusCache.delete(cacheKey(cwd, sessionId))
          loadStatus(cwd, sessionId).then(
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
        [cwd, sessionId, open, retry],
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
      // The host decides whether a Session can be moved at all: without its
      // working-directory service the deferred flow has nowhere to land.
      var canDefer = !failed && status && status.isRepo && status.deferred === true
      var waiting = !failed && status && status.waiting === true

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

      /**
       * Record the worktree intent on this blank Session.
       *
       * Nothing is created here: the branch is named from the first message, so
       * the record is all that can be committed before the user has said
       * anything. The host half reads it back when that message arrives.
       */
      var prepare = function () {
        setBusy(true)
        setNotice(null)
        postPrepare(sessionId, cwd)
          .then(function () {
            setOpen(false)
            setStatus(null)
            setRetry(retry + 1)
          })
          .catch(function (error) {
            setNotice(t('menu.failed', { message: String(error && error.message ? error.message : error) }))
          })
          .finally(function () {
            setBusy(false)
          })
      }

      var handleSelect = function (id) {
        if (id === '__new__') {
          prepare()
          return
        }
        // Both remaining paths mint a Session with a new cwd, so both discard
        // the draft. Asking once, here, keeps "create" from silently eating
        // typed text while "switch" asks.
        if (hasDraft && !confirmSwitch) {
          setConfirmSwitch(true)
          setNotice(t('menu.draft'))
          return
        }
        setConfirmSwitch(false)
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

      var footer = canDefer
        ? [
            {
              id: '__new__',
              label: waiting ? t('entry.pending') : t('menu.new'),
              description: t('menu.deferred'),
              icon: React.createElement(Primitives.IconPlusOutlineRegular, null),
              // Naming happens on the first message, so only a conversation
              // that has none yet can start one.
              disabled: busy || !blank || waiting,
            },
          ]
        : []

      var triggerLabel = failed
        ? t('entry.failed')
        : !status
          ? t('entry.loading')
          : !status.isRepo
            ? t('entry.label')
            : waiting
              ? t('entry.pending')
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
                statusCache.delete(cacheKey(cwd, sessionId))
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

    /* ------------------------------------------------------- row markers */

    /** Stylesheet id guarding the single injection of the row-marker CSS. */
    var ROW_CSS_ID = 'worktree-session/rows.css'

    /**
     * The branch glyph, carried as a mask so the row's own colour still applies.
     *
     * Same artwork as `IconBranchOutlineRegular` (16x16, 1px `currentColor`
     * strokes). A mask rather than a background image because the row tints its
     * icon when it is the active one, and a baked-in colour would lose that.
     */
    var BRANCH_MASK =
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\' fill=\'none\' stroke=\'%23000\' stroke-width=\'1\'%3E' +
      '%3Cpath d=\'M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564\'/%3E' +
      '%3Cpath d=\'M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944\'/%3E' +
      '%3Ccircle cx=\'12.4502\' cy=\'3.3079\' r=\'1.56962\'/%3E' +
      '%3Ccircle cx=\'12.4502\' cy=\'12.6921\' r=\'1.56962\'/%3E%3C/svg%3E")'

    /**
     * The document glyph a Session row shows when it is not in a worktree.
     *
     * Drawn on a 24-unit grid like the branch mark so both scale from one mask
     * box.
     */
    var DOC_MASK =
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%23000\' stroke-width=\'1.8\'%3E' +
      '%3Cpath d=\'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z\'/%3E%3C/svg%3E")'

    /**
     * Replace a worktree row's folder glyph with the branch glyph, hang a
     * worktree count off every plain workspace's name, and give each Session row
     * a glyph naming the checkout it runs in.
     *
     * The sidebar renders a workspace row as plain markup: it has no plugin
     * slot, and a Workspace carries no icon of its own. So a worktree's row can
     * only be told apart by marking the element and restyling it. The marker
     * rides on the row itself, and the rule is scoped to the row's first child
     * — the icon slot — because the sidebar's class names are build-local
     * hashes that this plugin cannot name.
     *
     * The count rides on the row's *title* element instead, because that is the
     * only spot where it lands next to the name. Two other candidates were
     * measured and rejected: the row itself is a flex strip, so a `::after`
     * there lands at the far right beside the row's action buttons; and the
     * title's parent is `flex-direction: column` at sidebar width, so a
     * `::after` there drops onto a second line and stretches across the row.
     */
    var ROW_CSS = [
      '[data-dsh-worktree]>span:first-child{background-color:currentColor;',
      '-webkit-mask:' + BRANCH_MASK + ' center/16px 16px no-repeat;',
      'mask:' + BRANCH_MASK + ' center/16px 16px no-repeat}',
      '[data-dsh-worktree]>span:first-child>svg{display:none}',
      '[data-dsh-worktree-count]::after{content:attr(data-dsh-worktree-count);',
      'display:inline-flex;align-items:center;justify-content:center;',
      'height:17px;min-width:17px;padding:0 5px;margin-left:6px;',
      'border-radius:9999px;background:rgba(226,232,240,.8);color:#64748b;',
      'font-size:10px;line-height:1;vertical-align:middle}',
      'body[data-ds-dark-theme] [data-dsh-worktree-count]::after{',
      'background:rgba(255,255,255,.1);color:#cbd5e1}',
      // Session rows: a glyph naming the checkout the row runs in. It hangs off
      // the leading 16px cell rather than replacing its contents, so the host's
      // own status dot keeps that cell and the row's indentation is untouched —
      // the leading cell is what the sidebar's indent reads from, and filling it
      // would flatten a session against its workspace row.
      '[data-row-key^="session:"]>span:first-child{position:relative}',
      // `left:100%` puts the glyph's left edge on the leading cell's right edge,
      // with no extra offset: the title's 20px margin is then exactly the glyph's
      // 16px plus a 4px gap, matching the design's `w-4 h-4 mr-1`. Any offset
      // here would eat into that gap and run the text into the glyph (measured:
      // a 4px offset left the two flush at 0px).
      '[data-row-key^="session:"]>span:first-child::after{content:"";position:absolute;',
      'left:100%;top:50%;transform:translateY(-50%);width:16px;height:16px;',
      'background-color:#94a3b8;',
      '-webkit-mask:' + DOC_MASK + ' center/14px 14px no-repeat;',
      'mask:' + DOC_MASK + ' center/14px 14px no-repeat}',
      // The glyph is out of flow, so the title reserves the room it occupies.
      // Margin rather than padding: the host clips the title at its padding box
      // and scrolls it on hover, so padding would let a long title slide its text
      // under the glyph, while margin keeps the clip edge exactly where the glyph
      // ends.
      '[data-row-key^="session:"]>span:nth-child(2){margin-left:20px}',
      '[data-row-key^="session:"]:hover>span:first-child::after{background-color:#475569}',
      // A Session running its tools in a worktree takes the branch glyph and the
      // worktree's blue. The marker is stamped from the Session's own
      // projections, so this holds for every row without asking the host a
      // second question.
      '[data-row-key^="session:"][data-dsh-worktree-session]>span:first-child::after{',
      'background-color:#60a5fa;',
      '-webkit-mask:' + BRANCH_MASK + ' center/14px 14px no-repeat;',
      'mask:' + BRANCH_MASK + ' center/14px 14px no-repeat}',
      '[data-row-key^="session:"][data-dsh-worktree-session]:hover>span:first-child::after{',
      'background-color:#2563eb}',
      'body[data-ds-dark-theme] [data-row-key^="session:"]>span:first-child::after{',
      'background-color:#64748b}',
      'body[data-ds-dark-theme] [data-row-key^="session:"]:hover>span:first-child::after{',
      'background-color:#94a3b8}',
      'body[data-ds-dark-theme] [data-row-key^="session:"][data-dsh-worktree-session]>span:first-child::after{',
      'background-color:#93c5fd}',
      'body[data-ds-dark-theme] [data-row-key^="session:"][data-dsh-worktree-session]:hover>span:first-child::after{',
      'background-color:#bfdbfe}',
    ].join('')

    /** Attribute this plugin stamps on a workspace row that is a worktree. */
    var ROW_ATTR = 'data-dsh-worktree'

    /** Attribute carrying the worktree count on a plain workspace's name box. */
    var COUNT_ATTR = 'data-dsh-worktree-count'

    /** Attribute this plugin stamps on a Session row whose tools run in a worktree. */
    var SESSION_ATTR = 'data-dsh-worktree-session'

    /**
     * Mark every sidebar workspace row whose directory is a linked worktree.
     *
     * Rows are addressed by their `data-row-key` (`workspace:<id>`), which is
     * the only stable handle the row exposes. Whether a directory is a worktree
     * is the host's answer, not a guess from the path, so this reuses the same
     * per-directory status read the picker shares.
     * @param workspaces - the client Workspace service, for its snapshot.
     * @param sessions - the client Session service, whose list carries the
     * working-directory projection each Session row is judged by.
     * @returns a disposer, or undefined when there is no DOM to mark.
     */
    function applyRowMarkers(workspaces, sessions) {
      if (typeof document === 'undefined') return undefined

      // The stylesheet is rewritten on every activation, never skipped when a
      // tag already exists: the client HMR replaces this plugin's fiber without
      // reloading the page, so a "inject once" guard would leave the *previous*
      // build's CSS in the document and any stylesheet change would be invisible
      // until a manual refresh.
      var existing = document.querySelector('style[data-plugin-css="' + ROW_CSS_ID + '"]')
      if (existing !== null) {
        existing.textContent = ROW_CSS
      } else {
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
        markSessionRows()
      }

      /** Stamp or clear one workspace row once the host has answered for its directory. */
      var markRow = function (row, path) {
        loadStatus(path, undefined).then(
          function (status) {
            var entry = (status.worktrees || []).find(function (candidate) {
              return candidate.path === path
            })
            var wanted = entry !== undefined && !entry.isMain
            // The observer re-runs this on every DOM change, so an unchanged
            // row must not be rewritten: the write would invalidate style for
            // every row on every keystroke in the composer.
            if (wanted !== (row.getAttribute(ROW_ATTR) !== null)) {
              if (wanted) row.setAttribute(ROW_ATTR, 'branch')
              else row.removeAttribute(ROW_ATTR)
            }

            // The count belongs to the repository, not the checkout: it is the
            // number of *other* worktrees this one's owner has, so it is shown
            // on the plain workspace row and cleared from worktree rows. It
            // comes from the same answer the picker lists, filtered the same
            // way, so the badge can never disagree with the menu.
            var title = row.querySelector('[class*="_title"]')
            if (title === null) return
            var count = 0
            if (!wanted) {
              count = (status.worktrees || []).filter(function (candidate) {
                return !candidate.isMain && !candidate.prunable
              }).length
            }
            var next = count === 0 ? null : String(count)
            if (next === title.getAttribute(COUNT_ATTR)) return
            if (next === null) title.removeAttribute(COUNT_ATTR)
            else title.setAttribute(COUNT_ATTR, next)
          },
          function () {
            // An unreadable directory is not evidence of a worktree.
            if (row.getAttribute(ROW_ATTR) !== null) row.removeAttribute(ROW_ATTR)
          },
        )
      }

      /**
       * Mark Session rows from the list snapshot alone.
       *
       * A Session keeps the `cwd` it was created in — that is what keeps it in
       * its Workspace group — while `workingDirectory` follows the worktree its
       * tools actually run in. The two disagreeing is therefore the exact
       * definition of "this conversation works in a worktree", and it needs no
       * request: the projection arrives with the list and with every live
       * `working-directory/change`.
       */
      var markSessionRows = function () {
        var snapshot = sessions.list.getSnapshot()
        var byId = (snapshot && snapshot.byId) || {}
        var rows = document.querySelectorAll('[data-row-key^="session:"]')
        for (var i = 0; i < rows.length; i += 1) {
          var row = rows[i]
          var id = (row.getAttribute('data-row-key') || '').slice('session:'.length)
          var summary = byId[id]
          var projected = summary && summary.projectionValues ? summary.projectionValues.workingDirectory : undefined
          var base = summary ? summary.cwd : undefined
          var wanted = typeof projected === 'string' && projected !== '' && typeof base === 'string' && base !== '' && projected !== base
          if (wanted !== (row.getAttribute(SESSION_ATTR) !== null)) {
            if (wanted) row.setAttribute(SESSION_ATTR, 'branch')
            else row.removeAttribute(SESSION_ATTR)
          }
        }
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
      // A row can already be on screen when its projection arrives, and the
      // projection update does not necessarily touch the DOM.
      var unsubscribe = sessions.list.subscribe(schedule)
      return function () {
        observer.disconnect()
        unsubscribe()
      }
    }

    /**
     * Register the picker at the left of the composer tool row.
     *
     * The workspace and Session services are required through a nested `inject`
     * rather than the plugin's own `inject` list: a plugin whose `inject` cannot
     * be satisfied never activates, and on the client a single such entry fails
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
      ctx.inject(['workspaces', 'uiWorkspace', 'sessions'], function (scoped) {
        // A worktree's sidebar row is plain markup with no plugin seat, so it
        // is marked and restyled rather than rendered by a slot.
        scoped.effect(
          function () {
            return applyRowMarkers(scoped.workspaces, scoped.sessions)
          },
          'worktree-session: row markers',
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
