import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const SCHEMA = 'xiaoshe-windows-process/v1'

function options(argv) {
  const result = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    const key = name?.slice(2)
    if (!name?.startsWith('--') || value === undefined || result.has(key)) throw new Error(`Invalid option: ${String(name)}`)
    result.set(key, value)
  }
  return result
}

function required(values, name) {
  const value = values.get(name)?.trim()
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

function validate(record, annotateLegacy = false) {
  const hasRuntimeIdentity = typeof record?.runtimeIdentity === 'string' && /^[a-f0-9]{64}$/u.test(record.runtimeIdentity)
  const hasOwnershipToken = typeof record?.ownershipToken === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.ownershipToken)
  if (record?.schema !== SCHEMA || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65535
    || typeof record.xsRoot !== 'string' || record.xsRoot === ''
    || typeof record.dshRoot !== 'string' || record.dshRoot === ''
    || hasRuntimeIdentity !== hasOwnershipToken
    || typeof record.creationDate !== 'string' || record.creationDate === '') {
    throw new Error('Invalid Xiaoshe Windows process ownership record')
  }
  return annotateLegacy ? { ...record, legacy: !hasRuntimeIdentity } : record
}

async function writeRecord(path, record) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
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
    runtimeIdentity: required(values, 'runtime-identity'),
    ownershipToken: required(values, 'ownership-token'),
    creationDate: required(values, 'creation-date'),
  })
  await writeRecord(path, record)
  process.stdout.write(`${JSON.stringify(record)}\n`)
} else if (command === 'read') {
  const record = validate(JSON.parse(await readFile(path, 'utf8')), true)
  process.stdout.write(`${JSON.stringify(record)}\n`)
} else if (command === 'migrate') {
  const observed = validate(JSON.parse(await readFile(path, 'utf8')), true)
  const expected = {
    pid: Number(required(values, 'expected-pid')),
    port: Number(required(values, 'expected-port')),
    xsRoot: required(values, 'expected-xs-root'),
    dshRoot: required(values, 'expected-dsh-root'),
    creationDate: required(values, 'expected-creation-date'),
  }
  if (!observed.legacy
    || observed.pid !== expected.pid || observed.port !== expected.port
    || observed.xsRoot !== expected.xsRoot || observed.dshRoot !== expected.dshRoot
    || observed.creationDate !== expected.creationDate) {
    throw new Error('legacy process ownership changed before migration')
  }
  const record = validate({
    schema: SCHEMA,
    ...expected,
    runtimeIdentity: required(values, 'runtime-identity'),
    ownershipToken: required(values, 'ownership-token'),
  })
  await writeRecord(path, record)
  process.stdout.write(`${JSON.stringify({ ...record, legacy: false })}\n`)
} else if (command === 'remove') {
  let record
  try {
    record = validate(JSON.parse(await readFile(path, 'utf8')), true)
  } catch (error) {
    if (error?.code === 'ENOENT') process.exit(0)
    throw error
  }
  const expectedPid = values.get('expected-pid')
  const expectedToken = values.get('expected-token')
  const expectedCreationDate = values.get('expected-creation-date')
  if (expectedPid !== undefined && record.pid !== Number(expectedPid)) throw new Error('process ownership PID changed before removal')
  if (expectedToken !== undefined && record.ownershipToken !== expectedToken) throw new Error('process ownership token changed before removal')
  if (expectedCreationDate !== undefined && record.creationDate !== expectedCreationDate) throw new Error('process ownership creation date changed before removal')
  if (expectedPid === undefined && expectedToken === undefined && expectedCreationDate === undefined) {
    throw new Error('process ownership removal requires an expected identity')
  }
  await rm(path)
} else {
  throw new Error('Usage: windows-process-owner.mjs <write|read|migrate|remove> --path <state> ...')
}
