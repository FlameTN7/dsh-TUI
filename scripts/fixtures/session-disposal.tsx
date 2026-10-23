/** Real Chat/DSH adapter fixture for verify-session-disposal.mjs. No model calls. */
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import React from 'react'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AgentEvent, AgentEventMeta } from '../../src/agent/events.js'

const home = process.env.DISPOSAL_TEST_HOME!
let cleanupComplete = false
process.on('exit', code => writeFileSync(process.env.DISPOSAL_TEST_EXIT!, JSON.stringify({ code, cleanupComplete })))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = home
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
const [{ render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel }, { createDshSession }, { createChannelUi, createChannelUiLease }] = await Promise.all([
  import('../../src/ui.js'), import('../../src/screens/Chat.js'),
  import('../../src/dsh-adapter/questions.js'), import('../../src/dsh-adapter/channel.js'),
  import('../../src/dsh-adapter/backend/session.js'), import('../../src/adapter/channel/ui.js'),
])
const ctx = new Context()
const delivered: Array<{ session: string; text: string }> = []
const agents: ReturnType<typeof makeAgent>[] = []
function makeAgent(session: Session) {
  let turn = 0
  const emit = <K extends Parameters<Session['append']>[0]>(type: K, data: never) => {
    const event = session.append(type, data, type === 'user/message' || type === 'assistant/message' ? { surfaceOp: 'append' } : undefined)
    ctx.emit('session/event', session, event)
  }
  const finish = (reason: TurnEndReason, text?: string) => {
    if (text) emit('assistant/message', {
      turn, step: 1, stream: [],
      // Real settlements carry request usage; without it the turn-summary row
      // (and its outcome marker) never renders, so the disposal case would not
      // exercise the path this regression exists to protect.
      usage: { inputTokens: 10, outputTokens: 5 },
      message: createAssistantMessage({
        source: { provider: 'fake', model: 'probe-model' }, content: [{ type: 'text', text }],
      }),
    } as never)
    emit('step/end', { turn, step: 1 } as never)
    // rc.2's durable shape includes the nested cancellation cause.
    emit('turn/end', { turn, reason } as never)
    agent.status = 'idle'
    ctx.emit('agent/status', { agent: agent as never, status: 'idle' })
    if (reason.kind === 'aborted' && reason.reason.kind === 'disposed') {
      ctx.emit('agent/disposed', { agent: agent as never })
    }
  }
  const agent = {
    id: String(session.id), session, status: 'idle',
    ctx: { on: () => () => {} },
    followup(message: UserMessage) {
      turn += 1
      agent.status = 'running'
      ctx.emit('agent/status', { agent: agent as never, status: 'running' })
      emit('turn/start', { turn } as never)
      ctx.emit('agent/inbox/claimed', { agent: agent as never, message, turn })
      emit('step/start', { turn, step: 1 } as never)
      emit('user/message', message as never)
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      delivered.push({ session: agent.id, text })
      if (text === 'dispose') finish({ kind: 'aborted', reason: { kind: 'disposed' } }, 'DISPOSAL_REPLY')
      else if (!text.startsWith('hold-')) finish({ kind: 'completed' }, 'NORMAL_REPLY')
    },
    steer(message: UserMessage) { agent.followup(message) },
    cancel() { finish({ kind: 'aborted', reason: { kind: 'user' } }) },
    whenIdle: async () => {},
    inbox: { remove: () => true, clear() {}, nextTurn: [], nextStep: [] },
    finish,
  }
  agents.push(agent)
  return agent
}
ctx.provide('agents', {
  get: () => undefined,
  async create(options: CreateAgentOptions) {
    const session = Session.create(options.sessionId, options.seed, {
      ...Session.create(options.sessionId).header, createdAt: 1, ...options.meta,
    }, options.inheritedEventCount)
    const agent = makeAgent(session)
    const setup = await options.setup?.(ctx, agent as never)
    setup?.commit()
    return { agent, dispose: async () => {} }
  },
} as never)
const source = Session.create(SessionId('disposal-source'), [], {
  ...Session.create(SessionId('disposal-source')).header, createdAt: 1, cwd: home,
})
const initial = createDshSession(ctx, { agent: makeAgent(source) as never, handle: undefined })
let oldListener: Parameters<typeof initial.subscribe>[0] | undefined
let oldBatch: readonly AgentEvent[] | undefined
let oldMeta: AgentEventMeta | undefined
const subscribe = initial.subscribe.bind(initial)
initial.subscribe = listener => {
  oldListener = listener
  return subscribe((batch, meta) => {
    if (batch.some(event => event.type === 'turn.end')) { oldBatch = batch; oldMeta = meta }
    listener(batch, meta)
  })
}
const channel = createChannel(ctx, initial, {
  model: 'probe-model', provider: 'fake', cwd: home, activity: false, whaleIdle: false,
})
const lease = createChannelUiLease(() => true)
const fullscreen = process.env.DISPOSAL_TEST_FULLSCREEN === '1'
const exited = Promise.withResolvers<void>()
const screen = <Chat channel={createChannelUi(channel, 'legacy', lease)} questionStore={new QuestionStore()} onExit={() => exited.resolve()} fullscreen={fullscreen} />
const app = await render(fullscreen ? <AlternateScreen>{screen}</AlternateScreen> : screen, {
  stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, exitOnCtrlC: false, patchConsole: false,
})
// Control only the bounded backend double. Input and /new travel through the PTY.
const server = createServer((req, res) => {
  if (req.url === '/stale') {
    if (!oldListener || !oldBatch || !oldMeta) throw new Error('No captured old turn.end')
    oldListener(oldBatch, oldMeta)
  }
  if (req.url === '/complete') agents.at(-1)!.finish({ kind: 'completed' }, 'NEW_SESSION_REPLY')
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({
    sessionId: channel.sessionId, working: channel.working, pending: channel.pending.length,
    rows: channel.rows.map(row => ({ kind: row.kind, text: row.text })), delivered,
  }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (typeof address === 'object' && address) writeFileSync(process.env.DISPOSAL_TEST_READY!, String(address.port))
await exited.promise
await app.unmount()
lease.dispose()
channel.releaseContributions()
await ctx.fiber.dispose()
await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
process.stdin.pause()
cleanupComplete = true
