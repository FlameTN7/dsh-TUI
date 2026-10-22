/**
 * Real-terminal Chat fixture for the migration PTY runner. The caller supplies
 * an isolated DSH_TUI_PTY_HOME, installed profile and host PATH; migration uses
 * Chat's real bin lookup and child process without interception.
 *
 * Run in a PTY: node --import tsx/esm scripts/fixtures/migrate-chat-pty.tsx
 * DSH_TUI_PTY_FULLSCREEN=1 wraps Chat in the production alternate-screen tree;
 * 0 uses inline mode. Type /migrate claude-code, then d to preview or Enter to
 * import. Ctrl+C (or /exit) unmounts before printing MIGRATE_CHAT_PTY_RESULT.
 * DSH_TUI_PTY_CHAT_RESULT optionally receives the same JSON without TTY wrapping.
 */
import { writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import type { ReactNode } from 'react'
import type { ChatRow, NotificationItem } from '../../src/adapter/ports/channel-view.js'
import type { ChannelUi } from '../../src/adapter/channel/ui-policy.js'

const fixtureHome = process.env.DSH_TUI_PTY_HOME
if (!fixtureHome) throw new Error('Set DSH_TUI_PTY_HOME to the isolated fixture home')
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('migrate-chat-pty requires a real PTY')

// Set these before importing stores/adapters, which can cache home paths.
process.env.HOME = resolve(fixtureHome)
process.env.USERPROFILE = resolve(fixtureHome)
process.env.DSH_HOME ??= join(resolve(fixtureHome), '.dsh')
process.env.GROK_HOME = join(resolve(fixtureHome), '.grok')
process.env.DSH_TUI_LANG ??= 'en'

const [React, { render, ThemeProvider, AlternateScreen, useInput }, { Chat }, { PageMargin }, { QuestionStore }, { LOCAL_COMMANDS }] = await Promise.all([
  import('react'),
  import('../../src/ui.js'),
  import('../../src/screens/Chat.js'),
  import('../../src/components/PageMargin.js'),
  import('../../src/dsh-adapter/questions.js'),
  import('../../src/commands.js'),
])

const fullscreen = process.env.DSH_TUI_PTY_FULLSCREEN === '1'
const listeners = new Set<() => void>()
const timers = new Set<ReturnType<typeof setTimeout>>()
const submitCalls: unknown[] = []
const notifyCalls: string[] = []
const localRows: { title: string; lines: string[] }[] = []
let rowId = 0
let notificationId = 0

const emit = (): void => {
  channel.version += 1
  for (const listener of listeners) listener()
}

const channel = {
  version: 0,
  ready: true,
  whaleIdle: false,
  rows: [] as ChatRow[],
  notifications: [] as NotificationItem[],
  status: 'idle' as const,
  sessionTitle: 'migrate-pty',
  agentId: 'migrate-pty',
  sessionId: 'migrate-pty',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  tokens: { input: 0, output: 0 },
  cwd: process.cwd(),
  displayCwd: process.cwd(),
  gitBranch: 'fixture',
  working: false,
  spinnerMode: 'requesting' as const,
  mode: { plan: false },
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  lastUserText: '',
  pending: [],
  commandList: LOCAL_COMMANDS,
  commandCompletions: () => [],
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  submit(input: unknown) {
    submitCalls.push(input)
    channel.notify('PTY fixture failure: local command reached model submit', { color: 'error' })
    return Promise.resolve()
  },
  steer() {},
  cancel() {},
  clear() { channel.rows = []; emit() },
  notify(text: string, options: { color?: NotificationItem['color']; timeoutMs?: number } = {}) {
    notifyCalls.push(text)
    const item: NotificationItem = { id: notificationId++, text, color: options.color, timeoutMs: options.timeoutMs ?? 4000 }
    channel.notifications.push(item)
    emit()
    let timer: ReturnType<typeof setTimeout> | undefined
    const dismiss = (): void => {
      if (timer !== undefined) { clearTimeout(timer); timers.delete(timer) }
      const index = channel.notifications.indexOf(item)
      if (index >= 0) { channel.notifications.splice(index, 1); emit() }
    }
    if (item.timeoutMs > 0) {
      timer = setTimeout(dismiss, item.timeoutMs)
      timers.add(timer)
    }
    return dismiss
  },
  pushLocal(title: string, lines: readonly string[]) {
    localRows.push({ title, lines: [...lines] })
    channel.rows.push({ id: rowId++, kind: 'local', text: title })
    for (const text of lines) channel.rows.push({ id: rowId++, kind: 'local-output', text })
    emit()
  },
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
}

let finish = (): void => undefined
const exited = new Promise<void>(resolveExit => { finish = resolveExit })
function ExitKey(): ReactNode {
  useInput((input, key) => { if (key.ctrl && input === 'c') finish() })
  return null
}
const chat = <PageMargin>
  <ExitKey />
  <Chat channel={channel as unknown as ChannelUi} questionStore={new QuestionStore()}
    fullscreen={fullscreen} onExit={finish} openHomeOnBoot={false}
    launchpadOnBoot={false} onboardingOnBoot={false} />
</PageMargin>
const instance = await render(
  <ThemeProvider>{fullscreen ? <AlternateScreen>{chat}</AlternateScreen> : chat}</ThemeProvider>,
  { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
    exitOnCtrlC: false, patchConsole: false, terminalImages: false },
)
process.once('SIGINT', finish)
process.once('SIGTERM', finish)
try {
  await exited
} finally {
  await instance.unmount()
  process.removeListener('SIGINT', finish)
  process.removeListener('SIGTERM', finish)
  for (const timer of timers) clearTimeout(timer)
  listeners.clear()
  process.stdin.pause()
}
const result = JSON.stringify({ fullscreen, submitCalls: submitCalls.length, submissions: submitCalls, localRows, notifications: notifyCalls })
if (process.env.DSH_TUI_PTY_CHAT_RESULT) writeFileSync(process.env.DSH_TUI_PTY_CHAT_RESULT, result + '\n')
process.stdout.write(`\nMIGRATE_CHAT_PTY_RESULT=${result}\n`)
process.exitCode = submitCalls.length > 0 ? 1 : 0
