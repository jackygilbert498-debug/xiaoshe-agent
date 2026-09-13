/**
 * Extract the durable failure facts from one DSH `tool/result` event.
 * The model-facing `isError` flag lives on the nested `tool-result` block;
 * optional machine-readable identity remains on `event.data.error`.
 */
export function extractToolResultFailure(event) {
  if (event?.type !== 'tool/result' || !event.data || typeof event.data !== 'object') return undefined

  const content = Array.isArray(event.data.message?.content) ? event.data.message.content : []
  const toolResultBlocks = content.filter(block => block?.type === 'tool-result')
  const nestedIsError = toolResultBlocks.some(block => block.isError === true)

  // Preserve compatibility with older bridge projections without making them
  // authoritative over the standard durable message shape.
  const projectedIsError = event.data.isError === true
    || event.data.result?.isError === true
    || event.data.output?.isError === true
  const candidates = [event.data.error, event.data.result?.error, event.data.output?.error]
  const error = candidates.find(candidate => candidate && typeof candidate === 'object')

  if (!nestedIsError && !projectedIsError && !error) return undefined

  const failure = { isError: true }
  if (typeof error?.name === 'string' && error.name.trim() !== '') failure.name = error.name
  if (typeof error?.code === 'string' && error.code.trim() !== '') failure.code = error.code
  return failure
}

/**
 * Summarize durable provider retry events without deriving unavailable facts.
 * Arrays retain one value per event that actually carried that field.
 */
export function summarizeLlmRetries(events) {
  const retryEvents = events.filter(event => event?.type === 'llm/retry')
  const startedEvents = events.filter(event => event?.type === 'llm/retry-started')

  return {
    count: retryEvents.length,
    startedCount: startedEvents.length,
    errorCodes: retryEvents.flatMap(event => {
      const code = event.data?.failure?.code
      return typeof code === 'string' && code.trim() !== '' ? [code] : []
    }),
    backoffMs: retryEvents.flatMap(event => {
      const delayMs = event.data?.delayMs
      return typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs >= 0 ? [delayMs] : []
    }),
  }
}

/** Build the diagnostics persisted beside one live acceptance scenario. */
export function buildEventDiagnostics(events) {
  return {
    errors: events.map(extractToolResultFailure).filter(Boolean),
    llmRetries: summarizeLlmRetries(events),
  }
}

/** Distinguish an exhausted external provider connection from Harness policy. */
export function isExternalTransportBoundary(diagnostics, { turnEnd, answer }) {
  const retry = diagnostics?.llmRetries
  return turnEnd === 'error'
    && String(answer ?? '').trim() === ''
    && retry?.count > 0
    && retry.errorCodes?.length === retry.count
    && retry.errorCodes.every(code => code === 'TRANSPORT')
}
