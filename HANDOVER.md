# dsh-side-chat 交接

侧问插件：`/side`、`/btw` 命令基于当前会话上下文发起无工具的独立问答，
答案走浮层（客户端半待实现），不进入主对话模型上下文。对标 Claude Code `/btw`。

## 当前状态（2026-10-10）

**已完成：Host 半 v1 + Web 客户端半**（`index.js` + `client.js`）

Host 半（`index.js`）：

- 双命令注册（`side`/`btw` 同一 handler），`recordInput: false` 问题不落日志
- `session.deriveMessages()` 取模型可见历史 → `buildDigest` 折叠成尾部字节预算的参考摘要
  （文本直取、图片/文件/工具调用留标记、reasoning 跳过、工具结果配对工具名并截断）
- `session.requestHeader().config` 取会话当前路由（配置覆盖 > 请求头 > agentDefaultModel）
- `llm.stream` 独立调用：无 tools、最低推理档（关键词阶梯）、90s 超时、maxTokens 2048
- 内存侧问记忆 `Map<sessionId, Exchange[]>`（读写两侧都截到 maxExchanges，重启即清）
- `sideChat.follow(sessionId)` 流式帧（snapshot/reopen/start/delta/done/error/cleared）
  + `sideChat.clear(sessionId)`；`@Remote` 标记用 `markRemote` 手工落原型（纯 JS 无装饰器语法）
- 宿主侧无需 typert 贡献：Gateway 的 SRC 发现从原型标记 + 函数签名（`follow(sessionId, signal)`）
  自动推参（`src-json` codec），已从 dsh-api-gateway 源码确认

Web 客户端半（`client.js`，ModuleLoader 模块 id = 包名）：

- 内联 TYPERT_REMOTE 描述符：`sideChat/follow`（stream）+ `sideChat/clear`；
  strict codec 的 `create()` 是占位实现（运行时参数直传 JSON、结果 passthrough，
  create 仅在 schema 物化/inspect 时被消费）
- SessionBridge 挂 `conversation.composer.dock`（session 范围）：`inject: (sessionId) => …`
  拿 sessionId（goal 插件先例），打开 `ctx.remote.$stream` follow 流写入模块级 store；
  卸载竞态防护
- SideOverlay 挂 `shell.overlay`：流式答案（轻量 markdown：围栏代码块/行内代码/粗体/列表）、
  Esc/背景点击关闭、c 复制、x 清空（调 remote clear）、`[` `]`/Shift+方向键翻历史侧问；
  store 用换引用的 setState（useSyncExternalStore 依赖引用变化）
- SideCommandRow 挂 `conversation.chat.commandview`（key: side/btw）：低调标记行替代默认整段答案卡片
- 全部样式只用 `--dsw-alias-*` 主题 token，前缀 `dshsc-`；中英词典经 client locale 服务
- package.json：`./client` export + `dsh.client`（web, immediately, inject 顺序依赖,
  external: api-gateway/client）

**验证**：`node --test test/host.test.mjs test/service.test.mjs test/client.test.mjs`
24/24 通过（Host 纯函数 12 + 真实 cordis Context 服务冒烟 6 + 客户端描述符/帧归约/
markdown/挂载注册 6）。本地 node_modules 符号链接指向 Desktop app 内置包仅供测试。

## 未完成

- [ ] GUI 实测（需先刷新页面让客户端模块进入 boot graph）：流式浮层、Esc/复制/
      清空/翻历史、turn 进行中提问、明暗主题、headless 文本可见、
      token 计量断言侧问不进主上下文
- [ ] 浮层"fork 深挖"按钮（v2，复用内置 sessions.fork/subagent fork）
- [ ] 原生消息重放研究（吃前缀缓存，v2）

## 安装状态（2026-10-10）

- `plugin_manager install_bundle` → `application: "applied"`、`warnings: []`、
  pnpm exitCode 0；profile package.json 已写入 link 依赖与 bundle 选择
- 宿主半经 HMR 生效；客户端半需页面刷新后随 boot graph 加载
  （本机未跑 dev:web，无免刷新热载）
- 验证手段限制：inspect 的 Service 目录是静态生成的（`api-catalog.js`），
  看不到三方服务，不能作为激活证据；本会话 cordis_inspect_query 的 input
  参数有序列化故障（"must be an object"），无法按 root 查 slot occupants；
  web 页面 curl 被 admission 拒绝。激活证据 = install 结果字段 + 24 项测试。

## 已知风险

- 手写描述符的 strict codec `create()` 占位：`$mount` 校验通过（已测），
  inspect/文档物化该 schema 时会拿到占位对象（不影响运行时调用）
- 手工 `markRemote` 依赖 typert-protocol 的 v1 原型标记格式（结构化读取，
  已在测试中验证落上）；格式升级时需跟进
- `methodParameterNames` 从函数源码解析参数名：宿主加载的是未压缩 JS，参数名保留；
  若未来构建流程压缩宿主半需注意
- 摘要前缀吃不到主对话前缀缓存，成本≈独立小请求（原生重放留 v2 研究）
