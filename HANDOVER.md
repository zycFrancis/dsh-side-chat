# dsh-side-chat 交接

侧问插件：`/side`、`/btw` 命令基于当前会话上下文发起无工具的独立问答，
答案走浮层（客户端半待实现），不进入主对话模型上下文。对标 Claude Code `/btw`。

## 当前状态（2026-10-10）

**已完成：Host 半 v1**（`index.js`，460 行）

- 双命令注册（`side`/`btw` 同一 handler），`recordInput: false` 问题不落日志
- `session.deriveMessages()` 取模型可见历史 → `buildDigest` 折叠成尾部字节预算的参考摘要
  （文本直取、图片/文件/工具调用留标记、reasoning 跳过、工具结果配对工具名并截断）
- `session.requestHeader().config` 取会话当前路由（配置覆盖 > 请求头 > agentDefaultModel）
- `llm.stream` 独立调用：无 tools、最低推理档（关键词阶梯）、90s 超时、maxTokens 2048
- 内存侧问记忆 `Map<sessionId, Exchange[]>`（读写两侧都截到 maxExchanges，重启即清）
- `sideChat.follow(sessionId)` 流式帧（snapshot/reopen/start/delta/done/error/cleared）
  + `sideChat.clear(sessionId)`；`@Remote` 标记用 `markRemote` 手工落原型（纯 JS 无装饰器语法）
- Config（schemastery）：provider/model/maxInputBytes/maxToolResultChars/maxOutputTokens/
  timeoutMs/maxExchanges/systemExtra

**验证**：`node --test test/host.test.mjs test/service.test.mjs` 18/18 通过
（纯函数 12 + 真实 cordis Context 的服务冒烟 6：双命令注册、完整侧问、reopen、
clear、follow 流顺序、llm 失败路径）。本地 node_modules 符号链接指向 Desktop app
内置包仅供测试，install_bundle 时会按 package.json 安装真实依赖。

## 未完成

- [ ] typert.remote-client.js（手写 TYPERT_REMOTE 描述符）+ client.js 浮层
      （`shell.overlay` slot、`ctx.remote.$mount` + `$stream` 订阅、Esc/复制/清空/翻历史）
- [ ] `conversation.chat.commandview`（key: side/btw）低调标记行渲染
- [ ] package.json 补 `./client` export 与 `dsh.client` 段；patch 加 UI 行
- [ ] `plugin_manager install_bundle` 安装 + GUI 实测（流式、turn 进行中提问、
      明暗主题、headless 文本可见、token 计量断言侧问不进主上下文）

## 已知风险

- 手写 typert 描述符对 `ctx.remote.$mount` 的兼容性待实测；降级方案：浮层一次性
  等 `commands.execute` 完整结果（不做流式）
- 手工 `markRemote` 依赖 typert-protocol 的 v1 原型标记格式（结构化读取，
  已在测试中验证落上）；格式升级时需跟进
- 摘要前缀吃不到主对话前缀缓存，成本≈独立小请求（原生重放留 v2 研究）
