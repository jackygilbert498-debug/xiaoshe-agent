import assert from 'node:assert/strict'
import test from 'node:test'
import { createVerificationPolicy } from '../lib/index.js'

const policy = createVerificationPolicy()
const classify = (command, toolName = 'pwsh') => policy.classifyTool({ toolName, arguments: { command } })
const unknown = { mutation: true }
const codeMutation = { mutation: true, change: { kind: 'code', risk: 'medium' } }

for (const command of [
  'node -e "console.log([1].map(x => x))"',
  "node -e 'console.log(1 > 0)'",
  'node --input-type=module -e "const t=(name,fn)=>{try{console.log(fn())}catch(e){console.log(e.name)}}; t(\'edge\',()=>1);"',
  'node -e "console.log(\'literal Set-Content src/example.mjs\')"',
]) test(`quoted code remains unknown without inventing a code change: ${command}`, () => {
  assert.deepEqual(classify(command), unknown)
})

test('quoted operator text is data for an existing read command', () => {
  assert.deepEqual(classify('Write-Output "literal > output.txt"'), { mutation: false })
  assert.deepEqual(classify("Write-Output 'literal Set-Content src/a.ts'"), { mutation: false })
})

test('real redirection and writes still declare a code change', () => {
  for (const command of [
    'Write-Output "literal >" > output.txt',
    "Write-Output 'literal >' >> output.txt",
    'node -e "console.log(1 > 0)" 2> errors.txt',
    'Get-ChildItem -Force | Select-Object Mode,Length,Name > output.txt',
    'Get-Location; Set-Content -LiteralPath src/a.ts -Value changed',
    'Get-ChildItem -Force | Out-File listing.txt',
  ]) assert.deepEqual(classify(command), codeMutation, command)
})

test('malformed or dynamic quoted syntax is never promoted to read-only', () => {
  for (const command of [
    'Write-Output "unterminated > text',
    "Write-Output 'unterminated text",
    'Write-Output "$(Invoke-CustomOperation) > text"',
    'Write-Output "text`" > output.txt"',
    'node -e "require(\'node:fs\').writeFileSync(\'src/a.mjs\',\'changed\')"',
  ]) assert.equal(classify(command).mutation, true, command)
})

for (const command of [
  'Get-Location; Get-ChildItem -Force | Select-Object Mode,Length,Name',
  'get-location ; get-childitem -File -Force | select-object Name, Length',
  'Get-ChildItem -Directory; Get-Location',
  'Get-ChildItem | Select-Object -Property Name,FullName,LastWriteTime',
  'pwd; Get-ChildItem -Force | Select-Object Name, Mode, Length',
  'Get-ChildItem -Directory; PWD',
]) test(`bounded PowerShell inventory is observational: ${command}`, () => {
  assert.deepEqual(classify(command), { mutation: false })
  assert.deepEqual(classify(command, 'powershell'), { mutation: false })
  assert.deepEqual(classify(command, 'bash'), unknown, 'PowerShell grammar is not a cross-shell allowlist')
})

test('inventory grammar rejects unknown stages, expressions and extra execution syntax', () => {
  for (const command of [
    'Get-Location; Invoke-CustomOperation',
    'Get-Location; node -e "console.log(1)"',
    'Get-Location; npm test',
    'Get-ChildItem | Invoke-CustomOperation',
    'Get-ChildItem | Select-Object Name | Select-Object Name',
    'Get-ChildItem | Select-Object @{Name="X";Expression={Invoke-CustomOperation}}',
    'Get-ChildItem | Select-Object $properties',
    'Get-ChildItem | Select-Object *',
    'Get-ChildItem | Select-Object Name -OutVariable result',
    'Get-ChildItem -Force; Get-ChildItem -Path $(Invoke-CustomOperation)',
    'Get-Location; & Invoke-CustomOperation',
    'Get-ChildItem | Select-Object Name; exit 0',
    'Get-Location; Get-ChildItem `\n-Force',
    'Get-Location;\nGet-ChildItem',
    'Get-Location;;Get-ChildItem',
    'pwd; Invoke-CustomOperation',
    'pwd -Stack; Get-ChildItem',
    'pwd | Select-Object Path; Get-ChildItem',
    'Set-Alias pwd Invoke-CustomOperation; pwd; Get-ChildItem',
    'function pwd { Invoke-CustomOperation }; pwd; Get-ChildItem',
    'pwd; Get-ChildItem | Select-Object @{Name="x";Expression={Invoke-CustomOperation}}',
    Array(9).fill('pwd').join('; '),
    Array(9).fill('Get-Location').join('; '),
  ]) assert.deepEqual(classify(command), unknown, command)
})

for (const command of [
  "find . -exec sh -c 'printf changed > output.txt' sh {} +",
  "find . -execdir sh -c 'printf changed > output.txt' sh {} +",
  'git -c "core.fsmonitor=sh -c \'printf changed > output.txt\'" status',
  'git -c "diff.external=sh -c \'printf changed > output.txt\'" diff --ext-diff',
  "rg --pre sh '>' task.sh",
  "grep 'literal >' input.txt",
]) test(`masking a quoted write cue cannot promote another program to read-only: ${command}`, () => {
  assert.equal(classify(command, 'bash').mutation, true)
})

test('find effectful actions remain unknown even without a quoted write cue', () => {
  for (const action of ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']) {
    assert.equal(classify(`find . ${action} operation`, 'bash').mutation, true, action)
  }
})

test('search and Git delegation or output flags are not observational evidence', () => {
  for (const command of [
    'rg --pre process-file needle src',
    'rg --pre=process-file needle src',
    'git -c core.fsmonitor=program status',
    'git -ccore.fsmonitor=program status',
    'git --config-env=core.fsmonitor=COMMAND status',
    'git --exec-path=custom status',
    'git diff --ext-diff',
    'git show --textconv HEAD:src/a.ts',
    'git diff --output=changes.patch',
    'git diff --output changes.patch',
    'git --paginate log',
  ]) assert.equal(classify(command, 'bash').mutation, true, command)
})

test('Node verification mode must be its execution mode rather than a payload argument', () => {
  for (const command of [
    'node --eval "--test"',
    'node -e "console.log(1)" --test',
    'node --check --eval "console.log(1)"',
    'node -p "--test"',
    'node --import ./hook.mjs --test',
    'node --require ./hook.cjs --check src/a.js',
    'node --loader ./hook.mjs --test',
    'node --test --experimental-loader=./hook.mjs',
    'node script.mjs --check',
    'node script.mjs --test',
    'node script.mjs unrelated.test.mjs',
  ]) assert.equal(classify(command).mutation, true, command)
})

test('Node supports only plain syntax checks, explicit static test targets or one direct test file', () => {
  for (const command of [
    'node --run=arbitrary.test.mjs',
    'node --test --run=arbitrary.test.mjs',
    'node test/a.test.mjs --run=arbitrary',
    'node test/a.test.mjs custom-argument',
    'node --test --test-name-pattern=filtered',
    'node --test $targets',
    'node --check $target',
    'node --check src/a.js src/b.js',
  ]) assert.deepEqual(classify(command), unknown, command)
  for (const command of [
    'node --check "src/中文 file.js"',
    'node --test test/a.test.mjs test/b.spec.mjs',
    'node --test test/*.test.mjs',
    'node "test/中文 file.test.mjs"',
  ]) assert.deepEqual(classify(command), { mutation: false }, command)
})

test('Git branch flags must describe listing rather than editor or configuration actions', () => {
  for (const command of ['git branch --edit-description', 'git branch --unset-upstream', 'git branch -D', 'git branch --delete']) {
    assert.equal(classify(command).mutation, true, command)
  }
  for (const command of ['git branch', 'git branch --list', 'git branch --show-current', 'git branch -a', 'git branch -vv']) {
    assert.deepEqual(classify(command), { mutation: false }, command)
  }
})

test('package exec must identify the actual runner instead of matching a later argument', () => {
  for (const command of [
    'npm exec arbitrary-command tsc',
    'npm exec -- arbitrary-command jest',
    'npm exec --call arbitrary-command tsc',
    'npm exec -c arbitrary-command vitest',
    'npm exec tsc -c arbitrary-command',
    'npm exec tsc -carbitrary-command',
    'npm exec tsc -parbitrary-package',
    'npm exec --package arbitrary-package tsc',
    'pnpm exec arbitrary-command vitest',
    'yarn exec arbitrary-command jest',
    'bun x arbitrary-command mocha',
    'npx arbitrary-command tsc',
    'npx --call arbitrary-command tsc',
    'bunx arbitrary-command vitest',
  ]) assert.equal(classify(command).mutation, true, command)
})

test('simple reads and established project verification invocations remain supported', () => {
  for (const command of [
    'rg --files', 'rg needle src', "find . -type f -name '*.ts' -print",
    'git status --short', 'git --no-pager diff --check', 'git diff --no-ext-diff',
    'node --check src/a.js', 'node --test',
    'node --test test/a.test.mjs', 'node test/a.test.mjs',
    'npm test', 'npm.cmd test', 'npm run typecheck', 'npm run build',
    'npm exec -- tsc --noEmit', 'pnpm exec vitest run', 'npx tsc --noEmit',
  ]) assert.deepEqual(classify(command), { mutation: false }, command)
})
