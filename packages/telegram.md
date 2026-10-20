# `@justfortytwo/telegram`

The **Telegram channel adapter** for fortytwo — a standalone, always-on
**bridge** connecting a Telegram bot to persistent Claude Code sessions through
`@justfortytwo/runner`.

- **Version:** `1.0.0-7` · **Runtime:** long-running bridge, `bin` is
  `fortytwo-telegram-bridge` · **Node:** >= 20

## Why this exists

The assistant needs a channel that reaches the owner where they already are.
telegram owns Telegram identity, pairing, message transport, attachment
handling, and the chat → live-session mapping. It delegates the agent process
lifecycle entirely to runner — it makes no provider or model decisions.

## Behavior

1. **Transport.** Each active authorized chat normally has one live
   RunnerSession. After authorization, attachment ingestion and optional
   journaling, input waits only for `session.send()` to write it. Polling
   continues while Claude works; another message goes to the same session
   immediately after preprocessing.
2. **Output and deferrals.** Complete assistant-message events are coalesced
   into an evolving Telegram reply, edited at most once per second during
   streaming. A result finalizes the reply; long replies use additional
   messages of at most 4000 UTF-16 units. Typing refreshes while submitted
   inputs await results. Deferred results produce a plain notice: Telegram
   cannot authorize the action — Claude Code owns tool permissions; gate is
   optional policy through Claude hooks/plugins.
3. **Scheduler separation.** Proactive wakes remain the responsibility of the
   external `@justfortytwo/scheduler` daemon.

### Typing indicator lifecycle

Each chat owns one typing refresher while Claude works. Sending a message
turns it on; so does Claude consuming a queued input. Every result turns it
off before final-message delivery, so messages sent mid-turn (steering,
answered together in one result) cannot leave it stuck. Fatal session errors,
exit, logout and shutdown cancel it. Typing is not a turn timeout: silent but
active work keeps refreshing; late output cannot restart typing after a
result.

## Session lifecycle and recovery

The bridge owns the chat-to-session mapping. Runner owns the Claude process
and stream transport; Claude Code owns the agent. The runner inherits process
configuration and receives `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` explicitly,
without changing `process.env`. Persistent sessions have no default
wall-clock turn timeout.

Claude stays alive between messages. When runner exposes a session ID, the
bridge writes it to `sessions` in `state/bridge-state.json`. After a bridge
restart, the next authorized message lazily creates a session with
`resumeSessionId`. These IDs are **recovery hints**: the state file is not a
transactional message queue, and in-flight inputs, partial replies, or
unobserved IDs can be lost on a crash. Recovery also requires Claude Code's
underlying session data to remain available.

An unexpected Claude exit removes the live mapping, retains the last known
ID, and reports an error if input was awaiting a result. The next message
attempts resumption; there is no automatic restart supervisor or input
replay.

SIGINT/SIGTERM abort polling, stop new session work and deterministically
close live RunnerSessions.

## Pairing / login binding model

The bot is **locked down**: an unbound sender without a valid `/login` gets
**no response at all**. Access is earned through a channel-agnostic
challenge/verify pairing flow:

```text
owner side:    adapter.issueChallenge(owner)  ->  { code, ttl }
channel side:  /login <code>                  ->  verify(chatId, code) -> binding
```

- `issueChallenge(owner)` mints a **single-use, short-TTL** code (default 6
  digits, 5 minutes). The owner relays it out-of-band to the chat to bind.
- `/login <code>` verifies it and persists a binding
  `(channelType, channelUserId) -> owner`.
- `/logout` removes the binding and closes the live session (recovery IDs
  remain).
- Every inbound message is authorized against **persisted bindings ∪ the
  optional `ALLOWED_CHAT_IDS` bootstrap set**. On a fresh install (no
  allowlist, no bindings) the bridge still starts, locked down; the first
  chat pairs with `/login <code>` using a code from `fortytwo pair`.

Pending challenges are **persisted in the binding store** (not process
memory), so a code minted by the `fortytwo pair` CLI is redeemable by the
separately-running bridge. The contract is intentionally channel-agnostic
(`ChannelAdapter` in `src/adapter.ts`) so a future Slack/email/SMS adapter
implements the same shape.

### Binding store

Authorization must work **even when memory is absent**, so the binding store
is self-owned:

| Implementation | Role |
| --- | --- |
| `SqliteBindingStore` | default — tiny `better-sqlite3` db in its own file (`state/telegram-bindings.db`) holding bindings + pending challenges |
| `MemoryBindingStore` | in-process Map, for tests / ephemeral use |
| `BindingStore` | the injectable interface |

If fortytwo later standardizes a shared identity table, swap the default for
a memory-backed `BindingStore` — the login flow is unaffected.

## Dependencies

| Package | Used for | Contract |
| --- | --- | --- |
| `@justfortytwo/runner` (pinned `1.0.0-1`) | Claude process/session lifecycle | library API |
| `@justfortytwo/gate` (regular dep) | `createSourceEnvelope` provenance helper in `attachments.ts` — the *policy hook* stays optional and separately configured | `POLICY_SCHEMA_VERSION` |
| `@justfortytwo/memory` (optional peer, loaded dynamically) | opens + migrates the memory DB at startup and persists each channel event; recall happens inside the headless `claude` turn via the memory MCP tools | `MEMORY_TOOL_CONTRACT_VERSION` |

If the memory peer is absent, the bridge degrades to **channel-only**
(messages relay but are not persisted) rather than refusing to start.

## Environment

| Var | Required | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token. The bridge is the **only** long-poller on this bot. |
| `ALLOWED_CHAT_IDS` | no | Chat IDs authorized without a binding. |
| `CLAUDE_BIN` | no | Path to `claude` (default `claude`). |
| `TELEGRAM_BINDINGS_DB` | no | Bindings db path (default `state/telegram-bindings.db`). |
| `DB_PATH` | no | Memory db path (default `db/fortytwo.db` relative to `FORTYTWO_ROOT`). |
| `EMBED_MODEL` / `OLLAMA_BASE_URL` | no | Embedder for memory persistence. |
| `ASSISTANT_NAME` / `ASSISTANT_ACTOR` / `OWNER_ACTOR` | no | Display name + journal actor labels. |
| `FORTYTWO_ROOT` | no | Working root for the headless `claude` process + state files (`FORD_ROOT` is a deprecated alias). |

Proxy auth for the headless `claude` session is not read here — the CLI reads
`ANTHROPIC_*` from its own config. The bridge also loads
`config/adapters.toml` from `$FORTYTWO_ROOT/config/`.

## Running it

```sh
npm run build
node dist/bridge.js
```

Run under a restart loop (tmux/systemd) — or under `fortytwo start`, which
supervises it together with the scheduler. Attachments: photo/document
**captions** are preserved in the same Claude turn as attachment details and
in inbound journal text; message text takes precedence when present.

## Notable API history

`1.0.0-4` removed approval buttons for deferred tools (intentional public API
change: `approvalKeyboard`, `ApprovalKeyboardOptions`, `formatApprovalCard`
are gone). Old buttons only report that the control is unsupported; they
never submit a Claude turn or change approval state.

## Testing

```sh
npm run build && npm test    # vitest run; fake runners only
```

An end-to-end concurrency check against a real Claude Code is documented in
the repo README (test bot, mid-turn second message, restart-resume).

## Scope

**In scope:** Telegram identity, pairing/bindings, message transport,
attachment ingestion + provenance, chat→session mapping, reply coalescing,
journal persistence via memory.

**Out of scope:** agent execution (Claude Code), process lifecycle (runner),
proactive wakes (scheduler), durable tool authorization (Claude Code
permissions), policy enforcement (gate, optional).
