/** Convert a single-package npm installation into a self-contained global package. */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export function collectPackageTree(modules, name, destination) {
  modules = resolve(modules)
  destination = resolve(destination)
  if (destination === modules || destination.startsWith(`${modules}${sep}`)) throw new Error('Package output must be outside the npm installation')
  // destination is computed from a fixed package name by the build script.
  if (!destination.replaceAll('\\', '/').endsWith(`/node_modules/${name}`)) throw new Error('Invalid package destination')
  rmSync(destination, { recursive: true, force: true })
  cpSync(join(modules, name), destination, { recursive: true })
  const copyDependency = dependency => {
    if (dependency === name) return
    const target = join(destination, 'node_modules', dependency)
    if (existsSync(target)) throw new Error(`Cannot relocate conflicting dependency: ${dependency}`)
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(join(modules, dependency), target, { recursive: true })
  }
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name === '.package-lock.json') continue
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(join(modules, entry.name))) copyDependency(`${entry.name}/${child}`)
    } else copyDependency(entry.name)
  }
}
