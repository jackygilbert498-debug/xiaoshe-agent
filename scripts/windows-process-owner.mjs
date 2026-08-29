import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const SCHEMA = 'xiaoshe-windows-process/v1'

function options(argv) {
  const result = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`Invalid option: ${String(name)}`)
    result.set(name.slice(2), value)
  }
  return result
}

function required(values, name) {
  const value = values.get(name)?.trim()
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

function validate(record) {
  if (record?.schema !== SCHEMA || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65535
    || typeof record.xsRoot !== 'string' || record.xsRoot === ''
    || typeof record.dshRoot !== 'string' || record.dshRoot === ''
    || typeof record.creationDate !== 'string' || record.creationDate === '') {
    throw new Error('Invalid Xiaoshe Windows process ownership record')
  }
  return record
}

const [command, ...rawOptions] = process.argv.slice(2)
const values = options(rawOptions)
const path = resolve(required(values, 'path'))

if (command === 'write') {
  const record = validate({
    schema: SCHEMA,
    pid: Number(required(values, 'pid')),
    port: Number(required(values, 'port')),
    xsRoot: required(values, 'xs-root'),
    dshRoot: required(values, 'dsh-root'),
    creationDate: required(values, 'creation-date'),
  })
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  await rm(path, { force: true })
  await rename(temporary, path)
  process.stdout.write(`${JSON.stringify(record)}\n`)
} else if (command === 'read') {
  const record = validate(JSON.parse(await readFile(path, 'utf8')))
  process.stdout.write(`${JSON.stringify(record)}\n`)
} else if (command === 'remove') {
  await rm(path, { force: true })
} else {
  throw new Error('Usage: windows-process-owner.mjs <write|read|remove> --path <state> ...')
}
