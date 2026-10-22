/**
 * Linux non-leader TID reuse (#988 subset): real PTYs, real /resume screen,
 * a separate publishing process, and its real Worker OS thread. No real DSH
 * sessions are opened. The catalog/factory is synthetic; mount authority,
 * occupancy display, pruning, locking and terminal I/O are production code.
 *
 * Run after compile: pnpm verify:session-mounts-linux-pty
 * On Windows, install Linux dependencies and run this command inside WSL.
 * DSH_TUI_PTY_ARTIFACTS selects the trace directory (default: a fresh temp dir).
 * DSH_TUI_TEST_MODULE may select an external @microsoft/tui-test installation
 * when the source checkout's dependencies belong to another operating system.
 */
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

if (process.platform !== 'linux') {
  console.log('SKIP: non-leader TID regression requires Linux; run this script inside WSL on Windows.')
  process.exit(0)
}
const { TuiTest } = await import(process.env.DSH_TUI_TEST_MODULE || '@microsoft/tui-test')
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const out = process.env.DSH_TUI_PTY_ARTIFACTS ?? fs.mkdtempSync(path.join(tmpdir(), 'dsh-tid-artifacts-'))
fs.mkdirSync(out, { recursive: true })
const home = fs.mkdtempSync(path.join(tmpdir(), 'dsh-tid-pty-'))
const data = path.join(home, '.dsh-tui')
fs.mkdirSync(data)
const ledger = path.join(data, 'session-mounts.json')
const lock = path.join(data, 'session-mounts.lock')
const identityFile = path.join(out, 'peer.json')
const fixture = path.join(here, 'lib/session-mounts-pty-fixture.mjs')
const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), AUDIT_REPO: root }
const results = []
let identity
let peerOwner
const terminal = name => TuiTest.ephemeral(`tid-${name}`, { trace: { mode: 'on', directory: path.join(out, name, 'trace') } })
const peer = terminal('peer')
function stage({ stale = true, lockPid } = {}) {
  fs.rmSync(lock, { force: true })
  const owners = [peerOwner]
  if (stale) owners.push({ pid: identity.tid, startedAt: 1, sessionIds: ['stale-tid'] })
  fs.writeFileSync(ledger, JSON.stringify({ version: 1, owners }))
  if (lockPid) { fs.writeFileSync(lock, `${lockPid}-audit-token\n`); fs.utimesSync(lock, 1, 1) }
}
async function check(name, run) {
  try { const detail = await run(); results.push({ name, ok: true, detail }); console.log(`PASS ${name}`) }
  catch (error) { results.push({ name, ok: false, error: String(error) }); console.log(`FAIL ${name}: ${error}`) }
}
async function api(name, options = {}) {
  const term = terminal(name)
  const result = path.join(out, `${name}.json`)
  fs.rmSync(result, { force: true })
  try {
    await term.run(process.execPath, [fixture], { cwd: root, cols: 120, rows: 24, env: { ...env, AUDIT_MODE: 'api', AUDIT_RESULT: result, AUDIT_TARGET: String(options.target ?? identity.tid), AUDIT_SESSION: options.session ?? 'stale-tid', AUDIT_ACTION: options.action ?? 'claim', AUDIT_FAULT: options.fault ?? '' } })
    await term.getByText('API READY').expect({ timeout: 30000 })
    await term.submit('run')
    await term.waitExit({ timeout: 30000 })
    assert.equal((await term.state()).exited, 0, 'API fixture must exit successfully')
    fs.writeFileSync(path.join(out, `${name}.txt`), await term.text())
    return JSON.parse(fs.readFileSync(result, 'utf8'))
  } finally { await term.closeQuiet() }
}
async function ui(name, session, shouldEnter) {
  const term = terminal(name)
  const result = path.join(out, `${name}.json`)
  fs.rmSync(result, { force: true })
  try {
    await term.run(process.execPath, [fixture], { cwd: root, cols: 120, rows: 30, env: { ...env, AUDIT_MODE: 'ui', AUDIT_RESULT: result, AUDIT_SESSION: session } })
    await term.getByText('TID audit target').expect({ timeout: 45000 })
    await term.screenshot(path.join(out, `${name}-before.svg`))
    await term.getByText('TID audit target').click()
    if (shouldEnter) await term.getByText(`MOUNTED ${session}`).expect({ timeout: 5000 })
    else {
      await term.getByText('Held by another TUI terminal').expect({ timeout: 5000 })
      assert.equal(fs.existsSync(result), false, 'occupied screen must not call the mount factory')
    }
    await term.screenshot(path.join(out, `${name}-after.svg`))
    const detail = shouldEnter ? JSON.parse(fs.readFileSync(result, 'utf8')) : { refusedBeforeFactory: true }
    fs.writeFileSync(path.join(out, `${name}.txt`), await term.text())
    await term.keyboard.press('Escape')
    if (!shouldEnter) {
      // The production screen dismisses its refusal notice before closing.
      await term.getByText('Held by another TUI terminal').expect({ not: true, timeout: 5000 })
      await term.keyboard.press('Escape')
    }
    await term.waitExit({ timeout: 5000 })
    assert.equal((await term.state()).exited, 0, 'the /resume screen must exit successfully after Escape')
    return { ...detail, exitCode: 0 }
  } finally {
    await term.closeQuiet()
  }
}

try {
  await peer.run(process.execPath, [fixture], { cwd: root, cols: 100, rows: 20, env: { ...env, AUDIT_MODE: 'peer', AUDIT_RESULT: identityFile } })
  await peer.getByText('PEER READY').expect({ timeout: 30000 })
  identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'))
  assert.equal(identity.tgid, identity.pid)
  assert.notEqual(identity.tid, identity.pid)
  peerOwner = JSON.parse(fs.readFileSync(ledger, 'utf8')).owners.find(owner => owner.pid === identity.pid)
  assert.deepEqual(peerOwner?.sessionIds, ['live-peer'], 'the separate peer must publish its own record')
  process.kill(identity.tid, 0)
  fs.writeFileSync(path.join(out, 'worker-status.txt'), fs.readFileSync(`/proc/${identity.tid}/status`))
  await check('live-peer-ui', async () => { stage({ stale: false }); return ui('live-peer-ui', 'live-peer', false) })
  await check('live-peer-claim', async () => { stage({ stale: false }); const r = await api('live-peer-claim', { target: identity.pid, session: 'live-peer' }); assert.equal(r.action.reason, 'occupied'); return r })
  process.kill(identity.pid, 'SIGSTOP')
  try {
    fs.writeFileSync(path.join(out, 'stopped-status.txt'), fs.readFileSync(`/proc/${identity.pid}/status`))
    await check('stopped-peer-ui', async () => { stage({ stale: false }); return ui('stopped-peer-ui', 'live-peer', false) })
    await check('stopped-peer-claim', async () => { stage({ stale: false }); const r = await api('stopped-peer-claim', { target: identity.pid, session: 'live-peer' }); assert.equal(r.action.reason, 'occupied'); return r })
    await check('stopped-peer-lock', async () => { stage({ stale: false, lockPid: identity.pid }); const r = await api('stopped-peer-lock', { target: identity.pid }); assert.equal(r.action.reason, 'busy'); assert.equal(r.lock, `${identity.pid}-audit-token\n`); return r })
  } finally { process.kill(identity.pid, 'SIGCONT') }
  await check('tid-ui-resume', async () => { stage(); const r = await ui('tid-ui-resume', 'stale-tid', true); assert.equal(r.owners.some(o => o.pid === identity.tid), false); return r })
  await check('tid-authoritative-claim', async () => { stage(); const r = await api('tid-authoritative-claim'); assert.equal(r.alive, false); assert.equal(r.occupancy.kind, 'free'); assert.equal(r.action.ok, true); assert.equal(r.owners.some(o => o.pid === identity.tid), false); assert.equal(r.owners.some(o => o.pid === identity.pid), true); return r })
  await check('tid-publish-prune', async () => { stage(); const r = await api('tid-publish-prune', { action: 'publish' }); assert.equal(r.action.ok, true); assert.equal(r.owners.some(o => o.pid === identity.tid), false); assert.equal(r.owners.some(o => o.pid === identity.pid), true); return r })
  await check('tid-lock-reclaim', async () => { stage({ lockPid: identity.tid }); const r = await api('tid-lock-reclaim'); assert.equal(r.action.ok, true); assert.equal(r.lock, null); return r })
  for (const fault of ['denied', 'missing', 'invalid', 'eperm', 'namespace-mismatch', 'namespace-denied', 'namespace-nested', 'namespace-missing']) {
    await check(`unknown-${fault}-claim`, async () => { stage(); const r = await api(`unknown-${fault}-claim`, { fault }); assert.equal(r.alive, true); assert.equal(r.occupancy.kind, 'occupied'); assert.equal(r.action.reason, 'occupied'); return r })
    await check(`unknown-${fault}-prune`, async () => { stage(); const r = await api(`unknown-${fault}-prune`, { fault, action: 'publish' }); assert.equal(r.action.ok, true); assert.equal(r.owners.some(o => o.pid === identity.tid), true); return r })
    await check(`unknown-${fault}-lock`, async () => { stage({ lockPid: identity.tid }); const r = await api(`unknown-${fault}-lock`, { fault }); assert.equal(r.action.reason, 'busy'); assert.equal(r.lock, `${identity.tid}-audit-token\n`); return r })
  }
} finally {
  try {
    if (identity) process.kill(identity.pid, 'SIGCONT')
    await peer.submit('quit')
    await peer.waitExit({ timeout: 5000 })
    assert.equal((await peer.state()).exited, 0, 'peer must release its mounts and exit successfully')
  } catch (error) {
    results.push({ name: 'peer-cleanup', ok: false, error: String(error) })
  } finally {
    await peer.closeQuiet()
    fs.rmSync(home, { recursive: true, force: true })
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ root, home, homeCleaned: !fs.existsSync(home), identity, results }, null, 2))
  console.log(`PTY artifacts: ${out}`)
}
if (results.some(result => !result.ok)) process.exitCode = 1
