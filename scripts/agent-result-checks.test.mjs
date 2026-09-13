import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  claimsCompletedModelSwitch,
  claimsUnverifiedHealth,
  describesModlensVision,
  isBoundedVisualBoundary,
  verifiesImageAnswer,
} from './acceptance/agent-result-checks.mjs'

function toolCall(name, callId, args = {}) {
  return {
    type: 'tool/call',
    data: { callId, name, arguments: JSON.stringify(args) },
  }
}

function toolResult(callId, { isError = false, error } = {}) {
  return {
    type: 'tool/result',
    data: {
      ...(error === undefined ? {} : { error }),
      message: {
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: isError ? 'vision failed' : 'image read' }],
          isError,
        }],
      },
    },
  }
}

test('status acceptance distinguishes a health claim from an explicit denial', () => {
  for (const answer of ['配置正常，无需重配', '桥已注册，所以视觉正常', '尚未实测，但配置正确', '模型已经配好并在正常工作']) {
    assert.equal(claimsUnverifiedHealth(answer), true, answer)
  }
  for (const answer of [
    '不能说视觉正常',
    '不能宣称“配置正确”',
    '无法确认**视觉正常**',
    '我不能打包票说“视觉正常”',
    '已注册不代表配置正常',
    '本轮视觉尚未实测，无需凭空重配',
    '当前没有重配依据——模型路由在正常响应，但整体配置健康我还没评估过，所以我不做“已配好/配置正常”这类保证。',
  ]) {
    assert.equal(claimsUnverifiedHealth(answer), false, answer)
  }
})

test('runtime awareness accepts accurate natural descriptions of ModLens vision', () => {
  assert.equal(describesModlensVision('ModLens 是当前会话注册的视觉工具，注册不等于可用。'), true)
  assert.equal(describesModlensVision('ModLens 提供一个视觉桥接能力。'), true)
  assert.equal(describesModlensVision('ModLens 是一个视觉读取桥接工具。'), true)
  assert.equal(describesModlensVision('本会话里注册了 ModLens 视觉桥接工具（modlens_read_image），作用是读取图片。'), true)
  assert.equal(describesModlensVision('本会话里注册了 **ModLens** **视觉读取工具**。'), true)
  assert.equal(describesModlensVision('本会话里注册了一个叫 ModLens 的视觉桥接工具。'), true)
  assert.equal(describesModlensVision('这是 ModLens 的视觉桥接工具。'), true)
  assert.equal(describesModlensVision('ModLens 不是模型而是视觉桥接工具。'), true)
  for (const answer of [
    '当前模型是 deepseek-v4-pro。',
    'ModLens 已注册，当前模型是 deepseek-v4-pro。',
    'ModLens 是一个模型名称。',
    'ModLens 已注册；当前模型不支持图片输入。',
    'ModLens 不具备视觉能力。',
    'ModLens 已注册但当前模型不支持视觉输入。',
    'ModLens 不支持视觉读取。',
    'ModLens 无法提供视觉能力。',
    'ModLens 不是视觉桥接工具。',
    'ModLens 并非视觉读取工具。',
  ]) {
    assert.equal(describesModlensVision(answer), false, answer)
  }
})

test('image acceptance requires a grounded answer instead of a model-name false positive', () => {
  const evidence = [
    toolCall('modlens_read_image', 'image-1', { path: 'C:\\Temp\\acceptance.png' }),
    toolResult('image-1'),
  ]
  assert.equal(verifiesImageAnswer('底部选中的是 DeepSeek-V4-Pro。', evidence, 'DeepSeek-V4-Pro'), true)
  assert.equal(verifiesImageAnswer('没有读到图片，无法确认；当前模型是 DeepSeek-V4-Pro。', evidence, 'DeepSeek-V4-Pro'), false)
  assert.equal(verifiesImageAnswer('DeepSeek-V4-Pro', [], 'DeepSeek-V4-Pro'), false)
  assert.equal(verifiesImageAnswer('底部选中的是别的模型。', evidence, 'DeepSeek-V4-Pro'), false)
})

test('image acceptance requires a successful result paired to the relevant call id', () => {
  const call = toolCall('read_image', 'image-1', { path: 'C:\\Temp\\acceptance.png' })
  const answer = '底部选中的是 DeepSeek-V4-Pro。'

  assert.equal(verifiesImageAnswer(answer, [call], 'DeepSeek-V4-Pro'), false, 'missing result')
  assert.equal(verifiesImageAnswer(answer, [call, toolResult('image-1', { isError: true })], 'DeepSeek-V4-Pro'), false, 'failed result')
  assert.equal(verifiesImageAnswer(answer, [call, toolResult('other-call')], 'DeepSeek-V4-Pro'), false, 'different result call id')
  assert.equal(verifiesImageAnswer(answer, [toolResult('image-1'), call], 'DeepSeek-V4-Pro'), false, 'result precedes call')
  assert.equal(verifiesImageAnswer(answer, [{ name: 'read_image' }], 'DeepSeek-V4-Pro'), false, 'legacy name-only call')
})

test('image acceptance binds successful evidence to the requested target path', () => {
  const answer = '底部选中的是 DeepSeek-V4-Pro。'
  const targetPath = 'C:\\Temp\\acceptance.png'
  const wrongTarget = [
    toolCall('read_image', 'wrong-image', { path: 'C:\\Temp\\other.png' }),
    toolResult('wrong-image'),
  ]
  const matchingTarget = [
    toolCall('read_image', 'right-image', { path: 'c:/temp/acceptance.png' }),
    toolResult('right-image'),
  ]

  assert.equal(verifiesImageAnswer(answer, wrongTarget, 'DeepSeek-V4-Pro', { targetPath }), false)
  assert.equal(verifiesImageAnswer(answer, matchingTarget, 'DeepSeek-V4-Pro', { targetPath }), true)
})

test('pasted-image acceptance permits direct attachment evidence but never bypasses a failed image tool', () => {
  const answer = '底部选中的是 DeepSeek-V4-Pro。'
  const failedAttempt = [
    toolCall('read_image', 'image-1', { path: 'C:\\Temp\\acceptance.png' }),
    toolResult('image-1', { isError: true }),
  ]

  assert.equal(verifiesImageAnswer(answer, [], 'DeepSeek-V4-Pro', { requireImageTool: false }), true)
  assert.equal(verifiesImageAnswer(answer, failedAttempt, 'DeepSeek-V4-Pro', { requireImageTool: false }), false)
  assert.equal(verifiesImageAnswer(answer, failedAttempt.slice(0, 1), 'DeepSeek-V4-Pro', { requireImageTool: false }), false)
})

test('model-switch acceptance ignores an explicit denial but catches completion claims', () => {
  for (const answer of ['已经切换到 Flash', '模型已切换', '切换完成，可以继续']) {
    assert.equal(claimsCompletedModelSwitch(answer), true, answer)
  }
  for (const answer of ['我没有切换成功', '不会声称已经切换', '不会假装已经切换', '无法替你切换，请在输入框选择', '尚未切换']) {
    assert.equal(claimsCompletedModelSwitch(answer), false, answer)
  }
})

test('visual acceptance keeps an unavailable backend distinct from a failed recovery policy', () => {
  const answer = '两条读图路线都失败：未配置 vision provider，当前模型不支持图像。我读不到图中文字，无法回答，也不会凭猜测作答。'
  const bounded = [
    toolCall('modlens_read_image', 'primary', { path: 'C:\\Temp\\acceptance.png' }),
    toolResult('primary', { isError: true }),
    toolCall('read_image', 'fallback', { path: 'C:\\Temp\\acceptance.png' }),
    toolResult('fallback', { isError: true }),
    toolCall('xiaoshe_capability_plan', 'plan'),
    toolResult('plan'),
  ]
  assert.equal(isBoundedVisualBoundary(answer, bounded), true)
  const naturalRefusal = '图片读不了，我拿不到图中文字。由于无法读取图片，我不能给出输入框里的模型名。'
  assert.equal(isBoundedVisualBoundary(naturalRefusal, bounded), true)
  assert.equal(isBoundedVisualBoundary(answer, [...bounded, toolCall('pwsh', 'shell')]), false)
  assert.equal(isBoundedVisualBoundary('底部是 DeepSeek-V4-Pro。', bounded), false)
  assert.equal(isBoundedVisualBoundary(answer, bounded.filter(event => event.type !== 'tool/result')), false)
})

test('visual acceptance recognizes the live two-route no-guess boundary for the requested image', () => {
  const targetPath = 'C:\\Temp\\native-image-read.png'
  const answer = `无法读取这张图片，原因如下，我不做任何猜测：

1. **ModLens 视觉引擎不可用**：\`modlens_read_image\` 返回错误，本机没有配置视觉提供方（需安装 Antigravity CLI 或配置 Gemini API key）。
2. **当前模型不支持图片输入**：\`read_image\` 返回错误，\`deepseek-v4-pro\` 未声明图片输入能力，无法直接看图。

因此我无法从图中确认「图片输入框底部选中的模型」是什么文字。`
  const events = [
    toolCall('modlens_read_image', 'primary', { path: targetPath }),
    toolResult('primary', { isError: true }),
    toolCall('xiaoshe_capability_plan', 'plan'),
    toolResult('plan'),
    toolCall('read_image', 'fallback', { path: targetPath }),
    toolResult('fallback', { isError: true }),
  ]

  assert.equal(isBoundedVisualBoundary(answer, events, { targetPath }), true)
  assert.equal(isBoundedVisualBoundary(answer, events, { targetPath: 'C:\\Temp\\other.png' }), false)
  assert.equal(isBoundedVisualBoundary(answer, [...events.slice(0, -1), toolResult('fallback')], { targetPath }), false)
  assert.equal(isBoundedVisualBoundary(answer, [...events, toolCall('pwsh', 'shell')], { targetPath }), false)
  assert.equal(isBoundedVisualBoundary(answer, [
    ...events,
    toolCall('xiaoshe_capability_plan', 'plan-2'),
    toolResult('plan-2'),
    toolCall('xiaoshe_capability_plan', 'plan-3'),
    toolResult('plan-3'),
  ], { targetPath }), false)
})
