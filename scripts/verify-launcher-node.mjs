#!/usr/bin/env node
/** Node-version launch guard regression. No build, network, or real tools.
 * Run: node scripts/verify-launcher-node.mjs
 * Versions are simulated with a preload on the current Node executable.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tmp = mkdtempSync(join(tmpdir(), 'launcher-node-'))
const home = join(tmp, 'home')
const globalPkg = join(tmp, 'global')
const profilePkg = join(home, '.dsh', 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
const stubDir = join(tmp, 'tools')
const log = join(tmp, 'calls')
const preload = join(tmp, 'version.cjs')
const isWin = process.platform === 'win32'
mkdirSync(stubDir, { recursive: true })
mkdirSync(home, { recursive: true })
writeFileSync(preload, "Object.defineProperty(process, 'version', {value: 'v' + process.env.TEST_NODE_VERSION}); Object.defineProperty(process.versions, 'node', {value: process.env.TEST_NODE_VERSION});")
const stub = join(stubDir, 'stub.cjs')
writeFileSync(stub, "require('node:fs').appendFileSync(process.env.TEST_TOOL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log('11.21.0');")
for (const tool of ['dsh', 'pnpm']) {
  const path = join(stubDir, tool + (isWin ? '.cmd' : ''))
  writeFileSync(path, isWin
    ? `@echo off\r\n"${process.execPath}" "${stub}" ${tool} %*\r\n`
    : `#!/bin/sh\n"${process.execPath}" "${stub}" ${tool} "$@"\n`)
  chmodSync(path, 0o755)
}
function installFixture(dir) {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  cpSync(join(root, 'bin', 'dsh-tui.js'), join(dir, 'bin', 'dsh-tui.js'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}
installFixture(globalPkg)
function run(version, args = [], inside = false, lang = 'en') {
  writeFileSync(log, '')
  const result = spawnSync(process.execPath, ['--require', preload, join(inside ? profilePkg : globalPkg, 'bin', 'dsh-tui.js'), ...args], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: join(home, '.dsh'),
      PATH: [stubDir, ...(isWin ? [process.env.SystemRoot + '\\System32'] : ['/usr/bin', '/bin'])].join(isWin ? ';' : ':'),
      NODE_OPTIONS: '--no-deprecation', TEST_NODE_VERSION: version, TEST_TOOL_LOG: log,
      DSH_TUI_LANG: lang, DSH_TUI_HOST_ENTRY: '0', DSH_TUI_NO_DELEGATE: '',
      DSH_TUI_STANDALONE_BINARY: '',
    },
  })
  assert.equal(result.error, undefined)
  return { ...result, calls: readFileSync(log, 'utf8') }
}
try {
  // Clean first-run fixture: a fake successful add must never be invoked.
  let result = run('23.11.0')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Node.*v23\.11\.0/)
  assert.ok(result.stderr.includes(manifest.engines.node))
  assert.equal(result.calls, '')
  assert.equal(existsSync(profilePkg), false)
  assert.doesNotMatch(result.stderr, /delete|unreadable/i)
  console.log('PASS: unsupported clean bootstrap stops before tool calls or profile changes')

  installFixture(profilePkg)
  // A delegated copy would print this marker; unsupported global launches
  // must reject before spawning it, even when the profile is readable.
  const profileBin = join(profilePkg, 'bin', 'dsh-tui.js')
  const launcher = readFileSync(profileBin, 'utf8')
  writeFileSync(profileBin, "console.log('DELEGATED'); process.exit(0)")
  result = run('23.11.0')
  assert.equal(result.status, 1)
  assert.equal(result.calls, '')
  assert.doesNotMatch(result.stdout, /DELEGATED/)
  result = run('22.19.0')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /DELEGATED/)
  assert.equal(result.calls, '')
  writeFileSync(profileBin, launcher)
  console.log('PASS: unsupported global launch stops before delegation')

  for (const version of ['20.19.0', '22.18.0', '23.0.0', '23.11.0']) {
    result = run(version, [], true)
    assert.equal(result.status, 1)
    assert.equal(result.calls, '')
    assert.ok(result.stderr.includes('v' + version))
    assert.ok(result.stderr.includes(manifest.engines.node))
  }
  for (const version of ['22.19.0', '22.20.0', '24.0.0', '25.0.0']) {
    result = run(version, ['--dump-config'], true)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.calls, /--dump-config/)
    assert.doesNotMatch(result.stderr, /unsupported/i)
  }
  console.log('PASS: supported range boundaries and profile launch')
  for (const args of [['help'], ['--help'], ['version'], ['--version'], ['-v'], ['safe'], ['doctor']]) {
    result = run('23.11.0', args)
    assert.doesNotMatch(result.stderr, /cannot start.*Node/i)
    if (!['doctor'].includes(args[0])) assert.equal(result.status, 0, result.stderr)
  }
  console.log('PASS: help/version/safe/doctor remain reachable on unsupported Node')
  for (const args of [['--', '--help'], ['--backend', 'claude', '--help'], ['--profile', 'help']]) {
    result = run('23.11.0', args, true)
    assert.equal(result.status, 1)
    assert.equal(result.calls, '')
    assert.match(result.stderr, /unsupported Node/)
  }
  console.log('PASS: app tails and host flag values do not bypass the guard')
  result = run('23.11.0', [], true, 'zh')
  assert.equal(result.status, 1)
  assert.equal(result.calls, '')
  assert.match(result.stderr, /无法启动.*Node v23\.11\.0/)
  assert.ok(result.stderr.includes(manifest.engines.node))
  console.log('PASS: Chinese diagnostic includes the current Node and supported range')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
