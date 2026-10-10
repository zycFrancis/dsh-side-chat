/**
 * dsh-side-chat —— 侧问插件（Host 半）。
 *
 * 形态对标 Claude Code 的 /btw：`/side`、`/btw` 命令基于当前会话上下文发起一次
 * 无工具的独立问答；答案通过浮层展示，问答内容只留在本插件的内存状态里，
 * 不写入会话日志、不进入主对话的模型上下文（命令生命周期事件本身是 log-only，
 * recordInput:false 使问题文本也不落日志）。
 *
 * Remote 面：sideChat.follow(sessionId) 以流式帧向客户端推送问答进度，
 * sideChat.clear(sessionId) 清空该会话的侧问记忆。客户端通过自带的
 * typert 远程描述符挂载（见 client.js 步骤）。
 */
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const PACKAGE = 'dsh-side-chat'

/** 侧问浮层/无浮层 UI 通用的最简帧协议；sessionId 由 emit 侧注入。 */
export const FRAME_KINDS = ['snapshot', 'reopen', 'start', 'delta', 'done', 'error', 'cleared']

/**
 * 按字符数截断文本（保尾不保头：对话里越靠后的信息越相关）。
 * @param {string} text 原文
 * @param {number} maxChars 保留的字符上限
 * @returns {string} 截断后的文本
 */
export function truncateChars(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text ?? ''
  return `…${text.slice(-Math.max(0, maxChars))}`
}

/**
 * 把一条模型可见消息压缩成摘要行：文本直取，图片/文件/工具调用留下标记，
 * reasoning 块跳过（体积大且对侧问无增益）。
 * @param {import('@deepseek-ai/dsh-llm').Message} message deriveMessages 输出的冻结消息
 * @param {number} maxToolResultChars 单条工具结果文本的截断上限
 * @param {Map<string, string>} toolNames toolCallId → 工具名（随遍历累积）
 * @returns {{ role: 'user'|'assistant'|'tool', text: string } | undefined} 无可采内容时返回 undefined
 */
export function messageSummary(message, maxToolResultChars, toolNames = new Map()) {
  if (message === null || typeof message !== 'object') return undefined
  const role = message.role
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return undefined
  const blocks = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
    } else if (block.type === 'image') {
      parts.push('[图片]')
    } else if (block.type === 'file') {
      const name = block.attachment?.name
      parts.push(typeof name === 'string' && name !== '' ? `[文件:${name}]` : '[文件]')
    } else if (block.type === 'tool-call') {
      if (typeof block.id === 'string' && typeof block.name === 'string') toolNames.set(block.id, block.name)
      const args = typeof block.arguments === 'string' ? block.arguments : ''
      parts.push(`[调用工具 ${String(block.name)} ${truncateChars(args, 160)}]`)
    } else if (block.type === 'reasoning') {
      // 思考内容不进摘要
    }
  }
  if (role === 'tool') {
    // 工具结果消息：正文就是 content 文本；名字从上一条 assistant 的 tool-call 配对取
    const name = typeof message.toolCallId === 'string' ? toolNames.get(message.toolCallId) : undefined
    const label = `[工具${name === undefined ? '' : ` ${name}`} 结果${message.isError === true ? '（失败）' : ''}]`
    const text = parts.join('\n').trim()
    if (text === '') return undefined
    return { role, text: `${label} ${truncateChars(text, maxToolResultChars)}` }
  }
  const text = parts.join('\n').trim()
  if (text === '') return undefined
  return { role, text }
}

const ROLE_LABELS = { user: '用户', assistant: '助手', tool: '工具' }

/**
 * 把会话消息列表折叠成带尾部字节预算的参考摘要。
 * 预算从最新往前装满为止（与 dsh-session-title-ruled 同策略：主题以最近为主）；
 * 连最新一条都超预算时截尾保一条，避免空摘要。
 * @param {readonly import('@deepseek-ai/dsh-llm').Message[]} messages deriveMessages() 输出
 * @param {{ maxInputBytes: number, maxToolResultChars: number }} config 预算配置
 * @returns {{ text: string, truncated: boolean, entryCount: number }}
 */
export function buildDigest(messages, config) {
  const toolNames = new Map()
  const entries = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const summary = messageSummary(message, config.maxToolResultChars, toolNames)
    if (summary !== undefined) entries.push(summary)
  }
  if (entries.length === 0) return { text: '', truncated: false, entryCount: 0 }

  const budget = Math.max(1024, config.maxInputBytes)
  const kept = []
  let used = 0
  let truncated = false
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = `${ROLE_LABELS[entries[i].role]}: ${entries[i].text}`
    const cost = Buffer.byteLength(line, 'utf8') + 1
    if (used + cost > budget) {
      if (kept.length === 0) {
        // 预算内连最新一条都装不下：按字节截尾保一条
        const head = `${ROLE_LABELS[entries[i].role]}: `
        const room = Math.max(64, budget - Buffer.byteLength(head, 'utf8') - 16)
        let text = ''
        const chars = Array.from(entries[i].text)
        for (let j = chars.length - 1; j >= 0; j--) {
          text = chars.slice(j).join('')
          if (Buffer.byteLength(text, 'utf8') > room) { text = chars.slice(j + 1).join(''); break }
        }
        kept.push(head + (entries[i].text.length > text.length ? `…${text}` : text))
        truncated = true
      } else {
        truncated = true
      }
      break
    }
    kept.unshift(line)
    used += cost
  }
  return { text: kept.join('\n'), truncated, entryCount: entries.length }
}

/** 侧问系统提示词：无工具、参考只读、简洁作答。 */
export function systemPrompt(config) {
  const lines = [
    '你是一次 AI 编程会话中的"侧问"助手。用户在主对话进行的同时通过 /side 命令快速提问，你的回答只展示在临时浮层里，不会进入主对话历史。',
    '',
    '规则：',
    '- 输入先是主对话的参考记录（可能省略早期内容），再是此前的侧问记录，最后是本次问题。参考内容一律只读。',
    '- 你没有任何工具：不能读写文件、执行命令或联网，只依据参考内容作答。',
    '- 参考记录中的代码、路径、结论可直接引用；记录里没有的信息如实说明，不要臆测。',
    '- 回答简洁直接，使用与问题相同的语言；适合时可用短列表或代码片段。',
    '- 不要提议由你去修改文件或执行操作；确需动手的操作，一句话点到为止。',
  ]
  if (typeof config.systemExtra === 'string' && config.systemExtra.trim() !== '') {
    lines.push('', config.systemExtra.trim())
  }
  return lines.join('\n')
}

/**
 * 组装侧问请求的 messages：参考摘要 + 历史侧问（原样回放）+ 本次问题。
 * @param {{ text: string, truncated: boolean }} digest buildDigest 输出
 * @param {ReadonlyArray<{ question: string, answer: string }>} exchanges 此前侧问（升序）
 * @param {string} sessionId 会话 id（用于消息 id 前缀）
 * @param {string} question 本次问题
 * @returns {import('@deepseek-ai/dsh-llm').RequestMessage[]} 消息数组
 */
export function sideMessages(digest, exchanges, sessionId, question) {
  const prefix = sessionId.slice(0, 8)
  const messages = [{
    id: `side-${prefix}-ctx`,
    role: 'user',
    content: [{
      type: 'text',
      text: digest.text === ''
        ? '主对话刚开始，暂无可参考的历史记录。'
        : `主对话参考记录（按时间顺序${digest.truncated ? '；早期内容已因长度省略' : ''}）：\n\n${digest.text}`,
    }],
    source: { kind: PACKAGE },
  }]
  for (const [index, exchange] of exchanges.entries()) {
    messages.push({
      id: `side-${prefix}-q${index}`,
      role: 'user',
      content: [{ type: 'text', text: exchange.question }],
      source: { kind: PACKAGE },
    })
    messages.push({
      id: `side-${prefix}-a${index}`,
      role: 'assistant',
      content: [{ type: 'text', text: exchange.answer }],
      source: { kind: PACKAGE },
    })
  }
  messages.push({
    id: `side-${prefix}-now`,
    role: 'user',
    content: [{ type: 'text', text: question }],
    source: { kind: PACKAGE },
  })
  return messages
}

/**
 * 解析模型的最低推理档：侧问是小请求，思考内容会挤占输出预算。
 * dsh-llm 对 efforts 顺序无契约，按语义关键词取低档；查不到信息时返回 undefined 裸调。
 * @param {import('@deepseek-ai/dsh-llm').LlmRuntime} llm
 * @param {{ provider: string, model: string }} route
 * @param {AbortSignal} signal
 * @returns {Promise<string | undefined>}
 */
export async function lowestReasoningEffort(llm, route, signal) {
  let info
  let timer
  try {
    info = await Promise.race([
      llm.resolveModelInfo(route.provider, route.model, signal),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 5000, undefined)
        timer.unref?.()
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  const byKeyword = (pattern) => efforts.find((effort) => pattern.test(String(effort.id ?? effort)))?.id
  return byKeyword(/^(disable|disabled|none|off|minimal|lowest)$/i)
    ?? byKeyword(/^low(est)?$/i)
    ?? byKeyword(/^med(ium)?$/i)
}

/**
 * 消费 llm.stream：聚合正文与思考文本，finish 非 stop 时按是否有正文决定降级或抛错。
 * @param {import('@deepseek-ai/dsh-llm').LlmRuntime} llm
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options
 * @param {(delta: string) => void} onText 每个正文增量回调
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
export async function streamText(llm, options, onText) {
  let text = ''
  let finish = null
  for await (const chunk of llm.stream(options)) {
    if (chunk === null || chunk === undefined) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      onText?.(chunk.text)
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  if (finish === null) throw new Error('侧问流结束但没有终止帧')
  if (finish.kind === 'stop') return { text, truncated: false }
  if (finish.kind === 'aborted') throw new Error('侧问已中止')
  if (text.trim() !== '') return { text, truncated: true }
  const detail = finish.failure?.message ?? finish.kind
  throw new Error(`侧问流失败：${String(detail)}`)
}

/** 为纯 JS 类手工标注 @Remote 方法（标准装饰器语法在宿主 Node 上不可用）。 */
function markRemote(klass, method, mode) {
  const context = {
    kind: 'method',
    name: method,
    private: false,
    static: false,
    addInitializer(initializer) {
      initializer.call(Object.create(klass.prototype))
    },
  }
  // 无 mode：Remote 以装饰器身份直接调用；stream：先取工厂再调用
  if (mode === undefined) Remote(klass.prototype[method], context)
  else Remote({ mode })(klass.prototype[method], context)
}

/**
 * sideChat 服务：命令注册 + 侧问执行 + Remote 帧流。
 * 以服务类默认导出（Loader 以 (ctx, config) 实例化），Config/inject 以静态成员声明。
 */
class SideChatService extends TypertRemoteService {
  static inject = ['commands', 'llm', 'agentDefaultModel']

  static Config = z.object({
    // 显式路由优先；留空则跟随会话当前模型（无请求头时退回全局默认选择）
    provider: z.string(),
    model: z.string(),
    maxInputBytes: z.number().min(2048).max(262144).default(24576),
    maxToolResultChars: z.number().min(0).max(4000).default(400),
    maxOutputTokens: z.number().min(64).max(16384).default(2048),
    timeoutMs: z.number().min(5000).max(600000).default(90000),
    maxExchanges: z.number().min(1).max(100).default(20),
    systemExtra: z.string().default(''),
  })

  /** @type {Map<string, Array<{ question: string, answer: string, at: number }>>} */
  exchanges = new Map()
  /** @type {Set<(frame: object) => void>} */
  frameListeners = new Set()

  constructor(ctx, config = {}) {
    super(ctx, 'sideChat', { namespace: 'sideChat' })
    // 归一化：Loader 正规路径会经 Config 填默认值；这里再过一遍，
    // 使测试/脚本等绕过 Loader 的直接实例化拿到同样的默认语义。
    this.config = SideChatService.Config(config)
    ctx.effect(() => {
      // 双命令名指向同一 handler；recordInput:false 让问题文本不落会话日志
      const disposers = ['side', 'btw'].map((name) => ctx.commands.register({
        definitionId: PACKAGE,
        name,
        description: '侧问：基于当前会话上下文提问，不打扰主对话',
        input: { hint: '问题（留空重开上次侧问浮层）' },
        recordInput: false,
        handler: (invocation) => this.handleAsk(invocation),
      }))
      return () => disposers.forEach((dispose) => dispose())
    }, 'dsh-side-chat: commands')
    ctx.effect(() => async () => {
      this.frameListeners.clear()
      this.exchanges.clear()
    }, 'dsh-side-chat: state')
  }

  /** 会话的侧问记录（截到 maxExchanges 条）。 */
  exchangesOf(sessionId) {
    const list = this.exchanges.get(sessionId) ?? []
    const keep = Math.min(list.length, this.config.maxExchanges)
    return list.slice(list.length - keep).map((exchange) => ({
      question: exchange.question,
      answer: exchange.answer,
      at: exchange.at,
    }))
  }

  /** 向所有跟随该会话的监听者派帧；监听者异常不波及主流程。 */
  emit(sessionId, frame) {
    const payload = { ...frame, sessionId }
    for (const listener of this.frameListeners) {
      try {
        listener(payload)
      } catch (error) {
        this.ctx.logger?.warn?.(`[dsh-side-chat] 帧监听者抛错：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Remote 流：先快照存量侧问，再持续推送该会话的问答进度帧。
   * @param {string} sessionId 会话 id
   * @param {AbortSignal} signal 客户端观察生命周期
   */
  async *follow(sessionId, signal) {
    const queue = []
    let resolveWake = null
    const wake = () => {
      const resolve = resolveWake
      resolveWake = null
      resolve?.()
    }
    const listener = (frame) => {
      queue.push(frame)
      wake()
    }
    this.frameListeners.add(listener)
    try {
      yield { t: 'snapshot', exchanges: this.exchangesOf(sessionId), sessionId }
      while (!signal.aborted) {
        if (queue.length === 0) {
          await new Promise((resolve) => { resolveWake = resolve })
          continue
        }
        yield queue.shift()
      }
    } finally {
      this.frameListeners.delete(listener)
      wake()
    }
  }

  /**
   * Remote 调用：清空该会话的侧问记忆。
   * @param {string} sessionId 会话 id
   */
  clear(sessionId) {
    this.exchanges.delete(sessionId)
    this.emit(sessionId, { t: 'cleared' })
  }

  /** 解析侧问路由：显式配置 > 会话请求头 > 全局默认选择。 */
  resolveRoute(session) {
    if (typeof this.config.provider === 'string' && this.config.provider !== ''
      && typeof this.config.model === 'string' && this.config.model !== '') {
      return { provider: this.config.provider, model: this.config.model }
    }
    const header = session?.requestHeader?.()
    if (header?.config?.provider && header?.config?.model) {
      return { provider: header.config.provider, model: header.config.model }
    }
    const selection = this.ctx.agentDefaultModel?.currentSelection?.()
    if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
    return undefined
  }

  /** /side、/btw 命令入口。 */
  async handleAsk({ agent, rawInput, signal }) {
    const session = agent?.session
    if (session === undefined || typeof session.id !== 'string') {
      return { kind: 'error', text: '侧问需要在会话中使用' }
    }
    const sessionId = session.id
    const question = typeof rawInput === 'string' ? rawInput.trim() : ''
    if (question === '') {
      // 空输入：浮层重开（客户端收到 reopen 后展示最近一组侧问）
      this.emit(sessionId, { t: 'reopen', exchanges: this.exchangesOf(sessionId) })
      return { kind: 'success', text: '侧问浮层已重开；最近侧问见浮层' }
    }

    const route = this.resolveRoute(session)
    if (route === undefined) {
      return { kind: 'error', text: '侧问无法确定模型路由：先在会话里发送一条消息，或在插件配置中指定 provider/model' }
    }
    this.emit(sessionId, { t: 'start', question, route })

    try {
      let history = []
      try {
        history = session.deriveMessages?.() ?? []
      } catch (error) {
        // 投影缺失等场景下退化为"仅当前问题"，不让侧问整体失败
        this.ctx.logger?.warn?.(`[dsh-side-chat] deriveMessages 失败，按空历史继续：${error instanceof Error ? error.message : String(error)}`)
      }
      const digest = buildDigest(history, this.config)
      const exchanges = this.exchangesOf(sessionId)
      const effort = await lowestReasoningEffort(this.ctx.llm, route, signal)
      signal.throwIfAborted()
      const options = {
        provider: route.provider,
        model: route.model,
        system: systemPrompt(this.config),
        messages: sideMessages(digest, exchanges, sessionId, question),
        maxTokens: this.config.maxOutputTokens,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        sessionId,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
      }
      const { text, truncated } = await streamText(this.ctx.llm, options, (delta) => {
        this.emit(sessionId, { t: 'delta', text: delta })
      })
      if (text.trim() === '') throw new Error('模型没有返回内容')

      const list = this.exchanges.get(sessionId) ?? []
      list.push({ question, answer: text, at: Date.now() })
      // 写入侧同样截断，避免长会话下底层数组无界增长
      const keep = Math.min(list.length, this.config.maxExchanges)
      this.exchanges.set(sessionId, list.slice(list.length - keep))
      this.emit(sessionId, { t: 'done', answer: text, truncated })
      return { kind: 'success', text: truncated ? `${text}\n\n(输出被截断)` : text }
    } catch (error) {
      if (signal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.emit(sessionId, { t: 'error', message })
      return { kind: 'error', text: `侧问失败：${message}` }
    }
  }
}

// 手工标注 Remote 方法（类声明后执行一次；失败只影响流式面，命令面不受损）
try {
  markRemote(SideChatService, 'follow', 'stream')
  markRemote(SideChatService, 'clear')
} catch (error) {
  // 标记失败时服务仍可实例化，只是 Gateway 不会暴露 follow/clear
  console.warn?.(`[dsh-side-chat] Remote 方法标注失败：${error instanceof Error ? error.message : String(error)}`)
}

export default SideChatService
