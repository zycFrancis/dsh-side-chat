# dsh-side-chat

[![CI](https://github.com/zycFrancis/dsh-side-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/zycFrancis/dsh-side-chat/actions/workflows/ci.yml)

[English](README.en.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 增加 **侧问**：`/side`（别名 `/btw`）基于当前会话上下文快速提问，答案在浮层里流式展示，**完全不进入主对话的模型上下文**。对标 Claude Code 的 `/btw` 与 Codex 的 `/side`。

```
/side 刚才改的那个配置文件叫什么来着？
```

- **零历史污染**：问答只存在插件内存里（重启即清），问题文本经 `recordInput: false` 不落会话日志；命令生命周期事件是 log-only，永远不会发给模型。
- **上下文齐全**：把当前会话的模型可见历史折叠成参考摘要（预算内全量、超预算从最新向前装满），再带上最近 N 条侧问记忆一起作答——能看到工具调用与结果的一行摘要。
- **主回合不打断**：侧问走独立的 `llm.stream` 调用（无工具、最低推理档），不开启 turn，主任务运行中也能问。
- **流式浮层**：答案在帧级浮层里打字机式展示，Esc 关闭、`c` 复制、`x` 清空记忆、`[` `]`（或 Shift+方向键）翻历史侧问。
- **路由跟随**：默认用会话当前模型；也可在配置里指定便宜小模型专门跑侧问。

## 为什么是插件

1. dsh 的命令注册表（`ctx.commands.register`）是公开扩展点，`/side` 可以像内置命令一样出现在斜杠菜单里，任何 UI（Web / headless）都能用；
2. `llm.stream` 允许插件发起与主回合完全独立的模型调用，无需碰 agent loop；
3. `shell.overlay`（帧级浮层）与 session 范围 slot 是官方预留的低风险 UI 落点，浮层不必侵入聊天流；
4. dsh 已有 `subagent`（带工具、可 fork）覆盖"深挖"场景，本插件专注"快速旁路一问"这一层。

## 安装

### 1. 安装包（任选其一）

```bash
# 从 GitHub(git 规格)
dsh plugin --profile <profile> add zycFrancis/dsh-side-chat

# 或本地路径
dsh plugin --profile <profile> add /absolute/path/to/dsh-side-chat
```

也可以用 Web UI 侧边栏的**插件**页或 `plugin_manager` 工具安装。

### 2. 配置（可选）

本插件无需停用任何内置条目，安装即用。需要固定路由或调预算时，在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: side-chat
  name: dsh-side-chat
  config:
    # provider: zai-coding-cn   # 显式指定便宜小模型;不配则跟随会话当前模型
    # model: glm-5.3-flash
    maxInputBytes: 24576        # 参考摘要字节预算
    maxExchanges: 20            # 内存保留的侧问条数
```

### 3. 刷新页面

首次安装后刷新一次 Web 页面，客户端浮层模块随 boot graph 加载（之后无需再刷）。宿主侧命令经 HMR 即时生效。

## 使用

| 输入 | 行为 |
|---|---|
| `/side <问题>` | 发起一次侧问，浮层弹出流式作答 |
| `/btw <问题>` | 同上（别名） |
| `/side`（空） | 重新打开浮层，展示最近一组侧问 |

浮层出现后的按键：

| 键 | 行为 |
|---|---|
| `Esc` / 点击背景 | 关闭浮层（流式中的答案继续在后台完成并记忆） |
| `c` | 复制当前答案（原始 Markdown 文本） |
| `x` | 清空该会话的侧问记忆 |
| `[` `]` / Shift+←→ | 在历史侧问之间浏览 |

主对话的聊天流里只会出现一行低调的"侧问已答"标记（不整段重复答案）；`command/done` 事件里保留完整答案文本，供 headless 等无浮层环境显示与事后检索。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | 未设 | 侧问请求的路由；建议显式指定便宜小模型，不设则跟随会话当前模型（无请求头时退回全局默认选择） |
| `maxInputBytes` | 24576 | 参考摘要字节预算；超预算从最新向前装满为止，连最新一条都超预算时截尾保一条 |
| `maxToolResultChars` | 400 | 单条工具结果文本进入摘要的截断上限 |
| `maxOutputTokens` | 2048 | 侧问回答输出上限 |
| `timeoutMs` | 90000 | 单次流式调用超时 |
| `maxExchanges` | 20 | 内存保留的侧问条数（读写两侧都截断） |
| `systemExtra` | 空 | 追加到侧问系统提示词末尾的额外指令 |

## 行为细节

- **摘要策略**：`session.deriveMessages()` 取模型可见历史（投影已应用），文本直取；图片/文件/工具调用留一行标记；reasoning 跳过；工具结果按 `toolCallId` 配对工具名并截断。摘要作为首条 user 消息 + 历史侧问原样回放 + 本次问题，交给独立的系统提示词（无工具、参考只读、简洁作答）。
- **推理档**：自动解析模型最低推理档（语义关键词阶梯，off 类 → low 类 → medium 类；dsh-llm 对 efforts 顺序无契约），查不到就不带档位裸调。
- **失败语义**：截断但有正文时降级成功并标注"输出被截断"；空正文或流错误返回 error 结果并在浮层展示。
- **成本**：摘要前缀与主对话请求不同，吃不到前缀缓存，每次侧问≈一次独立小请求（输入=摘要+侧问记忆+问题）。
- **内存态**：侧问记忆 `Map<sessionId, Exchange[]>` 纯内存，宿主重启即清（对齐 Claude `/btw` 的"退出即失"语义）；dsh 禁止插件自定义会话事件类型，本插件因此不落任何自定义日志事件。

## 排查

- 斜杠菜单里没有 `/side`：确认插件行已启用（插件页或 `dsh plugin list`），宿主日志无加载报错。
- 浮层不弹：刷新页面；浏览器 Console 搜 `dsh-side-chat`（重点看 slot entry crashed 或 `$mount` 失败）。
- 提示"无法确定模型路由"：会话还没发过消息（无请求头），先在会话里发一条消息，或配置 `provider`/`model`。
- 答案不完整：提高 `maxOutputTokens` 或 `maxInputBytes`；确认模型未思考耗尽输出预算（插件已默认取最低推理档）。

## 开发

```bash
pnpm install
npm test        # node --test:Host 纯函数 + 真实 cordis Context 冒烟 + 客户端帧归约/挂载(共 24 例)
```

设计与机制（SRC 发现、手写远程描述符、帧协议、零污染路径）见 [docs/design.md](docs/design.md)。

## License

MIT
