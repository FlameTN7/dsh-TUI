/**
 * /migrate 子进程运行期回归：将真实迁移源码编译到没有宿主 peer 的隔离 profile，
 * 通过真实 bin 检查产物缺失与依赖失败的区分。设置 DSH_TUI_CONTRACT_DSH 为
 * 已安装的 @deepseek-ai/dsh 包目录后，还验证该真实宿主的预览、导入与重复导入。
 * 不安装依赖、不启动 profile 插件、不读取真实会话、不发模型请求。
 * 运行：node scripts/verify-migrate-runtime.mjs（需要开发依赖；无需完整 build）
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const repo = resolve(import.meta.dirname, '..')
// Reuse the workspace's declared compiler dependency, not tsx's transitive tree.
const vendorRequire = createRequire(join(repo, 'vendor', 'mathjax-tex-svg', 'package.json'))
const { build } = await import(pathToFileURL(vendorRequire.resolve('esbuild')).href)
const fixture = mkdtempSync(join(tmpdir(), 'verify-migrate-runtime-'))
const home = join(fixture, 'home')
const dshHome = join(home, '.dsh')
const profile = join(dshHome, 'profiles', 'dsh-tui')
const pkg = join(profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
const migrate = join(pkg, 'lib', 'types', 'dsh-adapter', 'migrate')
const emptyPath = join(fixture, 'empty-path')
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dshHome,
  DSH_TUI_SESSION_ROOT: join(dshHome, 'sessions'), GROK_HOME: join(home, '.grok'),
  DSH_TUI_LANG: 'en', PATH: emptyPath, NODE_OPTIONS: '', NODE_PATH: '' }
// Windows env names are case-insensitive; don't leave the inherited Path competing with PATH.
for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH' && name !== 'PATH') delete env[name]
delete env.NO_COLOR
let checks = 0
const check = (label, value, detail = '') => {
  checks++
  assert.ok(value, `${label}${detail ? `: ${detail}` : ''}`)
  console.log(`PASS: ${label}`)
}
const run = (args, overrides = {}) => {
  const result = spawnSync(process.execPath, [join(pkg, 'bin', 'dsh-tui.js'), 'migrate', ...args], {
    cwd: fixture, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30_000,
  })
  assert.ifError(result.error)
  return { code: result.status, out: `${result.stdout}${result.stderr}` }
}
function snapshot(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? snapshot(path).map(([p, data]) => [join(entry.name, p), data])
      : [[entry.name, readFileSync(path).toString('base64')]]
  })
}

try {
  mkdirSync(migrate, { recursive: true })
  mkdirSync(emptyPath)
  cpSync(join(repo, 'bin'), join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module',
    peerDependencies: manifest.peerDependencies, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(pkg, 'cordis.patch.yml'), '- id: must-not-mount\n  name: ./must-not-mount.js\n')
  writeFileSync(join(pkg, 'must-not-mount.js'), 'throw new Error("migration must not mount profile plugins")\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'migrate-fixture', private: true,
    dependencies: { [manifest.name]: manifest.version }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', manifest.name] } } }))
  writeFileSync(join(profile, 'cordis.yml'), '# preserve this root during preview\n')
  const sourceCli = join(repo, 'src', 'dsh-adapter', 'migrate', 'cli.ts')
  const sourceEntry = join(repo, 'src', 'dsh-adapter', 'migrate', 'entry.ts')
  await build({ entryPoints: [sourceCli], outfile: join(migrate, 'cli.js'), bundle: true, format: 'esm',
    platform: 'node', target: 'node22', external: ['@deepseek-ai/*'], logLevel: 'silent' })
  if (existsSync(sourceEntry)) await build({ entryPoints: [sourceEntry], outfile: join(migrate, 'entry.js'), bundle: true,
    format: 'esm', platform: 'node', target: 'node22', external: ['./cli.js', '@deepseek-ai/*'], logLevel: 'silent' })
  const compiledEntry = existsSync(sourceEntry) ? 'entry.js' : 'cli.js'
  const original = readFileSync(join(migrate, compiledEntry), 'utf8')
  // A broken dependency is not an old/missing CLI. This fails on #1202's empty catch.
  const missingPeer = run([])
  check('缺宿主 peer 时保留具体依赖原因且非零退出', missingPeer.code === 1 && /cordis|no dsh on PATH/.test(missingPeer.out), missingPeer.out)
  check('依赖失败不误报升级产物', !/compiled copy|too old/.test(missingPeer.out), missingPeer.out)
  writeFileSync(join(migrate, compiledEntry), 'export const unrelated = true\n')
  const old = run([])
  check('旧产物没有 CLI 导出时给升级指引', old.code === 1 && /compiled copy/.test(old.out), old.out)
  rmSync(join(migrate, compiledEntry))
  const missing = run([])
  check('缺失产物时给升级指引', missing.code === 1 && /compiled copy/.test(missing.out), missing.out)
  writeFileSync(join(migrate, compiledEntry), original)
  const cliSource = readFileSync(join(migrate, 'cli.js'), 'utf8')
  rmSync(join(migrate, 'cli.js'))
  const missingCli = run([])
  check('迁移实现产物缺失时也给升级指引', missingCli.code === 1 && /compiled copy/.test(missingCli.out), missingCli.out)
  writeFileSync(join(migrate, 'cli.js'), cliSource)

  // The old direct-peer path remains usable without a host exposing the
  // standalone-entry APIs. Real dev peers resolve from this temporary child
  // of the checkout; no mock CLI or peer links participate in the success.
  mkdirSync(join(repo, '.local'), { recursive: true })
  const directDir = mkdtempSync(join(repo, '.local', 'migrate-direct-'))
  try {
    cpSync(migrate, directDir, { recursive: true })
    writeFileSync(join(directDir, 'run.mjs'), `import {cliMigrate} from './entry.js'; process.exitCode = await cliMigrate([], ${JSON.stringify(profile)});\n`)
    const direct = spawnSync(process.execPath, [join(directDir, 'run.mjs')], { cwd: fixture, env, encoding: 'utf8', timeout: 30_000 })
    assert.ifError(direct.error)
    check('无新宿主契约时保留真实 direct-peer 路径', direct.status === 0 && /\[claude-code\] 0 session file/.test(direct.stdout), `${direct.stdout}${direct.stderr}`)
  } finally { rmSync(directDir, { recursive: true, force: true }) }

  const hostDir = process.env.DSH_TUI_CONTRACT_DSH
  if (hostDir === undefined) {
    console.log('SKIP 真实宿主往返：设置 DSH_TUI_CONTRACT_DSH 为已安装的 dsh 包目录')
  } else {
    const hostManifest = JSON.parse(readFileSync(join(hostDir, 'package.json'), 'utf8'))
    check('真实宿主包身份有效', hostManifest.name === '@deepseek-ai/dsh')
    console.log(`HOST: ${hostManifest.version} at ${hostDir}`)
    const binPath = typeof hostManifest.bin === 'string' ? hostManifest.bin : hostManifest.bin.dsh
    const hostBin = join(hostDir, binPath)
    // findHostDsh follows this shell/cmd shim; no dependency links or copies are created.
    const shim = join(emptyPath, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    writeFileSync(shim, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${hostBin}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${hostBin}" "$@"\n`)
    chmodSync(shim, 0o755)
    const sourceDir = join(home, '.claude', 'projects', 'fixture')
    mkdirSync(sourceDir, { recursive: true })
    const sessionFile = join(sourceDir, '11111111-1111-4111-8111-111111111111.jsonl')
    writeFileSync(sessionFile, [
      { type: 'user', cwd: fixture, timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: '迁移运行期夹具问题' } },
      { type: 'assistant', cwd: fixture, timestamp: '2026-10-01T00:00:01.000Z', message: { id: 'fixture-answer', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: '迁移运行期夹具答复' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    const before = snapshot(home)
    const sourceBefore = snapshot(join(home, '.claude'))
    const preview = run(['claude-code', '--dry-run'])
    check('无 peer profile 通过真实宿主预览一条会话', preview.code === 0 && /1 conversation\(s\).*dry run/.test(preview.out), preview.out)
    check('dry-run 完全不写隔离 HOME/profile/会话库', JSON.stringify(snapshot(home)) === JSON.stringify(before))
    const first = run(['claude-code'])
    check('真实 JSONL persistence 导入一条会话', first.code === 0 && /imported 1/.test(first.out), first.out)
    const imported = snapshot(join(dshHome, 'sessions'))
    check('导入实际落盘', imported.length > 0)
    const second = run(['claude-code'])
    check('重复导入报告 existing 且不重写', second.code === 0 && /imported 0.*already present 1/.test(second.out)
      && JSON.stringify(snapshot(join(dshHome, 'sessions'))) === JSON.stringify(imported), second.out)
    check('外部源原样保留', JSON.stringify(snapshot(join(home, '.claude'))) === JSON.stringify(sourceBefore))
    // Read through the host's real persistence and Session APIs, rather than
    // trusting the CLI summary or merely checking that some file was created.
    const hostRequire = createRequire(join(hostDir, 'package.json'))
    const [{ Context }, { default: Persistence }, { Session, SessionLogOffset }] = await Promise.all([
      import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href),
      import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href),
      import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-session')).href),
    ])
    const ctx = new Context()
    try {
      await ctx.plugin(Persistence, { root: join(dshHome, 'sessions') })
      const persistence = ctx.get('sessionPersistence')
      const sessions = await persistence.list()
      check('宿主 persistence 读到恰好一条迁移会话', sessions.length === 1)
      const handle = await persistence.open(sessions[0].header.id, 'read')
      try {
        const restored = await handle.read()
        const messages = Session.fromRestore(handle.header.id, restored.events, handle.header, SessionLogOffset(0), restored.eventState).deriveMessages()
        check('宿主 Session 还原真实问答正文', JSON.stringify(messages.map(message => [message.role, message.content.map(block => block.text ?? '').join('')]))
          === JSON.stringify([['user', '迁移运行期夹具问题'], ['assistant', '迁移运行期夹具答复']]))
      } finally { await handle.close() }
    } finally { await ctx.fiber.dispose() }
    const tui = spawnSync(process.execPath, ['--import', 'tsx/esm', join(repo, 'scripts', 'verify-migrate-command.tsx')], {
      cwd: repo, env: { ...env, DSH_TUI_MIGRATE_TEST_HOME: home }, encoding: 'utf8', timeout: 90_000,
    })
    assert.ifError(tui.error)
    check('真实 Chat 确认层 → bin → 迁移子进程链通过', tui.status === 0, `${tui.stdout}${tui.stderr}`)
    console.log(stripVTControlCharacters(tui.stdout))
    check('TUI 预览/重复导入后源与既有日志不变', JSON.stringify(snapshot(join(dshHome, 'sessions'))) === JSON.stringify(imported)
      && JSON.stringify(snapshot(join(home, '.claude'))) === JSON.stringify(sourceBefore))
    console.log(`PREVIEW: ${preview.out.trim()}\nIMPORT: ${first.out.trim()}\nREPEAT: ${second.out.trim()}`)
  }
  console.log(`迁移运行期回归通过（${checks} 项）`)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
