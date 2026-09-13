#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMap, isSeq, parseDocument } from 'yaml'

function document(text) {
  // Parse !!js as inert YAML, never evaluate profile expressions in an installer.
  const doc = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
  // Parser messages can quote a bad line containing a credential; report
  // the error class only, never configuration content.
  if (doc.errors.length) throw new Error(`Profile YAML 无效，未修改（${doc.errors[0].code}）`)
  if (doc.contents === null) doc.contents = doc.createNode([])
  if (!isSeq(doc.contents)) throw new Error('Profile patch 必须是 YAML 列表，未修改')
  return doc
}

export function mergeProfile(current, template) {
  const doc = document(current)
  const defaults = document(template).contents.items.find(row => isMap(row) && row.get('id') === 'modlens')
  if (!defaults || !isMap(defaults.get('config'))) throw new Error('模板未定义 modlens config')
  const rows = doc.contents.items.filter(row => isMap(row) && row.get('id') === 'modlens')
  if (!rows.length) {
    doc.contents.add(defaults.clone())
    return String(doc)
  }
  let changed = false
  const first = rows[0]
  if (!first.has('config')) { first.set('config', doc.createNode({})); changed = true }
  const config = first.get('config')
  if (!isMap(config)) throw new Error('已有 ModLens config 不是映射，未修改')
  // DSH replaces an id's entire config. Coalesce the earlier installer's
  // timeout-only duplicate into ONE row so upstream and user options survive.
  for (const duplicate of rows.slice(1)) {
    if (duplicate.items.some(pair => !['id', 'config'].includes(String(pair.key)))) {
      throw new Error('多个 ModLens patch 含有非 config 操作，需人工合并，未修改')
    }
    const extra = duplicate.get('config')
    if (!isMap(extra)) throw new Error('重复 ModLens config 不是映射，未修改')
    for (const pair of extra.items) config.set(pair.key, pair.value?.clone?.() ?? pair.value)
    doc.contents.items.splice(doc.contents.items.indexOf(duplicate), 1)
    changed = true
  }
  for (const pair of defaults.get('config').items) {
    if (!config.has(pair.key)) { config.add(pair.clone()); changed = true }
  }
  // 25 seconds was the previous installer's value, too short for CLI cold
  // starts. Preserve other explicit user budgets; runtime supplies the cap.
  if (config.get('timeoutMs') === 25000) { config.set('timeoutMs', 60000); changed = true }
  return changed ? String(doc) : current
}

async function main() {
  const args = process.argv.slice(2)
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    if (!['--target', '--template'].includes(args[index]) || !args[index + 1]) throw new Error('必须指定 --target 和 --template')
    options.set(args[index], resolve(args[index + 1]))
  }
  if (options.size !== 2) throw new Error('必须指定 --target 和 --template')
  const target = options.get('--target')
  let current = ''; let mode = 0o600
  try { current = await readFile(target, 'utf8'); mode = (await stat(target)).mode & 0o777 }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const next = mergeProfile(current, await readFile(options.get('--template'), 'utf8'))
  if (next !== current) {
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.tmp-${process.pid}`
    await writeFile(temporary, next, { mode })
    await rename(temporary, target)
    await chmod(target, mode)
  }
  process.stdout.write(`[完成] ModLens 路由与限时配置已核对（保留用户配置）：${target}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`[错误] ${error.message}\n`); process.exitCode = 1 })
}
