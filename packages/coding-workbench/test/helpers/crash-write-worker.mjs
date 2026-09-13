import { readFile } from 'node:fs/promises'
import { localAtomicFileIo } from '../../lib/atomic-file.js'
import { WorkbenchTransactionStore } from '../../lib/transactions.js'
import { ControlledFileWriter } from '../../lib/patch.js'
import { WorkspacePathPolicy } from '../../lib/path-policy.js'

// Isolated temporary-workspace crash fixture. No product service or model runs.
const input = JSON.parse(process.argv[2])
const pending = input.operation === 'confirm' ? 'applying' : 'reverting'
const final = input.operation === 'confirm' ? 'applied' : 'reverted'
const io = { ...localAtomicFileIo, async rename(from, to) {
  const state = to === input.ledger ? JSON.parse(await readFile(from, 'utf8')).transactions.find(row => row.id === input.id)?.state : undefined
  await localAtomicFileIo.rename(from, to)
  if (input.stage === 'file' && to === input.file || input.stage === 'intent' && state === pending || input.stage === 'final' && state === final) process.exit(71)
} }
const paths = new WorkspacePathPolicy({ list: () => [{ id: 'w1', path: input.root }] })
const writer = new ControlledFileWriter({ paths, store: new WorkbenchTransactionStore(input.ledger, 100, io), io })
if (input.operation === 'confirm') await writer.confirm(input.id, input.token)
else await writer.revert(input.id)
throw new Error('crash checkpoint was not reached')
