/** Real PTY regression: node scripts/verify-session-disposal.mjs */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { TuiTest } from '@microsoft/tui-test'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(process.env.DISPOSAL_TEST_ARTIFACTS ?? join(tmpdir(), 'dsh-tui-session-disposal'))
await mkdir(root, { recursive: true })
const waitFor = async (predicate, label, timeout = 15_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await predicate()) return
    await delay(50)
  }
  throw new Error(`Timed out: ${label}`)
}
for (const lang of ['en', 'zh']) {
  for (const fullscreen of [false, true]) {
    for (const cols of [100, 48]) {
      const name = `${lang}-${fullscreen ? 'fullscreen' : 'inline'}-${cols}`
      const dir = join(root, name)
      await mkdir(dir, { recursive: true })
      const home = await mkdtemp(join(tmpdir(), 'dsh-disposal-'))
      const ready = join(home, 'ready')
      const exitResult = join(dir, 'exit.json')
      await rm(exitResult, { force: true })
      const term = TuiTest.ephemeral(`disposal-${name}`, {
        backend: 'alacritty', trace: { mode: 'on', directory: dir },
        recording: { directory: dir }, artifacts: { dir, onFailure: 'all', includeRecording: true },
      })
      const submit = async text => {
        await term.type(text)
        // 固定窗:pacing Chat and PromptInput deduplicate Enter inside an 80 ms window.
        await delay(120)
        await term.press('Enter')
      }
      const stopped = lang === 'zh' ? '会话已停止' : 'Session stopped'
      const interrupted = lang === 'zh' ? '已打断' : 'Interrupted'
      // The turn-summary row's own marker. A disposed turn carries usage in
      // this fixture on purpose: without covering it, "interrupted" could come
      // back through the ledger while the notice still read "Session stopped".
      const usageInterrupted = lang === 'zh' ? '已中断' : 'interrupted'
      const invitation = lang === 'zh' ? '接下来想让' : 'What should'
      let inspectState
      try {
        await term.run(process.execPath, ['--import', 'tsx/esm', 'scripts/fixtures/session-disposal.tsx'], {
          cwd, cols, rows: 32,
          env: { ...process.env, FORCE_COLOR: '3', DSH_TUI_LANG: lang, DISPOSAL_TEST_HOME: home,
            DISPOSAL_TEST_READY: ready, DISPOSAL_TEST_EXIT: exitResult,
            DISPOSAL_TEST_FULLSCREEN: fullscreen ? '1' : '0' },
        })
        let port
        await waitFor(async () => { try { port = await readFile(ready, 'utf8'); return true } catch { return false } }, 'fixture ready', 30_000)
        const state = async (path = '/') => (await fetch(`http://127.0.0.1:${port}${path}`)).json()
        inspectState = state
        await term.getByText('probe-model').expect()
        await submit('dispose')
        await term.getByText('DISPOSAL_REPLY').expect()
        await waitFor(async () => !(await state()).working, 'disposal settles')
        await term.screenshot(join(dir, 'disposed.svg'))
        await writeFile(join(dir, 'disposed.txt'), await term.text())
        await term.getByText(stopped).expect()
        await term.getByText(invitation).expect({ not: true })
        await term.getByText(interrupted).expect({ not: true })
        await term.getByText(usageInterrupted).expect({ not: true })
        await term.type('editable-after-stop')
        await waitFor(async () => (await term.text()).split('\n').filter(line => /❯/.test(line)).at(-1)?.includes('editable-after-stop'), 'composer remains editable')
        await term.screenshot(join(dir, 'editable.svg'))
        await term.press('Ctrl+U')
        await submit('/new')
        await waitFor(async () => (await state()).sessionId !== 'disposal-source', 'explicit /new adoption')
        await term.getByText(stopped).expect({ not: true })
        await submit('hold-new')
        await waitFor(async () => (await state()).working && (await state()).delivered.at(-1)?.text === 'hold-new', 'new session starts')
        const before = await state()
        const after = await state('/stale')
        assert.equal(after.sessionId, before.sessionId)
        assert.equal(after.working, true, 'old generation must not settle the new turn')
        assert.deepEqual(after.rows, before.rows, 'old generation must not append a stale stopped row')
        await term.getByText(stopped).expect({ not: true })
        await state('/complete')
        await term.getByText('NEW_SESSION_REPLY').expect()
        await term.screenshot(join(dir, 'new-session.svg'))
        await submit('ordinary')
        await term.getByText('NORMAL_REPLY').expect()
        await term.getByText(invitation).expect({ not: true })
        await submit('hold-user')
        await waitFor(async () => (await state()).working, 'user cancellation turn starts')
        await term.press('Escape')
        await term.getByText(interrupted).expect()
        await term.getByText(invitation).expect()
        await term.screenshot(join(dir, 'user-interrupted.svg'))
        const final = await state()
        assert.deepEqual(final.delivered.map(item => item.text), ['dispose', 'hold-new', 'ordinary', 'hold-user'])
        assert.ok(final.delivered.slice(1).every(item => item.session !== 'disposal-source'))
        assert.equal(final.working, false)
        await writeFile(join(dir, 'state.json'), JSON.stringify(final, null, 2))
        await term.press('Ctrl+C')
        await term.getByText(lang === 'zh' ? '再次按 Ctrl+C 退出' : 'Press Ctrl+C again to exit').expect()
        await term.press('Ctrl+C')
        await term.waitExit({ timeout: 15_000 })
        assert.deepEqual(JSON.parse(await readFile(exitResult, 'utf8')), { code: 0, cleanupComplete: true })
        console.log(`PASS ${name}: disposal, editing, /new, stale generation, completion, user cancellation, clean exit`)
      } catch (error) {
        if (inspectState) await writeFile(join(dir, 'failure-state.json'), JSON.stringify(await inspectState().catch(error => ({ inspectionError: String(error) })), null, 2))
        await writeFile(join(dir, 'failure.txt'), `${String(error)}\n\n${await term.text().catch(() => '')}`)
        throw error
      } finally {
        await term.closeQuiet()
        assert.equal(dirname(resolve(home)), resolve(tmpdir()), 'remove only the HOME created for this case')
        await rm(home, { recursive: true, force: true })
      }
    }
  }
}
