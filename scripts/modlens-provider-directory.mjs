/** Wrapper configuration belongs to its actual upstream, not a second API key.
 * Only called by the wrapper that owns the adapter registration. Do not infer
 * upstream from a display name or treat a successful text probe as vision proof.
 */
export function syncWrapperDirectory(ctx, current, upstream, displayName) {
  const llm = ctx.llm
  if (typeof llm.listConfigurableProviders !== 'function' || typeof llm.registerConfigurableProviders !== 'function') return
  const owner = llm.listConfigurableProviders().find(entry => entry.provider === upstream)
  if (!owner || typeof owner.settingsNs !== 'string' || !owner.settingsNs
    || !Array.isArray(owner.settingsPath) || !owner.settingsPath.every(part => typeof part === 'string' && part)) {
    releaseWrapperDirectory(current)
    return
  }
  const entry = { provider: current.providerId, displayName, settingsNs: owner.settingsNs, settingsPath: [...owner.settingsPath] }
  const signature = JSON.stringify(entry)
  if (current.directorySignature === signature) return
  try {
    if (current.directory) current.directory.replace([entry])
    else current.directory = llm.registerConfigurableProviders([entry])
    current.directorySignature = signature
  } catch {
    // Never keep a descriptor pointing at yesterday's credential/config owner.
    releaseWrapperDirectory(current)
    throw new Error('modlens upstream configuration directory unavailable')
  }
}

export function releaseWrapperDirectory(current) {
  const release = current.directory
  delete current.directory
  delete current.directorySignature
  if (typeof release === 'function') release()
}
