import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadClient() {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(
    `${source}\nexport { renderSessionButton as testOnlySessionRow, sessionMoveTargets as testOnlyMoveTargets }\n`,
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
  return await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

/**
 * React-like factory returning a plain node tree. The sidebar menu is pure
 * event wiring over props, so menu behavior stays testable without a DOM or a
 * bundled renderer.
 */
function elementFactory() {
  return (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter(child => child !== null && child !== undefined),
  })
}

function findMenu(node) {
  if (node === null || typeof node !== 'object') return undefined
  if (node.props?.className === 'side-action-menu') return node
  for (const child of node.children ?? []) {
    const found = findMenu(child)
    if (found !== undefined) return found
  }
  return undefined
}

function menuItems(node) {
  const menu = findMenu(node)
  if (menu === undefined) return []
  return menu.children.map(item => ({ label: item.children[0], click: item.props.onClick }))
}

function labels(node) {
  return menuItems(node).map(item => item.label)
}

const workspaces = [
  { workspaceId: 'w-a', path: '/proj/a', title: '项目 A', sessionIds: ['s1'] },
  { workspaceId: 'w-b', path: '/proj/b', title: '项目 B', sessionIds: [] },
]

function sidebarOptions(overrides = {}) {
  return {
    currentId: 's1',
    status: 'idle',
    onOpen() {},
    workspaces,
    sideMenu: undefined,
    sideEdit: undefined,
    sideMutation: undefined,
    sideMove: undefined,
    onMenu() {},
    onBeginEdit() {},
    onEditValue() {},
    onCommitEdit() {},
    onCancelEdit() {},
    onBeginMove() {},
    onMoveTo() {},
    onRemove() {},
    ...overrides,
  }
}

test('move targets exclude the project the session already belongs to', async () => {
  const { testOnlyMoveTargets } = await loadClient()
  assert.deepEqual(testOnlyMoveTargets(workspaces, '/proj/a'), [{ workspaceId: 'w-b', title: '项目 B' }])
  assert.deepEqual(testOnlyMoveTargets(workspaces, '/proj/b'), [{ workspaceId: 'w-a', title: '项目 A' }])
  assert.deepEqual(testOnlyMoveTargets(workspaces, undefined), [
    { workspaceId: 'w-a', title: '项目 A' },
    { workspaceId: 'w-b', title: '项目 B' },
  ])
  assert.deepEqual(testOnlyMoveTargets([], undefined), [], 'no registered project means no move target')
  assert.deepEqual(testOnlyMoveTargets(workspaces, '/proj/a').map(target => target.title), ['项目 B'],
    'registry order is preserved')
})

test('session menu offers the move step, then submits the chosen project', async () => {
  const { testOnlySessionRow } = await loadClient()
  const e = elementFactory()
  let sideMenu
  let sideMove
  const moves = []
  const draw = () => testOnlySessionRow(
    e,
    { sessionId: 's1', title: '定时推送', cwd: '/proj/a', updatedAt: 1 },
    sidebarOptions({
      sideMenu,
      sideMove,
      onMenu: target => { sideMenu = target; draw() },
      onBeginMove(target) { sideMove = target; draw() },
      onMoveTo: (sessionId, workspaceId) => moves.push({ sessionId, workspaceId }),
    }),
  )

  // The trigger button opens the row menu with the move entry between rename
  // and archive, without leaking the target list before the step is entered.
  const opened = draw()
  assert.deepEqual(labels(opened), [], 'a closed row renders no menu')
  const trigger = opened.children.find(child => child?.props?.className?.includes('session-menu-trigger'))
  trigger.props.onClick()
  assert.deepEqual(labels(draw()), ['重命名会话', '移入项目…', '归档并移出列表'])

  // Entering the step replaces the action list with the eligible project.
  menuItems(draw()).find(item => item.label === '移入项目…').click()
  const step = menuItems(draw())
  assert.deepEqual(step.map(item => item.label), ['移入「项目 B」'])
  assert.equal(findMenu(draw()).props['aria-label'], '定时推送 会话操作', 'the step keeps the row menu label')

  step[0].click()
  assert.deepEqual(moves, [{ sessionId: 's1', workspaceId: 'w-b' }])
})

test('the move entry is absent when no other project can receive the session', async () => {
  const { testOnlySessionRow } = await loadClient()
  const e = elementFactory()
  const node = testOnlySessionRow(
    e,
    { sessionId: 's1', title: '定时推送', cwd: '/proj/a', updatedAt: 1 },
    sidebarOptions({ workspaces: [workspaces[0]], sideMenu: { kind: 'session', id: 's1', title: '定时推送' } }),
  )
  assert.deepEqual(labels(node), ['重命名会话', '归档并移出列表'])
})

test('an ungrouped session can move into every registered project', async () => {
  const { testOnlySessionRow } = await loadClient()
  const e = elementFactory()
  let sideMove
  const node = testOnlySessionRow(
    e,
    { sessionId: 'loose', title: '临时', updatedAt: 1 },
    sidebarOptions({
      sideMenu: { kind: 'session', id: 'loose', title: '临时' },
      sideMove,
      onBeginMove(target) { sideMove = target },
    }),
  )
  menuItems(node).find(item => item.label === '移入项目…').click()
  assert.equal(sideMove.id, 'loose')
  assert.equal(sideMove.kind, 'session')

  const stepped = testOnlySessionRow(
    e,
    { sessionId: 'loose', title: '临时', updatedAt: 1 },
    sidebarOptions({ sideMenu: { kind: 'session', id: 'loose', title: '临时' }, sideMove }),
  )
  assert.deepEqual(labels(stepped), ['移入「项目 A」', '移入「项目 B」'])
})

test('another session pending a move never hijacks this row menu', async () => {
  const { testOnlySessionRow } = await loadClient()
  const e = elementFactory()
  const node = testOnlySessionRow(
    e,
    { sessionId: 's1', title: '定时推送', cwd: '/proj/a', updatedAt: 1 },
    sidebarOptions({
      sideMenu: { kind: 'session', id: 's1', title: '定时推送' },
      sideMove: { kind: 'session', id: 's-other', title: '别处' },
    }),
  )
  assert.deepEqual(labels(node), ['重命名会话', '移入项目…', '归档并移出列表'])
})
