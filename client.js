/**
 * dsh-side-chat —— 侧问插件（Web 客户端半）。
 *
 * 结构：
 * - typert 远程描述符（内联，TYPERT_REMOTE）：挂载 ctx.remote.sideChat 的
 *   follow 流与 clear 调用。宿主侧由 Gateway 的 SRC 发现从服务原型标记 +
 *   函数签名自动推参，无需宿主贡献；客户端 $mount 要求 strict codec，
 *   create() 只在 schema 物化（inspect/文档）时被消费，运行时参数直传
 *   JSON、结果 passthrough，故给出最小占位实现。
 * - SessionBridge：挂在 conversation.composer.dock（session 范围）的空渲染
 *   组件，拿到 sessionId 后打开 follow 流，把帧写进模块级 store。
 * - SideOverlay：挂在 shell.overlay（root 范围）的浮层，流式展示答案；
 *   Esc/点击背景关闭，c 复制，x 清空记录，[/]/Shift+方向键 翻历史侧问。
 * - SideCommandRow：conversation.chat.commandview（key: side/btw）的低调
 *   标记行，替代默认整段答案卡片。
 */
window.__ModuleLoader__.load({
  id: 'dsh-side-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { RemoteStreamCarrierError } = require('@deepseek-ai/dsh-api-gateway/client')

    const NS = 'dsh-side-chat'
    const inject = ['remote', 'slots', 'locale']

    // ---------- typert 远程描述符（与宿主 SRC 签名推参保持 wire 一致） ----------
    const looseSchema = () => Object.freeze({ type: 'object', additionalProperties: true })
    const TYPERT_REMOTE = {
      package: NS,
      descriptors: [
        {
          id: `${NS}#sideChat/follow`,
          service: 'sideChat',
          namespace: 'sideChat',
          method: 'follow',
          mode: 'stream',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'sessionId',
              wire: 'sessionId',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: `${NS}#SessionId`, create: looseSchema },
            },
          ],
          cancellation: { parameter: 'signal' },
          result: { mode: 'strict', typeSymbol: `${NS}#SideFrame`, create: looseSchema },
        },
        {
          id: `${NS}#sideChat/clear`,
          service: 'sideChat',
          namespace: 'sideChat',
          method: 'clear',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'sessionId',
              wire: 'sessionId',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: `${NS}#SessionId`, create: looseSchema },
            },
          ],
          result: { mode: 'strict', typeSymbol: `${NS}#ClearResult`, create: looseSchema },
        },
      ],
    }

    // ---------- 模块级状态 ----------
    function createStore() {
      const listeners = new Set()
      // useSyncExternalStore 依赖快照引用变化：setState 必须换新对象，
      // 原地修改会让 React 拿到相同引用而跳过重渲染。
      let state = {
        sessionId: null,
        open: false,
        phase: 'idle', // idle | streaming | done | error
        question: '',
        answer: '',
        error: '',
        truncated: false,
        exchanges: [],
        historyIndex: -1, // -1 = 当前/最新；>=0 = 浏览该下标的历史侧问
        copied: false,
      }
      const getSnapshot = () => state
      const setState = (patch) => {
        state = { ...state, ...patch }
        for (const listener of listeners) {
          try {
            listener()
          } catch {
            // 单个监听者异常不波及其余
          }
        }
      }
      return {
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot,
        setState,
      }
    }

    const store = createStore()
    /** 由 apply 注入的客户端上下文（remote 面），组件闭包经此访问。 */
    let runtime = null

    function currentExchange(snapshot) {
      if (snapshot.historyIndex >= 0 && snapshot.historyIndex < snapshot.exchanges.length) {
        return snapshot.exchanges[snapshot.historyIndex]
      }
      // reopen/idle 场景：没有进行中的侧问时展示最新一组
      if (snapshot.phase !== 'streaming' && snapshot.exchanges.length > 0) {
        return snapshot.exchanges[snapshot.exchanges.length - 1]
      }
      return { question: snapshot.question, answer: snapshot.answer }
    }

    /** 帧归约：把宿主 follow 帧折叠进 store。 */
    function applyFrame(frame) {
      if (frame === null || typeof frame !== 'object') return
      const snapshot = store.getSnapshot()
      switch (frame.t) {
        case 'snapshot':
          store.setState({ exchanges: Array.isArray(frame.exchanges) ? frame.exchanges : [] })
          break
        case 'reopen':
          store.setState({
            exchanges: Array.isArray(frame.exchanges) ? frame.exchanges : [],
            historyIndex: -1,
            open: true,
            phase: 'idle',
            question: '',
            answer: '',
            error: '',
          })
          break
        case 'start':
          store.setState({
            phase: 'streaming',
            question: String(frame.question ?? ''),
            answer: '',
            error: '',
            truncated: false,
            open: true,
            historyIndex: -1,
            copied: false,
            route: frame.route ?? null,
          })
          break
        case 'delta':
          store.setState({ answer: snapshot.answer + String(frame.text ?? '') })
          break
        case 'done': {
          const exchanges = [...snapshot.exchanges, {
            question: snapshot.question,
            answer: String(frame.answer ?? snapshot.answer),
            at: Date.now(),
          }]
          store.setState({
            phase: 'done',
            answer: String(frame.answer ?? snapshot.answer),
            truncated: frame.truncated === true,
            exchanges,
            historyIndex: -1,
          })
          break
        }
        case 'error':
          store.setState({ phase: 'error', error: String(frame.message ?? '未知错误'), open: true })
          break
        case 'cleared':
          store.setState({ exchanges: [], historyIndex: -1, open: false, phase: 'idle', question: '', answer: '', error: '' })
          break
        default:
          break
      }
    }

    // ---------- 轻量 Markdown（围栏代码块 / 行内代码 / 粗体 / 列表） ----------
    function inlineNodes(line, keyPrefix) {
      const nodes = []
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)/g
      let last = 0
      let match = null
      let index = 0
      while ((match = pattern.exec(line)) !== null) {
        if (match.index > last) nodes.push(line.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('`')) {
          nodes.push(h('code', { key: `${keyPrefix}-i${index}`, className: 'dshsc-inline-code' }, token.slice(1, -1)))
        } else {
          nodes.push(h('strong', { key: `${keyPrefix}-i${index}` }, token.slice(2, -2)))
        }
        last = match.index + token.length
        index += 1
      }
      if (last < line.length) nodes.push(line.slice(last))
      return nodes
    }

    function renderText(text) {
      const segments = String(text ?? '').split('```')
      const blocks = []
      segments.forEach((segment, position) => {
        if (segment === '') return
        if (position % 2 === 1) {
          // 代码块：去掉可选的语言行
          const body = segment.replace(/^[^\n]*\n/, '').replace(/\n$/, '')
          blocks.push(h('pre', { key: `c${position}`, className: 'dshsc-code' }, body))
          return
        }
        const lines = segment.split('\n')
        let list = null
        let listIndex = 0
        const flushList = () => {
          if (list === null) return
          blocks.push(h('ul', { key: `l${position}-${listIndex}`, className: 'dshsc-list' }, list))
          list = null
        }
        lines.forEach((line, lineIndex) => {
          const bullet = /^\s*(?:[-*]|\d+[.、])\s+(.*)$/.exec(line)
          if (bullet !== null) {
            listIndex += 1
            list = [...(list ?? []), h('li', { key: `li${lineIndex}` }, ...inlineNodes(bullet[1], `b${lineIndex}`))]
            return
          }
          flushList()
          if (line.trim() === '') return
          blocks.push(h('p', { key: `p${position}-${lineIndex}`, className: 'dshsc-para' }, ...inlineNodes(line, `p${lineIndex}`)))
        })
        flushList()
      })
      return blocks
    }

    // ---------- 组件 ----------
    /** 会话锚点：不渲染任何内容，只为拿到 sessionId 并维持 follow 流。 */
    function SessionBridge({ sessionId }) {
      React.useEffect(() => {
        if (runtime === null || typeof sessionId !== 'string' || sessionId === '') return undefined
        store.setState({ sessionId })
        let disposed = false
        let handle = null
        const observing = (async () => {
          try {
            handle = runtime.ctx.remote.$stream({
              name: 'dsh-side-chat follow',
              open: (signal) => runtime.ctx.remote.sideChat.follow(sessionId, signal),
              ended: () => new RemoteStreamCarrierError('dsh-side-chat follow stream ended'),
              carrierFailed: (error) => {
                // 断线重连期间不打断当前展示，仅标记
                store.setState({ error: `连接中断，重连中（${error instanceof Error ? error.message : String(error)}）` })
              },
            })
            // 竞态：卸载发生在流打开完成之前时立即关掉，避免泄漏
            if (disposed) {
              handle.dispose()
              return
            }
            for await (const item of handle) {
              item.accept?.()
              applyFrame(item.value)
            }
          } catch (error) {
            if (!disposed) store.setState({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return () => {
          disposed = true
          try {
            handle?.dispose?.()
          } catch {
            // 关闭失败不阻塞卸载
          }
          void observing.catch(() => {})
        }
      }, [sessionId])
      return null
    }

    function SideOverlay() {
      const t = runtime?.ctx.locale?.bind?.(NS) ?? ((key, params) => params?.fallback ?? key)
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      const exchange = currentExchange(snapshot)
      const browsing = snapshot.historyIndex >= 0
      const total = snapshot.exchanges.length

      const onCopy = React.useCallback(() => {
        const text = currentExchange(store.getSnapshot()).answer
        if (text === '') return
        Promise.resolve(navigator.clipboard?.writeText(text)).then(() => {
          store.setState({ copied: true })
          setTimeout(() => store.setState({ copied: false }), 1500)
        }, () => {})
      }, [])

      const onClear = React.useCallback(() => {
        const { sessionId } = store.getSnapshot()
        if (runtime === null || typeof sessionId !== 'string') return
        Promise.resolve(runtime.ctx.remote.sideChat.clear(sessionId)).catch(() => {
          store.setState({ exchanges: [], historyIndex: -1, open: false, phase: 'idle' })
        })
      }, [])

      React.useEffect(() => {
        if (!snapshot.open) return undefined
        const onKey = (event) => {
          const target = event.target
          if (target !== null && typeof target === 'object') {
            const tag = String(target.tagName ?? '').toLowerCase()
            if (tag === 'input' || tag === 'textarea' || target.isContentEditable === true) {
              // 输入框里的按键不劫持；Esc 仍然放行关闭
              if (event.key !== 'Escape') return
            }
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            store.setState({ open: false })
          } else if (event.key === 'c' || event.key === 'C') {
            event.preventDefault()
            onCopy()
          } else if (event.key === 'x' || event.key === 'X') {
            event.preventDefault()
            onClear()
          } else if (event.key === '[' || (event.key === 'ArrowLeft' && event.shiftKey)) {
            // 更旧：exchanges 升序，-1 等价最新（total-1）
            event.preventDefault()
            const position = snapshot.historyIndex === -1 ? total - 1 : snapshot.historyIndex
            store.setState({ historyIndex: Math.max(0, position - 1) })
          } else if (event.key === ']' || (event.key === 'ArrowRight' && event.shiftKey)) {
            // 更新：走到最新时回到 -1（当前/最新态）
            event.preventDefault()
            const position = snapshot.historyIndex === -1 ? total - 1 : snapshot.historyIndex
            store.setState({ historyIndex: position + 1 >= total - 1 ? -1 : position + 1 })
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [snapshot.open, snapshot.historyIndex, total, onCopy, onClear])

      if (!snapshot.open) return null

      const earlier = snapshot.exchanges.slice(0, -1).slice(-3)
      return h('div', {
        className: 'dshsc-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) store.setState({ open: false })
        },
      },
        h('div', { className: 'dshsc-panel', role: 'dialog', 'aria-label': t('title', { fallback: '侧问' }) },
          h('div', { className: 'dshsc-header' },
            h('span', { className: 'dshsc-badge' }, '侧问'),
            h('span', { className: 'dshsc-question' }, exchange.question || t('empty', { fallback: '暂无侧问' })),
            snapshot.phase === 'streaming'
              ? h('span', { className: 'dshsc-status' }, t('streaming', { fallback: '回答中…' }))
              : h('span', { className: 'dshsc-status' }, browsing ? `${snapshot.historyIndex + 1}/${total}` : ''),
            h('button', {
              className: 'dshsc-icon-btn',
              'aria-label': t('close', { fallback: '关闭' }),
              onClick: () => store.setState({ open: false }),
            }, '✕'),
          ),
          h('div', { className: 'dshsc-body' },
            browsing || earlier.length > 0
              ? h('div', { className: 'dshsc-earlier' },
                  browsing
                    ? t('browsing-hint', { fallback: '正在查看历史侧问；] 返回最新' })
                    : `${t('earlier', { fallback: '更早的侧问' })} · ${earlier.length}`,
                )
              : null,
            snapshot.phase === 'error'
              ? h('div', { className: 'dshsc-error' }, `${t('error-prefix', { fallback: '侧问失败' })}：${snapshot.error}`)
              : h('div', { className: 'dshsc-answer' },
                  ...renderText(exchange.answer),
                  snapshot.phase === 'streaming' ? h('span', { className: 'dshsc-cursor', key: 'cursor' }) : null,
                  snapshot.phase === 'done' && snapshot.truncated
                    ? h('p', { className: 'dshsc-truncated', key: 'trunc' }, t('truncated', { fallback: '（输出被截断）' }))
                    : null,
                  snapshot.phase === 'done' && !browsing && exchange.answer === ''
                    ? h('p', { className: 'dshsc-truncated', key: 'empty' }, t('reopen-empty', { fallback: '还没有侧问记录；输入 /side <问题> 开始' }))
                    : null,
                ),
          ),
          h('div', { className: 'dshsc-footer' },
            h('button', { className: 'dshsc-btn', onClick: onCopy, disabled: exchange.answer === '' },
              snapshot.copied ? t('copied', { fallback: '已复制' }) : t('copy', { fallback: '复制' })),
            h('button', { className: 'dshsc-btn', onClick: onClear, disabled: total === 0 },
              t('clear', { fallback: '清空记录' })),
            h('span', { className: 'dshsc-keys' }, 'Esc 关闭 · c 复制 · x 清空 · [ ] 翻历史'),
          ),
        ),
      )
    }

    /** 聊天流里的低调标记行：答案在浮层，不整段重复。 */
    function SideCommandRow({ node }) {
      const t = runtime?.ctx.locale?.bind?.(NS) ?? ((key, params) => params?.fallback ?? key)
      const data = node?.data ?? {}
      if (data.kind === 'error') {
        return h('div', { className: 'dshsc-row dshsc-row-error' }, `${t('row-error', { fallback: '侧问失败' })}：${String(data.text ?? '')}`)
      }
      if (data.kind === 'success') {
        return h('div', { className: 'dshsc-row' }, t('row-done', { fallback: '侧问已回答 · 答案在浮层，/side 重开' }))
      }
      return h('div', { className: 'dshsc-row' }, t('row-run', { fallback: '侧问…' }))
    }

    // ---------- 样式（仅主题 token，前缀隔离） ----------
    const STYLE = `
.dshsc-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-end;justify-content:center;padding:0 16px 88px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 45%,transparent)}
.dshsc-panel{width:min(720px,100%);max-height:min(560px,72vh);display:flex;flex-direction:column;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-shadow:var(--dsw-elevation-panel,0 12px 40px rgba(0,0,0,.18));border:.5px solid var(--dsw-alias-border-l1)}
.dshsc-header{display:flex;align-items:center;gap:10px;padding:10px 12px 8px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dshsc-badge{flex:none;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-state-business-primary);border:.5px solid var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-xs);padding:1px 6px}
.dshsc-question{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsc-status{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshsc-icon-btn{flex:none;width:26px;height:26px;display:grid;place-items:center;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:var(--dsw-radius-md);cursor:pointer}
.dshsc-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsc-body{flex:1;min-height:120px;overflow-y:auto;padding:12px 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:21px}
.dshsc-earlier{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-bottom:8px}
.dshsc-para{margin:0 0 8px}
.dshsc-list{margin:0 0 8px;padding-left:20px}
.dshsc-code{margin:0 0 10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow-x:auto;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.dshsc-inline-code{padding:1px 4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-primary)}
.dshsc-error{color:var(--dsw-alias-state-danger,var(--dsw-alias-label-primary))}
.dshsc-truncated{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshsc-cursor{display:inline-block;width:7px;height:14px;margin-left:2px;vertical-align:-2px;background:var(--dsw-alias-label-primary);animation:dshsc-blink 1s steps(1) infinite}
@keyframes dshsc-blink{50%{opacity:0}}
.dshsc-footer{display:flex;align-items:center;gap:8px;padding:8px 12px 10px 16px;border-top:.5px solid var(--dsw-alias-border-l3)}
.dshsc-btn{flex:none;height:26px;padding:0 10px;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);cursor:pointer}
.dshsc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsc-btn:disabled{opacity:.45;cursor:default}
.dshsc-keys{flex:1;min-width:0;text-align:right;color:var(--dsw-alias-label-caption);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsc-row{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshsc-row-error{color:var(--dsw-alias-state-danger,var(--dsw-alias-label-secondary))}
`

    // ---------- 挂载 ----------
    const dictionaries = {
      zh: {
        title: '侧问',
        streaming: '回答中…',
        empty: '暂无侧问',
        close: '关闭',
        copy: '复制',
        copied: '已复制',
        clear: '清空记录',
        earlier: '更早的侧问',
        'browsing-hint': '正在查看历史侧问；按 ] 返回最新',
        'error-prefix': '侧问失败',
        truncated: '（输出被截断）',
        'reopen-empty': '还没有侧问记录；输入 /side <问题> 开始',
        'row-done': '侧问已回答 · 答案在浮层，/side 重开',
        'row-error': '侧问失败',
        'row-run': '侧问…',
      },
      en: {
        title: 'Side question',
        streaming: 'Answering…',
        empty: 'No side question yet',
        close: 'Close',
        copy: 'Copy',
        copied: 'Copied',
        clear: 'Clear history',
        earlier: 'Earlier side questions',
        'browsing-hint': 'Browsing history; press ] to return to the latest',
        'error-prefix': 'Side question failed',
        truncated: '(output truncated)',
        'reopen-empty': 'No side questions yet; type /side <question> to start',
        'row-done': 'Answered · shown in the overlay; /side to reopen',
        'row-error': 'Side question failed',
        'row-run': 'Asking…',
      },
    }

    function registerUi(ctx) {
      runtime = { ctx }
      ctx.effect(() => ctx.locale.register(NS, dictionaries), `${NS}: dictionaries`)
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = STYLE
        document.head.appendChild(style)
        return () => style.remove()
      }, `${NS}: style`)

      // 会话锚点：composer.dock 是 session 范围，inject 回调拿到 sessionId
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'dsh-side-chat-bridge',
        order: 90,
        locale: NS,
        inject: (sessionId) => ({ sessionId }),
      }, SessionBridge))

      // 帧级浮层
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-side-chat',
        order: 40,
        locale: NS,
        label: () => ctx.locale.bind(NS)('title', { fallback: '侧问' }),
      }, SideOverlay))

      // 聊天流标记行（两个命令名各占一个 key）
      ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
        name: 'conversation.chat.commandview',
        key: 'side',
        locale: NS,
      }, SideCommandRow))
      ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
        name: 'conversation.chat.commandview',
        key: 'btw',
        locale: NS,
      }, SideCommandRow))
    }

    /**
     * 激活：先挂远程命名空间，再注册 UI（浮层/锚点在 sideChat 可用后才接线）。
     * @param {import('@deepseek-ai/dsh-api-gateway/client').ClientContext} ctx 客户端根上下文
     * @returns 完整的远程 + UI 卸载器
     */
    async function apply(ctx) {
      const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
      const ui = ctx.inject(['remote', 'remote.sideChat', 'slots', 'locale'], registerUi)
      try {
        await ui
      } catch (error) {
        await ui.dispose()
        await disposeRemote()
        throw error
      }
      return async () => {
        await ui.dispose()
        await disposeRemote()
      }
    }

    return {
      inject,
      apply,
      /** 测试钩子：仅测试文件消费，运行时无人读取。 */
      __test: { TYPERT_REMOTE, store, applyFrame, renderText, SessionBridge, SideOverlay, SideCommandRow },
    }
  },
})
