import test from 'node:test'
import assert from 'node:assert/strict'

/** ESM 模块体只执行一次：单例加载，测试各自重置 store。 */
let clientModule = null
async function loadClientModule() {
  if (clientModule !== null) return clientModule
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry } } }
  globalThis.document = {
    head: { appendChild: () => {} },
    createElement: () => ({ textContent: '', remove: () => {} }),
  }
  await import('../client.js')
  const reactStub = {
    createElement: (tag, props, ...children) => ({ tag, props: props ?? {}, children }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }
  const modules = {
    'react': reactStub,
    'react/jsx-runtime': { jsx: reactStub.createElement, jsxs: reactStub.createElement },
    '@deepseek-ai/dsh-api-gateway/client': {
      RemoteStreamCarrierError: class RemoteStreamCarrierError extends Error {},
    },
  }
  if (captured === null) throw new Error('client.js 未向 ModuleLoader 注册')
  assert.equal(captured.id, 'dsh-side-chat', '模块 id 必须等于包名')
  clientModule = captured.factory((id) => {
    if (!(id in modules)) throw new Error(`测试未提供模块 ${id}`)
    return modules[id]
  })
  return clientModule
}

const INITIAL_STATE = {
  sessionId: null,
  open: false,
  phase: 'idle',
  question: '',
  answer: '',
  error: '',
  truncated: false,
  exchanges: [],
  historyIndex: -1,
  copied: false,
  route: null,
}

function resetStore(store) {
  store.setState({ ...INITIAL_STATE })
}

test('描述符满足客户端 $mount 校验规则', async () => {
  const mod = await loadClientModule()
  const { TYPERT_REMOTE } = mod.__test
  assert.equal(TYPERT_REMOTE.package, 'dsh-side-chat')
  const endpoints = new Set()
  for (const descriptor of TYPERT_REMOTE.descriptors) {
    assert.ok(descriptor.id.length > 0)
    assert.equal(typeof descriptor.service, 'string')
    assert.equal(typeof descriptor.namespace, 'string')
    assert.equal(typeof descriptor.method, 'string')
    assert.deepEqual(descriptor.invocation, { kind: 'direct' })
    const endpoint = `${descriptor.namespace}/${descriptor.method}`
    assert.ok(!endpoints.has(endpoint), `端点重复 ${endpoint}`)
    endpoints.add(endpoint)
    const wires = new Set()
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict', '客户端要求 strict codec')
      assert.equal(typeof parameter.codec.create, 'function', 'strict codec 需要 create()')
      assert.ok(parameter.codec.typeSymbol.length > 0)
      assert.ok(!wires.has(parameter.wire))
      wires.add(parameter.wire)
      assert.equal(parameter.source, 'json')
    }
    assert.equal(descriptor.result.mode, 'strict')
    assert.equal(typeof descriptor.result.create, 'function')
    if (descriptor.cancellation !== undefined) assert.equal(descriptor.cancellation.parameter, 'signal')
  }
  assert.deepEqual([...endpoints].sort(), ['sideChat/clear', 'sideChat/follow'])
  const follow = TYPERT_REMOTE.descriptors.find((d) => d.method === 'follow')
  assert.equal(follow.mode, 'stream', 'follow 必须是流式')
  assert.deepEqual(follow.parameters.map((p) => p.wire), ['sessionId'])
})

test('帧归约：start/delta/done 流程与 reopen 展示最新', async () => {
  const mod = await loadClientModule()
  const { store, applyFrame } = mod.__test
  resetStore(store)
  applyFrame({ t: 'start', question: '配置文件名?', route: { provider: 'p', model: 'm' } })
  let s = store.getSnapshot()
  assert.equal(s.phase, 'streaming')
  assert.equal(s.open, true)
  applyFrame({ t: 'delta', text: 'dsh.' })
  applyFrame({ t: 'delta', text: 'config.yaml' })
  s = store.getSnapshot()
  assert.equal(s.answer, 'dsh.config.yaml')
  applyFrame({ t: 'done', answer: 'dsh.config.yaml', truncated: false })
  s = store.getSnapshot()
  assert.equal(s.phase, 'done')
  assert.equal(s.exchanges.length, 1)

  // 状态引用必须更换（useSyncExternalStore 依赖）
  const before = s
  applyFrame({ t: 'delta', text: 'x' })
  assert.notEqual(store.getSnapshot(), before, 'setState 必须换新对象')

  // reopen：无进行中的侧问时展示最新一组
  applyFrame({ t: 'reopen', exchanges: [
    { question: 'q1', answer: 'a1' },
    { question: 'q2', answer: 'a2' },
  ] })
  s = store.getSnapshot()
  assert.equal(s.open, true)
  assert.equal(s.phase, 'idle')
  // currentExchange 行为通过渲染间接验证：这里直接检查 exchanges 与 historyIndex
  assert.equal(s.historyIndex, -1)
  assert.equal(s.exchanges.length, 2)
})

test('帧归约：error 与 cleared', async () => {
  const mod = await loadClientModule()
  const { store, applyFrame } = mod.__test
  resetStore(store)
  applyFrame({ t: 'error', message: 'boom' })
  assert.equal(store.getSnapshot().phase, 'error')
  assert.match(store.getSnapshot().error, /boom/)
  applyFrame({ t: 'cleared' })
  const s = store.getSnapshot()
  assert.equal(s.open, false)
  assert.equal(s.exchanges.length, 0)
})

test('renderText：围栏代码块、行内代码、粗体与列表', async () => {
  const mod = await loadClientModule()
  const { renderText } = mod.__test
  const blocks = renderText('看 `dsh.config.yaml` 与 **路由**：\n\n- 甲\n- 乙\n\n```js\nfoo()\n```')
  const tags = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node === 'string') {
      tags.push(`"${node}"`)
      return
    }
    if (node && typeof node === 'object') {
      tags.push(node.tag)
      walk(node.children)
      walk(node.props?.children)
    }
  }
  walk(blocks)
  const flat = tags.join(',')
  assert.ok(flat.includes('code'), '行内代码存在')
  assert.ok(flat.includes('strong'), '粗体存在')
  assert.ok(flat.includes('ul'), '列表存在')
  assert.ok(flat.includes('pre'), '代码块存在')
  assert.ok(flat.includes('foo()'), '代码块内容保留')
  // 语言行被剥掉
  assert.ok(!flat.includes('"js"'), '语言行不应成为代码内容')
})

test('apply 挂载：$mount 收到描述符且 slots 注册齐全', async () => {
  const mod = await loadClientModule()
  const slotRegistrations = []
  const fakeCtx = {
    remote: {
      $mount: async (contribution) => {
        assert.equal(contribution.package, 'dsh-side-chat')
        assert.ok(contribution.descriptors.length >= 2)
        return async () => {}
      },
    },
    inject: (services, fn) => {
      assert.ok(services.includes('remote.sideChat'))
      const uiCtx = {
        effect: (fn2) => {
          fn2()
          return () => {}
        },
        locale: { register: () => () => {} },
        slots: {
          inject: (ownerKey, register) => {
            slotRegistrations.push({ ownerKey, register })
          },
        },
      }
      const fiber = {
        dispose: async () => {},
        then: (onFulfilled, onRejected) => Promise.resolve().then(onFulfilled, onRejected),
      }
      try {
        fn(uiCtx)
      } catch (error) {
        return Object.assign(Promise.reject(error), { dispose: fiber.dispose })
      }
      return fiber
    },
  }
  await mod.apply(fakeCtx)
  const owners = slotRegistrations.map((r) => r.ownerKey).sort()
  assert.deepEqual(owners, [
    'conversation.chat.commandview',
    'conversation.chat.commandview',
    'conversation.composer.dock',
    'shell.overlay',
  ])
})

test('SessionBridge 渲染为空', async () => {
  const mod = await loadClientModule()
  assert.equal(mod.__test.SessionBridge({ sessionId: 's1' }), null)
})
