// Record the real child's exit status without shell prompt markers. Inherit
// all three PTY streams, so the product process sees the actual terminal.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const [result, ...args] = process.argv.slice(2)
const child = spawn(process.execPath, args, { stdio: 'inherit' })
child.on('error', error => { throw error })
child.on('exit', (code, signal) => {
  writeFileSync(result, JSON.stringify({ code, signal }))
  process.exitCode = code ?? 1
})
