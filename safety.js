// Safety-critical artifact shape validation for @listardus/dsh-session-plugin.
//
// Extracted as a standalone module so the rejection paths are unit-testable
// without a DSH host (see test/delete-safety.test.js). `assertSafeArtifactShape`
// is the ONLY gate standing between a compromised/buggy
// `sessionPersistence.locate()` and an rm: it must reject every path that is
// not exactly `<root>/<sessionId>/session.jsonl[.zstd]` (or the v4 spelling)
// with a "refusing to delete" error, and it must reject symlinked artifacts
// and directories.
import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, basename, isAbsolute, normalize, sep } from 'node:path'

/** Artifact basenames the persistence backend is known to produce. */
export const KNOWN_ARTIFACTS = new Set([
  'session.jsonl', 'session.jsonl.zstd',
  'session.v4.jsonl', 'session.v4.jsonl.zstd',
])

/**
 * Validate a candidate session artifact path before any deletion.
 *
 * @param {string} artifactPath - raw path from `sessionPersistence.locate()`.
 * @param {string} sessionId - the session being deleted; the artifact must sit
 *   in a directory named exactly for it.
 * @param {{ homeNorm?: string, dshHomeNorm?: string }} [opts] - protected root
 *   overrides (tests inject fixtures; production defaults are the real home
 *   and DSH_HOME).
 * @returns {Promise<{ artifactPath: string, base: string, sessionDir: string }>}
 *   the normalized, validated coordinates.
 * @throws {Error} every rejection message starts with `refusing to delete`.
 */
export async function assertSafeArtifactShape(artifactPath, sessionId, opts = {}) {
  const normalizedArtifact = normalize(artifactPath)
  const base = basename(normalizedArtifact)
  // 1. Absolute path whose basename is exactly a known session artifact.
  if (!isAbsolute(normalizedArtifact) || !KNOWN_ARTIFACTS.has(base)) {
    throw new Error(`refusing to delete unexpected session artifact shape: '${base}'`)
  }
  // 2. Nested exactly one level under a directory named for this sessionId,
  //    and never at a filesystem root.
  const sessionDir = dirname(normalizedArtifact)
  if (!sessionDir || sessionDir === dirname(sessionDir)) {
    throw new Error('refusing to delete session directory at filesystem root')
  }
  if (basename(sessionDir) !== sessionId) {
    throw new Error(`refusing to delete session directory not owned by '${sessionId}'`)
  }
  // 3. Never from the user's home root or the DSH config root directly.
  const homeNorm = opts.homeNorm != null ? opts.homeNorm : normalize(homedir())
  const dshHomeNorm = opts.dshHomeNorm != null
    ? opts.dshHomeNorm
    : normalize(process.env.DSH_HOME || join(homedir(), '.dsh'))
  if (sessionDir === homeNorm || sessionDir === dshHomeNorm ||
    sessionDir === join(dshHomeNorm, sep)) {
    throw new Error('refusing to delete session directory at home/config root')
  }
  // 4. Neither the artifact nor its directory may be a symlink (a planted
  //    link could redirect the rm). lstat failing (file already gone) is fine —
  //    rm handles absence later.
  try {
    const artStat = await lstat(normalizedArtifact).catch(() => null)
    if (artStat && typeof artStat.isSymbolicLink === 'function' && artStat.isSymbolicLink()) {
      throw new Error('refusing to delete symlinked session artifact')
    }
    const dirStat = await lstat(sessionDir).catch(() => null)
    if (dirStat && typeof dirStat.isSymbolicLink === 'function' && dirStat.isSymbolicLink()) {
      throw new Error('refusing to delete symlinked session directory')
    }
  } catch (e) {
    if (e && /refusing to delete symlinked/.test(e.message || '')) throw e
  }
  return { artifactPath: normalizedArtifact, base, sessionDir }
}
