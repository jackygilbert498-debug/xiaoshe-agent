import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { runSearchQueries } from '../src/search.ts'

function contextWithSearch(search: (query: string, signal: AbortSignal) => Promise<any>): Context {
  return {
    web: {
      search: ({ query }: { query: string }, signal: AbortSignal) => search(query, signal),
    },
  } as Context
}

test('multi-query search preserves ordered deduplicated successes and reports partial failures', async () => {
  const completed: string[] = []
  const ctx = contextWithSearch(async (query) => {
    if (query === 'broken') throw new Error('provider unavailable')
    await new Promise(resolve => setTimeout(resolve, query === 'first' ? 10 : 1))
    completed.push(query)
    return {
      content: `answer:${query}`,
      sources: [
        { url: `https://example.com/${query}` },
        { url: 'https://example.com/shared' },
      ],
      truncated: false,
    }
  })

  const result = await runSearchQueries(ctx, ['first', 'broken', 'second'], 8, new AbortController().signal)

  assert.deepEqual(completed.sort(), ['first', 'second'], 'one provider failure must not abort sibling searches')
  assert.deepEqual(result.sources.map(source => source.url), [
    'https://example.com/first',
    'https://example.com/second',
    'https://example.com/shared',
  ])
  assert.match(result.content ?? '', /### first[\s\S]*### second/u)
  assert.match(result.content ?? '', /Partial search diagnostics:[\s\S]*"broken": provider unavailable/u)
})

test('multi-query search fails when every query fails', async () => {
  const ctx = contextWithSearch(async (query) => { throw new Error(`failed:${query}`) })
  await assert.rejects(
    runSearchQueries(ctx, ['first', 'second'], 8, new AbortController().signal),
    /failed:first/u,
  )
})

test('multi-query search preserves external cancellation', async () => {
  const controller = new AbortController()
  const reason = new Error('caller cancelled')
  const ctx = contextWithSearch((_query, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const pending = runSearchQueries(ctx, ['first', 'second'], 8, controller.signal)
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
})
