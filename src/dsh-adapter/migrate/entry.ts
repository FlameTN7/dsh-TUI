/**
 * The launcher's lazy migration entry. Spawned children do not inherit the
 * parent's runtime package resolution, so install it before importing any
 * migration module (which consumes the host's Cordis/session/persistence peers).
 */
import { loadHostDsh, prepareHostModuleResolution } from '../host-dsh.js'

export async function cliMigrate(argv: readonly string[], profileDir: string): Promise<number> {
  let root: Awaited<ReturnType<typeof prepareHostModuleResolution>> | undefined
  let hostError: unknown
  try {
    root = await prepareHostModuleResolution(await loadHostDsh(), profileDir)
  } catch (error) {
    // Older hosts and development installs may already resolve their peers
    // through Node. Try that existing path once, without retrying a rejected
    // ESM import (Node can cache the failed module job).
    hostError = error
  }
  try {
    const { cliMigrate: run } = await import('./cli.js')
    return await run(argv)
  } catch (error) {
    if (hostError === undefined) throw error
    const reason = (value: unknown): string => value instanceof Error ? value.message : String(value)
    throw new Error(`${reason(error)}; host module resolution: ${reason(hostError)}`, { cause: error })
  } finally {
    await root?.fiber.dispose()
  }
}
