/**
 * Esc ownership through real Chat, PromptInput and channel (#1310).
 * Covers command/file completion before cancellation, undo, queued input,
 * the expanded editor and ordinary running-turn interruption in both layouts.
 * Run: node --import tsx/esm scripts/verify-prompt-escape.tsx
 */
import fakeHome from './lib/fake-home.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentSession, CancelCause } from '../src/agent/session.js'
import type { PromptController } from '../src/components/PromptInput.js'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ Writable, PassThrough }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore },
  { createChannel }, { createStartingSession }, { settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Chat.js'), import('../src/channel/questions.js'),
  import('../src/dsh-adapter/channel.js'), import('../src/agent/starting-session.js'),
  import('./lib/term-test.mjs'),
])

const cwd = join(fakeHome, 'workspace')
mkdirSync(cwd)
writeFileSync(join(cwd, 'escape-fixture.txt'), 'completion fixture\n')
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? `\n${detail}` : ''}`)
}

async function boot(fullscreen: boolean, columns: number) {
  const term = new XTerm({ cols: columns, rows: 32, scrollback: 200, allowProposedApi: true })
  class Out extends Writable {
    columns = columns
    rows = 32
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  class In extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new In()
  const listeners = new Set<(events: readonly AgentEvent[], meta: AgentEventMeta) => void>()
  const cancels: CancelCause[] = []
  const session: AgentSession = {
    ...createStartingSession('fixture', cwd),
    ref: { backendId: 'fixture', sessionId: 'escape-fixture' },
    status: 'idle',
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    submit: () => Promise.resolve({ accepted: true }),
    cancel: cause => { cancels.push(cause); return Promise.resolve({ stillQueued: [], outcome: 'confirmed' }) },
  }
  const ctx = { on: () => () => undefined, get: () => undefined,
    logger: { warn() {}, info() {}, debug() {} } } as never
  const channel = createChannel(ctx, session, { model: 'fixture', provider: '', cwd, activity: false })
  const controller: { current: PromptController | null } = { current: null }
  const node = <Chat channel={channel} questionStore={new QuestionStore()} fullscreen={fullscreen}
    trajectorySeen promptControllerRef={controller} onExit={() => undefined} />
  const stdout = new Out()
  const app = await ui.render(fullscreen ? <ui.AlternateScreen>{node}</ui.AlternateScreen> : node, {
    stdout: stdout as never, stdin: stdin as never, stderr: stdout as never,
    exitOnCtrlC: false, patchConsole: false,
  })
  const view = () => viewportLines(term).join('\n')
  const emit = (event: AgentEvent) => {
    for (const listener of listeners) listener([event], { replay: false })
  }
  let turn = 0
  check('composer mounted', await settled(() => controller.current !== null))
  return {
    stdin, channel, controller, view, cancels,
    working: () => emit({ type: 'turn.start', turn: ++turn, origin: 'user', time: turn }),
    idle: () => emit({ type: 'turn.end', turn, reason: { kind: 'completed' }, time: turn }),
    clear: async () => {
      controller.current!.clear()
      check('previous draft cleared', await settled(() => controller.current!.text() === ''
        && !view().includes('commands ·') && !view().includes('escape-fixture.txt')))
    },
    type: (text: string) => stdin.write(`\x1b[200~${text}\x1b[201~`),
    close: () => { app.unmount(); channel.releaseContributions(); term.dispose() },
  }
}

for (const fullscreen of [false, true]) for (const columns of [120, 48]) {
  const h = await boot(fullscreen, columns)
  const tag = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}`
  const commandsOpen = () => h.view().includes('commands ·')
  const filesOpen = () => h.view().includes('escape-fixture.txt')
  try {
    for (const working of [false, true]) {
      if (working) h.working()
      else h.idle()
      await h.clear()
      h.type('/he')
      check(`${tag} working=${working}: command menu opens`, await settled(commandsOpen), h.view())
      const before = h.cancels.length
      h.stdin.write('\x1b')
      check(`${tag} working=${working}: Esc closes command menu and clears its draft`,
        await settled(() => !commandsOpen() && h.controller.current!.text() === ''), h.view())
      check(`${tag} working=${working}: closing menu does not cancel the turn`, h.cancels.length === before)

      h.stdin.write('\x1a')
      check(`${tag}: undo restores the dismissed command draft`,
        await settled(() => commandsOpen() && h.controller.current!.text() === '/he'))
      await h.clear()
      h.type('read @escape-')
      check(`${tag}: file menu opens mid-draft`, await settled(filesOpen), h.view())
      h.stdin.write('\x1b')
      check(`${tag}: Esc closes file menu and preserves the whole draft`,
        await settled(() => !filesOpen()) && h.controller.current!.text() === 'read @escape-', h.view())
      check(`${tag}: closing file menu does not cancel the turn`, h.cancels.length === before)
      h.stdin.write('f')
      check(`${tag}: editing the mention reopens completion`,
        await settled(() => filesOpen() && h.controller.current!.text() === 'read @escape-f'), h.view())
      await h.clear()
    }

    // Ordinary running-turn Esc still cancels and keeps the draft. A blanket
    // "composer has text" guard would swallow the documented interrupt here.
    h.type('keep this draft')
    check(`${tag}: ordinary draft entered`, await settled(() => h.controller.current!.text() === 'keep this draft'))
    const before = h.cancels.length
    h.stdin.write('\x1b')
    check(`${tag}: ordinary Esc still interrupts once`, await settled(() => h.cancels.length === before + 1))
    check(`${tag}: interruption preserves the draft`, h.controller.current!.text() === 'keep this draft')

    h.working()
    h.stdin.write('\x1b[69;6u')
    check(`${tag}: expanded editor opens`, await settled(() => h.view().includes('Draft editor')))
    h.stdin.write('\x1b')
    check(`${tag}: Esc collapses the editor without interrupting`,
      await settled(() => !h.view().includes('Draft editor')) && h.cancels.length === before + 1)
    check(`${tag}: collapse preserves text`, h.controller.current!.text() === 'keep this draft')

    await h.clear()
    h.type('queued follow-up')
    check(`${tag}: follow-up entered`, await settled(() => h.controller.current!.text() === 'queued follow-up'))
    h.stdin.write('\t')
    check(`${tag}: Tab queues the follow-up`, await settled(() => h.channel.pending.length === 1))
    const pendingId = h.channel.pending[0]?.id
    h.type('/he')
    check(`${tag}: command menu opens over queued input`, await settled(commandsOpen))
    h.stdin.write('\x1b')
    check(`${tag}: menu Esc leaves the queue running`, await settled(() => !commandsOpen())
      && h.cancels.length === before + 1 && h.channel.pending[0]?.id === pendingId && h.channel.working)
    h.stdin.write('\x1b')
    check(`${tag}: next Esc interrupts and docks the queue`, await settled(() => h.cancels.length === before + 2)
      && h.cancels.at(-1) === 'interrupt')
    // 固定窗:探针 no second listener may cancel again after the same parsed key.
    await sleep(100)
    check(`${tag}: cancellation is delivered once`, h.cancels.length === before + 2)

    // Extended keyboard protocols can deliver two Esc presses in one stdin
    // read. The second must see the first menu dismissal synchronously.
    for (const draft of ['/he', 'read @escape-']) {
      h.idle()
      h.working()
      await h.clear()
      h.type(draft)
      check(`${tag}: batch fixture menu opens`, await settled(draft.startsWith('/') ? commandsOpen : filesOpen))
      const cancelsBeforeBatch = h.cancels.length
      h.stdin.write('\x1b[27u\x1b[27u')
      // Cancellation is synchronous; the menu disappears on a later frame.
      // Wait for both effects before inspecting the terminal snapshot.
      check(`${tag} ${draft}: batched Esc closes the menu, then interrupts`,
        await settled(() => h.cancels.length === cancelsBeforeBatch + 1
          && !commandsOpen() && !filesOpen()),
        `cancels=${h.cancels.length - cancelsBeforeBatch}\n${h.view()}`)
    }
  } finally { h.close() }
}

console.log(`${checks - failures}/${checks} prompt escape checks passed`)
process.exit(failures === 0 ? 0 : 1)
