/** Shell output syntax only, not a claim that an arbitrary program is harmless.
 * Quoted program text is opaque; explicit user restrictions still govern scripts.
 * Keep PowerShell cmdlet effects in the caller, separate from shell redirection.
 */
export function shellOutputWrites(command: string): { targets: string[]; unresolved: boolean } {
  if (command.length > 131_072) return { targets: [], unresolved: true }
  const targets: string[] = []
  let unresolved = false
  let quote = ''
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]!
    if (c === '\\' && quote !== "'") { i += 1; continue }
    if (quote) {
      if (quote !== "'" && (c === '`' || (c === '$' && command[i + 1] === '('))) unresolved = true
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { if (c === '`') unresolved = true; quote = c; continue }
    // A heredoc body is program input, not shell output syntax. Unknown bodies
    // must not manufacture a target from Python comparisons or printed arrows.
    if (command.startsWith('<<', i) && !command.startsWith('<<<', i)) {
      const here = /^<<(-)?\s*(['"]?)([\w-]+)\2/u.exec(command.slice(i))
      if (here) {
        const lineEnd = command.indexOf('\n', i)
        if (lineEnd >= 0) {
          const lines = command.slice(lineEnd + 1).split('\n')
          let consumed = lineEnd + 1
          for (const line of lines) {
            consumed += line.length + 1
            if (!here[2] && /\$\(|`/u.test(line)) unresolved = true
            if ((here[1] ? line.replace(/^\t+/u, '') : line) === here[3]) {
              // Inspect trailing output redirection on the heredoc command.
              const tail = shellOutputWrites(command.slice(i + here[0].length, lineEnd))
              targets.push(...tail.targets); unresolved ||= tail.unresolved
              i = consumed - 1
              break
            }
          }
          if (i >= lineEnd) continue
        }
      }
    }
    if (c !== '>') continue
    if (command[i + 1] === '>') i += 1
    // Descriptor duplication writes no file: 2>&1, >&2, 1>&-.
    const duplicate = /^&(?:\d+|-)(?=$|[\s;&|])/u.exec(command.slice(i + 1))
    if (duplicate) { i += duplicate[0].length; continue }
    const operand = /^\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>]+))/u.exec(command.slice(i + 1))
    if (!operand) { unresolved = true; continue }
    const value = operand[1] ?? operand[2] ?? operand[3]!
    if (!value || /[$`*?]/u.test(value) || (operand[2] !== undefined && value.includes('\\'))) unresolved = true
    else if (value !== '/dev/null') targets.push(value)
    i += operand[0].length
  }
  return { targets, unresolved }
}
