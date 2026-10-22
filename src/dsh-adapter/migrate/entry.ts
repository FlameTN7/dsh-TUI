/**
 * Child processes do not inherit the TUI's package resolution hooks. Install
 * the host resolver before the first import of migration's framework peers.
 */
import { loadHostDsh, prepareHostModuleResolution } from '../host-dsh.js'

export async function cliMigrate(argv: readonly string[], profileDir: string): Promise<number> {
  let root: Awaited<ReturnType<typeof prepareHostModuleResolution>> | undefined
  let hostError: unknown
  try {
    root = await prepareHostModuleResolution(await loadHostDsh(), profileDir)
  } catch (error) {
    // Development installs and older hosts may already resolve their peers
    // directly. Try that path once: a failed ESM import cannot be retried
    // reliably because Node caches rejected module jobs.
    hostError = error
  }
  let failed = false
  try {
    const { cliMigrate: run } = await import('./cli.js')
    return await run(argv)
  } catch (error) {
    failed = true
    if (hostError === undefined) throw error
    const reason = (value: unknown): string => value instanceof Error ? value.message : String(value)
    throw new Error(`${reason(error)}; host module resolution: ${reason(hostError)}`, { cause: error })
  } finally {
    try {
      await root?.fiber.dispose()
    } catch (error) {
      // Cleanup must not hide the original load/import failure.
      if (!failed) throw error
    }
  }
}
