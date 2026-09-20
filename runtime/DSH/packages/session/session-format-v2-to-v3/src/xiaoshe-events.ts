/** Frozen Xiaoshe V2 event vocabulary; only these four log-only families migrate. */
import { SessionFormatError, sessionFormatCount, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'

export const XIAOSHE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'verification/result', 'xiaoshe/task-generation', 'xiaoshe/research-evidence', 'xiaoshe/obligation-state',
])

/** Validate owned fields and local references without interpreting strings or opaque tool metadata. */
export function assertXiaosheEvent(event: SessionFormatEvent): void {
  if (!XIAOSHE_EVENT_TYPES.has(event.type)) throw new SessionFormatError('unclassified Xiaoshe event')
  if (!isSessionFormatJsonObject(event.data)) throw new SessionFormatError(event.type + ' data must be an object')
  const data = event.data
  const fail = (message: string): never => { throw new SessionFormatError(event.type + ' ' + message) }
  const fields = (required: readonly string[], optional: readonly string[] = []): void => {
    for (const key of required) if (!Object.hasOwn(data, key)) fail('missing field ' + key)
    for (const key of Object.keys(data)) if (!required.includes(key) && !optional.includes(key)) fail('unexpected field ' + key)
  }
  const text = (key: string): void => { if (typeof data[key] !== 'string') fail(key + ' must be a string') }
  const choice = (key: string, values: readonly string[]): void => {
    if (typeof data[key] !== 'string' || !values.includes(data[key] as string)) fail('invalid ' + key)
  }
  const reference = (value: unknown): void => {
    if (sessionFormatCount(value, event.type + ' result reference') >= event.seq) fail('result reference must name an earlier event')
  }
  if (event.type === 'verification/result') {
    fields(['turn', 'mutationCallId', 'verifierCallId', 'gate', 'status'], ['evidence'])
    text('mutationCallId'); text('verifierCallId')
    choice('gate', ['typecheck', 'test', 'build', 'browser', 'windows-evidence', 'migration-rollback', 'profile-dump', 'profile-start', 'functional-probe', 'release-confirmation'])
    choice('status', ['passed', 'failed', 'skipped', 'not-run', 'blocked', 'not-applicable'])
    if (data['evidence'] !== undefined) text('evidence')
  } else {
    if (data['version'] !== 1) fail('version must be 1')
    sessionFormatCount(data['generation'], event.type + ' generation')
    if (event.type === 'xiaoshe/task-generation') {
      fields(['version', 'generation', 'relation', 'triggerMessageId'])
      choice('relation', ['new', 'continuation']); text('triggerMessageId')
      return
    }
    if (event.type === 'xiaoshe/research-evidence') {
      fields(['version', 'generation', 'turn', 'kind', 'callId'], ['url'])
      choice('kind', ['body']); text('callId')
      if (data['url'] !== undefined) text('url')
    } else {
      const base = ['version', 'generation', 'turn', 'kind', 'status']
      switch (data['kind']) {
        case 'ordered-read':
          fields([...base, 'primary', 'fallback'], ['reason'])
          choice('status', ['pending', 'blocked', 'satisfied']); text('primary'); text('fallback')
          if (data['reason'] !== undefined) text('reason')
          break
        case 'research':
          fields([...base, 'sourceResultSeqs', 'bodyResultSeqs', 'citedBodyResultSeqs'], ['reason'])
          choice('status', ['pending', 'blocked', 'bounded-partial', 'satisfied'])
          if (data['reason'] !== undefined) choice('reason', ['no-source', 'body-missing', 'citation-missing', 'stale-only'])
          for (const key of ['sourceResultSeqs', 'bodyResultSeqs', 'citedBodyResultSeqs']) {
            const values = data[key]
            if (!Array.isArray(values)) fail(key + ' must be an array')
            for (const value of values as unknown[]) reference(value)
          }
          break
        case 'route-recovery':
          fields([...base, 'failedFamily'], ['alternativeFamily', 'alternativeTool', 'toolContractDigest', 'presetId', 'proofResultSeq'])
          choice('status', ['needs-alternative', 'needs-proof', 'satisfied', 'blocked']); text('failedFamily')
          for (const key of ['alternativeFamily', 'alternativeTool', 'toolContractDigest', 'presetId']) if (data[key] !== undefined) text(key)
          if (data['proofResultSeq'] !== undefined) reference(data['proofResultSeq'])
          break
        default: fail('unclassified obligation kind')
      }
    }
  }
  sessionFormatCount(data['turn'], event.type + ' turn')
}

/** Metadata is product-owned JSON, never a coordinate container or an authorization grant. */
export function assertDispatchMeta(data: SessionFormatJsonObject): void {
  if (Object.hasOwn(data, 'meta') && !isSessionFormatJsonObject(data['meta'])) {
    throw new SessionFormatError('tool dispatch meta must be an object')
  }
}
