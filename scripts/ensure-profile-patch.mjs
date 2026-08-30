#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

function parseArgs(argv) {
  const values = new Map()
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--target', '--template'].includes(key) || !value) {
      throw new Error('用法：node scripts/ensure-profile-patch.mjs --target <cordis.patch.yml> --template <template.yml>')
    }
    values.set(key, resolve(value))
  }
  const target = values.get('--target')
  const template = values.get('--template')
  if (!target || !template || values.size !== 2) throw new Error('必须同时指定 --target 和 --template')
  return { target, template }
}

function containsModLensPatch(value) {
  return /^\s*-\s+id:\s*modlens(?:\s|$)/mu.test(value)
}

function semanticBody(value) {
  return value
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:#|$)/u.test(line))
    .join('')
    .replace(/\s/gu, '')
}

async function atomicWrite(path, content, mode) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content, { mode })
  await rename(temporary, path)
  await chmod(path, mode)
}

try {
  const { target, template } = parseArgs(process.argv)
  const templateValue = await readFile(template, 'utf8')
  if (!containsModLensPatch(templateValue)) throw new Error('模板未定义 modlens patch')

  let current = ''
  let mode = 0o600
  try {
    current = await readFile(target, 'utf8')
    mode = (await stat(target)).mode & 0o777
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
  }

  if (containsModLensPatch(current)) {
    process.stdout.write(`[保留] Profile 已有 modlens 配置：${target}\n`)
  } else {
    const body = semanticBody(current)
    const next = body === '' || body === '[]'
      ? templateValue.trimEnd() + '\n'
      : `${current.trimEnd()}\n\n# 小蛇安装器追加：ModLens 使用 DeepSeek 官方 Provider。\n${templateValue.trimEnd()}\n`
    await atomicWrite(target, next, mode)
    process.stdout.write(`[完成] 已合并 modlens Profile 配置：${target}\n`)
  }
} catch (error) {
  process.stderr.write(`[错误] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
