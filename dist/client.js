// Compiled Client half of @heeweelee/dsh-session-plugin.
//
// DSH loads each package's client entry (its `exports["./client"]`, declared by
// the `dsh.client` field) as a pre-bundled module through
// `window.__ModuleLoader__.load({ id, factory })`. This file is that bundle,
// hand-written against the same wire format the built-in plugins ship
// (`window.__ModuleLoader__.load` + a `require` factory).
//
// Ported 1:1 from `sess-7/pkg-9` with two changes:
//   1. `host.call(...)`          -> `fetch('/api/dsh-session-plugin/...')`
//   2. `ctx.get('slots')`        -> `ctx.slots` (inject: ['slots', 'timer'])
//
// Composer surface (0.1.6): DSH <= 0.1.0-rc.7 rendered the composer as a
// controlled `<textarea data-phase>`; DSH 2.0.4 replaced it with a shell-owned
// Lexical editor — `<div contenteditable role="textbox" data-composer-input
// data-phase>`. Every place that used to hard-code TEXTAREA now goes through
// `isComposerSurface` / `findComposerSurface`, which accept both shapes, so
// ↑/↓ keeps working before and after that migration.
window.__ModuleLoader__.load({
  id: '@listardus/dsh-session-plugin',
  factory: function (require) {
    var React = require('react')

    var BtnBase = {
      fontSize: '12px',
      cursor: 'pointer',
      background: 'transparent',
      borderRadius: '6px',
      color: 'inherit',
      lineHeight: '18px',
      padding: '0 6px',
      border: '1px solid rgba(140,140,160,.45)',
    }

    function api(path, init) {
      if (!init) init = {}
      // Keep this version in sync with package.json (it feeds the server-side
      // x-dsh-plugin-version gates, e.g. the legacy /archive alias check).
      init.headers = Object.assign({ 'x-dsh-csrf': '1', 'x-dsh-plugin-version': '0.1.15' }, init.headers || {})
      var ctrl = null
      var timer = null
      try {
        if (typeof AbortController !== 'undefined') {
          ctrl = new AbortController()
          init.signal = ctrl.signal
          timer = window.setTimeout(function () { try { ctrl.abort() } catch (e) {} }, 8000)
        }
      } catch (e) { ctrl = null }
      return fetch(path, init).then(function (r) {
        if (timer) window.clearTimeout(timer)
        if (!r.ok) {
          // Keep a server-provided machine reason (409 {reason: running|jobs})
          // inside the error text so deleteErrorText can tell "generating"
          // from "background jobs". Best-effort: an unreadable body falls back
          // to the status-only message.
          return r.json().catch(function () { return null }).then(function (d) {
            var reason = d && typeof d.reason === 'string' && d.reason ? ' ' + d.reason : ''
            throw new Error('HTTP ' + r.status + reason)
          })
        }
        return r.json()
      }).catch(function (e) {
        if (timer) window.clearTimeout(timer)
        throw (e && e.name === 'AbortError') ? new Error('请求超时（8s）') : e
      })
    }
    function historyOf(sessionId, force) {
      return api('/api/dsh-session-plugin/history?sessionId=' + encodeURIComponent(sessionId)
        + (force ? '&refresh=1' : ''))
        .then(function (d) { return { list: Array.isArray(d.history) ? d.history : [], limit: d.limit || 100, throttled: !!d.throttled } })
    }
    // Short-lived cache: right-click fallback must not hammer /sessions on
    // every contextmenu when fiber lookup misses repeatedly.
    var sessionsCache = { at: 0, data: null }
    function listSessionsApi() {
      var now = Date.now()
      if (sessionsCache.data && (now - sessionsCache.at) < 5000) {
        return Promise.resolve(sessionsCache.data)
      }
      return api('/api/dsh-session-plugin/sessions')
        .then(function (d) {
          var arr = Array.isArray(d.sessions) ? d.sessions : []
          sessionsCache = { at: Date.now(), data: arr }
          return arr
        })
    }
    // Canonical destructive endpoint. The legacy /archive path is kept
    // server-side as an alias with identical behavior — always call /delete.
    function deleteApi(sessionId) {
      return api('/api/dsh-session-plugin/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
      })
    }
    function archiveApi(sessionId) { return deleteApi(sessionId) }

    function apply(ctx) {
      var store = { toast: null, menu: null }
      // Currently viewed session id, maintained by the mounted HistoryHook.
      // Lets the right-click menu warn when the target IS the open session
      // (deleting it is allowed while idle, but the user should switch away
      // afterwards so a new message does not recreate its log file).
      var currentSidRef = { id: null }
      var subs = []
      // Number used to identify toasts: only the toast that created the timer
      // may clear it, so consecutive toasts don't cut each other short.
      var toastSeq = 0
      function notify() {
        var s = subs.slice()
        for (var i = 0; i < s.length; i++) { try { s[i]() } catch (e) {} }
      }
      function setStore(p) {
        for (var k in p) store[k] = p[k]
        notify()
      }
      function subscribe(f) {
        subs.push(f)
        return function () {
          var i = subs.indexOf(f)
          if (i >= 0) subs.splice(i, 1)
        }
      }
      function toast(msg) {
        var id = ++toastSeq
        setStore({ toast: { msg: msg, id: id } })
        ctx.timeout(function () {
          if (store.toast && store.toast.id === id) setStore({ toast: null })
        }, 3000)
      }

      // Resolve the real session id behind a contextmenu on a workspace tree
      // row. Primary path: read the React internals of the treeitem element and
      // pull the record object the DSH workspace UI rendered the row from.
      // Verified against dsh-client-ui-workspace source: rows are rendered by
      // `SessionNodeItem({ node, ... })` and use `node.id` as the authoritative
      // sessionId (the row's own onClick/drag handlers capture node.id), so we
      // look for props.node.id first, then common alternates. The element's
      // `_owner` points straight at SessionNodeItem; an ancestor walk covers
      // wrapped trees. Fallback: DOM title + /sessions lookup, kept ONLY when
      // that lookup has exactly one match — ambiguous titles never archive a
      // guess.
      function resolveSessionId(el) {
        try {
          var fiberKey = null
          var ks = Object.keys(el)
          for (var i = 0; i < ks.length; i++) {
            if (ks[i].indexOf('__reactFiber$') === 0) { fiberKey = ks[i]; break }
          }
          if (!fiberKey) return null
          var f = el[fiberKey]
          var hops = []
          if (f && f._owner) hops.push(f._owner)
          for (var g = f; g && hops.length <= 31; g = g.return) hops.push(g)
          for (var j = 0; j < hops.length; j++) {
            var fib = hops[j]
            var p = fib ? fib.memoizedProps : null
            if (!p || typeof p !== 'object') continue
            var node = p.node
            if (node && typeof node.id === 'string' && node.id) return node.id
            var res = p.result
            if (res && typeof res.id === 'string' && res.id) return res.id
            var rec = p.session || p.record || p.item || p.data
            if (rec) {
              var hid = rec.header ? rec.header.id : undefined
              if (typeof hid === 'string' && hid) return hid
            }
          }
        } catch (e) { /* fall through to title matching */ }
        return null
      }

      function HistoryHook(props) {
        var historyRef = React.useRef([])
        var recallRef = React.useRef(null)
        var actionsRef = React.useRef(null)
        actionsRef.current = props.inputActions
        // recall window cap, reported by the host (configurable there)
        var limitRef = React.useRef(100)

        function capList(list) {
          var limit = limitRef.current || 100
          return list.length > limit ? list.slice(-limit) : list
        }

        var cancelledRef = React.useRef(false)

        // Two-layer history model (ghost-message fix): `confirmedRef` only ever
        // holds entries verified against the host session log; texts that were
        // merely TYPED then lost from the input box go to `pendingRef` first
        // ({text, t}) and are promoted only once a forced host refresh actually
        // sees them in the log. Entries neither seen nor refreshed away within
        // PENDING_TTL_MS are dropped — a hand-cleared draft therefore never
        // pollutes recall permanently, even when its text matches some older
        // confirmed message verbatim.
        var confirmedRef = React.useRef([])
        var pendingRef = React.useRef([])
        var refreshingRef = React.useRef(false)
        // Set when a programmatic clear is about to run as part of ↓ recall
        // navigation; one-time latch so the draft watcher treats that emptying
        // as an exit from recall, not as "user just sent this text".
        var suppressSendWatchRef = React.useRef(false)
        var PENDING_TTL_MS = 10000
        // Stashed unsent draft: entering recall with a non-empty box parks the
        // draft here; leaving recall at the bottom restores it instead of blank.
        var stashedDraftRef = React.useRef(null)
        // Per-session load generation: stale in-flight fetches from a previous
        // session must never overwrite the newly selected session's list.
        var loadSeqRef = React.useRef(0)
        // Client-side "forget this entry": texts the user explicitly removed via
        // the history panel. Persisted per session in localStorage and applied
        // as a filter on every rebuild/reconcile, so a later forced host refresh
        // (which re-reads the immutable session log) cannot resurrect them in
        // the recall view. NOTE: this hides them from recall only; it does not
        // rewrite the session log on disk.
        var forgottenRef = React.useRef({ set: {}, sid: null })
        var listOpenRef = React.useRef(false)
        var listTick = React.useState(0)
        var setListTick = listTick[1]
        function forgottenKey(sid) { return 'dsh-session-plugin:forgotten:' + sid }

        function loadForgotten(sid) {
          var set = {}
          try {
            var raw = window.localStorage.getItem(forgottenKey(sid))
            var arr = raw ? JSON.parse(raw) : []
            if (Array.isArray(arr)) for (var i = 0; i < arr.length; i++) {
              if (typeof arr[i] === 'string' && arr[i]) set[arr[i]] = 1
            }
          } catch (e) {}
          forgottenRef.current = { set: set, sid: sid }
        }
        function saveForgotten() {
          try {
            var cur = forgottenRef.current
            var keys = Object.keys(cur.set || {})
            if (cur.sid) window.localStorage.setItem(forgottenKey(cur.sid), JSON.stringify(keys.slice(-200)))
          } catch (e) {}
        }
        function isForgotten(text) {
          return !!(forgottenRef.current.set && forgottenRef.current.set[text])
        }
        function dedupeConsecutive(list) {
          var out = []
          for (var i = 0; i < list.length; i++) {
            if (i > 0 && list[i] === out[out.length - 1]) continue
            out.push(list[i])
          }
          return out
        }
        function applyForgotten(list) {
          var out = []
          for (var i = 0; i < list.length; i++) {
            if (!isForgotten(list[i])) out.push(list[i])
          }
          return out
        }

        function rebuildHistory() {
          var texts = []
          for (var i = 0; i < pendingRef.current.length; i++) {
            var pt = pendingRef.current[i].text
            if (!isForgotten(pt)) texts.push(pt)
          }
          var base = applyForgotten(confirmedRef.current)
          historyRef.current = capList(dedupeConsecutive(base.concat(texts)))
        }

        // Fold a fresh host list into (confirmed, pending): a pending entry is
        // dropped once the host log contains its text (promoted into the
        // authoritative list) or once it ages past PENDING_TTL_MS. Membership
        // (value-based, not position-based) keeps this correct when the recall
        // window cap trims the head of both lists. Forgotten entries are
        // filtered out of the confirmed view so force-refresh cannot resurrect
        // a text the user explicitly removed from recall.
        function reconcile(hostList) {
          var p = pendingRef.current
          var now = Date.now()
          var remaining = []
          for (var i = 0; i < p.length; i++) {
            var seen = hostList.indexOf(p[i].text) !== -1
            var expired = (now - p[i].t) >= PENDING_TTL_MS
            if (!seen && !expired) remaining.push(p[i])
          }
          confirmedRef.current = dedupeConsecutive(hostList.slice())
          pendingRef.current = remaining
          return remaining.length
        }

        React.useEffect(function () {
          var seq = ++loadSeqRef.current
          cancelledRef.current = false
          recallRef.current = null
          stashedDraftRef.current = null
          confirmedRef.current = []
          pendingRef.current = []
          historyRef.current = []
          listOpenRef.current = false
          var sid = props.sessionId
          if (!sid) { cancelledRef.current = true; return function () { cancelledRef.current = true } }
          try { currentSidRef.id = sid } catch (e) {}
          loadForgotten(sid)
          // One bounded retry so a transient network blip at mount doesn't leave
          // the session with an empty recall list until the next send.
          function load(attempt) {
            var mySid = sid
            historyOf(mySid).then(function (d) {
              if (cancelledRef.current || seq !== loadSeqRef.current) return
              if (props.sessionId !== mySid) return
              limitRef.current = d.limit || 100
              confirmedRef.current = dedupeConsecutive(capList(applyForgotten(d.list)))
              rebuildHistory()
              setListTick(function (x) { return x + 1 })
            }).catch(function () {
              if (!cancelledRef.current && seq === loadSeqRef.current && attempt < 2) {
                window.setTimeout(function () { load(attempt + 1) }, 1000 * (attempt + 1))
              }
            })
          }
          load(0)
          return function () {
            cancelledRef.current = true
            try { if (currentSidRef.id === sid) currentSidRef.id = null } catch (e) {}
          }
        }, [props.sessionId])

        var draft = props.useInput
          ? props.useInput(function (s) { return (s && s.draft) || '' })
          : ''
        var draftRef = React.useRef('')
        draftRef.current = draft
        React.useEffect(function () {
          if (draft === '') recallRef.current = null
        }, [draft])

        // Watch for draft emptying (message just sent, or input hand-cleared).
        // The typed text goes to `pendingRef` first; a debounced forced refresh
        // reconciles against the host log: only texts the log actually contains
        // become confirmed history. A slow host query can never make the newest
        // message vanish from recall (pending keeps it visible), and a
        // hand-cleared draft dies on the first reconciliation instead of living
        // forever in the local list.
        // A ↓-recall exit (terminal clear) is NOT a send: it sets the one-time
        // suppress latch before emptying, so the withdrawn text never re-enters
        // the history as a ghost duplicate.
        var prevDraftRef = React.useRef('')
        React.useEffect(function () {
          var prev = prevDraftRef.current
          prevDraftRef.current = draft
          if (prev === '' || draft !== '' || cancelledRef.current) return
          if (suppressSendWatchRef.current) {
            // Recall-navigation clear: just drop out of recall state quietly.
            suppressSendWatchRef.current = false
            recallRef.current = null
            return
          }
          // draft just went non-empty → '' : send or manual clear. A real send
          // abandons any stashed pre-recall draft (the user committed to the
          // recalled text instead).
          stashedDraftRef.current = null
          pendingRef.current = pendingRef.current.concat([{ text: prev, t: Date.now() }])
          rebuildHistory()
          setListTick(function (x) { return x + 1 })
          recallRef.current = null
          var sid = props.sessionId
          if (!sid) return
          var seq = loadSeqRef.current
          function reconcileOnce(retriesLeft) {
            if (cancelledRef.current || seq !== loadSeqRef.current) return
            if (refreshingRef.current) {
              // A previous force-refresh is still in flight: retry shortly
              // instead of dropping this send's reconciliation on the floor.
              if (retriesLeft > 0) {
                window.setTimeout(function () { reconcileOnce(retriesLeft - 1) }, 800)
              }
              return
            }
            refreshingRef.current = true
            // force=true re-folds the host log so the disk cache catches up
            historyOf(sid, true).then(function (d) {
              refreshingRef.current = false
              if (cancelledRef.current || seq !== loadSeqRef.current) return
              limitRef.current = d.limit || 100
              reconcile(capList(applyForgotten(d.list)))
              rebuildHistory()
              setListTick(function (x) { return x + 1 })
              recallRef.current = null
              // The new message may not be visible yet if the log write raced
              // the forced read (or the host throttled us): one follow-up pass
              // keeps pending visible rather than leaking it until expiry.
              if (pendingRef.current.length > 0 && !d.throttled && retriesLeft > 0) {
                window.setTimeout(function () { reconcileOnce(retriesLeft - 1) }, 1200)
              }
            }).catch(function () { refreshingRef.current = false })
          }
          var timer = window.setTimeout(function () { reconcileOnce(2) }, 250)
          return function () { window.clearTimeout(timer) }
        }, [draft, props.sessionId])

        var doRecallRef = React.useRef(null)
        function recallAt(index) {
          var hist = historyRef.current || []
          if (index < 0 || index >= hist.length) return false
          var actions = actionsRef.current
          if (!actions || !actions.setDraft) return false
          // First step into recall with an unsent draft: park it so ↓-to-bottom
          // can restore it (shell-style) instead of forcing a manual clear.
          if (recallRef.current === null && draftRef.current !== '') {
            stashedDraftRef.current = draftRef.current
          }
          recallRef.current = index
          programmaticSet(hist[index])
          setListTick(function (x) { return x + 1 })
          return true
        }
        function forgetAt(index) {
          var hist = historyRef.current || []
          var text = hist[index]
          if (typeof text !== 'string' || !text) return false
          forgottenRef.current.set[text] = 1
          saveForgotten()
          // If we are currently showing the forgotten row, step out of recall
          // so the box never displays a text that is no longer recallable.
          if (recallRef.current === index) recallRef.current = null
          else if (recallRef.current !== null && recallRef.current > index) recallRef.current--
          rebuildHistory()
          setListTick(function (x) { return x + 1 })
          return true
        }
        doRecallRef.current = function (dir) {
          var hist = historyRef.current || []
          if (!hist.length) {
            if (dir === 'up') toast('该会话还没有可回填的历史消息')
            return false
          }
          var actions = actionsRef.current
          if (!actions || !actions.setDraft) return false
          var cur = recallRef.current
          if (dir === 'up') {
            // Entering recall from a non-empty box is allowed: park the unsent
            // draft first so ↓-to-bottom can restore it (shell-style) instead
            // of forcing the user to clear the box manually.
            var entering = (cur === null)
            cur = entering ? hist.length - 1 : Math.max(0, cur - 1)
            if (entering && draftRef.current !== '' && stashedDraftRef.current === null) {
              stashedDraftRef.current = draftRef.current
            }
            recallRef.current = cur
            programmaticSet(hist[cur])
            setListTick(function (x) { return x + 1 })
            return true
          } else {
            if (cur === null) return false
            cur = cur + 1
            if (cur >= hist.length) cur = null
          }
          recallRef.current = cur
          if (cur === null) {
            // Recall-terminal exit. Suppression flag BEFORE clearing: this is a
            // ↓-navigation exit, not a send — the draft watcher must not push the
            // withdrawn text into pending history (it would reappear as a ghost).
            suppressSendWatchRef.current = true
            var stash = stashedDraftRef.current
            stashedDraftRef.current = null
            if (stash !== null && stash !== '') programmaticSet(stash)
            else programmaticClear()
          } else {
            programmaticSet(hist[cur])
          }
          return true
        }

        // Programmatic draft writes.
        //
        // Legacy shape (DSH <= 0.1.0-rc.7): a controlled <textarea data-phase>,
        // where a plain setDraft("") invoked from a capture-phase keydown outside
        // React's synthetic system occasionally did not reach the DOM. There we
        // verify the DOM value and, if needed, force-sync through the same channel
        // the browser uses for real user edits: the native value setter plus an
        // `input` event — the one path proven to always work (manual deletion).
        //
        // Current shape (DSH 2.0.4+): the composer is a shell-owned Lexical editor,
        // <div contenteditable role="textbox" data-composer-input data-phase>. It
        // has no `value`, and Lexical owns that DOM, so writing el.value or
        // dispatching a synthetic `input` on it would fight the editor. There
        // inputActions.setDraft() is authoritative on its own: it rewrites the
        // Lexical tree and already parks the caret at the end.
        //
        // NOTE: every helper here resolves inputActions via actionsRef itself; none
        // may reference a caller-local `actions` binding (that was the 0.1.4
        // ReferenceError regression that killed every ↑/↓ press).
        function isComposerSurface(el) {
          if (!el || !el.hasAttribute || !el.hasAttribute('data-phase')) return false
          if (el.tagName === 'TEXTAREA') return true
          // Lexical contenteditable host (2.0.4+). data-composer-input is the
          // primary marker; role="textbox" covers a renamed attribute.
          return el.tagName === 'DIV'
            && (el.hasAttribute('data-composer-input') || el.getAttribute('role') === 'textbox')
        }
        function isNativeTextarea(el) {
          return !!el && el.tagName === 'TEXTAREA'
        }
        function findComposerSurface() {
          try {
            var a = document.activeElement
            if (isComposerSurface(a)) return a
          } catch (e) {}
          try {
            return document.querySelector(
              'textarea[data-phase], div[data-composer-input][data-phase]')
          } catch (e) {
            return null
          }
        }
        function domForceWrite(el, text) {
          try {
            var proto = el.constructor && el.constructor.prototype
            var desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null
            var setter = desc && desc.set
            if (setter) setter.call(el, text)
            else el.value = text
            el.dispatchEvent(new Event('input', { bubbles: true }))
          } catch (e) { /* best effort; setDraft already attempted */ }
        }
        function programmaticSet(text) {
          var a = actionsRef.current
          if (!a || !a.setDraft) return false
          a.setDraft(text)
          Promise.resolve().then(function () {
            var t = findComposerSurface()
            if (!t) return
            // DOM verification only exists for the textarea shape; on the Lexical
            // surface setDraft already is the write, and re-reading .value would
            // read undefined and a forced write would desync the editor.
            if (isNativeTextarea(t)) {
              if (t.value !== text) domForceWrite(t, text)
              try { t.setSelectionRange(text.length, text.length) } catch (e) {}
            }
            // A recall started from the header button leaves focus on that button;
            // move it to the composer so the next ↑/↓ is handled there. When the
            // recall came from a keypress this is already focused, so it no-ops.
            try { if (t !== document.activeElement) t.focus() } catch (e) {}
          })
          return true
        }
        function programmaticClear() {
          var a = actionsRef.current
          if (!a || !a.setDraft) return false
          a.setDraft('')
          Promise.resolve().then(function () {
            var t = findComposerSurface()
            if (!t) return
            if (isNativeTextarea(t) && t.value !== '') domForceWrite(t, '')
          })
          return true
        }

        React.useEffect(function () {
          function onKey(e) {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            // Accept both composer shapes (legacy <textarea> and the 2.0.4+
            // Lexical contenteditable div); see isComposerSurface above. Hard-
            // coding TEXTAREA here is what made every ↑/↓ press a silent no-op
            // once DSH 2.0.4 replaced the textarea composer.
            if (!isComposerSurface(document.activeElement)) return
            // Never steal arrows from an in-flight IME composition (the candidate
            // list uses them, and the draft may still read as empty mid-composition
            // on a contenteditable). keyCode 229 covers engines that do not set
            // isComposing on keydown.
            if (e.isComposing || e.keyCode === 229) return
            // Shell-style: ↓ outside recall still does nothing (let the editor
            // move the caret across lines); ↑ always enters recall — a non-empty
            // box is stashed first and restored on ↓-to-bottom (see doRecall).
            if (e.key === 'ArrowDown' && recallRef.current === null) return
            if (!doRecallRef.current(e.key === 'ArrowUp' ? 'up' : 'down')) return
            e.preventDefault()
            e.stopPropagation()
          }
          document.addEventListener('keydown', onKey, true)
          return function () { document.removeEventListener('keydown', onKey, true) }
        }, [])

        var histLen = historyRef.current ? historyRef.current.length : 0
        var recallIdx = recallRef.current
        // Re-render on listTick so the count / position badge stays fresh after
        // loads, sends and forgets (listTick is bumped at every such point).
        void listTick[0]
        var btnLabel = histLen > 0
          ? ('↑ 历史' + (recallIdx !== null ? ' ' + (recallIdx + 1) + '/' + histLen : ' ' + histLen))
          : '↑ 历史'
        var searchRef = React.useRef('')
        var searchTick = React.useState(0)
        var setSearchTick = searchTick[1]
        function toggleList() {
          listOpenRef.current = !listOpenRef.current
          searchRef.current = ''
          setListTick(function (x) { return x + 1 })
        }
        var headerChildren = [
          React.createElement('button', {
            key: 'recall',
            type: 'button',
            title: '↑ 回填上一条 / ↓ 下一条（有草稿时会自动暂存，↓到底恢复）',
            style: BtnBase,
            onClick: function () { doRecallRef.current('up') },
          }, btnLabel),
          React.createElement('button', {
            key: 'list',
            type: 'button',
            title: '打开历史列表（搜索 / 点击回填 / × 不再提示该条）',
            style: Object.assign({}, BtnBase, { marginLeft: '4px', opacity: listOpenRef.current ? 1 : 0.75 }),
            onClick: toggleList,
          }, listOpenRef.current ? '▴' : '▾'),
        ]
        if (listOpenRef.current) {
          var q = (searchRef.current || '').toLowerCase()
          var rows = []
          for (var hi = histLen - 1; hi >= 0 && rows.length < 30; hi--) {
            var text = historyRef.current[hi]
            if (q && String(text).toLowerCase().indexOf(q) === -1) continue
            (function (idx, t) {
              var short = String(t).length > 60 ? String(t).slice(0, 60) + '…' : String(t)
              rows.push(React.createElement('div', {
                key: 'h' + idx,
                style: {
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '4px 8px', cursor: 'pointer',
                  background: recallIdx === idx ? 'rgba(140,140,160,.18)' : 'transparent',
                  borderRadius: '6px', fontSize: '12px', maxWidth: '360px',
                },
                onMouseEnter: function (e) { e.currentTarget.style.background = 'rgba(140,140,160,.18)' },
                onMouseLeave: function (e) { e.currentTarget.style.background = recallIdx === idx ? 'rgba(140,140,160,.18)' : 'transparent' },
                onClick: function () { recallAt(idx) },
                title: String(t),
              },
                React.createElement('span', {
                  style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, short),
                React.createElement('span', {
                  style: { cursor: 'pointer', opacity: 0.6, padding: '0 2px' },
                  title: '不再提示该条（仅隐藏回填，不改会话记录）',
                  onClick: function (ev) { ev.stopPropagation(); forgetAt(idx) },
                }, '×')
              ))
            })(hi, text)
          }
          headerChildren.push(React.createElement('div', {
            key: 'panel',
            style: {
              position: 'absolute', top: '26px', right: 0, zIndex: 10003,
              background: 'var(--dsh-menu-bg, #1e1e2e)', color: 'var(--dsh-menu-fg, inherit)',
              border: '1px solid rgba(140,140,160,.45)', borderRadius: '8px',
              padding: '8px', minWidth: '280px', maxWidth: '400px',
              boxShadow: '0 6px 16px rgba(0,0,0,.4)',
            },
          },
            React.createElement('input', {
              placeholder: '过滤历史…（只显示最近 30 条匹配）',
              value: searchRef.current,
              onChange: function (e) { searchRef.current = e.target.value; setSearchTick(function (x) { return x + 1 }) },
              style: { width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(140,140,160,.45)', background: 'transparent', color: 'inherit' },
            }),
            React.createElement('div', { style: { maxHeight: '260px', overflowY: 'auto', marginTop: '6px' } },
              rows.length ? rows : React.createElement('div', { style: { fontSize: '12px', opacity: 0.6, padding: '6px 4px' } }, '无匹配条目')),
            React.createElement('div', { style: { fontSize: '11px', opacity: 0.55, marginTop: '6px' } }, '× 仅隐藏回填，不删除会话记录，可在 localStorage 清理后恢复。')
          ))
        }
        return React.createElement('span', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } }, headerChildren)
      }

      function Overlay() {
        var v = React.useState(0)
        var force = v[1]
        React.useEffect(function () {
          return subscribe(function () { force(function (x) { return x + 1 }) })
        }, [])
        var t = store.toast
        var m = store.menu
        var children = []
        if (t) {
          children.push(React.createElement('div', { key: 'toast', style: {
            position: 'fixed', bottom: '28px', left: '50%', transform: 'translateX(-50%)',
            background: 'var(--dsh-toast-bg, #1e1e2e)', color: 'var(--dsh-toast-fg, #e6e6ef)',
            border: '1px solid rgba(140,140,160,.45)', borderRadius: '8px',
            padding: '10px 18px', fontSize: '13px', zIndex: 10002, boxShadow: '0 4px 12px rgba(0,0,0,.4)',
            maxWidth: '70vw', pointerEvents: 'none',
          } }, t.msg))
        }
        if (m) {
          // Two-step PERMANENT delete: the first click only flips the menu item
          // into a "confirm?" row; the file removal happens on the second click.
          // Wording is deliberately 删除 (local log file removed, irreversible)
          // since 0.1.8 — never 归档. Double confirmation is the only guard, so
          // keep it: no silent deletes, no delete without an explicit 2nd click.
          var confirmItem = function () { setStore({ menu: Object.assign({}, m, { confirm: true }) }) }
          function deleteErrorText(e) {
            var msg = String((e && e.message) || e || '')
            // 0.1.11+: 409 carries the server busy reason (running|jobs|busy).
            // Only a *working* session refuses now — an idle one (even the
            // current session) is deletable, so "switch away" is no longer
            // the advice; "wait for it to finish" is.
            if (msg.indexOf('HTTP 409') !== -1) {
              if (msg.indexOf('jobs') !== -1) return '该会话有后台任务在跑：请等待任务完成后再删除。'
              if (msg.indexOf('running') !== -1) return '该会话正在生成中：请等待本轮完成后再删除。'
              return '该会话正忙：请等待生成/后台任务完成后再删除。'
            }
            if (msg.indexOf('HTTP 404') !== -1) return '会话记录已不存在（可能已被删除）。'
            if (msg.indexOf('HTTP 501') !== -1) return '当前存储后端不支持删除（无法定位会话文件）。'
            return '删除失败：' + msg
          }
          // [0.1.13] After deleting the CURRENT session, move the UI along
          // instead of only reminding: try the session service's own
          // navigation hooks, then the app's own "新会话" button, and only
          // then fall back to the reminder toast. A message sent into the
          // deleted session's view would recreate its record.
          function switchAwayFromDeleted(deletedSid) {
            try {
              var svc = null
              try { svc = (ctx && typeof ctx.get === 'function') ? ctx.get('sessions') : null } catch (e) { svc = null }
              if (!svc) { try { svc = ctx.sessions } catch (e) {} }
              var candidates = []
              try {
                var data = sessionsCache && sessionsCache.data && sessionsCache.data.sessions
                if (Array.isArray(data)) for (var i = 0; i < data.length; i++) {
                  if (data[i] && data[i].id && data[i].id !== deletedSid) candidates.push(data[i].id)
                }
              } catch (e) {}
              for (var c = 0; c < candidates.length; c++) {
                var id = candidates[c]
                var hooks = ['openSession', 'selectSession', 'activateSession', 'open', 'select', 'activate']
                for (var h = 0; h < hooks.length; h++) {
                  try {
                    if (svc && typeof svc[hooks[h]] === 'function') {
                      var r = svc[hooks[h]](id)
                      if (r && typeof r.catch === 'function') r.catch(function () {})
                      toast('已彻底删除本地会话记录（已自动切换到其他会话）')
                      return
                    }
                  } catch (e) {}
                }
              }
            } catch (e) {}
            try {
              var btns = document.querySelectorAll('button, [role=button], a')
              for (var b = 0; b < btns.length; b++) {
                var el = btns[b]
                if (!el) continue
                var txt = (el.textContent || '').trim()
                if (txt.indexOf('新会话') !== -1 && txt.length <= 8) {
                  el.click()
                  toast('已彻底删除本地会话记录（已自动新建会话）')
                  return
                }
              }
            } catch (e) {}
            toast('已彻底删除本地会话记录（这是当前会话，请切换到其他会话）')
          }
          var doArchive = function () {
            var sid = m.sid
            var rowEl = m.el
            // 0.1.11+: deleting the idle current session is allowed — remind
            // the user to switch away afterwards, or the next message sent in
            // this same view would recreate its log file.
            var isCurrent = false
            try { isCurrent = !!(sid && currentSidRef.id && sid === currentSidRef.id) } catch (e) { isCurrent = false }
            setStore({ menu: null })
            if (!sid) return
            toast('正在彻底删除该会话的本地记录…（不可恢复）')
            deleteApi(sid).then(function () {
              // Immediate hide without a full page reload (which would destroy
              // the current composer draft). DOM hide is only the first layer:
              // a React re-render would resurrect the row, so the session
              // store is updated too (see below). Host already detached +
              // archived the id, whose workspace feed hides the row even if
              // the list pull below races it.
              try {
                if (rowEl && rowEl.style) rowEl.style.display = 'none'
              } catch (e) {}
              // Our own /sessions fallback cache must not serve the deleted id.
              try {
                sessionsCache = { at: 0, data: null }
              } catch (e) {}
              // Drop this session's client-side recall-hiding cruft: the log is
              // gone, so a forgotten-set for it would only be dead weight.
              try {
                window.localStorage.removeItem('dsh-session-plugin:forgotten:' + sid)
              } catch (e) {}
              // Drop the row from the client session manager so it never comes
              // back as a clickable ghost ("session not found" on open), then
              // pull a fresh baseline to confirm (cold ids vanish there; live
              // ghosts stay hidden via the archived feed).
              try {
                var sessSvc = null
                try { sessSvc = (ctx && typeof ctx.get === 'function') ? ctx.get('sessions') : null } catch (e) { sessSvc = null }
                if (!sessSvc) { try { sessSvc = ctx.sessions } catch (e) {} }
                if (sessSvc) {
                  try { if (typeof sessSvc.handleSessionRemoved === 'function') sessSvc.handleSessionRemoved(sid) } catch (e) {}
                  try {
                    if (typeof sessSvc.refresh === 'function') {
                      var r = sessSvc.refresh()
                      if (r && typeof r.catch === 'function') r.catch(function () {})
                    }
                  } catch (e) {}
                }
              } catch (e) {}
              try {
                window.dispatchEvent(new CustomEvent('dsh-session-plugin:deleted', { detail: { sessionId: sid } }))
                window.dispatchEvent(new CustomEvent('dsh-session-plugin:archived', { detail: { sessionId: sid } }))
              } catch (e) {}
              if (isCurrent) { switchAwayFromDeleted(sid) } else { toast('已彻底删除本地会话记录') }
            }).catch(function (e) { toast(deleteErrorText(e)) })
          }
          children.push(React.createElement('div', {
            key: 'backdrop',
            onClick: function () { setStore({ menu: null }) },
            onContextMenu: function (ev) { ev.preventDefault(); setStore({ menu: null }) },
            style: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10000, background: 'transparent' },
          }))
          var items = []
          items.push(React.createElement('div', {
            key: 'label',
            style: { padding: '6px 16px', fontSize: '11px', color: '#9a9ab0', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, m.label || '会话'))
          if (m.ambiguous && !m.sid) {
            items.push(React.createElement('div', {
              key: 'ambig',
              style: { padding: '4px 16px 8px', fontSize: '11px', color: '#f5a97f', maxWidth: '260px' },
            }, '存在多个同名会话，无法确定目标；请重命名后再试。'))
          }
          if (!m.sid && !m.ambiguous) {
            items.push(React.createElement('div', {
              key: 'unknown',
              style: { padding: '4px 16px 8px', fontSize: '11px', color: '#f5a97f', maxWidth: '260px' },
            }, '无法确定该行的会话归属（DSH 界面结构已变化），为避免误删已禁用操作。'))
          }
          if (m.confirm && m.sid) {
            items.push(React.createElement('div', {
              key: 'warn',
              style: { padding: '4px 16px 6px', fontSize: '11px', color: '#f5a97f', maxWidth: '260px', whiteSpace: 'normal' },
            }, '彻底删除本地记录，不可恢复；正在生成/跑后台任务的会话会被拒绝。'))
            try {
              if (m.sid && currentSidRef.id && m.sid === currentSidRef.id) {
                items.push(React.createElement('div', {
                  key: 'warn-current',
                  style: { padding: '0 16px 6px', fontSize: '11px', color: '#f5a97f', maxWidth: '260px', whiteSpace: 'normal' },
                }, '这是当前正在查看的会话：删除后会自动切换到其他会话（失败则请手动切换）。'))
              }
            } catch (e) {}
            items.push(React.createElement('div', {
              key: 'yes',
              style: { padding: '8px 16px', cursor: 'pointer', color: '#ff7b72', fontSize: '13px', fontWeight: 'bold', whiteSpace: 'nowrap' },
              onMouseEnter: function (e) { e.currentTarget.style.background = 'rgba(140,140,160,.18)' },
              onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' },
              onClick: doArchive,
            }, '确认彻底删除该会话'))
            items.push(React.createElement('div', {
              key: 'no',
              style: { padding: '8px 16px', cursor: 'pointer', fontSize: '13px', whiteSpace: 'nowrap' },
              onMouseEnter: function (e) { e.currentTarget.style.background = 'rgba(140,140,160,.18)' },
              onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' },
              onClick: function () { setStore({ menu: null }) },
            }, '取消'))
          } else if (m.sid) {
            items.push(React.createElement('div', {
              key: 'del',
              style: { padding: '8px 16px', cursor: 'pointer', color: '#ff7b72', fontSize: '13px', whiteSpace: 'nowrap' },
              onMouseEnter: function (e) { e.currentTarget.style.background = 'rgba(140,140,160,.18)' },
              onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' },
              onClick: confirmItem,
            }, '删除该会话…'))
          }
          // Clamp into the viewport so the menu is never clipped off-screen
          // near the right/bottom edge.
          var mx = (typeof m.x === 'number' ? m.x : 0)
          var my = (typeof m.y === 'number' ? m.y : 0)
          try {
            mx = Math.max(8, Math.min(mx, window.innerWidth - 190))
            my = Math.max(8, Math.min(my, window.innerHeight - 150))
          } catch (e) {}
          children.push(React.createElement('div', { key: 'menu', style: {
            position: 'fixed', left: mx + 'px', top: my + 'px',
            background: 'var(--dsh-menu-bg, #1e1e2e)', color: 'var(--dsh-menu-fg, inherit)',
            border: '1px solid rgba(140,140,160,.45)', borderRadius: '8px', padding: '4px 0', minWidth: '150px',
            boxShadow: '0 6px 16px rgba(0,0,0,.4)', zIndex: 10001,
          } }, items))
        }
        return React.createElement('div', null, children)
      }

      ctx.effect(function () {
        function onCtx(e) {
          // Session rows (SessionNodeItem, SearchResultItem) carry
          // role="treeitem" + aria-selected; workspace/project group rows use
          // role="treeitem" + aria-expanded and never match this selector.
          // NOTE: there is deliberately NO container allowlist here. DSH renders
          // no stable container markers (verified: zero `data-dsh-role` attrs in
          // dsh-client-ui-workspace), so gating on one matched nothing and killed
          // the menu entirely. The React-fiber record below IS the authority
          // test instead: only real session rows render from `{node}` /
          // `{result}` props, so file-tree and other treeitem rows resolve to
          // null and never reach a delete button. The title fallback stays
          // unique-match-only, so a non-session row can at most show
          // "无法确定归属", never someone else's delete.
          var el = e.target && e.target.closest ? e.target.closest('[role="treeitem"][aria-selected]') : null
          if (!el) return
          // Case-insensitive-ish: session rows use `title`, search results use
          // `searchResultTitle` (capital T).
          var titleEl = el.querySelector ? el.querySelector('span[class*="itle"]') : null
          var title = (titleEl ? titleEl.textContent : el.textContent) || ''
          title = title.replace(/\s+/g, ' ').trim()
          if (!title) return
          e.preventDefault()
          e.stopPropagation()
          var fiberId = resolveSessionId(el)
          if (fiberId) {
            // Authoritative path: no title lookup at all.
            setStore({ menu: { x: e.clientX, y: e.clientY, sid: fiberId, label: title, el: el } })
            return
          }
          try { if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-session-plugin] fiber lookup missed, falling back to title match') } catch (e2) {}
          listSessionsApi().then(function (all) {
            var matches = []
            for (var i = 0; i < all.length; i++) {
              if (all[i].title === title) matches.push(all[i])
            }
            setStore({
              menu: {
                x: e.clientX, y: e.clientY,
                sid: matches.length === 1 ? matches[0].id : null,
                ambiguous: matches.length > 1,
                label: title,
                el: el,
              },
            })
          }).catch(function () {
            setStore({ menu: { x: e.clientX, y: e.clientY, sid: null, label: title, el: el } })
          })
        }
        document.addEventListener('contextmenu', onCtx, true)
        return function () { document.removeEventListener('contextmenu', onCtx, true) }
      })

      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'input-history', order: 50, label: '输入历史' },
          HistoryHook,
        )
      })
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'input-history-overlay', order: 100, label: '输入历史浮层' },
          Overlay,
        )
      })
    }

    var module = { exports: {} }
    var exports = module.exports
    exports.inject = ['slots', 'timer']
    exports.apply = apply
    return module.exports
  },
})