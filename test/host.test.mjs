import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDigest,
  messageSummary,
  sideMessages,
  streamText,
  systemPrompt,
  truncateChars,
} from '../index.js'

const CONFIG = { maxInputBytes: 24576, maxToolResultChars: 400 }

test('truncateChars 保尾截断', () => {
  assert.equal(truncateChars('abcdef', 10), 'abcdef')
  assert.equal(truncateChars('abcdef', 3), '…def')
  assert.equal(truncateChars('', 3), '')
})

test('messageSummary 提取文本并标记非文本块', () => {
  const toolNames = new Map()
  const summary = messageSummary({
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '思考内容不应出现' },
      { type: 'text', text: '先看一下配置' },
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
      { type: 'image', attachment: {} },
    ],
  }, 400, toolNames)
  assert.equal(summary.role, 'assistant')
  assert.match(summary.text, /先看一下配置/)
  assert.match(summary.text, /\[调用工具 bash/)
  assert.match(summary.text, /\[图片\]/)
  assert.ok(!summary.text.includes('思考内容'))
  assert.equal(toolNames.get('call-1'), 'bash')
})

test('messageSummary 工具结果配对工具名并截断', () => {
  const toolNames = new Map([['call-9', 'read']])
  const summary = messageSummary({
    role: 'tool',
    toolCallId: 'call-9',
    isError: false,
    content: [{ type: 'text', text: 'x'.repeat(900) }],
  }, 100, toolNames)
  assert.match(summary.text, /\[工具 read 结果\]/)
  assert.ok(summary.text.length < 200, `结果应被截断，实际 ${summary.text.length}`)
})

test('messageSummary 跳过 system/developer 与空消息', () => {
  assert.equal(messageSummary({ role: 'system', content: [{ type: 'text', text: 'sys' }] }, 400), undefined)
  assert.equal(messageSummary({ role: 'user', content: [] }, 400), undefined)
})

test('buildDigest 预算内全量保留', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '帮我看看这个报错' }] },
    { role: 'assistant', content: [{ type: 'text', text: '是配置里少了字段' }] },
  ]
  const digest = buildDigest(messages, CONFIG)
  assert.equal(digest.truncated, false)
  assert.equal(digest.entryCount, 2)
  assert.match(digest.text, /用户: 帮我看看这个报错/)
  assert.match(digest.text, /助手: 是配置里少了字段/)
})

test('buildDigest 超预算从旧的一侧省略并标记', () => {
  const big = '长'.repeat(3000)
  const messages = [
    { role: 'user', content: [{ type: 'text', text: `${big}旧问题` }] },
    { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
    { role: 'user', content: [{ type: 'text', text: '新问题' }] },
  ]
  const digest = buildDigest(messages, { ...CONFIG, maxInputBytes: 2048 })
  assert.equal(digest.truncated, true)
  assert.match(digest.text, /用户: 新问题/)
  assert.ok(!digest.text.includes('旧问题'), '最早的超预算条目应被省略')
})

test('buildDigest 空历史返回空摘要', () => {
  const digest = buildDigest([], CONFIG)
  assert.equal(digest.text, '')
  assert.equal(digest.entryCount, 0)
})

test('sideMessages 顺序：摘要 → 历史侧问 → 本次问题', () => {
  const digest = { text: '参考记录', truncated: true }
  const exchanges = [{ question: 'q1', answer: 'a1' }]
  const messages = sideMessages(digest, exchanges, 'session-abcdef1234', 'q2')
  assert.equal(messages.length, 4)
  assert.equal(messages[0].role, 'user')
  assert.match(messages[0].content[0].text, /早期内容已因长度省略/)
  assert.match(messages[0].content[0].text, /参考记录/)
  assert.equal(messages[1].content[0].text, 'q1')
  assert.equal(messages[2].role, 'assistant')
  assert.equal(messages[2].content[0].text, 'a1')
  assert.equal(messages[3].content[0].text, 'q2')
  for (const message of messages) {
    assert.equal(message.source.kind, 'dsh-side-chat')
    assert.ok(typeof message.id === 'string' && message.id.startsWith('side-'))
  }
})

test('systemPrompt 含附加指令', () => {
  assert.match(systemPrompt({ systemExtra: '' }), /没有任何工具/)
  assert.match(systemPrompt({ systemExtra: '回答用中文' }), /回答用中文/)
})

test('streamText 聚合增量并回调', async () => {
  const chunks = [
    { type: 'reasoning-delta', text: '思考' },
    { type: 'text-delta', text: '答案是 ' },
    { type: 'text-delta', text: '42' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const seen = []
  const result = await streamText({ stream: () => (async function* () { yield* chunks })() }, {}, (delta) => seen.push(delta))
  assert.equal(result.text, '答案是 42')
  assert.equal(result.truncated, false)
  assert.deepEqual(seen, ['答案是 ', '42'])
})

test('streamText 截断但有正文时降级成功', async () => {
  const chunks = [
    { type: 'text-delta', text: '部分答案' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  const result = await streamText({ stream: () => (async function* () { yield* chunks })() }, {})
  assert.equal(result.text, '部分答案')
  assert.equal(result.truncated, true)
})

test('streamText 空正文失败时抛错', async () => {
  const chunks = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }]
  await assert.rejects(
    streamText({ stream: () => (async function* () { yield* chunks })() }, {}),
    /boom/,
  )
})
