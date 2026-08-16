import { spawn } from 'node:child_process'

/**
 * Hands a PDF to CUPS via `lp`. CUPS does the PDF→printer-language conversion,
 * so this works with any queue Debian can drive, thermal or laser.
 */
export function sendToCups(pdf: Buffer, queue: string, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const lp = spawn('lp', ['-d', queue, '-t', title, '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    let stderr = ''
    lp.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    // Same reason as stdin below: a faulting pipe on an abnormal child death
    // must not become an unhandled 'error' event. 'close' still reports.
    lp.stderr.on('error', () => {})
    lp.on('error', (err) => reject(new Error(`lp not available: ${err.message}`)))
    lp.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `lp exited with code ${code}`))
    })
    // A misconfigured queue makes lp exit before draining stdin; the pending
    // write then emits EPIPE on the pipe. Without this handler that becomes an
    // unhandled 'error' event and crashes the whole server. The close handler
    // above still surfaces lp's real error message to the caller.
    lp.stdin.on('error', () => {})

    lp.stdin.write(pdf)
    lp.stdin.end()
  })
}
