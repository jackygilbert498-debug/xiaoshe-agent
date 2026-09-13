#!/usr/bin/env node
/** A dormant stage wrapper: only the supervisor's fixed handshake permits
 * execution. Python attaches this process to its Job before sending start.
 * This is ownership/lifetime control, not a security sandbox or shell parser.
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:os'

const [command, ...args] = process.argv.slice(2)
const start = 'start\n'
let received = ''
let started = false

function rejectHandshake() {
  process.stderr.write('windows-stage: invalid or missing start handshake\n')
  process.exit(78)
}

function run() {
  started = true
  // The actual command does not inherit the private supervisor protocol pipe.
  process.stdin.destroy()
  if (!command) rejectHandshake()
  const child = spawn(command, args, {
    shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
  })
  child.once('error', error => {
    process.stderr.write(`windows-stage: command spawn failed (${error.code ?? 'unknown'})\n`)
    process.exit(127)
  })
  // Do not wait for inherited pipes to close: descendants can outlive the
  // immediate command. Wrapper exit makes Python close the Job and reap them.
  child.once('exit', (code, signal) => {
    process.exit(code ?? (128 + (constants.signals[signal] ?? 1)))
  })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  if (started) return
  received += chunk
  if (!start.startsWith(received)) rejectHandshake()
  if (received === start) run()
})
process.stdin.once('end', () => { if (!started) rejectHandshake() })
process.stdin.once('error', () => { if (!started) rejectHandshake() })
