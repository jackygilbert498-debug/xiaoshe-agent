export type LegacyClassification =
  | 'DSH 已提供'
  | 'XS 已提供'
  | '应迁移'
  | '暂留 Provider'
  | '淘汰'
  | '外部阻塞'

export interface DiscoveredLegacySurface {
  tools: string[]
  cli: string[]
  sources: { toolsSource: string; runSource: string }
}

export interface LegacyCapability {
  id: string
  userValue: string
  oldImplementationReferences: string[]
  oldTests: string[]
  replacement: string
  classification: LegacyClassification
  windowsVerification: string
  migrationCost: string
  decisionRationale: string
  sourceType: string
  sourceName: string
}

export interface LegacyInventory {
  schema: number
  generatedAt: string
  legacyRoot: string
  discovered: { toolCount: number; cliCount: number }
  capabilities: LegacyCapability[]
}

export const APPROVED_CLASSIFICATIONS: readonly LegacyClassification[]
export function discoverLegacyPublicSurface(root: string): Promise<DiscoveredLegacySurface>
export function buildInventory(root: string): Promise<LegacyInventory>
export function validateInventory(discovered: DiscoveredLegacySurface, inventory: LegacyInventory): string[]
