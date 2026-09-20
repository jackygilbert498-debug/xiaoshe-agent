import { access, readFile, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// No third-party imports: this diagnostic must work before dependencies do.
export function foreignDependencyMetadata(text) {
  return /^\s*["']?(?:storeDir|virtualStoreDir)["']?\s*:\s*["']?(?:[a-z]:[\\/]|\/mnt\/[a-z]\/)/imu.test(text)
}

export async function inspectMacDependencies(root, dshRoot) {
  if (![root, dshRoot].every(isAbsolute)) throw new Error('Expected absolute workspace roots')
  const issues = []
  for (const [label, workspace] of [['XS', root], ['DSH', dshRoot]]) {
    try {
      const metadata = await readFile(join(workspace, 'node_modules/.modules.yaml'), 'utf8')
      if (foreignDependencyMetadata(metadata)) issues.push(`${label}: 检测到 Windows/WSL 依赖路径，需要按锁文件在本机重新安装`)
    } catch { issues.push(`${label}: 缺少可读取的 pnpm 依赖记录`) }
  }
  const packages = [root, dshRoot]
  // Check every product package's own resolution, not just root node_modules.
  for (const group of ['packages', 'apps']) {
    for (const entry of await readdir(join(root, group), { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) packages.push(join(root, group, entry.name))
    }
  }
  for (const directory of packages) {
    let manifest
    try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) }
    catch { issues.push(`${directory}: package.json 缺失或无效`); continue }
    if (!manifest.devDependencies?.typescript && !manifest.dependencies?.typescript) continue
    try {
      // pnpm links direct dependencies locally. Parent fallback can hide a
      // broken DSH TypeScript link by resolving XS's different compiler.
      await access(join(directory, 'node_modules/typescript/package.json'), constants.R_OK)
      const require = createRequire(join(directory, 'package.json'))
      const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc')
      if (!(await stat(compiler)).isFile()) throw new Error('missing compiler')
      await access(compiler, constants.R_OK)
      const shim = join(directory, 'node_modules/.bin/tsc')
      if (!(await stat(shim)).isFile()) throw new Error('missing shim')
      await access(shim, constants.R_OK | constants.X_OK)
      const script = await readFile(shim, 'utf8')
      if (/\/mnt\/[a-z]\/|(?:^|[\s"'=;:])[a-z]:[\\/]/imu.test(script)) throw new Error('foreign shim')
    } catch { issues.push(`${manifest.name ?? directory}: TypeScript 缺失、链接损坏、跨平台脚本或 tsc 不可执行`) }
  }
  return { ok: issues.length === 0, issues }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await inspectMacDependencies(process.argv[2], process.argv[3])
    if (!result.ok) {
      for (const issue of result.issues) process.stderr.write(`[依赖检查] ${issue}\n`)
      process.stderr.write('[依赖检查] 请保留源码和配置，隔离旧 node_modules 后重新运行 macOS 锁定安装；不要使用 chmod -R 或回退旧应用。\n')
      process.exitCode = 1
    }
  } catch {
    process.stderr.write('[依赖检查] 无法检查工作区依赖；停止构建。\n')
    process.exitCode = 1
  }
}
