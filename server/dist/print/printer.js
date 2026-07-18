import { spawn } from 'node:child_process';
/**
 * Hands a PDF to CUPS via `lp`. CUPS does the PDF→printer-language conversion,
 * so this works with any queue Debian can drive, thermal or laser.
 */
export function sendToCups(pdf, queue, title) {
    return new Promise((resolve, reject) => {
        const lp = spawn('lp', ['-d', queue, '-t', title, '-'], {
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderr = '';
        lp.stderr.on('data', (d) => (stderr += d.toString()));
        lp.on('error', (err) => reject(new Error(`lp not available: ${err.message}`)));
        lp.on('close', (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(stderr.trim() || `lp exited with code ${code}`));
        });
        lp.stdin.write(pdf);
        lp.stdin.end();
    });
}
