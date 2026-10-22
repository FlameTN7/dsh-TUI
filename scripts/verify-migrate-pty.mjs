/**
 * Real PTY regression for the profile migration child. Requires an installed
 * stock DSH (DSH_TUI_CONTRACT_DSH=its package directory), never user sessions.
 * Run: node scripts/verify-migrate-pty.mjs
 * The profile deliberately has no host peers or historical fallback links.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TuiTest } from '@microsoft/tui-test'

const repo = resolve(import.meta.dirname, '..')
const hostDir = process.env.DSH_TUI_CONTRACT_DSH
assert.ok(hostDir, 'Set DSH_TUI_CONTRACT_DSH to a real installed DSH package')
const hostManifest = JSON.parse(readFileSync(join(hostDir, 'package.json'), 'utf8'))
assert.equal(hostManifest.name, '@deepseek-ai/dsh')
// May point at an extracted npm pack archive. No development dependencies or
// source imports are copied into the profile child.
const packageSource = resolve(process.env.DSH_TUI_PTY_PACKAGE ?? repo)
const manifest = JSON.parse(readFileSync(join(packageSource, 'package.json'), 'utf8'))
assert.ok(existsSync(join(packageSource, 'lib', 'types')), 'Run compile first, or set DSH_TUI_PTY_PACKAGE')
const root = mkdtempSync(join(tmpdir(), 'migrate-pty-'))
const home = join(root, 'home')
const dshHome = join(home, '.dsh')
const profile = join(dshHome, 'profiles', 'dsh-tui')
const pkg = join(profile, 'node_modules', manifest.name)
const migrate = join(pkg, 'lib', 'types', 'dsh-adapter', 'migrate')
const shimDir = join(root, 'bin')
const artifacts = resolve(process.env.DSH_TUI_PTY_ARTIFACTS ?? join(repo, '.local', 'migrate-pty', hostManifest.version))
const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dshHome,
  DSH_TUI_SESSION_ROOT: join(dshHome, 'sessions'), GROK_HOME: join(home, '.grok'),
  DSH_TUI_LANG: 'en', PATH: shimDir, NODE_OPTIONS: '', NODE_PATH: '' }
for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH' && key !== 'PATH') delete env[key]
delete env.NO_COLOR

function snapshot(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? snapshot(path).map(([name, data]) => [join(entry.name, name), data])
      : [[entry.name, createHash('sha256').update(readFileSync(path)).digest('hex')]]
  })
}
// The compiled sanitizer uses these ordinary production dependencies. Copy
// their real package bytes and transitive dependencies, never pnpm links or
// framework peers from the development tree.
function copyRuntimeDependency(name, from, target) {
  assert.ok(!name.startsWith('@deepseek-ai/'))
  const require = createRequire(join(from, 'package.json'))
  let source = dirname(require.resolve(name))
  while (!existsSync(join(source, 'package.json'))
    || JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name !== name) {
    assert.notEqual(dirname(source), source, `package root for ${name}`)
    source = dirname(source)
  }
  cpSync(source, target, { recursive: true, dereference: true,
    filter: path => basename(path) !== 'node_modules' })
  const dependency = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  for (const child of Object.keys(dependency.dependencies ?? {})) {
    copyRuntimeDependency(child, source, join(target, 'node_modules', child))
  }
}
function terminalFor(label) {
  return TuiTest.ephemeral(`migrate-${label}`, {
    trace: { mode: 'on', directory: join(artifacts, 'traces') },
    recording: { directory: join(artifacts, 'casts') },
    artifacts: { dir: join(artifacts, 'failures'), onFailure: 'all', includeRecording: true },
  })
}
async function run(label, args, expected, code = 0, overrides = {}) {
  const terminal = terminalFor(label)
  const result = join(artifacts, `${label}.exit.json`)
  try {
    await terminal.run(process.execPath, [join(repo, 'scripts', 'fixtures', 'migrate-pty-process.mjs'), result, ...args], {
      cwd: root, env: { ...env, ...overrides }, cols: 100, rows: 30,
    })
    await terminal.waitExit({ timeout: 30_000 })
    const output = await terminal.text({ full: true })
    writeFileSync(join(artifacts, `${label}.txt`), output)
    await terminal.screenshot(join(artifacts, `${label}.svg`))
    assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), { code, signal: null }, label)
    assert.match(output, expected, `${label}: ${output}`)
    if (code === 0) assert.doesNotMatch(output, /compiled copy|too old/, 'A valid migration cannot ask for an update')
    console.log(`PASS ${hostManifest.version} ${label}`)
    return output
  } finally {
    await terminal.closeQuiet()
  }
}
const cli = (label, args, expected, code) => run(label, [join(pkg, 'bin', 'dsh-tui.js'), 'migrate', ...args], expected, code)

async function chat(fullscreen) {
  const label = fullscreen ? 'chat-fullscreen' : 'chat-inline'
  const terminal = terminalFor(label)
  const result = join(artifacts, `${label}.exit.json`)
  const report = join(artifacts, `${label}.result.json`)
  try {
    const tsx = pathToFileURL(createRequire(join(repo, 'package.json')).resolve('tsx/esm')).href
    await terminal.run(process.execPath, [join(repo, 'scripts', 'fixtures', 'migrate-pty-process.mjs'), result,
      '--import', tsx, join(repo, 'scripts', 'fixtures', 'migrate-chat-pty.tsx')], {
      cwd: root, env: { ...env, DSH_TUI_PTY_HOME: home, DSH_TUI_PTY_FULLSCREEN: fullscreen ? '1' : '0',
        DSH_TUI_PTY_CHAT_RESULT: report }, cols: 100, rows: 30,
    })
    await terminal.getByText('migrate-pty').expect({ timeout: 30_000 })
    // The real Chat records typed commands in its normal input history. The
    // migration itself must preserve the source, profile and session stores.
    const before = [snapshot(dshHome), snapshot(join(home, '.claude'))]
    await terminal.submit('/migrate claude-code')
    await terminal.getByText('Confirm import').expect()
    await terminal.screenshot(join(artifacts, `${label}-confirm.svg`))
    await terminal.press('d')
    await terminal.getByText('dry run', { full: true }).expect({ timeout: 30_000 })
    assert.deepEqual([snapshot(dshHome), snapshot(join(home, '.claude'))], before,
      'Chat dry-run must preserve source, profile and session stores')
    await terminal.resize(50, 20)
    await terminal.waitIdle()
    await terminal.submit('/migrate claude-code')
    await terminal.getByText('Confirm import').expect()
    // Chat ignores repeated Enter within 80 ms. This is a separate physical
    // confirmation after the Enter that submitted the slash command.
    await new Promise(resolve => setTimeout(resolve, 120))
    await terminal.press('Enter')
    await terminal.getByText('already present 1', { full: true }).expect({ timeout: 30_000 })
    await terminal.type('input-restored')
    await terminal.getByText('input-restored').expect()
    await terminal.screenshot(join(artifacts, `${label}-narrow.svg`))
    await terminal.resize(100, 30)
    await terminal.waitIdle()
    await terminal.screenshot(join(artifacts, `${label}-wide.svg`))
    await terminal.press('Ctrl+C')
    await terminal.waitExit({ timeout: 15_000 })
    writeFileSync(join(artifacts, `${label}.txt`), await terminal.text({ full: true }))
    assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), { code: 0, signal: null })
    const data = JSON.parse(readFileSync(report, 'utf8'))
    assert.equal(data.submitCalls, 0, 'local migration must not submit to a model')
    assert.equal(data.localRows.length, 2, 'preview and import each return output to Chat')
    assert.match(JSON.stringify(data.localRows), /dry run/)
    assert.match(JSON.stringify(data.localRows), /already present 1/)
    console.log(`PASS ${hostManifest.version} ${label} confirmation, child output, resize, input, exit`)
  } finally {
    await terminal.closeQuiet()
  }
}

try {
  mkdirSync(migrate, { recursive: true })
  mkdirSync(shimDir)
  mkdirSync(artifacts, { recursive: true })
  cpSync(join(packageSource, 'bin'), join(pkg, 'bin'), { recursive: true })
  cpSync(join(packageSource, 'lib'), join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest))
  for (const dependency of ['emoji-regex', 'get-east-asian-width', 'strip-ansi']) {
    assert.ok(manifest.dependencies[dependency], `${dependency} must be a production dependency`)
    copyRuntimeDependency(dependency, repo, join(pkg, 'node_modules', dependency))
  }
  writeFileSync(join(pkg, 'cordis.patch.yml'), '- id: must-not-mount\n  name: ./must-not-mount.js\n')
  writeFileSync(join(pkg, 'must-not-mount.js'), 'throw new Error("migration must not compose profile plugins")\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'migrate-pty-profile', private: true,
    dependencies: { [manifest.name]: manifest.version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', manifest.name, '@deepseek-ai/dsh-experimental-schedule-bundle'] } } }))
  writeFileSync(join(profile, 'cordis.yml'), '# migration must preserve this root\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), 'invalid: [ must not be parsed\n')
  assert.deepEqual(readdirSync(join(profile, 'node_modules')), ['@deepseek-harness-tui'])
  assert.deepEqual(readdirSync(join(pkg, 'node_modules')).sort(), ['emoji-regex', 'get-east-asian-width', 'strip-ansi'])
  assert.ok(!existsSync(join(dshHome, 'profiles', 'node_modules')), 'profile must not have fallback links')
  const hostBin = join(hostDir, typeof hostManifest.bin === 'string' ? hostManifest.bin : hostManifest.bin.dsh)
  const shim = join(shimDir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  writeFileSync(shim, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${hostBin}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${hostBin}" "$@"\n`)
  chmodSync(shim, 0o755)
  const source = join(home, '.claude', 'projects', 'fixture')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, '11111111-1111-4111-8111-111111111111.jsonl'), [
    { type: 'user', cwd: root, timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'migration PTY question' } },
    { type: 'assistant', cwd: root, timestamp: '2026-10-01T00:00:01.000Z', message: { id: 'fixture-answer', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'migration PTY answer' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  const before = snapshot(home)
  await cli('preview', ['claude-code', '--dry-run'], /1 conversation\(s\).*dry run/s)
  assert.deepEqual(snapshot(home), before, 'dry-run must not write HOME, profile, or sessions')
  const sourceBefore = snapshot(source)
  await cli('import', ['claude-code'], /imported 1/)
  const imported = snapshot(join(dshHome, 'sessions'))
  assert.ok(imported.length > 0, 'real persistence must create a session')
  await cli('repeat', ['claude-code'], /imported 0.*already present 1/s)
  assert.deepEqual(snapshot(join(dshHome, 'sessions')), imported, 'repeat must not rewrite sessions')
  assert.deepEqual(snapshot(source), sourceBefore, 'foreign source must remain untouched')
  await run('read-back', [join(repo, 'scripts', 'fixtures', 'migrate-pty-reader.mjs'), hostDir, join(dshHome, 'sessions')], /official reader restored user and assistant/)
  await cli('unknown-agent', ['not-an-agent'], /unknown agent/, 2)
  await run('no-host', [join(pkg, 'bin', 'dsh-tui.js'), 'migrate', 'claude-code', '--dry-run'],
    /host module resolution: no dsh on PATH/, 1, { PATH: '' })
  await run('direct-peer-fallback', ['--input-type=module', '-e',
    `import { cliMigrate } from ${JSON.stringify(pathToFileURL(join(repo, 'lib', 'types', 'dsh-adapter', 'migrate', 'entry.js')).href)};
     process.exitCode = await cliMigrate(['claude-code', '--dry-run'], ${JSON.stringify(profile)})`],
  /1 conversation\(s\).*dry run/s, 0, { PATH: '' })

  const entryFile = join(migrate, 'entry.js')
  const cliFile = join(migrate, 'cli.js')
  const entryBytes = readFileSync(entryFile)
  const cliBytes = readFileSync(cliFile)
  // Only these two controlled fixture files are changed for diagnostic tests.
  rmSync(entryFile)
  await cli('missing-entry', [], /compiled copy.*missing or too old/s, 1)
  writeFileSync(entryFile, 'export const cliMigrate = undefined\n')
  await cli('missing-export', [], /compiled copy.*missing or too old/s, 1)
  writeFileSync(entryFile, entryBytes)
  rmSync(cliFile)
  await cli('missing-cli', [], /compiled copy.*missing or too old/s, 1)
  writeFileSync(cliFile, 'import "missing-migration-dependency"\n')
  const loadFailure = await cli('load-failure', [], /could not run:.*missing-migration-dependency/s, 1)
  assert.doesNotMatch(loadFailure, /compiled copy|too old/)
  writeFileSync(cliFile, 'export async function cliMigrate() { throw new Error("migration runtime sentinel") }\n')
  await cli('runtime-failure', [], /could not run: migration runtime sentinel/, 1)
  writeFileSync(cliFile, cliBytes)

  // A new importer after each run must no longer see the temporary host hook.
  const lifecycle = join(pkg, 'lifecycle.mjs')
  writeFileSync(lifecycle, `import assert from 'node:assert/strict'
import { cliMigrate } from './lib/types/dsh-adapter/migrate/entry.js'
await assert.rejects(import('./before.mjs'), { code: 'ERR_MODULE_NOT_FOUND' })
await cliMigrate(['claude-code', '--dry-run'], ${JSON.stringify(profile)})
await assert.rejects(import('./after.mjs'), { code: 'ERR_MODULE_NOT_FOUND' })
console.log('resolver disposed')
`)
  for (const name of ['before', 'after']) writeFileSync(join(pkg, `${name}.mjs`), 'import "@deepseek-ai/cordis"\n')
  await run('resolver-lifecycle', [lifecycle], /resolver disposed/)
  writeFileSync(cliFile, 'import "missing-migration-dependency"\n')
  writeFileSync(lifecycle, readFileSync(lifecycle, 'utf8').replace(
    `await cliMigrate(['claude-code', '--dry-run'], ${JSON.stringify(profile)})`,
    `await assert.rejects(cliMigrate([], ${JSON.stringify(profile)}), /missing-migration-dependency/)`))
  await run('resolver-failure-lifecycle', [lifecycle], /resolver disposed/)
  writeFileSync(cliFile, cliBytes)
  await chat(false)
  await chat(true)
} finally {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')))
  rmSync(root, { recursive: true, force: true })
}
