/** Run with node --test scripts/windows/installer.test.mjs; no real user state is used. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { extractContract, kernelAction, tuiNeedsDowngrade, mergeProfile, updatePath } from './policy.mjs'
import { FileTransaction, recoverTransaction } from './transaction.mjs'
import { normalizeBundledWorkspaceReferences } from './payload-lock.mjs'
import { installPayload, prepareStage, uninstallPackages } from './install-engine.mjs'
import { collectPackageTree } from './package-tree.mjs'

const metadata = {
  tuiVersion: '0.14.0', kernelVersion: '0.2.0-rc.2',
  kernelMinimum: '0.1.0-rc.6', kernelMaximum: '0.2.0-rc.2',
  kernelPeerRange: '^0.1.0-rc.6 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2',
}

test('version gates distinguish missing, old, compatible, ahead, and unsupported prereleases', () => {
  for (const [installed, expected] of [
    [undefined, 'install'], ['0.1.0-rc.5', 'upgrade'], ['0.1.0-rc.6', 'keep'],
    ['0.1.0-rc.10', 'keep'], ['0.2.0-rc.1', 'keep'], ['0.2.0-rc.2', 'keep'],
    ['0.2.0-rc.10', 'downgrade'], ['0.2.0', 'downgrade'], ['0.1.6-alpha.1', 'incompatible'],
  ]) assert.equal(kernelAction(installed, metadata), expected, String(installed))
  assert.throws(() => kernelAction('damaged', metadata), /version/i)
  assert.equal(tuiNeedsDowngrade('0.14.1', metadata), true)
  assert.equal(tuiNeedsDowngrade('0.14.0', metadata), false)
})

test('contract extraction derives bounds and rejects a primary outside the peer range', () => {
  const source = "export const UPSTREAM_VALIDATED_VERSION = '0.2.0-rc.2'\nexport const UPSTREAM_VALIDATED_VERSIONS = ['0.1.0-rc.6', '0.2.0-rc.2'] as const"
  const pkg = { version: '0.14.0', engines: { node: '^22.19 || >=24' }, peerDependencies: { '@deepseek-ai/dsh-agent': metadata.kernelPeerRange } }
  assert.equal(extractContract(pkg, source).kernelMaximum, '0.2.0-rc.2')
  assert.throws(() => extractContract({ ...pkg, peerDependencies: { '@deepseek-ai/dsh-agent': '0.1.0-rc.6' } }, source), /primary/i)
})

test('profile merge preserves other plugins and metadata without duplicating bundles', () => {
  const original = { name: 'custom', private: true, dependencies: { other: '^1', '@deepseek-harness-tui/dsh-tui': '0.11.2' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'other'], extra: true } } }
  const merged = mergeProfile(original, '0.14.0')
  assert.equal(original.dependencies['@deepseek-harness-tui/dsh-tui'], '0.11.2')
  assert.equal(merged.dependencies.other, '^1')
  assert.equal(merged.name, 'custom')
  assert.equal(merged.dsh.profile.extra, true)
  assert.deepEqual(merged.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'other', '@deepseek-harness-tui/dsh-tui'])
  assert.deepEqual(mergeProfile(merged, '0.14.0'), merged)
  assert.throws(() => mergeProfile({ dsh: { profile: { bundles: 'broken' } } }, '0.14.0'), /bundles/)
})

test('PATH edits keep unrelated entries, recognize spelling variants, and retain shared commands', () => {
  const prefix = 'C:\\Users\\A\\AppData\\Roaming\\npm'
  assert.deepEqual(updatePath('C:\\Tool;', prefix, 'add'), { value: `C:\\Tool;${prefix}`, changed: true })
  assert.equal(updatePath(`"${prefix.toUpperCase()}\\";C:\\Tool`, prefix, 'add').changed, false)
  assert.equal(updatePath(`C:\\Tool;${prefix}`, prefix, 'remove', false, false).changed, false)
  assert.equal(updatePath(`C:\\Tool;${prefix}`, prefix, 'remove', true, true).changed, false)
  assert.equal(updatePath(`C:\\Tool;${prefix};C:\\Other`, prefix, 'remove', true, false).value, 'C:\\Tool;C:\\Other')
})

test('failed replacements restore files and leave unrelated user data intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-transaction-'))
  const stage = join(root, 'stage'); mkdirSync(stage)
  const target = join(root, 'owned'); writeFileSync(target, 'before')
  writeFileSync(join(root, 'credentials'), 'keep')
  const source = join(stage, 'new'); writeFileSync(source, 'after')
  const tx = new FileTransaction(stage, [root])
  tx.replace(source, target)
  assert.equal(readFileSync(target, 'utf8'), 'after')
  assert.throws(() => tx.replace(join(stage, 'missing'), join(root, 'second')))
  tx.rollback()
  assert.equal(readFileSync(target, 'utf8'), 'before')
  assert.equal(readFileSync(join(root, 'credentials'), 'utf8'), 'keep')
})

test('a persisted interrupted transaction can be recovered by a new process', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-recovery-'))
  const stage = join(root, 'stage'); mkdirSync(stage)
  const source = join(stage, 'new'); writeFileSync(source, 'after')
  const target = join(root, 'new-file')
  new FileTransaction(stage, [root]).replace(source, target)
  recoverTransaction(stage, [root])
  assert.equal(existsSync(target), false)
})

test('transaction refuses paths outside its authorized roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-bounds-'))
  const stage = join(root, 'stage'); mkdirSync(stage)
  const source = join(stage, 'new'); writeFileSync(source, 'after')
  const tx = new FileTransaction(stage, [root])
  assert.throws(() => tx.replace(source, join(root, '..', 'outside')), /outside/i)
})

test('transaction refuses a parent junction pointing outside the installation', () => {
  const container = mkdtempSync(join(tmpdir(), 'dsh-installer-junction-'))
  const root = join(container, 'owned'); mkdirSync(root)
  const outside = join(container, 'external'); mkdirSync(outside)
  writeFileSync(join(outside, 'keep'), 'user-data')
  symlinkSync(outside, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
  const stage = join(root, 'stage'); mkdirSync(stage)
  const source = join(stage, 'incoming'); writeFileSync(source, 'replacement')
  const tx = new FileTransaction(stage, [root])
  assert.throws(() => tx.replace(source, join(root, 'redirect/keep')), /outside/)
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'user-data')
})

test('bundled workspace references bind to shipped siblings without changing archive integrity', () => {
  const lock = { packages: {
    'node_modules/tui': { version: '1.0.0', integrity: 'archive-integrity' },
    'node_modules/tui/node_modules/@std/core': { version: '0.1.0', inBundle: true },
    'node_modules/tui/node_modules/@std/command': { version: '0.1.0', inBundle: true, dependencies: { '@std/core': 'workspace:*' } },
  } }
  normalizeBundledWorkspaceReferences(lock)
  assert.equal(lock.packages['node_modules/tui/node_modules/@std/command'].dependencies['@std/core'], '0.1.0')
  assert.equal(lock.packages['node_modules/tui'].integrity, 'archive-integrity')
  assert.throws(() => normalizeBundledWorkspaceReferences({ packages: { 'node_modules/unbundled': { dependencies: { unknown: 'workspace:*' } } } }), /Unsupported workspace/)
})

function installationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-integration-'))
  const prefix = join(root, 'npm'); mkdirSync(prefix)
  const userHome = join(root, 'user')
  const profile = join(userHome, '.dsh/profiles/dsh-tui')
  const metadataDir = join(root, 'metadata')
  const target = { prefix, userHome, profile, metadataDir, stage: join(prefix, '_stage_tui'), roots: [prefix, join(userHome, '.dsh/profiles'), metadataDir] }
  const payload = join(root, 'payload')
  const files = {}
  const put = (name, data) => {
    const path = join(payload, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, data)
    files[name] = createHash('sha256').update(data).digest('hex')
  }
  for (const [name, commands, packageVersion] of [
    ['@deepseek-ai/dsh', ['dsh'], '0.2.0-rc.2'],
    ['@deepseek-harness-tui/dsh-tui', ['dsh-tui', 'dst'], '0.14.0'],
    ['pnpm', ['pnpm', 'pnpx'], '11.21.0'],
  ]) {
    put(`global/node_modules/${name}/package.json`, JSON.stringify({ name, version: packageVersion, bin: Object.fromEntries(commands.map(command => [command, 'bin.js'])) }))
    put(`global/node_modules/${name}/bin.js`, '#!/usr/bin/env node\n')
    for (const command of commands) for (const suffix of ['', '.cmd', '.ps1']) put(`global/${command}${suffix}`, `node_modules/${name}/bin.js`)
  }
  put('node/node.exe', 'fixture-runtime')
  put('node/LICENSE', 'fixture-license')
  put('node/node_modules/npm/package.json', '{"name":"npm","version":"11.13.0"}')
  const fullMetadata = { ...metadata, schemaVersion: 1, nodeRange: '^22.19 || >=24', files }
  const context = { fileOnly: true, work: root }
  prepareStage(target, context)
  return { root, target, payload, metadata: fullMetadata, context }
}

test('offline install seeds the profile and default uninstall preserves kernel and all user assets', () => {
  const fixture = installationFixture()
  const { target, payload, metadata, context } = fixture
  const credential = join(target.userHome, '.dsh/.credentials.yaml')
  mkdirSync(join(credential, '..'), { recursive: true }); writeFileSync(credential, 'private-test-value')
  installPayload(target, payload, metadata, {}, context)
  assert.equal(JSON.parse(readFileSync(join(target.profile, 'package.json'))).dependencies['@deepseek-harness-tui/dsh-tui'], '0.14.0')
  assert.ok(existsSync(join(target.prefix, 'dsh-tui.cmd')))
  assert.match(readFileSync(join(target.profile, 'pnpm-workspace.yaml'), 'utf8'), /nodeLinker: hoisted\nautoInstallPeers: false/)
  assert.equal(existsSync(target.stage), false)
  uninstallPackages(target, metadata, false, false, context)
  assert.equal(existsSync(join(target.prefix, 'dsh-tui.cmd')), false)
  assert.ok(existsSync(join(target.prefix, 'dsh.cmd')))
  assert.ok(existsSync(join(target.profile, 'package.json')))
  assert.equal(readFileSync(credential, 'utf8'), 'private-test-value')
})

test('compatible DSH is retained byte for byte while profile plugins and patch files survive', () => {
  const { target, payload, metadata, context } = installationFixture()
  const kernelFile = join(target.prefix, 'node_modules/@deepseek-ai/dsh/package.json')
  mkdirSync(join(kernelFile, '..'), { recursive: true })
  const original = '{"name":"@deepseek-ai/dsh","version":"0.2.0-rc.1","custom":"retain"}'
  writeFileSync(kernelFile, original)
  mkdirSync(target.profile, { recursive: true })
  writeFileSync(join(target.profile, 'package.json'), JSON.stringify({ dependencies: { 'other-plugin': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'other-plugin'] } } }))
  writeFileSync(join(target.profile, 'cordis.patch.yml'), '# user patch\n[]\n')
  installPayload(target, payload, metadata, {}, context)
  assert.equal(readFileSync(kernelFile, 'utf8'), original)
  assert.equal(readFileSync(join(target.profile, 'cordis.patch.yml'), 'utf8'), '# user patch\n[]\n')
  assert.equal(JSON.parse(readFileSync(join(target.profile, 'package.json'))).dependencies['other-plugin'], '1.0.0')
})

test('checksum failure occurs before replacing an existing package', () => {
  const { target, payload, metadata, context } = installationFixture()
  writeFileSync(join(payload, 'global/dsh.cmd'), 'corrupt')
  assert.throws(() => installPayload(target, payload, metadata, {}, context), /checksum mismatch/)
  assert.equal(existsSync(join(target.prefix, 'node_modules')), false)
  assert.equal(existsSync(join(target.profile, 'package.json')), false)
})

test('a late metadata write failure rolls back packages and profile manifest', () => {
  const { target, payload, metadata, context } = installationFixture()
  mkdirSync(target.profile, { recursive: true })
  const original = '{"name":"existing-profile","dependencies":{"other":"1"}}'
  writeFileSync(join(target.profile, 'package.json'), original)
  writeFileSync(target.metadataDir, 'a file blocks the metadata directory')
  assert.throws(() => installPayload(target, payload, metadata, {}, context))
  assert.equal(existsSync(join(target.prefix, 'dsh.cmd')), false)
  assert.equal(readFileSync(join(target.profile, 'package.json'), 'utf8'), original)
  assert.equal(readFileSync(target.metadataDir, 'utf8'), 'a file blocks the metadata directory')
})

test('full uninstall requires confirmation for other profiles and never removes their data', () => {
  const { target, payload, metadata, context } = installationFixture()
  installPayload(target, payload, metadata, {}, context)
  const otherProfile = join(target.userHome, '.dsh/profiles/web/package.json')
  mkdirSync(join(otherProfile, '..'), { recursive: true }); writeFileSync(otherProfile, '{"name":"web"}')
  assert.throws(() => uninstallPackages(target, metadata, true, false, context), /Other profiles/)
  assert.ok(existsSync(join(target.prefix, 'dsh.cmd')))
  uninstallPackages(target, metadata, true, true, context)
  assert.equal(existsSync(join(target.prefix, 'dsh.cmd')), false)
  assert.equal(readFileSync(otherProfile, 'utf8'), '{"name":"web"}')
  assert.ok(existsSync(join(target.profile, 'node_modules/@deepseek-harness-tui/dsh-tui/package.json')))
})

test('hoisted peers move with the kernel and remain resolvable from its dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-tree-'))
  const modules = join(root, 'input/node_modules')
  const put = (name, text) => { const file = join(modules, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text) }
  put('@test/kernel/index.cjs', "module.exports=require('plugin')")
  put('plugin/index.js', "module.exports=require('@test/peer')")
  put('@test/peer/index.js', "module.exports='shared-peer'")
  const output = join(root, 'output/node_modules/@test/kernel')
  collectPackageTree(modules, '@test/kernel', output)
  const { createRequire } = await import('node:module')
  assert.equal(createRequire(join(output, 'index.cjs'))('./index.cjs'), 'shared-peer')
  assert.ok(existsSync(join(modules, '@test/peer/index.js')))
})

test('downgrade rejection leaves installed bytes untouched', () => {
  for (const name of ['@deepseek-ai/dsh', '@deepseek-harness-tui/dsh-tui']) {
    const { target, payload, metadata, context } = installationFixture()
    const file = join(target.prefix, 'node_modules', name, 'package.json')
    mkdirSync(join(file, '..'), { recursive: true })
    const content = JSON.stringify({ name, version: '9.0.0' })
    writeFileSync(file, content)
    assert.throws(() => installPayload(target, payload, metadata, {}, context), /confirmations/)
    assert.equal(readFileSync(file, 'utf8'), content)
    assert.equal(existsSync(join(target.profile, 'package.json')), false)
  }
})

test('registration failure restores files, user PATH and the previous registration', () => {
  const { target, payload, metadata, context } = installationFixture()
  const originalRegistration = [{ name: 'DisplayVersion', value: 'old', kind: 1 }]
  const system = { path: 'C:\\Other', pathContainsPrefix: false, running: [], nodePaths: [], registration: originalRegistration }
  context.system = (action, data) => {
    if (action === 'inspect') return structuredClone(system)
    if (action === 'path') { assert.equal(system.path, data.expected); system.path = data.value }
    if (action === 'register') { system.registration = []; throw new Error('simulated registry failure') }
    if (action === 'restore-registration') system.registration = data.registration
    return { ok: true }
  }
  assert.throws(() => installPayload(target, payload, metadata, {}, context), /simulated registry failure/)
  assert.equal(system.path, 'C:\\Other')
  assert.deepEqual(system.registration, originalRegistration)
  assert.equal(existsSync(join(target.prefix, 'dsh.cmd')), false)
})

test('an existing compatible Node runtime is reused without installing another copy', () => {
  const { target, payload, metadata, context } = installationFixture()
  context.system = action => action === 'inspect'
    ? { path: '', pathContainsPrefix: false, running: [], nodePaths: [process.execPath], registration: null }
    : { ok: true }
  installPayload(target, payload, metadata, {}, context)
  assert.equal(existsSync(join(target.prefix, 'node.exe')), false)
  assert.equal(existsSync(join(target.prefix, 'node_modules/npm')), false)
  assert.equal(JSON.parse(readFileSync(join(target.metadataDir, 'installation.json'))).installNode, false)
  assert.ok(existsSync(join(target.prefix, 'dsh-tui.cmd')))
})

test('a running application blocks replacement before any package is installed', () => {
  const { target, payload, metadata, context } = installationFixture()
  context.system = () => ({ path: '', pathContainsPrefix: false, running: [1234], nodePaths: [], registration: null })
  assert.throws(() => installPayload(target, payload, metadata, {}, context), /Close dsh.*1234/)
  assert.equal(existsSync(join(target.prefix, 'node_modules')), false)
  assert.equal(existsSync(join(target.profile, 'package.json')), false)
})
