export interface ProviderRouteAddress {
  readonly provider: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
}
export interface PublicSettingsNamespace {
  readonly ns: string
  readonly value: unknown
  readonly revision?: number
}

/**
 * Fingerprint only the owner's redacted, public route configuration. The host
 * MUST obtain descriptors with describe({ redactSecrets: true }); the browser
 * uses the same wire-safe view. The host's non-secret epoch invalidates evidence
 * across launches, including changed adapter environment overrides that are not
 * present in the public settings view. No environment values are hashed.
 * Same-reference secret rotation within one mount still needs an explicit probe.
 */
export async function providerRouteRevision(
  provider: string,
  model: string,
  directory: readonly ProviderRouteAddress[],
  namespaces: readonly PublicSettingsNamespace[],
  configurationEpoch?: string,
): Promise<string | undefined> {
  const address = directory.find(entry => entry.provider === provider)
  const namespace = address === undefined ? undefined : namespaces.find(entry => entry.ns === address.settingsNs)
  if (address === undefined || namespace === undefined) return undefined
  let configuration = namespace.value
  for (const part of address.settingsPath) {
    if (!isRecord(configuration) || !Object.hasOwn(configuration, part)) return undefined
    configuration = configuration[part]
  }
  const publicValue = publicConfiguration(configuration)
  const serialized = JSON.stringify({ provider, model, configurationEpoch,
    namespace: address.settingsNs, path: address.settingsPath, revision: namespace.revision ?? 0, configuration: publicValue })
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function publicConfiguration(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new TypeError('provider configuration exceeds the supported nesting depth')
  if (Array.isArray(value)) return value.map(item => publicConfiguration(item, depth + 1))
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value).sort()) {
    // Defense in depth for adapters exposing familiar secret fields without a
    // schema role. apiKeyEnv is a public reference and intentionally retained.
    if (/^(?:api[-_]?key|password|secret|token|authorization|access[-_]?token|refresh[-_]?token)$/iu.test(key)) continue
    // Header names are not a secret-role schema: any custom header may carry
    // credential bytes. Retain names only; settings revision invalidates edits.
    if (/headers$/iu.test(key)) {
      result[key] = isRecord(value[key]) ? Object.keys(value[key]).sort() : undefined
      continue
    }
    if (/(?:url|endpoint)$/iu.test(key) && typeof value[key] === 'string') {
      result[key] = publicEndpoint(value[key])
      continue
    }
    result[key] = publicConfiguration(value[key], depth + 1)
  }
  return result
}

/** URL credentials can be embedded even when an adapter declares plain string. */
function publicEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return `${url.origin}${url.pathname}`
  } catch { return undefined }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
