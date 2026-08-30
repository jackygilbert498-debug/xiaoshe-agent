export interface ProductPackage {
  readonly name: string
  readonly version: string
  readonly relativeDirectory: string
  readonly filename: string
}

export const PRODUCT_PACKAGES: readonly ProductPackage[]
export function rewriteWorkspaceDependencies<T extends Record<string, unknown>>(input: T): T
export function renderPortableOverrides(artifactDirectory: string, forbiddenSourceDirectory?: string): string
export function portableFileSpec(path: string): string
export function tarballFilename(name: string, version: string): string
export function toPosix(value: string): string
