# Changelog

## 1.0.0 (2026-10-10)

- 首个可用版本：`/side`、`/btw` 双命令侧问，基于当前会话模型可见历史的参考摘要
  （`deriveMessages` + 尾部字节预算，文本直取/工具活动留标记/reasoning 跳过/工具结果
  配对截断）+ 最近 20 条侧问记忆，发起无工具的独立 `llm.stream` 调用。
- 零污染路径：`recordInput: false` 使问题不落日志；命令生命周期事件 log-only 不进模型
  上下文；不写任何自定义会话事件类型（dsh 约束），侧问记忆纯内存、重启即清。
- Web 浮层（`shell.overlay`）：流式答案 + 轻量 Markdown（围栏代码块/行内代码/粗体/列表）、
  Esc/背景点击关闭、`c` 复制、`x` 清空、`[` `]`/Shift+方向键翻历史；样式全用
  `--dsw-alias-*` 主题 token。
- 宿主-客户端流式通道：`sideChat.follow(sessionId)` 帧流（snapshot/reopen/start/delta/
  done/error/cleared）+ `sideChat.clear(sessionId)`；宿主侧靠 Gateway 的 SRC 发现从服务
  原型标记 + 函数签名自动推参，零宿主配置；客户端手写 typert 描述符经 `$mount` 挂载
  （strict codec 占位实现，运行时不消费）。
- 聊天流标记行（`conversation.chat.commandview`，key side/btw）替代默认整段答案卡片。
- 路由：配置覆盖 > 会话请求头（`requestHeader().config`）> 全局默认选择；自动取最低
  推理档；90s 超时；截断但有正文降级成功。
- 测试 24 例：Host 纯函数 12 + 真实 cordis Context 服务冒烟 6 + 客户端描述符校验/
  帧归约/Markdown/挂载注册 6；GUI 实测浮层流式正常。
