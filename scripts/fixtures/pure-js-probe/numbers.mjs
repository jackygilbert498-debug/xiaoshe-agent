export function sum(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'number')) throw new TypeError('expected numbers')
  return values.reduce((total, value) => total + value, 0)
}
