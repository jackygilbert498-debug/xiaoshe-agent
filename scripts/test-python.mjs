import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const configured = process.env.XIAOSHE_PYTHON
const fallback = '/opt/miniconda3/bin/python3'
const python = configured && configured.trim() !== ''
  ? configured
  : process.platform === 'darwin' && existsSync(fallback)
    ? fallback
    : process.platform === 'win32' ? 'python' : 'python3'

const result = spawnSync(
  python,
  ['-m', 'unittest', 'discover', '-s', 'python/tests', '-v'],
  { stdio: 'inherit', env: process.env },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
