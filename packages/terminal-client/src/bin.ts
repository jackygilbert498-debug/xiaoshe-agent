#!/usr/bin/env node

import { HELP, parseOptions } from './options.js'
import { nodeStreams, TerminalApp } from './app.js'

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), process.cwd())
  if (options.help) {
    process.stdout.write(HELP)
    return
  }
  const app = new TerminalApp(options, nodeStreams())
  await app.run()
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[小蛇终端] ${message}\n`)
  process.exitCode = 1
})
