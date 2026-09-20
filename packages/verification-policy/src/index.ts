export type VerificationGate =
  | 'typecheck'
  | 'test'
  | 'build'
  | 'browser'
  | 'windows-evidence'
  | 'migration-rollback'
  | 'profile-dump'
  | 'profile-start'
  | 'functional-probe'
  | 'release-confirmation'

export type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'not-run' | 'blocked' | 'not-applicable'
export type VerificationRisk = 'low' | 'medium' | 'high'
export type VerificationChangeKind = 'code' | 'data' | 'ui' | 'windows' | 'persistence' | 'plugin' | 'release'
export type VerificationOutcome = 'verified' | 'partial' | 'blocked' | 'failed' | 'release-held'

export interface VerificationPlan {
  readonly kind: VerificationChangeKind
  readonly risk: VerificationRisk
  readonly gates: readonly VerificationGate[]
}

export interface VerificationResult {
  readonly gate: VerificationGate
  readonly status: VerificationStatus
  readonly evidence?: string
}

export interface VerificationPolicy {
  plan(input: { readonly kind: VerificationChangeKind; readonly risk?: VerificationRisk }): VerificationPlan
  /** Plan proof for an actual tool effect, which can differ from code that implements that platform. */
  planTool(input: {
    readonly toolName: string
    readonly arguments?: unknown
    readonly kind: VerificationChangeKind
    readonly risk?: VerificationRisk
  }): VerificationPlan
  classifyTool(input: { readonly toolName: string; readonly arguments?: unknown }): {
    readonly mutation: boolean
    readonly change?: { readonly kind: VerificationChangeKind; readonly risk: VerificationRisk }
  }
  evaluate(plan: VerificationPlan, results: readonly VerificationResult[]): VerificationOutcome
}

const GATE_ORDER: readonly VerificationGate[] = [
  'typecheck', 'test', 'build', 'browser', 'windows-evidence', 'migration-rollback',
  'profile-dump', 'profile-start', 'functional-probe', 'release-confirmation',
]

const BASE_GATES: Readonly<Record<VerificationChangeKind, readonly VerificationGate[]>> = {
  code: ['typecheck', 'test'],
  data: ['functional-probe'],
  ui: ['typecheck', 'test', 'browser'],
  windows: ['typecheck', 'test', 'windows-evidence'],
  persistence: ['typecheck', 'test', 'migration-rollback'],
  plugin: ['typecheck', 'test', 'profile-dump', 'profile-start', 'functional-probe'],
  release: ['typecheck', 'test', 'build', 'profile-dump', 'profile-start', 'functional-probe', 'release-confirmation'],
}

const HIGH_RISK_GATE: Readonly<Record<VerificationChangeKind, VerificationGate>> = {
  code: 'functional-probe',
  data: 'functional-probe',
  ui: 'functional-probe',
  windows: 'browser',
  persistence: 'functional-probe',
  plugin: 'migration-rollback',
  release: 'migration-rollback',
}

const EVIDENCE_REQUIRED = new Set<VerificationGate>([
  'browser', 'windows-evidence', 'migration-rollback', 'profile-dump',
  'profile-start', 'functional-probe', 'release-confirmation',
])
const WINDOWS_ACTIONS = new Set(['screen_click', 'screen_type', 'screen_press', 'screen_focus_window'])
const BROWSER_ACTIONS = new Set([
  'browser_open', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_close',
])
const MEMORY_ACTIONS = new Set(['xiaoshe_memory_remember', 'xiaoshe_memory_set_state'])
const WHOLE_FILE_WRITE_ARGUMENTS = new Set(['file_path', 'content', 'sandbox_permissions', 'justification'])
const ENGINEERING_JSON_DIRECTORIES = new Set([
  '.git', '.github', '.idea', '.openai', '.vscode', 'app', 'apps', 'config', 'configs', 'deployment', 'deployments',
  'node_modules',
  'extension', 'extensions', 'infra', 'infrastructure', 'lib', 'package', 'packages', 'plugin',
  'plugins', 'runtime', 'script', 'scripts', 'source', 'src', 'spec', 'specs', 'test', 'tests',
])

/** Pure, deterministic verification policy. It owns neither execution nor persistence. */
export function createVerificationPolicy(): VerificationPolicy {
  const plan = (input: {
    readonly kind: VerificationChangeKind
    readonly risk?: VerificationRisk
  }): VerificationPlan => {
    const risk = input.risk ?? 'medium'
    const requested = [
      ...BASE_GATES[input.kind],
      ...(risk === 'low' || input.kind === 'data' ? [] : ['build'] as const),
      ...(risk === 'high' ? [HIGH_RISK_GATE[input.kind]] : []),
    ]
    const selected = new Set<VerificationGate>(requested)
    return {
      kind: input.kind,
      risk,
      gates: GATE_ORDER.filter(gate => selected.has(gate)),
    }
  }
  return {
    plan,
    planTool(input) {
      const base = plan(input)
      // A desktop/browser action changes external state. Requiring compilation
      // gates for it is both semantically wrong and impossible to satisfy. It
      // needs a later, target-specific observation from that same platform.
      if (WINDOWS_ACTIONS.has(input.toolName)) return { ...base, gates: ['windows-evidence'] }
      if (BROWSER_ACTIONS.has(input.toolName)) return { ...base, gates: ['browser'] }
      if (MEMORY_ACTIONS.has(input.toolName)) return { ...base, gates: ['functional-probe'] }
      // Artifact validation is additional evidence, never permission to skip
      // compilation. The host separately proves applicability after a read.
      if (input.kind === 'code' && standaloneArtifactKind(input.toolName, input.arguments) === 'document') {
        return { ...base, gates: [...base.gates, 'functional-probe'] }
      }
      return base
    },
    classifyTool(input) {
      return classifyToolEffect(input.toolName, input.arguments)
    },
    evaluate(plan, results) {
      const required = new Set(plan.gates)
      // Results are chronological. Only the latest attempt for a gate applies
      // to the current evaluation; the event log still preserves every older
      // failure for diagnosis. Otherwise a recovered typecheck/test failure
      // permanently poisons the receipt even after a successful rerun.
      const latest = new Map<VerificationGate, VerificationResult>()
      for (const result of results) if (required.has(result.gate)) latest.set(result.gate, result)
      const applicable = [...latest.values()]
      if (applicable.some(result => result.status === 'failed')) return 'failed'
      if (applicable.some(result => result.status === 'blocked')) return 'blocked'

      let partial = false
      let releaseHeld = false
      for (const gate of plan.gates) {
        const passed = latest.get(gate)
        const satisfied = verificationResultSatisfied(gate, passed)
        if (satisfied) continue
        if (gate === 'release-confirmation') releaseHeld = true
        else partial = true
      }
      if (releaseHeld) return 'release-held'
      return partial ? 'partial' : 'verified'
    },
  }
}

/** N/A is a distinct, evidenced disposition of compilation (or document test)
 * requirements, not a passing test and never a waiver for live/release gates. */
export function verificationResultSatisfied(gate: VerificationGate, result: VerificationResult | undefined): boolean {
  if (!result || result.gate !== gate) return false
  if (result.status === 'not-applicable') return ['typecheck', 'build', 'test'].includes(gate)
    && hasEvidence(result.evidence) && result.evidence!.startsWith('applicability/v1;')
  return result.status === 'passed' && (!EVIDENCE_REQUIRED.has(gate) || hasEvidence(result.evidence))
}

export function standaloneArtifactKind(toolName: string, args: unknown): 'script' | 'plist' | 'document' | undefined {
  if (!['write', 'edit', 'read'].includes(toolName)) return undefined
  const target = asRecord(args)?.file_path
  if (typeof target !== 'string' || /[\r\n\0]/u.test(target)) return undefined
  if (/\.(?:sh|bash|zsh|command)$/iu.test(target)) return 'script'
  if (/\.plist$/iu.test(target)) return 'plist'
  if (/\.(?:md|markdown|txt)$/iu.test(target)) {
    const parts = target.replaceAll('\\', '/').split('/')
    const input = asRecord(args)
    if (parts.slice(0, -1).some(part => part.startsWith('.') && part !== '.' || ENGINEERING_JSON_DIRECTORIES.has(part.toLowerCase()))) return undefined
    if (!isPlainDocumentWrite('write', { file_path: `output/${parts.at(-1)}`,
      content: toolName === 'write' ? input?.content : '# Plain document' })) return undefined
    return 'document'
  }
  return undefined
}

function classifyToolEffect(toolName: string, args: unknown): {
  readonly mutation: boolean
  readonly change?: { readonly kind: VerificationChangeKind; readonly risk: VerificationRisk }
} {
  // This first-party runner executes only closed QuickJS module snapshots with
  // no guest host APIs. Neither its name nor its pass-like result certifies a
  // project gate; namespaced lookalikes do not inherit that execution contract.
  if (toolName === 'pure_js_probe') return { mutation: false }
  // Official reminders mutate session records, not engineering source. A
  // later schedule_list must prove the exact record/absence independently.
  if (toolName === 'schedule_list') return { mutation: false }
  if (toolName === 'schedule_create' || toolName === 'schedule_delete') {
    return { mutation: true, change: { kind: 'data', risk: 'low' } }
  }
  if (/(?:^|[_:.-])pure_js_probe$/iu.test(toolName)) return { mutation: true }
  if (/(?:^|[_:.-])str_replace_editor$/iu.test(toolName)) {
    const command = typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>).command
      : undefined
    if (command === 'view') return { mutation: false }
    if (command === 'create' || command === 'str_replace' || command === 'insert') {
      return { mutation: true, change: { kind: 'code', risk: 'medium' } }
    }
    // Unknown editor commands fail closed instead of inheriting a read effect.
    return { mutation: true }
  }
  if (toolName === 'run_code' || toolName === 'todo_write'
    || toolName === 'xiaoshe_runtime_info' || toolName === 'xiaoshe_capability_plan'
    || toolName === 'xiaoshe_memory_list') return { mutation: false }
  if (isShellTool(toolName)) return classifyShellEffect(args, toolName)
  if (MEMORY_ACTIONS.has(toolName)) {
    return { mutation: true, change: { kind: 'persistence', risk: 'high' } }
  }
  if (/(?:publish|deploy|release)/iu.test(toolName)) {
    return { mutation: true, change: { kind: 'release', risk: 'high' } }
  }
  if (/(?:plugin.*(?:install|add|remove|update)|(?:install|uninstall).*plugin)/iu.test(toolName)) {
    return { mutation: true, change: { kind: 'plugin', risk: 'high' } }
  }
  if (/(?:migrate|migration|restore|rollback|backup)/iu.test(toolName)) {
    return { mutation: true, change: { kind: 'persistence', risk: 'high' } }
  }
  if (WINDOWS_ACTIONS.has(toolName) || /(?:registry|win32|windows[_-])/iu.test(toolName)) {
    return { mutation: true, change: { kind: 'windows', risk: 'high' } }
  }
  if (BROWSER_ACTIONS.has(toolName)) return { mutation: true, change: { kind: 'ui', risk: 'medium' } }
  const fileArgs = asRecord(args)
  if ((toolName === 'edit' || toolName === 'write') && isJsonlDataPath(fileArgs?.file_path)) {
    // Classification is not acceptance. The host must still bind the actual
    // before/after bytes and an independent observation to this exact call.
    return { mutation: true, change: { kind: 'data', risk: 'low' } }
  }
  if (isCompleteStaticJsonWrite(toolName, args)) {
    return { mutation: true, change: { kind: 'data', risk: 'low' } }
  }
  if (isPlainDocumentWrite(toolName, args)) {
    return { mutation: true, change: { kind: 'data', risk: 'low' } }
  }
  if (/(?:write|edit|delete|remove|move|rename|apply_patch|create_file)/iu.test(toolName)) {
    return { mutation: true, change: { kind: 'code', risk: 'medium' } }
  }
  // Unknown effect verbs remain fail-closed, but without inventing a gate plan
  // that the tool contract never declared.
  const mutation = /(?:^|[_-])(?:click|fill|submit|upload|type|write|edit|delete|remove|move|rename|execute|exec|run|shell|powershell|pwsh|bash|plugin|publish|deploy|install|uninstall)(?:$|[_-])/iu
    .test(toolName)
  return { mutation }
}

/**
 * Only a whole-file write can use the data gate: its arguments contain the
 * complete post-write value that an independent read can compare exactly.
 * Known project/configuration locations stay on the code path, as do partial
 * edits and malformed JSON, so this exception cannot weaken engineering work.
 */
function isCompleteStaticJsonWrite(toolName: string, args: unknown): boolean {
  // This exception is deliberately tied to DSH's first-party whole-file tool.
  // Name-compatible plugin tools may append or patch despite accepting content.
  if (toolName !== 'write') return false
  const input = asRecord(args)
  if (input === undefined || typeof input.content !== 'string'
    || Object.keys(input).some(key => !WHOLE_FILE_WRITE_ARGUMENTS.has(key))
    || (input.sandbox_permissions !== undefined && typeof input.sandbox_permissions !== 'string')
    || (input.justification !== undefined && typeof input.justification !== 'string')) return false
  const target = safeStaticJsonTarget(input.file_path)
  if (target === undefined || isEngineeringJsonPath(target)) return false
  try {
    JSON.parse(input.content)
    return true
  } catch {
    return false
  }
}

/**
 * Only literal whole-file output documents carry a complete expected value.
 * This shared predicate is eligibility, not permission or proof: the host must
 * independently bind workspace containment, exact bytes and a later full read.
 * Executable Markdown, instruction files and build/config inputs stay closed.
 */
export function isPlainDocumentWrite(toolName: string, args: unknown): boolean {
  const input = asRecord(args)
  if (toolName !== 'write' || input === undefined || typeof input.content !== 'string'
    || Object.keys(input).some(key => !WHOLE_FILE_WRITE_ARGUMENTS.has(key))
    || (input.sandbox_permissions !== undefined && typeof input.sandbox_permissions !== 'string')
    || (input.justification !== undefined && typeof input.justification !== 'string')) return false
  const target = safeStaticJsonTarget(input.file_path, /\.(?:md|markdown|txt)$/iu, true)
  if (!target) return false
  const parts = target.toLowerCase().split('/')
  if (parts.slice(1, -1).some(part => part.startsWith('.') || ENGINEERING_JSON_DIRECTORIES.has(part))) return false
  const basename = parts.at(-1) ?? ''
  if (/^(?:agents|claude|gemini|skill|instructions|copilot-instructions)\.(?:md|markdown|txt)$/u.test(basename)
    || /^(?:cmakelists|requirements(?:[.-].*)?|constraints(?:[.-].*)?)\.txt$/u.test(basename)) return false
  // Plain text is deliberately bounded to non-executable prose. Code fences
  // carrying execution attributes, template blocks, HTML and front matter are
  // conservative exclusions; mentioning words such as build in prose is safe.
  const content = input.content
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(content)
    && !/^\uFEFF?\s*(?:---|\+\+\+)\s*\r?\n/u.test(content)
    && !/^\s*(?:import|export)\s/mu.test(content)
    && !/<(?:[A-Za-z!/?])|\{%|\{\{/u.test(content)
    && !/^\s*(?:`{3,}|~{3,})[^\r\n]*(?:\{|\b(?:exec|execute|eval|run)\b)/imu.test(content)
}

/**
 * Return the normalized `output/...json` suffix of a syntactically eligible
 * target. Ordinary absolute paths remain candidates because the live tools use
 * them; the verifier separately proves they resolve below this session's real
 * workspace/output tree. Device/UNC/ADS and traversal spellings stay closed.
 */
function safeStaticJsonTarget(value: unknown, extension: RegExp = /\.json$/iu, unambiguousOutput = false): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || /[\0\r\n]/u.test(value)) return undefined
  const slashed = value.replace(/\\/gu, '/')
  if (slashed.startsWith('//')) return undefined
  const windowsAbsolute = /^[a-z]:\//iu.test(slashed)
  if ((windowsAbsolute && slashed.slice(2).includes(':'))
    || (!windowsAbsolute && slashed.includes(':'))
    || /^[a-z]:(?!\/)/iu.test(slashed)) return undefined
  const absolute = windowsAbsolute || slashed.startsWith('/')
  const path = windowsAbsolute ? slashed.slice(3) : slashed.replace(/^\//u, '')
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return undefined
    parts.push(segment)
  }
  // Without a session cwd, multiple absolute output segments are ambiguous:
  // choosing the last could erase a protected ancestor such as output/src.
  if (absolute && unambiguousOutput && parts.filter(segment => segment.toLowerCase() === 'output').length !== 1) return undefined
  const outputIndex = absolute
    ? parts.map(segment => segment.toLowerCase()).lastIndexOf('output')
    : parts[0]?.toLowerCase() === 'output' ? 0 : -1
  if (outputIndex < 0 || outputIndex >= parts.length - 1) return undefined
  const normalized = parts.slice(outputIndex).join('/')
  return extension.test(normalized) ? normalized : undefined
}

function isEngineeringJsonPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, '/').toLowerCase()
  const parts = normalized.split('/').filter(Boolean)
  const basename = parts.at(-1) ?? ''
  if (parts.slice(0, -1).some(part => ENGINEERING_JSON_DIRECTORIES.has(part))) return true
  return /^(?:package(?:-lock)?|npm-shrinkwrap|composer|bower|deno|manifest|plugin|schema|openapi|swagger|appsettings|settings|config)\.json$/u.test(basename)
    || /^(?:tsconfig|jsconfig)(?:\..+)?\.json$/u.test(basename)
    || /^(?:eslint|prettier|biome|babel|webpack|vite|vitest|jest|playwright|stylelint|electron-builder|wrangler|netlify|vercel|turbo|nx|lerna)(?:[.-].*)?\.json$/u.test(basename)
    || /^\.(?:eslintrc|prettierrc|stylelintrc|babelrc)\.json$/u.test(basename)
    || /(?:^|\.)config\.json$/u.test(basename)
    || /(?:^|[.-])lock(?:file)?(?:[.-]|$)/u.test(basename)
}

/** Data-file eligibility only; never a permission grant or verification proof. */
export function isJsonlDataPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) return false
  const path = value.replace(/\\/gu, '/')
  if (path.startsWith('//') || path.split('/').includes('..')
    || /:(?!\/)/u.test(path) || !/\.jsonl$/iu.test(path)) return false
  // Apply the same project/configuration exclusions as JSON, including names.
  return !isEngineeringJsonPath(path.replace(/\.jsonl$/iu, '.json'))
}

function classifyShellEffect(args: unknown, toolName: string): {
  readonly mutation: boolean
  readonly change?: { readonly kind: VerificationChangeKind; readonly risk: VerificationRisk }
} {
  const input = asRecord(args)
  const command = asText(input?.command) ?? asText(input?.cmd)
  if (command === undefined) return { mutation: true }
  const kind = shellCommandKind(command, toolName)
  return kind === 'read-only'
    ? { mutation: false }
    : kind === 'code-mutation'
      ? { mutation: true, change: { kind: 'code', risk: 'medium' } }
      : { mutation: true }
}

function shellCommandKind(command: string, toolName: string): 'read-only' | 'code-mutation' | 'unknown' {
  const trimmed = command.trim()
  if (trimmed === '') return 'unknown'
  // A heredoc contains another language. Its comparisons, arrows and quoted
  // redirections are not evidence of a code-file mutation. Keep the effect
  // unknown until it has a real effect contract; never invent build gates.
  if (/<<|[\r\n]/u.test(trimmed)) return 'unknown'
  const outsideQuotes = shellOutsideQuotes(trimmed)
  if (outsideQuotes === undefined) return 'unknown'
  // Quoted JS arrows do not declare an outer-shell write, but a quoted string
  // may still be a delegated program (find -exec, git config, etc.). Never use
  // masking alone to promote such a command to read-only. Only one literal
  // PowerShell output argument has a deliberately narrow data-only exception.
  if (shellWriteSyntax(outsideQuotes)) return 'code-mutation'
  const literalOutput = ['pwsh', 'powershell'].includes(toolName)
    && /^write-output[\t ]+(?:"[^"`$\r\n]*"|'[^'\r\n]*')$/iu.test(trimmed)
  if (shellWriteSyntax(trimmed) && !literalOutput) return 'unknown'
  if (['pwsh', 'powershell'].includes(toolName) && readOnlyPowerShellInventory(trimmed)) return 'read-only'
  if (/[\r\n;|`]|\$\(/u.test(trimmed)) return 'unknown'
  const segments = trimmed.split(/\s*&&\s*/u)
  if (segments.some(segment => !readOnlyShellSegment(segment))) return 'unknown'
  return 'read-only'
}

function shellWriteSyntax(command: string): boolean {
  // Discarded output / descriptor copying are not code-file targets. This is
  // only an effect classification: the remaining command still must satisfy
  // the read-only grammar, or keep an explicitly unknown effect.
  const fileOutputs = command.replace(/(?:\b\d+)?\s*>\s*\/dev\/null(?=\s|$)/gu, ' ')
    .replace(/(?:\b\d+)?\s*>\s*&\s*(?:\d+|-)(?=\s|$)/gu, ' ')
  return /(?:^|\s)(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|mkdir|touch|rm|del|erase|cp|mv|install-package|uninstall-package)(?:\s|$)/iu.test(command)
    || /(?:^|\s)(?:npm|npm\.cmd|pnpm|pnpm\.cmd|yarn|yarn\.cmd|bun|bun\.exe)\s+(?:add|install|remove|uninstall|update|upgrade)(?:\s|$)/iu.test(command)
    || /(?:^|\s)git(?:\.exe)?\s+(?:add|commit|checkout|switch|restore|reset|clean|merge|rebase|cherry-pick|tag|push|pull|fetch)(?:\s|$)/iu.test(command)
    || /(?:^|[^<])>{1,2}(?:[^>]|$)/u.test(fileOutputs)
    || /(?:^|\s)sed\s+-[^\s]*i[^\s]*(?:\s|$)/iu.test(command)
}

/** Mask balanced literal quotes without evaluating shell input. Escape forms
 * differ across shells, so ambiguous escapes fail closed instead of being parsed.
 */
function shellOutsideQuotes(command: string): string | undefined {
  let quote: string | undefined
  let outside = ''
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (char === '`' || (char === '\\' && /["']/u.test(command[index + 1] ?? ''))) return undefined
    if (char === quote) quote = undefined
    else if (quote === undefined && (char === '"' || char === "'")) quote = char
    else if (quote === undefined) {
      outside += char
      continue
    }
    outside += ' '
  }
  return quote === undefined ? outside : undefined
}

/** A deliberately small PowerShell inventory grammar, not a general pipeline
 * parser. Only static current-directory listing and fixed metadata projection
 * are admitted; expressions, paths/providers, extra stages and other commands
 * must continue through the conservative unknown-effect path.
 */
function readOnlyPowerShellInventory(command: string): boolean {
  if (/[\r\n`$&{}()<>"']/u.test(command)) return false
  const statements = command.split(';')
  if (statements.length > 8) return false
  return statements.every(statement => {
    const stages = statement.trim().split('|').map(stage => stage.trim())
    if (stages.length > 2) return false
    const first = stages[0] ?? ''
    // DSH's fresh -NoProfile PowerShell uses pwd as the built-in no-argument
    // Get-Location alias. Keep compound inventory consistent with plain pwd;
    // alias definitions, arguments and pipeline use remain outside this grammar.
    if (/^(?:get-location|pwd)$/iu.test(first)) return stages.length === 1
    if (!/^get-childitem(?:[\t ]+-(?:force|file|directory|name))*$/iu.test(first)) return false
    if (stages.length === 1) return true
    return /^select-object[\t ]+(?:-property[\t ]+)?(?:mode|length|name|fullname|lastwritetime|extension|psiscontainer)(?:[\t ]*,[\t ]*(?:mode|length|name|fullname|lastwritetime|extension|psiscontainer))*$/iu.test(stages[1] ?? '')
  })
}

function readOnlyShellSegment(segment: string): boolean {
  const tokens = shellTokens(segment)
  if (tokens.length === 0) return false
  const normalized = tokens.map(token => token.toLowerCase())
  const executable = shellBasename(normalized[0] ?? '').replace(/\.(?:cmd|exe)$/u, '')
  const args = normalized.slice(1)
  // These otherwise observational programs can explicitly delegate execution
  // or write files. Unknown effect is not an execution denial or a sandbox.
  if (executable === 'find') return !args.some(token => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/u.test(token))
  if (executable === 'rg') return !args.some(token => /^--pre(?:=|$)/u.test(token))
  if (['grep', 'findstr', 'ls', 'dir', 'pwd', 'where', 'where.exe', 'get-content',
    'select-string', 'test-path', 'get-item', 'get-childitem', 'get-child-item', 'resolve-path',
    'get-location', 'get-command', 'write-output'].includes(executable)) return true
  if (executable === 'git') return readOnlyGit(args)
  if (executable === 'node') return readOnlyNode(args)
  if (executable === 'tsc') return normalized.includes('--noemit')
  if (['pytest', 'vitest', 'jest', 'mocha'].includes(executable)) return true
  if (['cargo', 'go', 'dotnet'].includes(executable)) return ['test', 'check', 'build'].includes(normalized[1] ?? '')
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    if (['exec', 'x', 'dlx'].includes(normalized[1] ?? '')) {
      return readOnlyRunnerInvocation(normalized.slice(2))
    }
    const runIndex = normalized.indexOf('run')
    const script = runIndex >= 0 ? normalized[runIndex + 1] : normalized[1]
    return script !== undefined && /(?:^|:)(?:test|typecheck|check-types|check:types|build)(?::|$)/u.test(script)
  }
  if (['npx', 'bunx'].includes(executable)) return readOnlyRunnerInvocation(args)
  return false
}

/** Recognize only plain Node verification forms, never another execution mode
 * or a flag/file inside a payload. Extra options and direct-file arguments are
 * intentionally unknown; this is a finite classifier, not a Node CLI parser.
 */
function readOnlyNode(args: readonly string[]): boolean {
  const first = args[0] ?? ''
  if (first === '--check') return args.length === 2 && staticNodePath(args[1]!)
  if (first === '--test') return args.slice(1).every(staticNodePath)
  return args.length === 1 && staticNodePath(first)
    && /(?:^|[\\/])[^\\/]+\.(?:test|spec)\.[cm]?[jt]s$/iu.test(first)
}

function staticNodePath(value: string): boolean {
  return value !== '' && !value.startsWith('-') && !/[\u0000\r\n$`@%"'{}()[\]&;|<>]/u.test(value)
}

/** Only a direct, known runner is a verification invocation. Wrapper options
 * that change the executed payload are not inferred from later runner names.
 */
function readOnlyRunnerInvocation(args: readonly string[]): boolean {
  if (args.some(token => /^-[cp]|^--(?:call|package)(?:=|$)/u.test(token))) return false
  const command = args[0] === '--' ? args[1] : args[0]
  return command !== undefined
    && ['tsc', 'vitest', 'jest', 'mocha'].includes(shellBasename(command).replace(/\.(?:cmd|exe)$/u, ''))
}

function readOnlyGit(args: readonly string[]): boolean {
  if (args.some(token => /^-c|^--(?:config-env|exec-path|ext-diff|textconv|output)(?:=|$)|^(?:-p|--paginate)$/u.test(token))) return false
  let index = 0
  while (index < args.length && args[index]?.startsWith('-')) {
    index += 1
  }
  const command = args[index]
  if (command === undefined) return false
  if (['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'fsck'].includes(command)) return true
  return command === 'branch' && args.slice(index + 1).every(value => [
    '--list', '--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--no-color',
  ].includes(value))
}

function isShellTool(toolName: string): boolean {
  return ['bash', 'pwsh', 'powershell', 'exec_command', 'shell'].includes(toolName)
}

function shellTokens(command: string): string[] {
  return (command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/gu) ?? []).map(token =>
    ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
      ? token.slice(1, -1)
      : token,
  )
}

function shellBasename(path: string): string {
  return path.replace(/\\/gu, '/').split('/').at(-1) ?? path
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export const name = 'xiaoshe-verification-policy'
export const inject: readonly string[] = []

export function apply(ctx: { provide(name: string, value: unknown): unknown }): void {
  ctx.provide('xiaosheVerificationPolicy', createVerificationPolicy())
}

function hasEvidence(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && value.length <= 2_048
}
