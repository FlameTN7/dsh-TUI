import fs from 'node:fs'
import { syncBuiltinESMExports, createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

if (process.platform !== 'linux' || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Linux real PTY required')
const root = process.env.AUDIT_REPO
const target = Number(process.env.AUDIT_TARGET)
const mode = process.env.AUDIT_MODE
const resultPath = process.env.AUDIT_RESULT
const sessionId = process.env.AUDIT_SESSION ?? 'stale-tid'
process.env.DSH_TUI_LANG = 'en'
const source = relative => import(pathToFileURL(path.join(root, 'lib/types', relative)).href)
// Fault injection is limited to the OS witness, before named fs exports load.
// Ledger I/O, UI, locks, reservations and publication remain production code.
const originalRead = fs.readFileSync
const originalKill = process.kill
if (process.env.AUDIT_FAULT) {
  fs.readFileSync = function (file, ...rest) {
    if (file === '/proc/self/status') {
      if (process.env.AUDIT_FAULT === 'namespace-mismatch') return `Tgid:\t${process.pid + 1}\nNStgid:\t${process.pid}\n`
      if (process.env.AUDIT_FAULT === 'namespace-nested') return `Tgid:\t${process.pid}\nNStgid:\t${process.pid}\t${process.pid}\n`
      if (process.env.AUDIT_FAULT === 'namespace-missing') return `Tgid:\t${process.pid}\n`
      if (process.env.AUDIT_FAULT === 'namespace-denied') throw Object.assign(new Error('injected proc namespace access failure'), { code: 'EACCES' })
    }
    if (file === `/proc/${target}/status`) {
      if (process.env.AUDIT_FAULT === 'missing') return 'Name:\tfixture\n'
      if (process.env.AUDIT_FAULT === 'invalid') return 'Tgid:\tnot-a-pid\n'
      if (process.env.AUDIT_FAULT === 'denied') throw Object.assign(new Error('injected proc access failure'), { code: 'EACCES' })
    }
    return originalRead.call(this, file, ...rest)
  }
  if (process.env.AUDIT_FAULT === 'eperm') process.kill = (pid, signal) => {
    if (pid === target) throw Object.assign(new Error('injected kill permission failure'), { code: 'EPERM' })
    return originalKill(pid, signal)
  }
  syncBuiltinESMExports()
}
const mounts = await source('sessionMounts.js')
const lockPath = path.join(process.env.HOME, '.dsh-tui/session-mounts.lock')
const save = data => fs.writeFileSync(resultPath, JSON.stringify(data, null, 2))

if (mode === 'peer') {
  const worker = new Worker(`const fs=require('node:fs'); const {parentPort}=require('node:worker_threads'); const status=fs.readFileSync('/proc/thread-self/status','utf8'); parentPort.postMessage({tid:Number(/^Pid:\\s+(\\d+)$/m.exec(status)[1]),tgid:Number(/^Tgid:\\s+(\\d+)$/m.exec(status)[1])}); setInterval(()=>{},60000)`, { eval: true })
  const identity = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
  if (!mounts.publishMounts(['live-peer'])) throw new Error('peer publish failed')
  save({ pid: process.pid, ...identity })
  console.log('PEER READY')
  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) if (line === 'quit') break
  mounts.clearOwnMounts()
  await worker.terminate()
  process.exit(0)
}

if (mode === 'api') {
  console.log('API READY')
  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) {
    if (line !== 'run') continue
    const occupancy = mounts.occupancyOf(sessionId, mounts.readSessionOwners())
    const alive = mounts.pidAlive(target)
    let action
    if (process.env.AUDIT_ACTION === 'publish') action = { ok: mounts.publishMounts(['new-publication']) }
    else {
      const result = await mounts.reserveMount(sessionId)
      action = result.ok ? { ok: true } : result
      if (result.ok) result.reservation.settle()
    }
    const result = { alive, occupancy, action, owners: mounts.readMountLedger(), lock: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null }
    save(result)
    console.log(`API RESULT ${JSON.stringify(result)}`)
    rl.close()
    break
  }
  process.exit(0)
}

// Actual /resume screen and actual shared mount authority. Only the durable
// catalog/factory is synthetic, so no user's DSH session is opened or mutated.
process.env.FORCE_COLOR = '3'
const require = createRequire(path.join(root, 'package.json'))
const React = require('react')
const [{ render, AlternateScreen, Text, useInput }, { SessionSupervisor }, { mountFailureText }] = await Promise.all([
  source('ui.js'), source('screens/SessionSupervisor.js'), source('sessions/resumeFailure.js'),
])
const cwd = process.env.HOME
const channel = {
  cwd, agentId: 'unrelated-current', ready: true,
  async listSessions() { return [{ id: sessionId, kind: { kind: 'root' }, title: { text: 'TID audit target', source: 'auto' }, cwd, createdAt: 1, updatedAt: 1, bytes: 100, hasPrompt: true, childCount: 0 }] },
  async listWorkspaceRegistry() { return [{ id: 'audit-workspace', path: cwd, title: 'Audit workspace', present: true, sessionCount: 1 }] },
}
let app
const leave = async () => { mounts.clearOwnMounts(); await app.unmount(); process.exit(0) }
function App() {
  const [entered, setEntered] = React.useState(false)
  useInput((input, key) => { if (entered && key.escape) void leave() })
  if (entered) return React.createElement(Text, null, `MOUNTED ${sessionId}`)
  return React.createElement(SessionSupervisor, {
    channel, home: cwd, onClose: leave, onNewSession: async () => false,
    onStopSession: async () => false, approval: null, onApprove() {}, liveStateOf: () => undefined,
    async onOpenSession(id) {
      const result = await mounts.reserveMount(id)
      save(result.ok ? { ok: true, owners: mounts.readMountLedger() } : result)
      if (!result.ok) return { ok: false, reason: 'failed', error: mountFailureText(result) }
      result.reservation.settle()
      setEntered(true)
      return { ok: true }
    },
  })
}
app = await render(React.createElement(AlternateScreen, null, React.createElement(App)), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, exitOnCtrlC: false, patchConsole: false })
