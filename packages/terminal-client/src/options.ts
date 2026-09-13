export interface TerminalOptions {
  readonly baseUrl: string
  readonly cwd?: string
  readonly resume?: string
  readonly fresh: boolean
  readonly noColor: boolean
  readonly help: boolean
}

/** Accept a launcher's ephemeral credential only for the exact configured local Host. */
export function authenticatedOptions(options: TerminalOptions, authUrl: string | undefined): TerminalOptions {
  if (authUrl === undefined) return options
  try {
    const target = new URL(options.baseUrl)
    const auth = new URL(authUrl)
    const keys = [...auth.searchParams.keys()]
    const token = auth.searchParams.get('token')
    if (!['http:', 'https:'].includes(auth.protocol) || auth.origin !== target.origin
      || !['127.0.0.1', '[::1]', 'localhost'].includes(auth.hostname)
      || auth.username || auth.password || auth.hash || auth.pathname !== '/'
      || keys.length !== 1 || keys[0] !== 'token' || token === null || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error()
    // A launcher credential must cross boundaries in one canonical spelling,
    // including log redactors that should never retain encoded query names.
    auth.search = ''
    auth.searchParams.set('token', token)
    return { ...options, baseUrl: auth.href }
  } catch { throw new Error('终端启动认证地址无效（必须同源、loopback、根路径及唯一 token）') }
}

export function parseOptions(argv: readonly string[], processCwd: string): TerminalOptions {
  let baseUrl = process.env.XIAOSHE_BASE_URL ?? `http://127.0.0.1:${process.env.XIAOSHE_DSH_PORT ?? '3080'}`
  let cwd: string | undefined = processCwd
  let resume: string | undefined
  let fresh = false
  let noColor = process.env.NO_COLOR !== undefined
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--url') baseUrl = requireValue(argv, ++index, arg)
    else if (arg === '--cwd') cwd = requireValue(argv, ++index, arg)
    else if (arg === '--resume') resume = requireValue(argv, ++index, arg)
    else if (arg === '--new') fresh = true
    else if (arg === '--no-color') noColor = true
    else if (arg === '--help' || arg === '-h') help = true
    else throw new Error(`未知参数：${String(arg)}`)
  }
  if (fresh && resume !== undefined) throw new Error('--new 与 --resume 不能同时使用')
  return { baseUrl, ...(cwd === undefined ? {} : { cwd }), ...(resume === undefined ? {} : { resume }), fresh, noColor, help }
}

function requireValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} 缺少值`)
  return value
}

export const HELP = `小蛇终端版（与界面版共享同一 DSH Runtime）

用法：s [选项]
  --new              直接新建会话
  --resume <id>      继续指定会话（可用唯一前缀）
  --cwd <路径>       新会话工作目录（默认当前目录）
  --url <地址>       DSH 地址（默认 http://127.0.0.1:3080）
  --no-color         关闭 ANSI 颜色
  -h, --help         查看帮助
`
