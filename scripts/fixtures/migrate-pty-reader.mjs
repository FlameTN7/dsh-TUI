import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [host, root] = process.argv.slice(2)
const require = createRequire(join(host, 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const persistenceModule = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { Session, SessionLogOffset } = await load('@deepseek-ai/dsh-session')
const ctx = new Context()
try {
  await ctx.plugin(persistenceModule.default ?? persistenceModule, { root })
  for (let i = 0; i < 100 && ctx.get('sessionPersistence') === undefined; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const persistence = ctx.get('sessionPersistence')
  assert.ok(persistence, 'official persistence is ready')
  const listed = await persistence.list()
  assert.equal(listed.length, 1)
  const id = listed[0].header.id
  const handle = await persistence.open(id, 'read')
  try {
    const { events, eventState } = await handle.read()
    const session = Session.fromRestore(id, events, handle.header, SessionLogOffset(0), eventState)
    const messages = session.deriveMessages()
    assert.deepEqual(messages.map(message => message.role), ['user', 'assistant'])
    assert.deepEqual(messages.map(message => message.content.map(block => block.text ?? '').join('')),
      ['migration PTY question', 'migration PTY answer'])
  } finally {
    await handle.close()
  }
  console.log('official reader restored user and assistant')
} finally {
  await ctx.fiber.dispose()
}
