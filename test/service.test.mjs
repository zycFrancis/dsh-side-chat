import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SideChatService, { buildDigest } from '../index.js'

/** 真实 cordis Context + mock 服务面：commands 注册表与 llm 流可控。 */
function makeContext() {
  const ctx = new Context()
  const effects = []
  const registeredCommands = new Map()
  ctx.effects = effects
  ctx.registeredCommands = registeredCommands
  ctx.logger = { warn: () => {}, info: () => {} }
  ctx.effect = (fn, label) => {
    const dispose = fn()
    effects.push({ dispose, label })
  }
  ctx.commands = {
    register(definition) {
      registeredCommands.set(definition.name, definition)
      return () => registeredCommands.delete(definition.name)
    },
  }
  ctx.llm = {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
    stream: () => (async function* () {
      yield { type: 'text-delta', text: '那个文件是 ' }
      yield { type: 'text-delta', text: 'dsh.config.yaml' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  ctx.agentDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'glm-air' }) }
  return ctx
}

/** 假会话：deriveMessages 返回固定历史，requestHeader 提供路由。 */
function makeAgent() {
  return {
    session: {
      id: 'sess-smoke-0001',
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: '帮我配一下模型路由' }] },
        { role: 'assistant', content: [{ type: 'text', text: '改的是 dsh.config.yaml' }] },
      ],
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat-pro' } }),
    },
  }
}

test('服务冒烟：注册双命令并完成一次侧问', async () => {
  const ctx = makeContext()
  const service = new SideChatService(ctx, {})
  assert.deepEqual([...ctx.registeredCommands.keys()].sort(), ['btw', 'side'])
  const side = ctx.registeredCommands.get('side')
  assert.equal(side.recordInput, false, '问题文本不应落日志')

  const frames = []
  service.frameListeners.add((frame) => frames.push(frame))

  const controller = new AbortController()
  const result = await side.handler({
    agent: makeAgent(),
    rawInput: ' 那个配置文件叫什么来着？ ',
    signal: controller.signal,
  })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /dsh\.config\.yaml/)
  // 帧序列：start → delta*2 → done
  assert.equal(frames[0].t, 'start')
  assert.equal(frames[0].sessionId, 'sess-smoke-0001')
  assert.equal(frames[0].route.model, 'chat-pro', '路由应取会话请求头')
  assert.equal(frames.filter((f) => f.t === 'delta').length, 2)
  assert.equal(frames.at(-1).t, 'done')
  // 侧问已入内存态
  assert.equal(service.exchangesOf('sess-smoke-0001').length, 1)
})

test('空输入触发 reopen 帧', async () => {
  const ctx = makeContext()
  const service = new SideChatService(ctx, {})
  const frames = []
  service.frameListeners.add((frame) => frames.push(frame))
  const result = await ctx.registeredCommands.get('btw').handler({
    agent: makeAgent(),
    rawInput: '   ',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.equal(frames.at(-1).t, 'reopen')
})

test('clear 清空记忆并广播', async () => {
  const ctx = makeContext()
  const service = new SideChatService(ctx, {})
  service.exchanges.set('s1', [{ question: 'q', answer: 'a', at: 1 }])
  const frames = []
  service.frameListeners.add((frame) => frames.push(frame))
  service.clear('s1')
  assert.equal(service.exchangesOf('s1').length, 0)
  assert.deepEqual(frames.map((f) => f.t), ['cleared'])
})

test('follow 流：先快照后增量', async () => {
  const ctx = makeContext()
  const service = new SideChatService(ctx, {})
  service.exchanges.set('s1', [{ question: 'q0', answer: 'a0', at: 1 }])
  const controller = new AbortController()
  const iterator = service.follow('s1', controller.signal)
  const first = await iterator.next()
  assert.equal(first.value.t, 'snapshot')
  assert.equal(first.value.exchanges.length, 1)
  service.emit('s1', { t: 'delta', text: 'hi' })
  service.emit('s2', { t: 'delta', text: '别家会话的帧' })
  const second = await iterator.next()
  assert.equal(second.value.t, 'delta')
  assert.equal(second.value.text, 'hi')
  controller.abort()
  await service.exchanges.clear()
})

test('llm 失败时返回 error 结果并派 error 帧', async () => {
  const ctx = makeContext()
  ctx.llm.stream = () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota' } } }
  })()
  const service = new SideChatService(ctx, {})
  const frames = []
  service.frameListeners.add((frame) => frames.push(frame))
  const result = await ctx.registeredCommands.get('side').handler({
    agent: makeAgent(),
    rawInput: '问题',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /quota/)
  assert.equal(frames.at(-1).t, 'error')
  assert.equal(service.exchanges.size, 0, '失败侧问不入记忆')
})

test('digest 冒烟：deriveMessages 内容进入参考摘要', () => {
  const digest = buildDigest(makeAgent().session.deriveMessages(), { maxInputBytes: 8192, maxToolResultChars: 400 })
  assert.match(digest.text, /dsh\.config\.yaml/)
})
