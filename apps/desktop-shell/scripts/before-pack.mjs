import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertReleaseInputsSafe } from './verify-artifact.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** electron-builder hook: stop before app.asar/installer creation on private inputs. */
export default async function beforePack() {
  await assertReleaseInputsSafe(repositoryRoot)
}
