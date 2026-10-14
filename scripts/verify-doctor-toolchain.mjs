#!/usr/bin/env node
/**
 * Black-box doctor/safe toolchain diagnostics (#815, #892), without lib/.
 * Node version fields are simulated; pnpm/dsh are isolated executable stubs.
 * No package installation, real profile or credential store is accessed.
 * Run: node scripts/verify-doctor-toolchain.mjs
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { satisfies } from 'semver'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'bin', 'dsh-tui.js')
const nodeRange = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines.node
const tmp = mkdtempSync(join(tmpdir(), 'doctor-toolchain-'))
const home = join(tmp, 'home')
const stubDir = join(tmp, 'bin')
const preload = join(tmp, 'node-version.mjs')
mkdirSync(home)
mkdirSync(stubDir)
const isWin = process.platform === 'win32'
const secret = 'fixture-secret-must-not-appear'
let checks = 0
let failures = 0
function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? `\n${detail}` : ''}`)
}
function stub(name, version, status = 0) {
  const path = join(stubDir, name + (isWin ? '.cmd' : ''))
  // The versions below are literal fixtures, never user input or credentials.
  writeFileSync(path, isWin
    ? `@echo off\r\necho ${version}\r\nexit /b ${status}\r\n`
    : `#!/bin/sh\nprintf '%s\\n' '${version}'\nexit ${status}\n`)
  if (!isWin) chmodSync(path, 0o755)
}
function run(node, pnpm, { lang = 'en', args = ['doctor'], status = 0 } = {}) {
  stub('pnpm', pnpm, status)
  writeFileSync(preload, `Object.defineProperty(process, 'version', { value: ${JSON.stringify('v' + node)} });\n`
    + `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(node)} });\n`)
  return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, bin, ...args], {
    cwd: tmp, encoding: 'utf8', timeout: 15000,
    env: {
      PATH: [stubDir, ...(isWin ? [join(process.env.SystemRoot, 'System32'), process.env.SystemRoot] : [])].join(delimiter),
      ...(isWin ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC } : {}),
      HOME: home, USERPROFILE: home, DSH_HOME: join(home, '.dsh'), TMP: tmp, TEMP: tmp,
      DSH_TUI_LANG: lang, DEEPSEEK_API_KEY: secret, NODE_OPTIONS: '--no-deprecation',
    },
  })
}
stub('dsh', '0.2.0-rc.2')

try {
  for (const [version, supported] of [
    ['20.19.0', false], ['22.18.0', false], ['22.19.0', true], ['22.20.0', true],
    ['23.11.0', false], ['24.0.0', true], ['25.0.0', true], ['24.0.0-rc.1', false],
  ]) {
    const r = run(version, '10.0.0')
    check(`Node ${version}: fixture matches the published engines contract`, satisfies(version, nodeRange) === supported)
    check(`Node ${version}: diagnostic mark`, r.stdout.includes(`${supported ? '✓' : '✗'} node:`), r.stdout)
    check(`Node ${version}: exit status`, r.status === (supported ? 0 : 1), `${r.status}\n${r.stderr}`)
    if (!supported) check(`Node ${version}: actionable requirement`, /22\.19.*24/.test(r.stdout))
    check(`Node ${version}: remaining checks still run`, r.stdout.includes('profile:') && r.stdout.includes('DEEPSEEK_API_KEY:'))
  }
  for (const [version, supported] of [
    ['9.15.0', false], ['10.0.0', true], ['11.21.0', true], ['v12.0.0', true],
    ['10.0.0-rc.1', false], ['unreadable', false],
  ]) {
    for (const lang of ['en', 'zh']) {
      const r = run('24.0.0', version, { lang })
      check(`pnpm ${version} ${lang}: diagnostic mark`, r.stdout.includes(`${supported ? '✓' : '✗'} pnpm:`), r.stdout)
      check(`pnpm ${version} ${lang}: exit status`, r.status === (supported ? 0 : 1), `${r.status}\n${r.stderr}`)
      if (!supported) check(`pnpm ${version} ${lang}: upgrade guidance`, r.stdout.includes('pnpm@10'))
      check(`pnpm ${version} ${lang}: no credential disclosure`, !`${r.stdout}${r.stderr}`.includes(secret))
    }
  }
  const failedProbe = run('24.0.0', '10.0.0', { status: 1 })
  check('pnpm probe failure is unhealthy', failedProbe.status === 1 && failedProbe.stdout.includes('✗ pnpm:'))
  const doctor = run('23.11.0', '9.0.0')
  const safe = run('23.11.0', '9.0.0', { args: ['safe', '--report'] })
  for (const label of ['node', 'pnpm']) {
    const line = doctor.stdout.split('\n').find(line => line.startsWith(`✗ ${label}:`))
    check(`safe report shares ${label} diagnostics`, line !== undefined && safe.stdout.includes(line), safe.stdout)
  }
  for (const args of [['--help'], ['--version']]) {
    const r = run('23.11.0', '9.0.0', { args })
    check(`${args[0]} remains available on unsupported tools`, r.status === 0)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log(`${checks - failures}/${checks} doctor toolchain checks passed`)
process.exit(failures === 0 ? 0 : 1)
