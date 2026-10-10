# dsh-side-chat

English | [中文](README.md)

Side questions for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): `/side` (alias `/btw`) answers a quick question from the current session's context in a streaming overlay, with **zero pollution of the main conversation's model context**. Modeled after Claude Code's `/btw` and Codex's `/side`.

```
/side what was that config file called again?
```

- **Zero history pollution** — exchanges live only in plugin memory (cleared on restart); the question text never enters the session log (`recordInput: false`), and command lifecycle events are log-only and never sent to the model.
- **Full context** — the session's model-visible history is folded into a reference digest (full when within budget, newest-first otherwise), plus your last N side exchanges, so answers can cite tool calls and results.
- **Never interrupts the main turn** — each side question is an independent `llm.stream` call (no tools, lowest reasoning effort) that opens no turn; ask while the agent is working.
- **Streaming overlay** — answers stream into a frame-level overlay: `Esc` dismisses, `c` copies, `x` clears memory, `[` `]` (or Shift+arrows) browse earlier exchanges.
- **Follows your routing** — uses the session's current model by default, or a dedicated cheap model via config.

## Why a plugin

1. dsh's command registry (`ctx.commands.register`) is a public extension point, so `/side` shows up in the slash menu like a built-in and works from any UI (Web / headless).
2. `llm.stream` lets a plugin fire model calls fully independent of the agent loop.
3. `shell.overlay` (frame-wide floating layer) and session-scoped slots are official low-risk UI seats — the overlay never touches the chat flow.
4. dsh already ships `subagent` (with tools, forkable) for deep-dives; this plugin covers the "quick aside" layer only.

## Install

### 1. Add the package (either way)

```bash
# from GitHub (git spec)
dsh plugin --profile <profile> add zycFrancis/dsh-side-chat

# or a local path
dsh plugin --profile <profile> add /absolute/path/to/dsh-side-chat
```

The Plugins page in the Web UI sidebar or the `plugin_manager` tool works too.

### 2. Configure (optional)

Nothing needs to be disabled — install and go. To pin a route or tune budgets, override in the profile's `cordis.patch.yml`:

```yaml
- id: side-chat
  name: dsh-side-chat
  config:
    # provider: zai-coding-cn   # pin a cheap model; defaults to the session's model
    # model: glm-5.3-flash
    maxInputBytes: 24576        # reference-digest byte budget
    maxExchanges: 20            # side exchanges kept in memory
```

### 3. Refresh the page

After first install, refresh the Web page once so the overlay module loads with the boot graph. Host-side commands go live via HMR immediately.

## Usage

| Input | Behavior |
|---|---|
| `/side <question>` | Ask; the overlay opens and streams the answer |
| `/btw <question>` | Same (alias) |
| `/side` (empty) | Reopen the overlay on the latest exchange |

Keys while the overlay is open:

| Key | Behavior |
|---|---|
| `Esc` / backdrop click | Dismiss (a streaming answer keeps finishing in the background and is remembered) |
| `c` | Copy the current answer as raw Markdown |
| `x` | Clear this session's side-exchange memory |
| `[` `]` / Shift+←→ | Browse earlier exchanges |

The main chat shows only a subtle "answered" marker row; the full answer stays in the `command/done` event for headless UIs and later retrieval.

## Config

| Field | Default | Notes |
|---|---|---|
| `provider` / `model` | unset | Route for side requests; a cheap model is recommended. Falls back to the session's current model, then the global default selection |
| `maxInputBytes` | 24576 | Reference-digest byte budget; newest-first, the newest entry always survives (tail-truncated if oversized) |
| `maxToolResultChars` | 400 | Per-tool-result truncation inside the digest |
| `maxOutputTokens` | 2048 | Answer token cap |
| `timeoutMs` | 90000 | Per-stream timeout |
| `maxExchanges` | 20 | Side exchanges kept in memory (truncated on both write and read) |
| `systemExtra` | empty | Extra instructions appended to the side system prompt |

## Behavior notes

- **Digest strategy** — `session.deriveMessages()` yields the model-visible history (projections applied); text passes through, images/files/tool calls become one-line markers, reasoning is skipped, tool results are paired with their tool name by `toolCallId` and truncated. The request is digest + replayed side exchanges + the question, under a dedicated no-tools system prompt.
- **Reasoning effort** — the lowest effort is resolved by semantic keyword ladder (off-class → low → medium; dsh-llm gives no ordering contract on efforts); absent info, the call goes without an effort.
- **Failure semantics** — a truncated-but-nonempty answer succeeds with a note; empty output or stream errors surface as an error result and in the overlay.
- **Cost** — the digest prefix differs from the main conversation, so no prefix-cache reuse: each side question costs roughly one small standalone request.
- **In-memory only** — exchanges live in a `Map<sessionId, Exchange[]>`, cleared on host restart (matching Claude `/btw` semantics); dsh forbids plugin-defined session event types, so none are written.

## Troubleshooting

- `/side` missing from the slash menu — check the plugin row is enabled and the host log is clean.
- Overlay never opens — refresh the page; search the browser console for `dsh-side-chat` (slot entry crashes, `$mount` failures).
- "cannot resolve a model route" — the session has no request header yet; send one message first or configure `provider`/`model`.
- Truncated answers — raise `maxOutputTokens` / `maxInputBytes`.

## Development

```bash
pnpm install
npm test        # node --test: host pure functions + real cordis-Context smoke + client frame/store/mount (24 cases)
```

Design and mechanisms (SRC discovery, hand-written remote descriptors, frame protocol, the zero-pollution path) are documented in [docs/design.md](docs/design.md).

## License

MIT
