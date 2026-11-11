// Host half of @heeweelee/dsh-session-plugin.
//
// Ported 1:1 from the dynamic Cordis plugin `sess-7/pkg-9`
// ("Session Input History + Archive") with one architectural change: the
// dynamic runtime's `harness.handle(...)` / `host.call(...)` private RPC is
// replaced by plain JSON routes on the Host `webServer` service, which the
// Client half fetches from the same origin.
//
// Deletion semantics (0.1.9+): the destructive route PERMANENTLY deletes the
// session's local log directory from disk (irreversible) AND removes it from
// the workspace view. File removal alone leaves a ghost row: the workspace
// record still accounts the id and the client session list still holds the
// summary, so clicking the leftover row fails with "session not found".
// After a successful rm this plugin therefore also (best-effort, never fatal):
//   1. detachSession on every workspace accounting the id (cleans the durable
//      `sessionIds` record), then
//   2. archiveSession (official hide feed — the client filters archived ids
//      everywhere, so the row disappears immediately without a reload).
// DSH itself exposes only `workspaceRegistry.archiveSession` (hide); there is
// no official delete-session API, so the file part still resolves the
// backend-owned artifact via `sessionPersistence.locate(header)` and removes
// `<sessionDir>/session.jsonl[.zstd]` (+ empty parent dir). Busy sessions (a
// turn running or background jobs active) are refused with 409 — idle and
// cold sessions are deletable (0.1.11+: merely viewing a session mounts its
// agent, so "mounted ⇒ busy" blocked even the idle current session).
//
// Performance notes (measured on an ~9 MB zstd session log):
//   - ctx.sessionQuery.readSession() decompresses and replay-validates the whole
//     log, taking ~3.6s. It is only ever run on a cache miss or when the client
//     explicitly forces a refresh (`refresh=1`) after sending a message.
//   - Two cache layers keep normal recall instant:
//       1. in-memory TTL cache (~1s) absorbs bursts right after a send;
//       2. a disk-persisted cache (this plugin's own state file) survives DSH
//          restarts, so the FIRST recall after a restart hits disk (<10ms)
//          instead of replaying the whole log.
//   - Only the most recent N user messages are kept (configurable, default 100),
//     so the folded history and cache stay bounded.

import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, readdirSync, unlinkSync } from 'node:fs'
import { rm, stat, readdir, rmdir, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, basename, isAbsolute, normalize, sep } from 'node:path';
import { assertSafeArtifactShape } from './safety.js'

export const name = 'dsh-session-plugin'
export const inject = ['sessionQuery', 'workspaceRegistry', 'webServer']

const ROUTE_HISTORY = '/api/dsh-session-plugin/history'
const ROUTE_SESSIONS = '/api/dsh-session-plugin/sessions'
// Canonical destructive route. ROUTE_ARCHIVE is kept as a legacy alias with
// IDENTICAL destructive behavior since 0.1.8 (old clients still call it);
// new clients call ROUTE_DELETE.
const ROUTE_DELETE = '/api/dsh-session-plugin/delete'
const ROUTE_ARCHIVE = '/api/dsh-session-plugin/archive'

// ---------------------------------------------------------------------------
// Configuration & disk cache state
// ---------------------------------------------------------------------------

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CONFIG_PATH = join(DSH_HOME, 'dsh-session-plugin.json')
const CACHE_PATH = join(DSH_HOME, 'dsh-session-plugin-history-cache.json')

/** Default recall window: keep the most recent N user messages per session. */
const DEFAULT_HISTORY_LIMIT = 100
/** Hard ceiling so a typo in the config cannot balloon memory/disk. */
const MAX_HISTORY_LIMIT = 10000
/** Single-entry truncation so one huge paste cannot balloon memory/disk. */
const DEFAULT_MAX_CHARS_PER_ENTRY = 4000
const MAX_CHARS_PER_ENTRY_CEIL = 20000

let historyLimit = DEFAULT_HISTORY_LIMIT
let maxCharsPerEntry = DEFAULT_MAX_CHARS_PER_ENTRY
/** When true, skip disk persistence (memory TTL cache still works). */
let disableDiskCache = false

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const n = raw && typeof raw.historyLimit === 'number' ? Math.floor(raw.historyLimit) : NaN
    if (Number.isFinite(n) && n > 0) {
      historyLimit = Math.min(n, MAX_HISTORY_LIMIT)
    }
    const m = raw && typeof raw.maxCharsPerEntry === 'number' ? Math.floor(raw.maxCharsPerEntry) : NaN
    if (Number.isFinite(m) && m > 0) {
      maxCharsPerEntry = Math.min(m, MAX_CHARS_PER_ENTRY_CEIL)
    }
    if (raw && raw.disableDiskCache === true) disableDiskCache = true
  } catch {
    // no config file / unreadable → defaults
  }
}

function truncateEntry(text) {
  if (typeof text !== 'string') return ''
  if (text.length <= maxCharsPerEntry) return text
  return text.slice(0, maxCharsPerEntry) + '…（已截断）'
}

// { version: 2, sessions: { [sessionId]: { ts, history, limit } } } — history is
// the folded, capped + truncated user-message list, so the file stays small.
// `limit` records the historyLimit the entry was folded with; a config change
// invalidates stale entries instead of serving a permanently truncated list.
let diskCache = null

function loadDiskCache() {
  if (disableDiskCache) {
    diskCache = { version: 2, sessions: {} }
    // disableDiskCache means "no plaintext on disk": remove a stale cache
    // file left by an earlier run instead of leaving it behind.
    try { unlinkSync(CACHE_PATH) } catch {}
    return
  }
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    if (raw && (raw.version === 1 || raw.version === 2) && raw.sessions && typeof raw.sessions === 'object') {
      // v1 entries lack `limit` — they are still readable but treated as stale
      // when historyLimit differs (see readInputHistory); migrate version lazily.
      raw.version = 2
      diskCache = raw
      return
    }
  } catch {
    // first boot / corrupt file → fresh state
  }
  diskCache = { version: 2, sessions: {} }
}

/** Remove `*.pid.ts.tmp` files left by a crashed atomicWriteJson. Runs even
 * when the disk cache is disabled, so switching modes never leaves cruft. */
function cleanupStaleTmpFiles() {
  try {
    const dir = dirname(CACHE_PATH)
    const prefix = basename(CACHE_PATH) + '.'
    let names = null
    try { names = readdirSync(dir) } catch { return }
    for (const n of names || []) {
      if (n.startsWith(prefix) && n.endsWith('.tmp')) {
        try { unlinkSync(join(dir, n)) } catch {}
      }
    }
  } catch {}
}

function atomicWriteJson(path, data) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch {}
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch {}
}

let saveTimer = null
function scheduleSaveDiskCache() {
  if (disableDiskCache) return
  if (saveTimer !== null) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      trimDiskCache()
      atomicWriteJson(CACHE_PATH, diskCache)
    } catch {
      // best-effort persistence; next write retries
    }
  }, 200)
  // A pending timer must never keep the host process alive by itself.
  if (saveTimer && typeof saveTimer.unref === 'function') {
    try { saveTimer.unref() } catch {}
  }
}

function clearSaveTimer() {
  if (saveTimer !== null) {
    try { clearTimeout(saveTimer) } catch {}
    saveTimer = null
  }
}

/** Keep at most 128 sessions AND at most 32MB of plaintext in the disk cache
 * (oldest ts evicted first). The cache holds raw user message text, so the
 * unbounded byte budget was a real disk-fill risk: 128 sessions x 100
 * entries x 4000 chars could approach 50MB of plaintext. [0.1.13] */
const MAX_DISK_CACHE_BYTES = 32 * 1024 * 1024
function trimDiskCache() {
  const keys = Object.keys(diskCache.sessions)
  if (keys.length > 128) {
    keys.sort((a, b) => (diskCache.sessions[a].ts || 0) - (diskCache.sessions[b].ts || 0))
    for (let i = 0; i < keys.length - 96; i++) delete diskCache.sessions[keys[i]]
  }
  // Byte budget: evict oldest-ts entries until the serialized cache fits.
  const remaining = Object.keys(diskCache.sessions)
  let total = 0
  const sizes = new Map()
  for (const k of remaining) {
    const bytes = Buffer.byteLength(JSON.stringify(diskCache.sessions[k] || {}), 'utf8')
    sizes.set(k, bytes)
    total += bytes
  }
  if (total <= MAX_DISK_CACHE_BYTES) return
  remaining.sort((a, b) => (diskCache.sessions[a].ts || 0) - (diskCache.sessions[b].ts || 0))
  for (const k of remaining) {
    if (total <= MAX_DISK_CACHE_BYTES) break
    total -= sizes.get(k) || 0
    delete diskCache.sessions[k]
  }
}

// /sessions title cache (0.1.13): id -> { title, sig, at }; sig is the
// artifact's `size:mtime` so unchanged files are served from memory instead
// of re-read on every right-click menu open.
const titleCache = new Map()

loadConfig()
loadDiskCache()
cleanupStaleTmpFiles()

// ---------------------------------------------------------------------------
// In-memory TTL cache
// ---------------------------------------------------------------------------

const HISTORY_CACHE_TTL_MS = 1000
const historyCache = new Map() // sessionId -> { expires, history }

function cacheGet(sessionId) {
  const now = Date.now()
  const hit = historyCache.get(sessionId)
  if (hit && hit.expires > now) return hit.history
  if (hit) historyCache.delete(sessionId)
  return undefined
}

function cacheSet(sessionId, history) {
  const now = Date.now()
  historyCache.set(sessionId, { expires: now + HISTORY_CACHE_TTL_MS, history })
  // opportunistic sweep: never grow without bound
  if (historyCache.size > 64) {
    for (const [k, v] of historyCache) {
      if (v.expires <= now) historyCache.delete(k)
    }
  }
}

// ---------------------------------------------------------------------------
// History folding
// ---------------------------------------------------------------------------

function capHistory(history) {
  return history.length > historyLimit ? history.slice(-historyLimit) : history
}

/**
 * Fold the recent user messages of one session.
 *
 * `force` skips every cache (used by the client right after sending a message,
 * when the log definitely gained a new event). Non-forced reads hit the memory
 * cache, then the disk cache, and only fall through to the expensive
 * readSession replay when neither has the session yet.
 *
 * Disk entries record the `limit` they were folded with: when historyLimit is
 * raised, a stale capped entry is treated as a miss so the slow path can
 * refill the full window once (instead of serving a permanently truncated list).
 *
 * @returns {{ history: string[], limit: number }}
 */
async function readInputHistory(ctx, sessionId, force) {
  if (!force) {
    const mem = cacheGet(sessionId)
    if (mem !== undefined) return { history: capHistory(mem), limit: historyLimit }
    const dc = diskCache.sessions[sessionId]
    // v1 entries lack `limit`: they were folded with the default window, so
    // they are only fresh when historyLimit is still the default. Otherwise
    // treat them as a miss so the slow path refills the full window once.
    if (dc && Array.isArray(dc.history) && (dc.limit === historyLimit ||
      (dc.limit === undefined && historyLimit === DEFAULT_HISTORY_LIMIT))) {
      cacheSet(sessionId, dc.history)
      return { history: capHistory(dc.history), limit: historyLimit }
    }
  }

  let history = []
  try {
    const snap = await ctx.sessionQuery.readSession(sessionId)
    const events = (snap && Array.isArray(snap) ? snap : (snap && snap.events)) || []
    for (const ev of events) {
      if (!ev || ev.type !== 'user/message' || !ev.data) continue
      const src = ev.data.source
      if (!src || src.kind !== 'user') continue
      let text = ''
      const content = ev.data.content
      if (Array.isArray(content)) {
        text = content.map((c) => (c && c.text ? c.text : '')).join('')
      } else if (typeof content === 'string') {
        text = content
      } else if (content && typeof content.text === 'string') {
        text = content.text
      }
      if (text) history.push(truncateEntry(text))
    }
  } catch {
    // The slow path failed; fall back to whatever the caches still hold so a
    // transient query error does not wipe the recall list.
    const fallback = cacheGet(sessionId) ?? diskCache.sessions[sessionId]?.history
    if (fallback !== undefined) {
      return { history: capHistory(fallback), limit: historyLimit }
    }
    return { history: [], limit: historyLimit }
  }

  const capped = capHistory(history)
  cacheSet(sessionId, capped)
  if (!disableDiskCache) {
    diskCache.sessions[sessionId] = { ts: Date.now(), history: capped, limit: historyLimit }
    scheduleSaveDiskCache()
  }
  return { history: capped, limit: historyLimit }
}

// Force-refresh throttle: `refresh=1` replays the whole session log (seconds on
// large logs). At most one forced replay per session per window; throttled calls
// fall back to the cached path and report `throttled: true` so the client can
// keep its pending entry visible instead of spinning.
const FORCE_MIN_INTERVAL_MS = 2000
const lastForceAt = new Map() // sessionId -> timestamp ms
/** Bound the throttle table the same way as the caches (oldest evicted first). */
const MAX_FORCE_ENTRIES = 256
function noteForceAt(sessionId, now) {
  lastForceAt.set(sessionId, now)
  if (lastForceAt.size > MAX_FORCE_ENTRIES) {
    // Map preserves insertion order: delete oldest until back under budget.
    // A re-set key moves to the tail, so hot sessions survive.
    const overflow = lastForceAt.size - MAX_FORCE_ENTRIES
    let n = 0
    for (const k of lastForceAt.keys()) {
      if (n++ >= overflow) break
      lastForceAt.delete(k)
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function isValidSessionId(value) {
  // Allowlist: alphanumerics plus _ - : — covers UUID-style ids while rejecting
  // path separators, dots (.. traversal), whitespace and control chars.
  // If DSH ever mints ids outside this set, extend here (and keep / \ . out).
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9_:\-]+$/.test(value)
}

function readQuerySessionId(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const value = url.searchParams.get('sessionId')
    return isValidSessionId(value) ? value : undefined
  } catch {
    return undefined
  }
}

function readQueryRefresh(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    return url.searchParams.get('refresh') === '1'
  } catch {
    return false
  }
}

// Read routes carry sensitive user text. They cause no state change, so they do
// not require the custom header — but they DO require an empty-or-same-origin
// Origin, so a future CORS change upstream cannot turn them into a
// cross-site read oracle (DNS-rebinding style).
function isOriginSafe(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const o = new URL(origin)
    const proto = (req.socket && req.socket.encrypted) ? 'https:' : 'http:'
    return o.protocol === proto && o.host === (req.headers.host || '')
  } catch {
    return false
  }
}

// Archive is a state-changing route served without auth on localhost. Browsers
// can send "simple" cross-site POSTs (no CORS preflight) at any local port while
// a malicious page is open, so the route requires BOTH:
//   1. the custom header `x-dsh-csrf: 1` — a cross-site form/simple-POST cannot
//      carry it, and adding it forces a CORS preflight this server never
//      satisfies, so the browser blocks the real request;
//   2. an Origin that either is absent (in-process callers, curl) or whose
//      host matches the request's own Host header (same-origin fetch).
function isCsrfSafe(req) {
  if (req.headers['x-dsh-csrf'] !== '1') return false
  return isOriginSafe(req)
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

// ---------------------------------------------------------------------------
// Permanent local deletion (0.1.8+)
// ---------------------------------------------------------------------------

class SessionLiveError extends Error {
  constructor(sessionId, reason) {
    super(`cannot delete busy session '${sessionId}': wait until its running turn/background jobs finish`)
    this.name = 'SessionLiveError'
    this.sessionId = sessionId
    // Machine-readable busy cause, echoed in the 409 body so the client can
    // tell "generating" from "background jobs": 'running' | 'jobs' | 'busy'.
    this.reason = reason || 'busy'
  }
}

class SessionNotFoundError extends Error {
  constructor(sessionId) {
    super(`session not found: '${sessionId}'`)
    this.name = 'SessionNotFoundError'
    this.sessionId = sessionId
  }
}

function evictPluginCaches(sessionId) {
  try { historyCache.delete(sessionId) } catch {}
  try {
    if (diskCache && diskCache.sessions && diskCache.sessions[sessionId]) {
      delete diskCache.sessions[sessionId]
      scheduleSaveDiskCache()
    }
  } catch {}
  try { lastForceAt.delete(sessionId) } catch {}
}

/**
 * Best-effort workspace cleanup after the log file is gone (0.1.9+).
 *
 * File removal alone leaves a ghost row: the workspace record still accounts
 * the id and the client session list still holds the summary, so the leftover
 * row stays clickable and opening it fails with "session not found".
 * This helper removes the id from every workspace (`detachSession`, cleans
 * the durable `sessionIds` record) and then clears the registry-global
 * archive/pin sets (`unarchiveSession` / `unpinSession`) so the deleted id
 * has no remaining reference to render. [patch 2026-11-11: the old
 * `archiveSession` tombstone now renders as an archived ghost row in the
 * unassigned group on new DSH clients.]
 *
 * Never throws — file deletion already succeeded (or was already gone);
 * workspace cleanup must not turn that into a 500. An unknown-session
 * archive failure is expected when the header cache already dropped the id;
 * the detached accounting + session-list refresh still hide the row.
 */
/** Degraded-path logging (0.1.13): cleanup failures must never turn into a
 * 500 after the file is gone, but they must not vanish silently either — a
 * changed host signature (detachSession shape, registry availability) should
 * leave a debug trail instead of surfacing as "the ghost row came back". */
function cleanupWarn(ctx, what, e) {
  try {
    const log = ctx && ctx.logger
    if (log && typeof log.debug === 'function') log.debug(`[dsh-session-plugin] ${what}`, e)
    else if (typeof console !== 'undefined' && console && typeof console.debug === 'function') console.debug(`[dsh-session-plugin] ${what}`, e)
  } catch {}
}

async function cleanupWorkspaceAfterDelete(ctx, sessionId) {
  // [local patch 2026-11-11] Detach the LIVE session entry from the session
  // store first: a deleted-but-mounted session keeps a live row in the
  // session-query index (temp.live_sessions), which serves the ghost list row
  // and re-projects it (rewriting the projection cache) until detached.
  // `liveEntryFor(live).detach` is the store's own removal path
  // (detachEntered: store.delete + attachment clear + session/disposed).
  try {
    const store = ctx.get('sessions')
    const live = store?.get?.(sessionId)
    if (live != null) {
      // 0.1.13: best-effort explicit disposal first when the host exposes one;
      // the store detach below is the reliable removal path and already emits
      // `session/disposed` via detachEntered (verified in the dsh-session
      // SessionStore source), so a missing dispose() is never a failure.
      try { await live.dispose?.() } catch (e) { cleanupWarn(ctx, 'session dispose() unavailable/failed (store detach follows)', e) }
      if (typeof store.liveEntryFor === 'function') {
        const entry = store.liveEntryFor(live)
        if (entry && typeof entry.detach === 'function') entry.detach()
      }
    }
  } catch (e) { cleanupWarn(ctx, 'live-session detach failed', e) }
  try {
    let registry = null
    try { registry = ctx.workspaceRegistry ?? null } catch (e) { registry = null; cleanupWarn(ctx, 'workspaceRegistry property probe failed (expected fallback)', e) }
    if (!registry) {
      try { registry = ctx.get('workspaceRegistry') ?? null } catch (e) { registry = null; cleanupWarn(ctx, 'workspaceRegistry lookup failed', e) }
    }
    if (!registry) return
    try {
      let list = typeof registry.list === 'function' ? registry.list() : []
      // list() may be sync or async depending on host version — await a
      // thenable so an async registry does not silently skip every detach
      // (a Promise is not iterable; without this the ghost row comes back).
      if (list && typeof list.then === 'function') {
        try { list = await list } catch (e) { list = []; cleanupWarn(ctx, 'workspaceRegistry.list() rejected', e) }
      }
      for (const ws of list || []) {
        try {
          // detachSession is idempotent (no-op when not accounted).
          if (ws && typeof ws.detachSession === 'function') {
            await ws.detachSession(sessionId)
          }
        } catch (e) { cleanupWarn(ctx, 'workspace detachSession failed', e) }
      }
    } catch (e) { cleanupWarn(ctx, 'workspace detach sweep failed', e) }
    // [local patch 2026-11-11] New DSH clients RENDER archived ids (the old
    // client filtered them), so leaving an archive tombstone for the deleted id
    // makes it reappear as an archived row in the unassigned group — exactly the
    // ghost this cleanup exists to prevent. Clear the tombstone instead:
    // unarchive is explicitly allowed for sessions that no longer exist (it only
    // removes the id from the registry-global set). Unpin too, so a pinned
    // deleted id cannot linger either.
    try {
      if (typeof registry.unarchiveSession === 'function') {
        await registry.unarchiveSession(sessionId)
      }
    } catch (e) { cleanupWarn(ctx, 'unarchiveSession failed', e) }
    try {
      if (typeof registry.unpinSession === 'function') {
        await registry.unpinSession(sessionId)
      }
    } catch (e) { cleanupWarn(ctx, 'unpinSession failed', e) }
  } catch (e) { cleanupWarn(ctx, 'workspace cleanup failed', e) }
  // [local patch 2026-11-11] Remove the session projection cache entry too:
  // the UI session list can be served from
  // `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`, and leaving it
  // behind resurrects the deleted row in the "未分组" group. Strict shape
  // check — exact `<sessionId>.json` in that one known directory, never a
  // symlink — mirroring the artifact validation above.
  try {
    const projDir = normalize(join(DSH_HOME, 'storages', 'session_projcache', 'sessions'))
    const projPath = normalize(join(projDir, `${sessionId}.json`))
    if (isAbsolute(projPath) && basename(projPath) === `${sessionId}.json` && dirname(projPath) === projDir) {
      const st = await lstat(projPath).catch(() => null)
      if (st && typeof st.isSymbolicLink === 'function' && !st.isSymbolicLink()) {
        await rm(projPath, { force: true })
      }
    }
  } catch (e) { cleanupWarn(ctx, 'projection-cache removal failed', e) }
}

/**
 * Idle-vs-busy probe for one session's agent (0.1.11+).
 *
 * Old rule ("any mounted agent → 409") blocked nearly everything: merely
 * *viewing* a session mounts its agent and the mount lingers after the turn
 * finishes, so even the idle current session could never be deleted. New
 * rule: only a session that is actually doing work refuses deletion —
 *   - agent.status === 'running' (a turn is in flight; the loop publishes
 *     exactly 'idle' | 'running'), or
 *   - the `jobs` service lists a non-terminal job for it (background work).
 * A mounted-but-idle agent with no active jobs is deletable: the caller
 * flushes its write-behind queue first, so no buffered tail is lost.
 *
 * Fail-closed wherever the shape is unknown: an unreadable agent status, an
 * unlisted status string, or (when there is no agents service at all) any
 * resident session all count as busy — a destructive rm must never race an
 * unverifiable writer.
 *
 * @returns {null | { reason: 'running' | 'jobs' | 'busy' }} null when deletable.
 */
function agentBusyReason(ctx, sessionId) {
  let agentsService = null
  try { agentsService = ctx.get('agents') } catch { agentsService = null }
  if (!agentsService || typeof agentsService.get !== 'function') return null
  let agent = null
  try { agent = agentsService.get(sessionId) } catch { agent = null }
  // Both null and undefined count as absent (some hosts report null).
  if (agent == null) return null
  let status = null
  try { status = agent.status } catch { status = null }
  if (status === 'running') return { reason: 'running' }
  if (status !== 'idle') return { reason: 'busy' }
  // Idle mount: background jobs are the remaining writer risk. jobs.list(agent)
  // returns this session's jobs (plus rare global unowned ones — blocking on
  // those too is the conservative choice for a destructive op, mirroring what
  // the first-party session controller broadcasts per session).
  try {
    const jobsSvc = ctx.get('jobs')
    if (jobsSvc && typeof jobsSvc.list === 'function') {
      let list = null
      try { list = jobsSvc.list(agent) } catch { list = null }
      if (Array.isArray(list)) {
        for (const j of list) {
          const st = j && j.status
          // Mirror dsh-jobs-local isTerminal: completed/killed/failed are
          // done; anything else (running/stopping/unknown) fails closed.
          if (st !== 'completed' && st !== 'killed' && st !== 'failed') {
            return { reason: 'jobs' }
          }
        }
      }
    }
  } catch {
    // jobs lookup failing → ignore here; the post-flush re-check below still
    // guards the rm against a turn that starts concurrently.
  }
  return null
}

/**
 * Permanently delete one session's local log directory AND remove it from
 * the workspace view (0.1.9+: file rm + detach + archive).
 *
 * Liveness is busy-based (0.1.11+), because merely *viewing* a session mounts
 * its agent and the mount lingers after the turn finishes — gating on
 * "mounted" blocked nearly everything, including the idle current session.
 * Instead:
 *   1. agent mounted AND busy (`status === 'running'` → a turn is in flight,
 *      or the `jobs` service lists a non-terminal job → background work) →
 *      refuse 409 with reason 'running'/'jobs' (see agentBusyReason).
 *   2. mounted but idle with no active jobs → drain the write-behind queue
 *      via the store-owned `flush(session)` checkpoint, re-check busyness
 *      once (another tab may have started a turn while we were flushing),
 *      then delete. (A turn starting between the final gate and rm stays a
 *      narrow documented race.)
 *   3. cold session (no agent) → delete directly.
 * When the `agents` service is absent (unknown host), fall back to the strict
 * rule: any resident session refuses with 409, since idle-vs-running cannot
 * be told apart. "Absent" means a null/undefined service value (0.1.10+);
 * an unreadable agent shape fails closed (busy).
 *
 * Then: resolve the header (persistence list, then sessionQuery fallback) →
 * `sessionPersistence.locate(header).path` → strict artifact-shape validation
 * (0.1.10+: absolute path, exact `session.jsonl[.zstd]` basename, parent dir
 * named for this sessionId, home/config roots excluded, no symlinks on the
 * artifact or its dir) → `rm` the session dir → detach from every workspace
 * + archive (official hide feed) so the row vanishes instead of lingering as
 * a clickable ghost. `registry.list()` may be sync or async (0.1.10+: awaited
 * either way — an async registry previously skipped every detach silently).
 *
 * Only the session's own log directory is removed (`session.jsonl[.zstd]` +
 * its now-empty parent). Attachments are intentionally left alone. The
 * `archivedSessionIds` tombstone for the deleted id is kept on purpose: it is
 * the official hide mechanism (no unarchive API exists), it is invisible in
 * the UI, and after a restart the session is gone from persistence anyway —
 * documented in README.
 *
 * Deleting the currently viewed idle session is allowed, but its in-memory
 * agent/session objects outlive the file (no public API unmounts them):
 * sending another message in that same view would recreate the log file.
 * The client therefore warns when the target is the current session and
 * advises switching away right after deletion.
 *
 * @returns {{ path: string }} the removed artifact path (for logging only;
 *   never echoed to the client verbatim beyond basename).
 */
async function deleteSessionLocally(ctx, sessionId) {
  // 1. Busy guard (0.1.11+: only a *working* session refuses — running turn
  // or active background jobs. An idle-mounted agent, including the currently
  // viewed session at rest, is deletable after a flush).
  let agentsService = null
  try { agentsService = ctx.get('agents') } catch { agentsService = null }
  if (agentsService && typeof agentsService.get === 'function') {
    const busy = agentBusyReason(ctx, sessionId)
    if (busy) throw new SessionLiveError(sessionId, busy.reason)
  } else {
    // Unknown host without an agents service: stay strict — any resident
    // session refuses, rather than risk deleting under a hidden writer.
    try {
      const live = ctx.get('sessions')?.get(sessionId)
      if (live != null) throw new SessionLiveError(sessionId, 'busy')
    } catch (e) {
      if (e instanceof SessionLiveError) throw e
      // ctx.get failing means "no live store" — treat as not-live, continue.
    }
  }

  // 2. Resident-but-idle: drain the persistence write-behind queue through
  // the store-owned flush checkpoint before rm, so buffered tail events are
  // not lost to the void (and a half-flushed file is never left behind).
  try {
    const store = ctx.get('sessions')
    const liveSession = store?.get?.(sessionId)
    if (liveSession != null && store && typeof store.flush === 'function') {
      try { await store.flush(liveSession) } catch {}
    }
  } catch {
    // best effort only — rm is still attempted below.
  }

  // 2b. Re-check busyness AFTER the flush with the same probe: another tab
  // may have started a turn (or a job) while we were flushing/resolving the
  // header. Cheap second gate narrows the documented race to the rm itself.
  try {
    const agentsAgain = ctx.get('agents')
    if (agentsAgain && typeof agentsAgain.get === 'function') {
      const busyAgain = agentBusyReason(ctx, sessionId)
      if (busyAgain) throw new SessionLiveError(sessionId, busyAgain.reason)
    }
  } catch (e) {
    if (e instanceof SessionLiveError) throw e
    // ctx.get failing → no agents service to re-check; continue.
  }

  // 3. Resolve the immutable header (needed for backend-owned locate()).
  const persistence = ctx.get('sessionPersistence')
  let header = null
  if (persistence && typeof persistence.list === 'function') {
    try {
      const headers = await persistence.list()
      if (Array.isArray(headers)) {
        for (const h of headers) {
          if (h && h.id === sessionId) { header = h; break }
        }
      }
    } catch {
      // fall through to the sessionQuery fallback below
    }
  }
  if (!header) {
    try {
      const sessions = await ctx.sessionQuery.listSessions()
      for (const rec of sessions || []) {
        const h = rec && rec.header
        if (h && h.id === sessionId) { header = h; break }
      }
    } catch {
      // list failure → 404 vs 500 decided below (header still null → 404
      // would mask a storage fault; rethrow as generic to surface 500).
      throw new Error(`cannot resolve session '${sessionId}': session listing unavailable`)
    }
  }
  if (!header) {
    // Header already gone (file removed earlier, or never persisted) but the
    // workspace record may still account the id → detach it so no ghost row
    // lingers, then report 404.
    try { await cleanupWorkspaceAfterDelete(ctx, sessionId) } catch {}
    throw new SessionNotFoundError(sessionId)
  }

  // 3. Backend-owned artifact path. No persistence service, or a backend
  // without per-session artifacts (e.g. a future sqlite backend), cannot be
  // deleted at file level — report 501 rather than guessing paths.
  if (!persistence || typeof persistence.locate !== 'function') {
    throw new Error('session persistence backend is unavailable: cannot locate session file')
  }
  let artifactPath = null
  try {
    const loc = persistence.locate(header)
    if (loc && typeof loc.path === 'string') artifactPath = loc.path
  } catch {
    artifactPath = null
  }
  if (!artifactPath) throw new Error(`cannot locate session file for '${sessionId}'`)

  // 4. Strict shape validation BEFORE any rm — extracted to safety.js so the
  // rejection paths are unit-tested (test/delete-safety.test.js). This is the
  // last line of defense against a compromised/buggy locate() pointing at
  // home, root, DSH_HOME, /tmp, or a planted symlink.
  const { artifactPath: normalizedArtifact, base } = await assertSafeArtifactShape(artifactPath, sessionId)
  const sessionDir = dirname(normalizedArtifact)
  artifactPath = normalizedArtifact

  // 5. Remove. The session dir owns only this session's artifacts
  // (root/<project>/<sessionId>/session.jsonl[.zstd]), so rm recursive on the
  // dir is bounded. Try the opposite-compression sibling too (harmless if the
  // backend guarantees a single encoding — rm force ignores absence).
  // [local patch 2026-11-10] derive the opposite-compression sibling from the
  // artifact stem so both legacy and v4 generations pair correctly.
  const siblingName = base.endsWith('.zstd')
    ? base.slice(0, -'.zstd'.length)
    : `${base}.zstd`
  const sibling = join(sessionDir, siblingName)
  let removed = false
  try {
    await stat(artifactPath)
    removed = true
  } catch {
    // Primary artifact already absent — still try the sibling before 404, so
    // a half-migrated (recompressed) session still deletes cleanly.
    try {
      await stat(sibling)
      removed = true
    } catch {}
  }
  try { await rm(sibling, { force: true }) } catch {}
  try { await rm(artifactPath, { force: true }) } catch {}
  // Prune the now-empty session dir (ignore when non-empty: future
  // session-local artifacts must survive).
  try {
    const rest = await readdir(sessionDir)
    if (rest.length === 0) await rmdir(sessionDir)
  } catch {}
  if (!removed) {
    // Neither encoding existed — file already gone. Still detach+archive so a
    // previously-deleted session never lingers as a clickable ghost, then
    // report 404 so the client can inform rather than pretend.
    try { await cleanupWorkspaceAfterDelete(ctx, sessionId) } catch {}
    throw new SessionNotFoundError(sessionId)
  }

  // File is gone: detach from workspaces + archive (official hide feed) so the
  // row disappears immediately instead of staying clickable → "not found".
  try { await cleanupWorkspaceAfterDelete(ctx, sessionId) } catch {}
  evictPluginCaches(sessionId)
  return { path: artifactPath }
}

export function apply(ctx) {
  ctx.effect(
    () => {
      const offHistory = ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_HISTORY,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
            if (!isOriginSafe(req)) return sendJson(res, 403, { error: 'origin check failed' })
            const sessionId = readQuerySessionId(req)
            if (!sessionId) return sendJson(res, 400, { error: 'missing sessionId' })
            let force = readQueryRefresh(req)
            let throttled = false
            if (force) {
              const now = Date.now()
              const last = lastForceAt.get(sessionId) || 0
              if (now - last < FORCE_MIN_INTERVAL_MS) {
                force = false
                throttled = true
              } else {
                noteForceAt(sessionId, now)
              }
            }
            const result = await readInputHistory(ctx, sessionId, force)
            sendJson(res, 200, { history: result.history, limit: result.limit, throttled })
          } catch {
            sendJson(res, 500, { error: 'history unavailable' })
          }
        },
      })

      const offSessions = ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_SESSIONS,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
            if (!isOriginSafe(req)) return sendJson(res, 403, { error: 'origin check failed' })
            const sessions = await ctx.sessionQuery.listSessions()
            // Hide archived (including just-deleted) ids: the workspace UI
            // filters them everywhere, and the title fallback must never
            // resurrect a deleted row via a name match.
            let archivedSet = null
            try {
              let registry = null
              try { registry = ctx.workspaceRegistry ?? null } catch { registry = null }
              if (!registry) {
                try { registry = ctx.get('workspaceRegistry') ?? null } catch { registry = null }
              }
              const arr = registry ? registry.archivedSessionIds : null
              if (Array.isArray(arr)) archivedSet = new Set(arr.map(String))
            } catch {}
            const ids = []
            const recs = []
            for (const rec of sessions) {
              const id = rec && rec.header ? rec.header.id : undefined
              if (typeof id !== 'string' || !id) continue
              if (archivedSet && archivedSet.has(id)) continue
              ids.push(id)
              recs.push(rec)
            }
            // Bounded concurrency + [0.1.13] signature-keyed title cache:
            // unchanged session files serve their title from memory (size:mtime
            // match) so a right-click open no longer re-reads every log — O(n)
            // reads per open dragged the menu with hundreds of sessions.
            // Unlocatable files fall back to a 60s TTL entry.
            const CONCURRENCY = 8
            const result = new Array(ids.length)
            let cursor = 0
            let persistenceSvc = null
            try { persistenceSvc = ctx.get('sessionPersistence') } catch { persistenceSvc = null }
            async function titleFor(rec, id) {
              let sig = null
              try {
                const loc = persistenceSvc && typeof persistenceSvc.locate === 'function' ? persistenceSvc.locate(rec.header) : null
                if (loc && typeof loc.path === 'string') {
                  const st = await lstat(loc.path).catch(() => null)
                  if (st) sig = `${st.size}:${st.mtimeMs}`
                }
              } catch {}
              const hit = titleCache.get(id)
              if (hit && ((sig !== null && hit.sig === sig) || (sig === null && hit.at > Date.now() - 60000))) {
                return hit.title
              }
              let title
              try {
                const t = await ctx.sessionQuery.readTitle(id)
                title = t && t.title ? t.title : undefined
              } catch (e) { cleanupWarn(ctx, `readTitle failed for ${id}`, e) }
              titleCache.set(id, { title, sig, at: Date.now() })
              if (titleCache.size > 4096) {
                const now = Date.now()
                for (const [k, v] of titleCache) { if (v.at + 300000 < now) titleCache.delete(k) }
              }
              return title
            }
            async function worker() {
              while (true) {
                const i = cursor++
                if (i >= ids.length) return
                const title = await titleFor(recs[i], ids[i])
                result[i] = { id: ids[i], title: title || String(ids[i]) }
              }
            }
            const workers = []
            for (let w = 0; w < Math.min(CONCURRENCY, ids.length); w++) workers.push(worker())
            await Promise.all(workers)
            sendJson(res, 200, { sessions: result })
          } catch {
            sendJson(res, 500, { error: 'sessions unavailable' })
          }
        },
      })

      async function handleDelete(req, res) {
        try {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          if (!isCsrfSafe(req)) return sendJson(res, 403, { error: 'csrf check failed' })
          let body
          try {
            body = await readJsonBody(req)
          } catch {
            return sendJson(res, 400, { error: 'invalid body' })
          }
          const sessionId =
            body && isValidSessionId(body.sessionId)
              ? body.sessionId
              : undefined
          if (!sessionId) return sendJson(res, 400, { error: 'missing sessionId' })
          try {
            await deleteSessionLocally(ctx, sessionId)
          } catch (e) {
            if (e instanceof SessionLiveError) {
              return sendJson(res, 409, { error: 'session is busy: wait for its running turn/background jobs to finish', reason: e.reason || 'busy' })
            }
            if (e instanceof SessionNotFoundError) {
              return sendJson(res, 404, { error: 'session not found' })
            }
            const msg = String((e && e.message) || e || '')
            if (/not found|no such|unknown session/i.test(msg)) {
              return sendJson(res, 404, { error: 'session not found' })
            }
            if (/persistence backend is unavailable|cannot locate session file/i.test(msg)) {
              return sendJson(res, 501, { error: 'delete unavailable for this backend' })
            }
            if (/refusing to delete/i.test(msg)) {
              return sendJson(res, 500, { error: 'delete refused: unexpected artifact shape' })
            }
            throw e
          }
          sendJson(res, 200, { success: true, deleted: true })
        } catch {
          sendJson(res, 500, { error: 'delete failed' })
        }
      }

      // [0.1.13] Parse x-dsh-plugin-version (semver-ish) and compare against a
      // floor. The legacy /archive alias PERMANENTLY DELETES (since 0.1.8),
      // which is not what a 0.1.6/0.1.7 client means by "archive" — gate the
      // alias on an explicit version header so pre-0.1.8 clients (which never
      // send one) are refused instead of silently destroying data they meant
      // to hide. The canonical /delete route is unchanged.
      function pluginVersionAtLeast(req, maj, min, pat) {
        const raw = String((req && req.headers && req.headers['x-dsh-plugin-version']) || '')
        const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim())
        if (!m) return false
        const a = Number(m[1]); const b = Number(m[2]); const c = Number(m[3])
        if (a !== maj) return a > maj
        if (b !== min) return b > min
        return c >= pat
      }
      const handleArchiveAlias = (req, res) => {
        if (!pluginVersionAtLeast(req, 0, 1, 8)) {
          return sendJson(res, 426, {
            error: 'the /archive alias permanently deletes since 0.1.8; upgrade the client to >= 0.1.8 (sends x-dsh-plugin-version) or call /delete explicitly',
          })
        }
        return handleDelete(req, res)
      }
      // Canonical route (permanent local deletion) + legacy alias behind the
      // version gate above.
      const offDelete = ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_DELETE,
        handler: handleDelete,
      })

      const offArchive = ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_ARCHIVE,
        handler: handleArchiveAlias,
      })

      return () => {
        offHistory()
        offSessions()
        offDelete()
        offArchive()
        clearSaveTimer()
        historyCache.clear()
        lastForceAt.clear()
      }
    },
    'dsh-session-plugin: routes',
  )
}