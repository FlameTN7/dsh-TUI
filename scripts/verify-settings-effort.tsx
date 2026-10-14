/**
 * Model-owned effort IDs in the real /settings input/save path (#1317).
 * Run: node --import tsx/esm scripts/verify-settings-effort.tsx
 * Optional DSH_TUI_EFFORT_SCREEN_DIR captures the rendered terminal evidence.
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
await import('./lib/fake-home.mjs')

const [
  React,
  { PassThrough, Writable },
  { Terminal },
  { render, AlternateScreen },
  { Settings },
  { settingField },
  { settled, settle, sleep, viewportLines },
  assert, fs, path, os,
  { createTuiSettingsService },
  { readTuiSettings, writeTuiSettings },
] = await Promise.all([
  import('react'),
  import('node:stream'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Settings.js'),
  import('../src/settings/definitions.js'),
  import('./lib/term-test.mjs'),
  import('node:assert/strict'),
  import('node:fs'),
  import('node:path'),
  import('node:os'),
  import('../src/dsh-adapter/tui-settings.js'),
  import('../src/tuiSettingsFile.js'),
])
import type { ChannelUi } from '../src/adapter/channel/ui-policy.js'
import type { SettingsPathOp } from '../src/adapter/ports/channel-settings.js'

class Stdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Stderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) { callback() }
}
for (const fullscreen of [false, true]) {
  for (const columns of [100, 42]) {
    const rows = 22
    const term = new Terminal({ cols: columns, rows, allowProposedApi: true })
    class Stdout extends Writable {
      columns = columns
      rows = rows
      isTTY = true
      _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) { term.write(String(chunk), callback) }
    }
    const stdin = new Stdin()
    const section = {
      ns: 'dsh-tui',
      title: 'TUI',
      groups: [{ id: 'conversation', title: 'Conversation', mode: 'inline' as const }],
      fields: [settingField('effortDefault')],
    }
    let effortDefault = 'auto'
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-effort-'))
    const file = path.join(directory, 'settings.json')
    writeTuiSettings({ version: 1, values: { effortDefault } }, file)
    const serviceOptions = { ns: section.ns, file, profile: 'effort-fixture', keys: ['effortDefault'] }
    const service = createTuiSettingsService(serviceOptions)
    const writes: SettingsPathOp[] = []
    let calls = 0
    const host = {
      listNamespaces: () => service.describe(),
      async write(ns: string, ops: readonly SettingsPathOp[], expected?: number) {
        assert.equal(ns, section.ns)
        assert.equal(expected, service.describe()[0]?.revision)
        writes.push(...ops)
        const op = ops[0]
        assert.equal(op?.path.join('.'), 'effortDefault')
        assert.equal(op?.op, 'set')
        await service.mutate(ns, ops, expected)
        effortDefault = String(readTuiSettings(file)?.values.effortDefault)
      },
      credentialConfigured: async () => false,
      writeCredential: async () => {},
    }
    const levels = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom-budget']
    let staleReply: (() => void) | undefined
    const fixture = {
      provider: 'fixture', model: 'complete', agentId: 'fixture-agent', settingsNamespace: section.ns,
      settingsHost: () => host, settingsSections: () => [section], subscribeSettingsSections: () => () => {},
      async listEfforts(route: { provider: string; model: string }) {
        calls++
        assert.equal(route.provider, 'fixture')
        const ids = route.model === 'complete' ? levels : route.model === 'single' ? ['high'] : []
        if (route.model === 'pending') await new Promise<void>(resolve => { staleReply = resolve })
        if (route.model === 'broken') throw new Error('catalog unavailable')
        return { efforts: ids.map(id => ({ id, name: id })), defaultEffort: ids[0] }
      },
    }
    const channel = fixture as unknown as ChannelUi
    const screen = () => viewportLines(term, rows).join('\n')
    const capture = (label: string): void => {
      const evidenceDir = process.env.DSH_TUI_EFFORT_SCREEN_DIR
      if (!evidenceDir) return
      fs.mkdirSync(evidenceDir, { recursive: true })
      fs.writeFileSync(path.join(evidenceDir, `${fullscreen ? 'fullscreen' : 'inline'}-${columns}-${label}.txt`), screen())
    }
    const scene = () => <Settings channel={channel} onClose={() => {}} />
    const tree = () => fullscreen ? scene() : <AlternateScreen>{scene()}</AlternateScreen>
    const instance = await render(tree(), {
      stdout: new Stdout(), stdin, stderr: new Stderr(), exitOnCtrlC: false, patchConsole: false,
    })
    try {
      assert.ok(await settled(() => screen().includes('Conversation') && calls === 1), screen())
      for (const id of levels) {
        stdin.write('\x1b[C')
        assert.ok(await settled(() => effortDefault === id && screen().includes(`‹ ${id}`)
          && !screen().includes('[saving]')), `${fullscreen ? 'fullscreen' : 'inline'} ${columns}: can select/save ${id}\n${screen()}`)
        if (['medium', 'xhigh', 'ultra', 'custom-budget'].includes(id)) capture(id)
      }
      assert.deepEqual(writes.map(op => op.op === 'set' ? op.value : undefined), levels)
      assert.equal(calls, 1, 'one capability query for the mounted route')
      assert.equal((createTuiSettingsService(serviceOptions).get(section.ns) as { effortDefault: string }).effortDefault, 'custom-budget', 'global preference survives a fresh service/launch')
      fixture.model = 'single'
      instance.rerender(tree())
      assert.ok(await settled(() => calls === 2 && (columns < 80 || screen().includes('unavailable on this model'))))
      assert.equal(effortDefault, 'custom-budget', 'changing models keeps the stored preference')
      assert.equal(writes.length, levels.length, 'capability refresh writes nothing')
      if (columns >= 80) capture('unavailable-preference')
      stdin.write('\x1b[C')
      assert.ok(await settled(() => effortDefault === 'auto'), 'Auto remains selectable after all backend IDs')
      stdin.write('\x1b[C')
      assert.ok(await settled(() => effortDefault === 'high'), 'single-tier models expose their only tier')
      fixture.model = 'pending'
      instance.rerender(tree())
      await settle(() => staleReply !== undefined)
      fixture.model = 'complete'
      instance.rerender(tree())
      assert.ok(await settled(() => calls === 4 && screen().includes('‹ high ›')), screen())
      staleReply?.()
      await sleep(200) // 固定窗:pacing 模型切换后 useInput effect 更新收键闭包，无纯文本锚点
      // The next rendered selection proves the stale zero-tier reply did not
      // replace the complete model's catalog.
      stdin.write('\x1b[C')
      assert.ok(await settled(() => effortDefault === 'xhigh'), `late replies from the previous model cannot replace current choices; saved=${effortDefault}\n${screen()}`)
      for (const nextModel of ['non-reasoning', 'broken']) {
        fixture.model = nextModel
        instance.rerender(tree())
        assert.ok(await settled(() => calls === (nextModel === 'broken' ? 6 : 5) && (columns < 80 || screen().includes('unavailable on this model'))))
        assert.equal(effortDefault, 'xhigh', 'empty/failed catalogs preserve the saved ID')
      }
      console.log(`PASS settings effort ${fullscreen ? 'fullscreen' : 'inline'} ${columns}`)
    } finally {
      await instance.unmount()
      term.dispose()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}
