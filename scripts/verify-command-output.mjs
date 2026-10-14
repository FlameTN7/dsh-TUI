/**
 * Registry command output through real Chat, channel and xterm: reports must
 * remain readable in the local transcript, without model submissions. Only
 * the external command result is replaced; sanitization, draft admission,
 * session adoption and rendering are production code.
 * Run: node --import tsx/esm scripts/verify-command-output.mjs
 * Optional: DSH_TUI_COMMAND_OUTPUT_EVIDENCE=<path> saves terminal snapshots.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

const home = mkdtempSync(join(tmpdir(), 'dsh-command-output-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
process.env.SSH_CONNECTION = 'headless-command-output'
delete process.env.TMUX
delete process.env.STY
const [React, { Terminal }, ui, { Chat }, { createChannel }, { createStartingSession },
  { QuestionStore }, { PermissionStore }, { LOCAL_COMMANDS }, { settled, sleep, viewportLines },
  { TerminalWriteContext }, { TuiDialogStore }] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'), import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/channel.js'), import('../src/agent/starting-session.js'),
  import('../src/channel/questions.js'), import('../src/channel/permissions.js'),
  import('../src/commands.js'), import('./lib/term-test.mjs'),
  import('../src/ink/useTerminalNotification.js'), import('../src/dsh-adapter/dialogs.js'),
])

const evidence = []
async function fixture(fullscreen, test, existing = false, whale = false) {
  const term = new Terminal({ cols: 54, rows: 18, scrollback: 2000, allowProposedApi: true })
  const stdout = new Writable({ write(chunk, _encoding, done) { term.write(String(chunk), done) } })
  Object.assign(stdout, { isTTY: true, columns: 54, rows: 18 })
  const stdin = new PassThrough()
  Object.assign(stdin, { isTTY: true, setRawMode() { return this }, ref() { return this }, unref() { return this } })
  let modelCalls = 0
  let commandCalls = 0
  let sessionIndex = 0
  const session = () => ({
    ...createStartingSession('fixture', home),
    ref: { backendId: 'fixture', sessionId: `command-output-${++sessionIndex}` },
    status: 'idle', subscribe: () => () => {},
    async submit() { modelCalls++; return { accepted: true } },
  })
  const ctx = { on: () => () => {}, get: () => undefined, logger: { warn() {}, info() {}, debug() {} } }
  const channel = createChannel(ctx, session(), {
    model: 'fixture', provider: '', cwd: home, activity: false, whale, whaleIdle: false, openSession: async () => session(),
  })
  channel.commandList = [...LOCAL_COMMANDS, { name: 'demo', description: 'Fixture report', external: true }]
  if (existing) {
    channel.rows.push({ id: -2, kind: 'user', text: 'Ready for a plugin report' }, { id: -1, kind: 'assistant', text: 'Ready.' })
    channel.emit()
  }
  const controller = { current: null }
  const questions = new QuestionStore()
  const approvals = new PermissionStore()
  const dialogs = new TuiDialogStore()
  const rawWrites = []
  const chat = React.createElement(Chat, { channel, questionStore: questions, approvalStore: approvals, extensionDialogs: dialogs,
    onExit() {}, fullscreen, trajectorySeen: true, launchpadOnBoot: false, promptControllerRef: controller })
  const node = React.createElement(TerminalWriteContext.Provider, {
    value(raw) { rawWrites.push(raw); stdout.write(raw) },
  }, chat)
  const app = await ui.render(fullscreen ? React.createElement(ui.AlternateScreen, null, node) : node,
    { stdout, stderr: stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  const screen = () => viewportLines(term).join('\n')
  const buffer = () => Array.from({ length: term.buffer.active.baseY + term.rows },
    (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  const output = () => channel.rows.filter(row => row.kind === 'local-output').map(row => row.text)
  let prompt
  const draft = () => prompt.text()
  const run = async result => {
    if (screen().includes('c copy')) {
      stdin.write('\x1b')
      assert.ok(await settled(() => !screen().includes('c copy')), 'reader closes before the next command')
    }
    channel.runExternalCommandOutcome = async () => { commandCalls++; return typeof result === 'function' ? result() : result }
    controller.current.clear()
    assert.ok(await settled(() => controller.current.text() === ''))
    stdin.write('\x1b[200~/demo\x1b[201~')
    assert.ok(await settled(() => controller.current.text() === '/demo'), 'command draft reaches real composer')
    await sleep(100) // 固定窗:pacing separate Enter gestures must clear Chat's 80ms duplicate-enter guard.
    const previous = commandCalls
    stdin.write('\r')
    assert.ok(await settled(() => commandCalls === previous + 1), 'registry route executes')
  }
  try {
    assert.ok(await settled(() => controller.current !== null))
    prompt = controller.current
    assert.ok(await settled(() => screen().includes('fixture ·')), 'initial terminal frame has been parsed before sending a command')
    await test({ channel, controller, draft, questions, approvals, dialogs, rawWrites, stdin, term, screen, buffer, output, run })
    assert.equal(modelCalls, 0, 'local command output never reaches the model')
  } finally {
    await app.unmount()
    channel.releaseContributions()
    stdin.destroy(); stdout.destroy(); term.dispose()
  }
}

try {
  for (const fullscreen of [false, true]) {
    for (const initial of [{ existing: false, whale: false }, { existing: true, whale: false }, { existing: false, whale: true }]) await fixture(fullscreen, async io => {
      const report = Array.from({ length: 30 }, (_, i) => `ROW-${i + 1} original plugin report END`).join('\n')
      await io.run({ kind: 'success', text: report, consumeDraft: true })
      assert.ok(await settled(() => io.output().length === 30), 'multiline result becomes a local transcript block')
      assert.equal(io.output()[29], 'ROW-30 original plugin report END')
      assert.equal(io.channel.notifications.length, 0, 'report is not duplicated in a toast')
      assert.ok(await settled(() => io.draft() === ''), 'successful command consumes its draft')
      assert.ok(await settled(() => io.screen().includes('ROW-1 ')), `reader opens at the first report line\n${io.screen()}`)
      const head = io.screen()
      io.stdin.write('\x1b[F')
      assert.ok(await settled(() => io.screen().includes('ROW-30')), 'End reaches the last report line')
      const tail = io.screen()
      io.stdin.write('c')
      assert.ok(await settled(() => io.rawWrites.some(raw => raw.includes('\x1b]52;c;'))), 'reader copies through the real OSC 52 path')
      const copied = io.rawWrites.map(raw => /\x1b\]52;c;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/u.exec(raw)?.[1]).find(value => value !== undefined)
      assert.equal(Buffer.from(copied, 'base64').toString('utf8'), report, 'copy contains all thirty sanitized lines')
      io.stdin.write('\x1b[H')
      assert.ok(await settled(() => io.screen().includes('ROW-1 ')), 'Home returns to the first report line')
      const read = new Set()
      for (let page = 0; page < 3; page++) {
        for (const match of io.screen().matchAll(/ROW-(\d+) original/gu)) read.add(Number(match[1]))
        const before = io.screen()
        io.stdin.write('\x1b[6~')
        if (page < 2) assert.ok(await settled(() => io.screen() !== before), `PageDown moves the reader (${page})\n${io.screen()}`)
      }
      for (const match of io.screen().matchAll(/ROW-(\d+) original/gu)) read.add(Number(match[1]))
      assert.equal(read.size, 30, 'every report line can be read on a narrow terminal')
      io.stdin.write('\x1b')
      assert.ok(await settled(() => !io.screen().includes('c copy')), 'Esc closes the reader')
      assert.ok(await settled(() => io.controller.current !== null))
      assert.equal(io.controller.current.text(), '', 'consumed draft stays cleared after reader return')
      io.stdin.write('\x1b[1;2A')
      await sleep(120) // 固定窗:pacing the message selector must commit before Enter reopens its report.
      io.stdin.write('\r')
      assert.ok(await settled(() => io.screen().includes('ROW-1 ')), 'a selected local-output row reopens the retained report')
      io.stdin.write('\x1b')
      assert.ok(await settled(() => io.controller.current !== null))
      const again = 'SECOND HEAD\nsecond report\nSECOND TAIL'
      await io.run({ kind: 'success', text: again, consumeDraft: true })
      assert.ok(await settled(() => io.screen().includes('SECOND HEAD') && io.screen().includes('SECOND TAIL')), 'a consecutive report is readable independently')
      evidence.push({ fullscreen, width: 54, ...initial, case: '30-line report', head, tail, second: io.screen() })
    }, initial.existing, initial.whale)
    await fixture(fullscreen, async io => {
      const long = 'HEAD ' + '界e\u0301🙂 '.repeat(50) + 'TAIL'
      await io.run({ kind: 'success', text: long, consumeDraft: true })
      assert.ok(await settled(() => io.output().length === 1))
      assert.equal(io.output()[0], long, 'long Unicode single line survives notification and local preview caps')
      io.stdin.write('\x1b[F')
      assert.ok(await settled(() => io.screen().includes('TAIL')), 'long line wraps through the reader')
      evidence.push({ fullscreen, width: 54, case: 'Unicode single line', screen: io.buffer() })
    })
    await fixture(fullscreen, async io => {
      await io.run({ kind: 'success', text: '\x1b[32mSaved\x1b[0m\x07', consumeDraft: true })
      assert.ok(await settled(() => io.channel.notifications.some(item => item.text === 'Saved')))
      assert.ok(await settled(() => io.controller.current.text() === ''))
      assert.deepEqual(io.output(), [], 'short confirmation stays a notification')
      await io.run({ kind: 'error', text: 'Refused', consumeDraft: false })
      assert.ok(await settled(() => io.channel.notifications.some(item => item.text === 'Refused' && item.color === 'error')))
      assert.equal(io.controller.current.text(), '/demo', 'error keeps draft editable')
      await io.run({ kind: 'success', text: '界'.repeat(101), consumeDraft: true })
      assert.ok(await settled(() => io.output().length === 1), 'routing uses display cells, not string length')
      assert.equal(io.output()[0], '界'.repeat(101))
    })
    for (const thrown of [false, true]) await fixture(fullscreen, async io => {
      const text = '\x1b[31mERROR HEAD\x1b[0m\n\x1b]52;c;evil\x07detail\x00\x9b\nERROR TAIL'
      await io.run(thrown ? () => { throw new Error(text) } : { kind: 'error', text, consumeDraft: false })
      assert.ok(await settled(() => io.output().length === 3), 'multiline errors remain in transcript')
      assert.deepEqual(io.output(), ['ERROR HEAD', 'detail', 'ERROR TAIL'], 'ANSI, OSC and controls cannot escape onto screen')
      assert.equal(io.draft(), '/demo')
      assert.ok(await settled(() => io.screen().includes('/demo (error)')), 'error report has an explicit error identity')
      assert.ok(await settled(() => io.screen().includes('ERROR TAIL')), io.screen())
      io.stdin.write('\x1b')
      assert.ok(await settled(() => !io.screen().includes('c copy')))
      assert.ok(await settled(() => io.controller.current !== null))
      assert.equal(io.controller.current.text(), '/demo', 'closing the error reader restores the exact draft')
    })
    await fixture(fullscreen, async io => {
      const text = 'LONG ERROR ' + 'x'.repeat(300) + ' END'
      await io.run({ kind: 'error', text, consumeDraft: false })
      assert.ok(await settled(() => io.output().length === 1))
      assert.equal(io.output()[0], text, 'long single-line errors are not clipped into a notification')
      assert.ok(await settled(() => io.screen().includes('/demo (error)')))
      assert.equal(io.draft(), '/demo')
    })
    await fixture(fullscreen, async io => {
      await io.run({ kind: 'success', text: 'one\ntwo', consumeDraft: false })
      assert.ok(await settled(() => io.output().length === 2))
      assert.equal(io.draft(), '/demo', 'successful non-consuming outcome preserves input')
      assert.ok(await settled(() => io.screen().includes('c copy')))
      io.stdin.write('\x1b')
      assert.ok(await settled(() => io.controller.current !== null))
      assert.equal(io.controller.current.text(), '/demo')
    })
    await fixture(fullscreen, async io => {
      let resolve
      const pending = new Promise(done => { resolve = done })
      await io.run(() => pending)
      io.controller.current.append(' edited')
      assert.ok(await settled(() => io.controller.current.text() === '/demo edited'))
      resolve({ kind: 'success', text: 'one\ntwo', consumeDraft: true })
      assert.ok(await settled(() => io.output().length === 2))
      await sleep(120) // 固定窗:探针 late completion must not consume a changed draft.
      assert.equal(io.draft(), '/demo edited')
      assert.ok(await settled(() => io.screen().includes('c copy')))
      io.stdin.write('\x1b')
      assert.ok(await settled(() => io.controller.current !== null))
      assert.equal(io.controller.current.text(), '/demo edited', 'edited draft is restored after closing the reader')
    })
    for (const reject of [false, true]) await fixture(fullscreen, async io => {
      let complete
      const pending = new Promise((resolve, fail) => { complete = reject ? fail : resolve })
      await io.run(() => pending)
      const generation = io.channel.agentBindingGeneration
      assert.equal(await io.channel.newSession(), true, 'real session adoption succeeds')
      assert.ok(io.channel.agentBindingGeneration > generation)
      assert.ok(await settled(() => io.controller.current.text() === ''))
      io.controller.current.append('new session draft')
      assert.ok(await settled(() => io.controller.current.text() === 'new session draft'))
      const notices = io.channel.notifications.length
      complete(reject ? new Error('STALE\nERROR') : { kind: 'success', text: 'STALE\nRESULT', consumeDraft: true })
      await sleep(120) // 固定窗:探针 a stale result/rejection must never reach the replacement session.
      assert.deepEqual(io.output(), [])
      assert.equal(io.channel.notifications.length, notices)
      assert.equal(io.controller.current.text(), 'new session draft')
    })
    await fixture(fullscreen, async io => {
      await io.run({ kind: 'success', text: 'OLD REPORT\nOLD TAIL', consumeDraft: false })
      assert.ok(await settled(() => io.screen().includes('OLD REPORT')))
      assert.equal(await io.channel.newSession(), true)
      assert.ok(await settled(() => io.controller.current !== null && !io.screen().includes('c copy')))
      assert.equal(io.controller.current.text(), '', 'a reader and its draft cannot leak into a replacement session')
      assert.deepEqual(io.output(), [])
    })
    for (const priority of ['question', 'approval', 'dialog']) await fixture(fullscreen, async io => {
      let resolve
      const pending = new Promise(done => { resolve = done })
      await io.run(() => pending)
      let finished
      if (priority === 'question') {
        finished = io.questions.ask({ questions: [{ id: 'priority', question: 'QUESTION PRIORITY',
          options: [{ label: 'Continue' }], hideCustomInput: true }] })
        assert.ok(await settled(() => io.screen().includes('QUESTION PRIORITY')))
      } else if (priority === 'approval') {
        io.approvals.park({ sessionId: io.channel.agentId, request: { requestId: 'priority', toolName: 'fixture',
          title: 'APPROVAL PRIORITY', options: [{ id: 'reject', label: 'Reject', kind: 'reject' }] }, settle() {} })
        assert.ok(await settled(() => io.screen().includes('APPROVAL PRIORITY')))
      } else {
        finished = io.dialogs.ask({ kind: 'confirm', title: 'DIALOG PRIORITY', confirmLabel: 'Continue', cancelLabel: 'Cancel' })
        assert.ok(await settled(() => io.screen().includes('DIALOG PRIORITY')))
      }
      resolve({ kind: 'success', text: 'DEFERRED REPORT\nDEFERRED TAIL', consumeDraft: false })
      assert.ok(await settled(() => io.output().length === 2))
      await sleep(120) // 固定窗:探针 a report must never steal the active question/approval panel.
      assert.ok(!io.screen().includes('c copy'))
      assert.ok(io.screen().includes(priority === 'question' ? 'QUESTION PRIORITY' : priority === 'approval' ? 'APPROVAL PRIORITY' : 'DIALOG PRIORITY'))
      if (priority === 'question') {
        io.questions.answerCurrent({ selected: ['Continue'] })
        await finished
      } else if (priority === 'approval') io.approvals.withdraw(io.channel.agentId, 'priority')
      else { io.dialogs.decide(io.dialogs.getSnapshot().key, true); await finished }
      assert.ok(await settled(() => io.screen().includes('DEFERRED REPORT') && io.screen().includes('c copy')))
    })
    await fixture(fullscreen, async io => {
      let resolve
      const pending = new Promise(done => { resolve = done })
      await io.run(() => pending)
      io.controller.current.clear()
      io.stdin.write('\x1b[200~/theme\x1b[201~')
      assert.ok(await settled(() => io.controller.current.text() === '/theme'))
      await sleep(100) // 固定窗:pacing a second command is a distinct Enter gesture.
      io.stdin.write('\r')
      assert.ok(await settled(() => io.screen().includes('auto')))
      resolve({ kind: 'success', text: 'OVERLAY REPORT\nOVERLAY TAIL', consumeDraft: true })
      assert.ok(await settled(() => io.output().length === 2))
      await sleep(120) // 固定窗:探针 a late report must not replace a picker the user explicitly opened.
      assert.ok(io.screen().includes('auto') && !io.screen().includes('c copy'))
      io.stdin.write('\x1b')
      assert.ok(await settled(() => io.controller.current !== null))
      await sleep(120) // 固定窗:探针 closing the picker must not resurrect an auto-open that was refused.
      assert.ok(!io.screen().includes('c copy'))
    })
    await fixture(fullscreen, async io => {
      await io.run({ kind: 'success', text: 'line\n'.repeat(100000), consumeDraft: true })
      assert.ok(await settled(() => io.output().length > 0))
      assert.ok(io.output().length <= 201, 'a hostile report has bounded row count')
      assert.match(io.output().at(-1), /truncated/i, 'resource limit is explicitly reported')
    })
    await fixture(fullscreen, async io => {
      await io.run({ kind: 'success', text: '界'.repeat(40000), consumeDraft: true })
      assert.ok(await settled(() => io.output().length > 0))
      assert.ok(io.output()[0].endsWith('…'), 'a clipped line announces its limit')
      assert.ok(io.output()[0].length <= 2001, 'wide characters respect the per-line cell budget')
    })
    await fixture(fullscreen, async io => {
      await io.run({ kind: 'success', text: '\x00'.repeat(65535) + '🙂TAIL', consumeDraft: true })
      assert.ok(await settled(() => io.output().length === 1))
      assert.match(io.output()[0], /truncated/i)
      assert.ok(!/[\uD800-\uDFFF\uFFFD]/u.test(io.output()[0]), 'total text cap does not split a surrogate pair')
    })
    console.log(`PASS: registry command reports, errors, drafts and session races (${fullscreen ? 'fullscreen' : 'inline'}, 54 columns)`)
  }
  if (process.env.DSH_TUI_COMMAND_OUTPUT_EVIDENCE) writeFileSync(process.env.DSH_TUI_COMMAND_OUTPUT_EVIDENCE, JSON.stringify(evidence, null, 2))
} finally {
  rmSync(home, { recursive: true, force: true })
}
