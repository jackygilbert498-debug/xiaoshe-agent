/** Normalize plugin metadata for display and routing. */
export function normalizePlugins(entries) {
  const plugins = new Map()
  for (const plugin of entries) {
    const id = String(plugin?.id ?? '').trim()
    if (!id) continue
    const current = plugins.get(id) ?? plugin
    current.capabilities = [...new Set(plugin.capabilities ?? [])]
    plugins.set(id, current)
  }
  return [...plugins.values()]
}
