#!/usr/bin/env node
/**
 * Production React selection (#685), without rendering or allocating a long session.
 * Run: node --import tsx/esm scripts/verify-production-react.mjs
 * Fresh children load the real guard (after Node's .env loader) or the zero-lib
 * launcher, then inspect the actual React/reconciler CJS modules in require.cache.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const marker = 'REACT_BUILD:'
function reportBuild() {
  require('react')
  require('react-reconciler')
  const loaded = Object.keys(require.cache)
    .filter(path => /[\\/]react(?:-reconciler)?\.(development|production)\.js$/.test(path))
    .map(path => basename(path)).sort()
  process.stderr.write(`${marker}${JSON.stringify({ nodeEnv: process.env.NODE_ENV, loaded })}\n`)
}

if (process.env.DSH_TUI_PRODUCTION_PROBE === 'launcher') {
  process.on('exit', reportBuild)
} else if (process.argv[2] === '--worker') {
  if (process.argv[3] !== '-') process.loadEnvFile(process.argv[3])
  await import('../src/force-production-react.js')
  reportBuild()
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-production-'))
  try {
    const envFile = join(scratch, '.env')
    writeFileSync(envFile, 'NODE_ENV=development\n')
    const cases = [
      ['default', undefined, undefined, false, 'production'],
      ['inherited development', 'development', undefined, false, 'production'],
      ['workspace .env', undefined, undefined, true, 'production'],
      ['explicit production', 'production', undefined, false, 'production'],
      ['opt-in production', 'production', '1', false, 'production'],
      ['debug opt-in', 'development', '1', false, 'development'],
      ['debug .env', undefined, '1', true, 'development'],
      ['opt-in without NODE_ENV', undefined, '1', false, 'production'],
      ['non-opt-in value', 'development', 'true', false, 'production'],
    ]
    for (const entry of ['guard', 'launcher']) {
      for (const [name, nodeEnv, allowDev, fromFile, expected] of cases) {
        const env = { ...process.env, DSH_HOME: scratch, HOME: scratch, USERPROFILE: scratch }
        delete env.NODE_ENV
        delete env.DSH_TUI_ALLOW_DEV
        delete env.DSH_TUI_PRODUCTION_PROBE
        if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv
        if (allowDev !== undefined) env.DSH_TUI_ALLOW_DEV = allowDev
        const argv = ['--import', 'tsx/esm']
        if (entry === 'launcher') {
          env.DSH_TUI_PRODUCTION_PROBE = 'launcher'
          if (fromFile) argv.push(`--env-file=${envFile}`)
          argv.push('--import', import.meta.url, 'bin/dsh-tui.js', '--help')
        } else argv.push(fileURLToPath(import.meta.url), '--worker', fromFile ? envFile : '-')
        const child = spawnSync(process.execPath, argv, {
          cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 15000,
        })
        assert.equal(child.status, 0, `${entry}: ${name}\n${child.stderr}`)
        const line = child.stderr.split('\n').find(line => line.startsWith(marker))
        assert.ok(line, `${entry}: ${name}: no build report\n${child.stderr}`)
        const actual = JSON.parse(line.slice(marker.length))
        assert.equal(actual.nodeEnv, expected, `${entry}: ${name}`)
        assert.deepEqual(actual.loaded, [`react-reconciler.${expected}.js`, `react.${expected}.js`], `${entry}: ${name}`)
        console.log(`✓ ${entry}: ${name} → ${expected}`)
      }
    }
    assert.equal(readFileSync(envFile, 'utf8'), 'NODE_ENV=development\n', 'workspace .env must remain unchanged')
    // ESM evaluates static dependencies before the entry body. A body assignment
    // cannot protect a later textual import: keep the guard first in every graph.
    for (const [path, guard] of [
      ['src/index.ts', './force-production-react.js'],
      ['src/dsh-adapter/host-entry.ts', '../force-production-react.js'],
      ['scripts/run.ts', '../src/force-production-react.js'],
    ]) {
      const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
      const first = source.statements[0]
      assert.ok(ts.isImportDeclaration(first) && ts.isStringLiteral(first.moduleSpecifier)
        && first.moduleSpecifier.text === guard, `${path}: guard must be the first statement`)
    }
    console.log('✓ package, host and developer entry import order')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
