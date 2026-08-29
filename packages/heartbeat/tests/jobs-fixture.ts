export interface FakeJobOutcome {
  readonly status: 'completed' | 'killed' | 'failed'
  readonly detail?: string
  readonly output?: string
}

interface FakeJobHooks {
  cancel(reason?: string): void
  done: Promise<FakeJobOutcome>
}

interface FakeJobSpec {
  readonly kind: string
  readonly label: string
  readonly owner?: unknown
  run(): FakeJobHooks
}

interface FakeJobRecord {
  readonly id: string
  readonly hooks: FakeJobHooks
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
}

export function fakeJobs() {
  let controllerCount = 0
  let counter = 0
  const records = new Map<string, FakeJobRecord>()
  const events: string[] = []
  return {
    events,
    attachController(name: string) {
      events.push(`attach:${name}`)
      controllerCount += 1
      let attached = true
      return () => {
        if (!attached) return
        attached = false
        controllerCount -= 1
        events.push(`detach:${name}`)
      }
    },
    start(spec: FakeJobSpec) {
      if (controllerCount === 0) throw new Error('no job controller')
      if (spec.owner !== undefined) throw new Error('heartbeat jobs must be unowned')
      events.push(`start:${spec.label}`)
      const hooks = spec.run()
      const id = `${spec.kind}-${++counter}`
      const record: FakeJobRecord = { id, hooks, status: 'running' }
      records.set(id, record)
      void hooks.done.then((outcome) => {
        record.status = outcome.status
        events.push(`job:${outcome.status}`)
      })
      return id
    },
    get(id: string) {
      const record = records.get(id)
      if (record === undefined) throw new Error(`unknown job ${id}`)
      return { id, status: record.status }
    },
    kill(id: string, _caller?: unknown, reason?: string) {
      const record = records.get(id)
      if (record === undefined) throw new Error(`unknown job ${id}`)
      if (record.status !== 'running' && record.status !== 'stopping') return 'already-finished' as const
      record.hooks.cancel(reason)
      record.status = 'stopping'
      events.push(`kill:${id}`)
      return 'requested' as const
    },
    list: () => [...records.values()].map(record => ({ id: record.id, status: record.status })),
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}
