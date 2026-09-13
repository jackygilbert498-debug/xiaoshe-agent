import { sum } from './numbers.mjs'

export function summarize(values) {
  return { count: values.length, total: sum(values) }
}
