// Unit tests for the destructive-path validation of
// @listardus/dsh-session-plugin (safety.js). These cover the rejection paths
// that stand between a buggy/compromised locate() and an rm.
//
// Run: npm test   (node --test test/)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafeArtifactShape, KNOWN_ARTIFACTS } from '../safety.js'

const SID = 'session-test1'
const ART = 'session.v4.jsonl.zstd'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsp-safety-'))
  const home = join(root, 'home')
  const dshHome = join(root, 'dsh')
  const sessions = join(root, 'sessions')
  mkdirSync(home); mkdirSync(dshHome); mkdirSync(sessions)
  return { root, home, dshHome, sessions }
}

function rejects(t, promise, snippet) {
  return assert.rejects(promise, (e) => {
    assert.ok(String(e.message).startsWith('refusing to delete'), `message must start with "refusing to delete": ${e.message}`)
    assert.ok(String(e.message).includes(snippet), `message must include "${snippet}": ${e.message}`)
    return true
  })
}

test('rejects unknown artifact basenames', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const dir = join(f.sessions, SID); mkdirSync(dir)
  for (const bad of ['evil.exe', 'session.v3.jsonl', 'notes.txt', 'session.jsonl.bak']) {
    await rejects(t, assertSafeArtifactShape(join(dir, bad), SID, f), 'unexpected session artifact shape')
  }
})

test('rejects relative / traversal paths', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  await rejects(t, assertSafeArtifactShape('../../../etc/session.jsonl', SID, f), 'unexpected session artifact shape')
  await rejects(t, assertSafeArtifactShape(join('..', '..', 'etc', ART), SID, f), 'unexpected session artifact shape')
})

test('rejects artifacts at a filesystem root', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const rootDir = f.root.slice(0, 3) // e.g. "C:\" — the drive root
  await rejects(t, assertSafeArtifactShape(join(rootDir, ART), SID, f), 'filesystem root')
})

test('rejects directories not owned by the session id', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const dir = join(f.sessions, 'session-other'); mkdirSync(dir); writeFileSync(join(dir, ART), '')
  await rejects(t, assertSafeArtifactShape(join(dir, ART), SID, f), 'not owned')
})

test('rejects home root and DSH config root', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  // Home root: the sessionDir itself is the home dir — needs a session id that
  // matches the dir basename, so craft home named like the session.
  const fakeHome = join(f.root, SID); mkdirSync(fakeHome)
  await rejects(t, assertSafeArtifactShape(join(fakeHome, ART), SID, { ...f, homeNorm: fakeHome }), 'home/config root')
  // The DSH-home case also needs a dir named exactly like the session to get
  // past the ownership gate and reach the home/config-root check.
  const fakeDshParent = join(f.root, 'dshroot'); mkdirSync(fakeDshParent)
  const fakeDsh = join(fakeDshParent, SID); mkdirSync(fakeDsh)
  await rejects(t, assertSafeArtifactShape(join(fakeDsh, ART), SID, { ...f, dshHomeNorm: fakeDsh }), 'home/config root')
})

test('rejects a symlinked session directory (junction)', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const real = join(f.sessions, SID); mkdirSync(real); writeFileSync(join(real, ART), '')
  const evil = join(f.root, 'evil'); mkdirSync(evil)
  const link = join(evil, SID)
  symlinkSync(real, link, 'junction') // junction = no admin rights required
  await rejects(t, assertSafeArtifactShape(join(link, ART), SID, f), 'symlinked session directory')
})

test('rejects a symlinked artifact file (skipped without symlink rights)', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const dir = join(f.sessions, SID); mkdirSync(dir)
  const real = join(dir, ART); writeFileSync(real, '')
  const link = join(dir, 'link-target.tmp')
  try {
    symlinkSync(real, link)
  } catch {
    t.skip('cannot create file symlinks on this machine (needs developer mode/admin)')
    return
  }
  // The link must carry an accepted basename to reach the symlink check.
  const linkAsArtifact = join(dir, 'session.jsonl.zstd')
  symlinkSync(real, linkAsArtifact)
  await rejects(t, assertSafeArtifactShape(linkAsArtifact, SID, f), 'symlinked session artifact')
})

test('accepts a well-formed v4 artifact and the legacy pair', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const dir = join(f.sessions, SID); mkdirSync(dir)
  for (const name of KNOWN_ARTIFACTS) {
    writeFileSync(join(dir, name), '')
    const out = await assertSafeArtifactShape(join(dir, name), SID, f)
    assert.equal(out.base, name)
    assert.equal(out.sessionDir, dir)
  }
})
