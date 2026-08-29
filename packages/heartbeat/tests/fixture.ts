export function memoryStore(initial: Record<string, unknown> = {}) {
  let value = structuredClone(initial)
  const watchers = new Set<(next: Record<string, unknown>) => void>()
  return {
    get: () => structuredClone(value),
    watch(callback: (next: Record<string, unknown>) => void) { watchers.add(callback); return () => watchers.delete(callback) },
    async update(patch: Record<string, unknown>) {
      value = { ...value, ...structuredClone(patch) }
      for (const watcher of watchers) watcher(structuredClone(value))
    },
    watcherCount: () => watchers.size,
    raw: () => structuredClone(value),
  }
}
