import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shellOutputWrites } from '../dist/plugins/shell-output-effects.js'

test('output syntax keeps quoted program text separate from filesystem targets', () => {
  for (const command of [
    'find . -name "*.css" 2>/dev/null | head -50',
    'grep "x > y" app.css 2>&1',
    'python3 -c "print(\'accent ->\', 2 > 1)"',
    'python3 - <<\'PY\'\nprint("accent ->", 2 > 1)\nPY',
  ]) assert.deepEqual(shellOutputWrites(command), { targets: [], unresolved: false }, command)
  assert.deepEqual(shellOutputWrites('echo ok > "a file.txt" 2>/dev/null'), { targets: ['a file.txt'], unresolved: false })
  assert.deepEqual(shellOutputWrites('cat <<\'EOF\' > out.html\n<p>a > b</p>\nEOF\necho x >> audit.log'), { targets: ['out.html', 'audit.log'], unresolved: false })
  for (const command of ['echo x > "$target"', 'echo "$(touch outside.txt)"', 'echo x >', 'echo `touch outside.txt`']) {
    assert.equal(shellOutputWrites(command).unresolved, true, command)
  }
})
