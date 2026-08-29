/**
 * Test-only Cordis probe for the Product Profile's model-facing history tools.
 * It reads schema names only and never opens the history index or session data.
 */
export const name = 'xiaoshe-session-continuity-inspector'
export const inject = ['tools']

const EXPECTED = [
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  'session_search',
  'session_trace',
].sort()

export function apply(ctx) {
  ctx.effect(() => {
    const controller = new AbortController()
    void inspectSchemas(ctx, controller.signal).catch(error => {
      console.error(`[xiaoshe-session-continuity] error=${error instanceof Error ? error.message : String(error)}`)
    })
    return () => { controller.abort() }
  }, 'inspect session continuity schemas')
}

async function inspectSchemas(ctx, signal) {
  const deadline = Date.now() + 60_000
  let visible = []
  while (!signal.aborted && Date.now() < deadline) {
    visible = ctx.tools.schemas().map(schema => schema.name).sort()
    if (EXPECTED.every(tool => visible.includes(tool))) {
      console.log(`[xiaoshe-session-continuity] tools=${JSON.stringify(EXPECTED)}`)
      return
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }

  if (signal.aborted) return
  throw new Error(
    `session continuity tool composition timed out: expected=${JSON.stringify(EXPECTED)} `
      + `visible=${JSON.stringify(visible.filter(name => name.startsWith('session_')))}`,
  )
}
