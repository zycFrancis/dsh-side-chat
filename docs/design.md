# 设计与机制

本文记录 dsh-side-chat 的架构决策、依赖的宿主机制与权衡。面向想理解或改造插件的读者；使用方式见 [README](../README.md)。

## 对标

| | Claude Code `/btw` | Codex `/side` | dsh-side-chat |
|---|---|---|---|
| 本质 | 无工具单次侧问答，浮层展示 | 临时 fork 完整侧线程（有工具、可多轮） | 无工具单次侧问答，浮层展示 |
| 历史污染 | 零（内存态，退出即清） | 零（独立 fork 线程） | 零（内存态，重启即清） |
| 上下文 | 复用主对话已有内容 | 继承历史，reference-only 护栏 | 主对话摘要（reference-only）+ 侧问记忆回放 |
| 可否追问 | 再问一次，回放最近 20 条 | 线程内自由对话 | 再问一次 `/side`，回放最近 N 条 |
| 带工具深挖 | `f` 键 fork 成子代理 | 原生 | v2 候选（复用 dsh 内置 subagent fork） |

选择 `/btw` 形态为 v1 主轴：dsh 已有 `subagent`（带工具、可 fork）覆盖深挖场景，"快速旁路一问"是空白层。

## 总体架构

```
用户输入 /side 问题
   │ Web composer → ctx.remote.commands.execute(sessionId, line)
   ▼
Host: commands.execute（不开 turn，不进模型上下文）
   ├─ session.deriveMessages() ──► buildDigest：尾部字节预算参考摘要
   ├─ 路由解析：config > session.requestHeader().config > agentDefaultModel
   ├─ llm.stream（无 tools、最低推理档、超时合并取消）
   │     └─ 每个正文增量 emit 帧 ──► sideChat.follow(sessionId) 流 ──► 客户端浮层
   ├─ 完成：入内存 Map<sessionId, Exchange[]>，emit done 帧
   └─ 返回 CommandResult{ text: 答案 }（command/done 事件落日志，headless 可见）

Client（Web 页面）
   ├─ SessionBridge（conversation.composer.dock，session 范围）：拿 sessionId，
   │    打开 ctx.remote.$stream 订阅 follow 帧流，写入模块级 store
   ├─ SideOverlay（shell.overlay，root 范围）：浮层渲染 + 按键交互
   └─ SideCommandRow（conversation.chat.commandview，key side/btw）：低调标记行
```

## 关键机制

### 1. 命令注册与零污染路径

- `ctx.commands.register({ name, recordInput: false, handler })`：`/side` 与 `/btw` 各注册一次指向同一 handler；`recordInput: false` 使 `command/run` 事件不带问题文本。
- 命令执行是 log-only 生命周期（`command/run`/`command/done`），不开启 turn、不进入模型可见 surface（surface 只收录 user/assistant/developer/system/tool-result 等消息事件）。
- `command/done` 携带完整答案文本——这是有意取舍：headless 等无浮层 UI 靠它显示答案，事后也可检索；它仍然永不进入模型上下文。
- dsh 明确禁止插件 append 自定义事件类型（未知事件会使会话无法 reopen），侧问记忆因此只存进程内存，宿主重启即清。

### 2. 上下文摘要（而非原生重放）

`session.deriveMessages()` 返回当前模型可见消息（替换/投影已应用）。本插件把它折叠成一条 framed user 消息，而不是原样重放，原因：

- 原生重放要求 assistant 工具调用块与 tool-result 严格配对（OpenAI 风格 API 约束），剥离/内联都易碎；
- 图片/文件块的 attachment 引用解析路径复杂，文本标记更稳；
- 预算可控（`maxInputBytes` 尾部预算，主题以最近为主——与 dsh-session-title-ruled 同策略）。

代价：摘要前缀与主对话请求不同，吃不到 DeepSeek 前缀缓存，每次侧问≈一次独立小请求。原生重放留作 v2 研究。

### 3. 宿主侧零配置的 Remote 暴露（SRC 发现）

`SideChatService extends TypertRemoteService`（服务名 `sideChat`）。宿主 Gateway 解析端点时优先查 strict typert 贡献，缺失则走 **SRC 兜底**：从服务的原型 Remote 标记 + 函数签名（`async *follow(sessionId, signal)`）自动推参——`sessionId` 成 json 参数、`signal` 成取消信号。因此宿主侧不需要任何 typert 贡献文件。

纯 JS 插件没有装饰器语法（宿主 Node 未开 stage 提案），`markRemote()` 用手工装饰器上下文调用 typert-protocol 的 `Remote()` 原厂函数把标记落上原型：

```js
Remote({ mode: 'stream' })(klass.prototype.follow, fakeDecoratorContext)
```

标记格式是 v1 结构化描述符（`remoteMethods()` 可读，已测）。若上游升级格式需跟进；标记失败只影响流式面，命令面不受损。

### 4. 客户端远程挂载与 strict codec 占位

客户端 `ctx.remote.$mount(TYPERT_REMOTE)` 挂载 `sideChat` 命名空间。`$mount` 的校验要求每个参数 codec 为 strict 且带 `create()`；运行时参数直传 JSON、结果 passthrough，`create()` 只在 schema 物化（inspect/文档）时被消费，故给出最小占位实现——这是有意的务实取舍，已注释说明。

### 5. session 范围 UI 拿 sessionId

`shell.overlay` 是 root 范围，不带会话信息。会话锚点走 goal 插件先例：`conversation.composer.dock`（session 范围）注册项的 `inject: (sessionId) => ({ sessionId })` 由 slot 系统在挂载时调用；SessionBridge 拿到后打开 follow 流，卸载时关闭（含竞态防护）。

### 6. 帧协议

| 帧 | 载荷 | 语义 |
|---|---|---|
| `snapshot` | `exchanges[]` | follow 订阅建立时的存量侧问 |
| `reopen` | `exchanges[]` | `/side` 空输入，浮层重开 |
| `start` | `question`, `route` | 侧问开始 |
| `delta` | `text` | 答案正文增量 |
| `done` | `answer`, `truncated` | 完成 |
| `error` | `message` | 失败 |
| `cleared` | — | 记忆已清空 |

store 归约遵循 useSyncExternalStore 契约：`setState` 必须换新对象引用，原地修改会让 React 拿到相同引用而跳过重渲染（初版实现的真实 bug）。

## 权衡与已知风险

- **前缀缓存不命中**：见上文摘要策略；影响是成本，不是正确性。
- **strict codec 占位**：inspect 物化该 schema 时会拿到占位对象；不影响运行时调用链。
- **`methodParameterNames` 依赖函数源码解析**：宿主加载未压缩 JS，参数名保留；若宿主侧引入压缩构建需关注。
- **流式中途关闭浮层**：宿主继续完成流并记忆（对齐 Claude），重新 `/side` 空输入可回看。
- **并发侧问**：同会话并行发起时帧交错，浮层跟随最新一条；内存按完成序追加。

## 测试

`node --test`，24 例，零测试框架依赖：

- Host 纯函数（12）：截断/摘要提取（工具名配对、reasoning 跳过、图片文件标记）/预算选择（全量、超预算省略、空历史）/消息组装顺序/系统提示词/流消费三态（stop、截断降级、失败抛错）。
- 服务冒烟（6）：真实 cordis `Context` 实例化，验证双命令注册、完整侧问链路（帧序、路由取请求头）、空输入 reopen、clear 广播、follow 流（snapshot → 增量 → 取消）、llm 失败路径（error 结果 + error 帧、不入记忆）。
- 客户端（6）：描述符逐字段过 `$mount` 校验规则、帧归约（start/delta/done、状态引用更换断言、error/cleared）、轻量 Markdown、`apply` 挂载（$mount 收到描述符、四个 slot 注册齐全）、SessionBridge 空渲染。

GUI 实测（v1.0.0）：页面刷新后 `/side` 浮层流式正常。
