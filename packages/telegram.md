# `@justfortytwo/telegram`

The **Telegram channel adapter** for fortytwo: a standalone, always-on
bridge connecting a Telegram bot to persistent Claude Code sessions through
`@justfortytwo/runner`.

- **Version:** `1.2.0` · **Runtime:** long-running bridge, `bin` is
  `fortytwo-telegram-bridge` · **Node:** >= 20

## Why this exists

The assistant needs a channel that reaches the owner where they already are.
telegram owns Telegram identity, pairing, message transport, attachment
handling, and the chat → live-session mapping. It delegates the agent process
lifecycle entirely to runner; it makes no provider or model decisions.

## Behavior

1. **Transport.** Each active authorized chat normally has one live
   RunnerSession. After authorization, attachment ingestion and optional
   conversation logging, input waits only for `session.send()` to write it.
   Polling continues while Claude works; another message goes to the same session
   immediately after preprocessing.
2. **Output and deferrals.** The bridge coalesces complete assistant-message
   events into an evolving Telegram reply and edits it at most once per second
   during streaming. A result finalizes the reply; long replies use additional
   messages of at most 4000 UTF-16 units. Typing refreshes while submitted
   inputs await results. Deferred results produce a plain notice: Telegram
   cannot authorize the action. Claude Code owns tool permissions; gate is
   optional policy through Claude hooks/plugins. With `TELEGRAM_APPROVALS` set
   (since 1.0.3), a deferral the gate staged as pending becomes a card with
   **Approve** / **Deny** buttons showing the tool and its exact input. A tap
   on the current card records the decision in the gate's approval store
   (`approvalsPath`) and restarts the chat's Claude process on its saved
   session with no input; the gate's hook then allows the call once or denies
   it. A new message while a request waits denies it. An input over 3500
   characters, or one containing a code fence, gets a notice without buttons.
   A typed "yes" is never an approval.
3. **Scheduler separation.** Proactive wakes remain the responsibility of the
   external `@justfortytwo/scheduler` daemon.
4. **Context from elsewhere.** A reply to an earlier message carries that
   message's text (or the selected part, cut at 4000 characters) in front of
   the new one (since 1.0.4). Messages the scheduler sent since the owner's
   previous message in that chat (conversation log, channel `scheduler`; at
   most the latest 5, each cut at 3000 characters) are put in front of the
   next inbound message (since 1.0.5; needs `@justfortytwo/transcript`). The
   bridge marks both as context, not as new instructions. It tracks this
   with a per-chat cursor (`scheduledSeen` in the state file): a chat's first
   message with no cursor carries none, at most the last 2000 log entries are
   scanned, and only messages that reach Claude advance the cursor (not
   `/login`, `/logout` or `/start`).
5. **Local commands.** `/start` gets a fixed online notice from the bridge
   and never reaches Claude. Other `/command` text reaches Claude marked as
   a Telegram bot command, not a Claude Code slash command.

### Attachments

Inbound messages can carry attachments: photos (`telegram_photo`), documents
(`telegram_document`), voice notes (`telegram_voice`) and audio files
(`telegram_audio`). Each is downloaded within the byte limit,
stored under the inbox store dir as `<chat>/<message>[-<n>].<ext>` (`<n>` is
the attachment index, omitted for the first), and handed to the session as an
untrusted-content attachment with a gate provenance envelope. The extension
comes from Telegram's declared mime type (photos are always `image/jpeg`),
else from the file name's extension, else `bin`; bytes are not sniffed.
Telegram never sends a file name for voice notes, and the bridge does not
invent one: the stored name is built from the chat id, message id and
attachment index for every kind. The bridge skips files over the download
limit and reports them.

The limit and the store dir come from `config/adapters.toml`:
`[attachments] max_bytes` (default 26214400, 25 MiB) and `store_dir`
(default `inbox`, relative to `FORTYTWO_ROOT`). `[channel.telegram] enabled`
is parsed but the bridge does not read it.

Limitation: the agent receives the stored file path only; nothing transcribes
audio yet. Transcription, video and video-note ingestion, and richer handling
of oversized files are tracked separately.

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

Since telegram 1.2.0 the bridge passes every session an output note through
`--append-system-prompt`. Telegram does not render Markdown tables, so the note
asks Claude for compact lists in chat replies; files it writes are not
affected. If the operator sets `--append-system-prompt` in
`FORTYTWO_CLAUDE_ARGS`, the bridge keeps that value and adds the note after it.
A resumed session keeps its history, and Claude may keep answering with tables
if earlier replies used them; starting a new session fixes it (see the homelab
guide).

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
replay. One exception: an input rejected because the process had already
died (before its exit event was seen) is sent once more to a resumed
session.

SIGINT/SIGTERM abort polling, stop new session work and deterministically
close live RunnerSessions.

## Pairing / login binding model

The bot is **locked down**: an unbound sender without a valid `/login` gets
**no response at all**. A chat gets access through a channel-agnostic
challenge/verify pairing flow:

```text
owner side:    adapter.issueChallenge(owner)  ->  { code, ttl }
channel side:  /login <code>                  ->  verify(chatId, code) -> binding
```

- `issueChallenge(owner)` mints a **single-use, short-TTL** code (default 6
  digits, 5 minutes). The owner relays it out-of-band to the chat to bind.
- `/login <code>` verifies it and persists a binding
  `(channelType, channelUserId) -> owner`. A chat that already holds a
  binding is refused ("already paired") until it sends `/logout`.
- Only private chats can pair or be authorized: group and channel chat IDs
  (negative) are always dropped, even if listed in `ALLOWED_CHAT_IDS`.
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
| `SqliteBindingStore` | default: a tiny `better-sqlite3` db in its own file (the bridge uses `state/telegram-bindings.db`; the constructor alone defaults to `telegram-bindings.db` in the cwd) holding bindings + pending challenges |
| `MemoryBindingStore` | in-process Map, for tests / ephemeral use |
| `BindingStore` | the injectable interface |

If fortytwo later standardizes a shared identity table, swap the default for
a memory-backed `BindingStore`; the login flow is unaffected.

## Dependencies

| Package | Used for | Contract |
| --- | --- | --- |
| `@justfortytwo/runner` (pinned `1.0.1`) | Claude process/session lifecycle | library API |
| `@justfortytwo/gate` (regular dep `^1.0.0`) | `createSourceEnvelope` provenance helper in `attachments.ts`; the gate's approval store for opt-in Telegram approvals; the *policy hook* stays optional and separately configured | `createSourceEnvelope`, `JsonlApprovalStore`, `approvalsPath`, `ApprovalStore` (type) |
| `@justfortytwo/memory` (optional peer, loaded dynamically) | opens + migrates the shared DB at startup and builds the embedder; recall happens inside the headless `claude` turn via the memory MCP tools | `openDb`, `runMigrations`, `OllamaEmbedder`, `FakeEmbedder` |
| `@justfortytwo/transcript` *(new, optional peer `^1.0.0`, loaded dynamically)* | the `ConversationLog` implementation that persists each channel event, and the cursor API that reads scheduler messages back (see below) | `prepareTranscript`, `createTranscript`; optional `transcriptHead`, `transcriptDelta` |
| `@justfortytwo/scheduler` (optional peer `^2.0.0`, loaded dynamically) | the reply queue: the `jobs` table and job API | `runSchedulerMigrations`, `enqueue`, `existsPending` |

If the memory peer is absent, the bridge degrades to **channel-only**
(messages relay but are not persisted) rather than refusing to start.

The reply queue needs memory **and** the scheduler. It carries one thing:
the "Something went wrong" notice the bridge sends after a handler error,
when that notice also fails to send inline. It becomes a `reply` job for the
scheduler, deduped per chat. Normal Claude replies are never queued. The
scheduler owns the `jobs` table since 2.0.0. The bridge runs `runSchedulerMigrations` after
memory's migrations and checks `existsPending` before it enqueues. Without the
scheduler, or with one older than the job API, such replies are dropped and the
bridge says so on stderr. memory is accepted as `^0.1.5 || ^1.0.0 || ^2.0.0`.

### Conversation log

The bridge no longer stores chat in memory (memory holds facts only). It
writes every inbound and outbound event through a small port it defines
itself, `ConversationLog` (`src/conversation-log.ts`):

```ts
interface ConversationLog {
  append(event: ConversationEvent): Promise<unknown>;
  scheduledSince?(after: LogCursor | undefined): { cursor: LogCursor; messages: ScheduledMessage[] };
}
```

- The port is structural: telegram imports no transcript or memory types for
  it. The event carries `channel`, `direction`, `actor`, `kind`, `content`,
  and optional `threadId` and `meta`.
- `loadConversationLog(h, embedder)` dynamically imports
  `@justfortytwo/transcript`, calls `prepareTranscript` and
  `createTranscript`. When transcript also has `transcriptHead` and
  `transcriptDelta`, it adds `scheduledSince` (built by the exported
  `scheduledReader`), which feeds the scheduler-message context. If
  transcript is not installed, or loading fails, it
  logs to stderr and returns `noopConversationLog`, preserving channel-only
  behavior. The bridge's composition root uses the no-op when memory itself is
  absent.
- **Fire-and-forget.** The bridge never awaits the log in the reply path;
  a failed `append` (sync or async) is logged and the bridge continues. A slow
  embedding can never delay a reply or stall the poll loop. Call order is
  preserved because `append` inserts synchronously.

## Environment

| Var | Required | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token. The bridge is the **only** long-poller on this bot. |
| `ALLOWED_CHAT_IDS` | no | Comma-separated private-chat IDs authorized without a binding. Negative (group/channel) IDs are always refused. |
| `CLAUDE_BIN` | no | Path to `claude` (default `claude`). |
| `FORTYTWO_CLAUDE_ARGS` | no | Extra arguments for every `claude` run, as a JSON array of strings (e.g. `["--chrome"]`). Set by `fortytwo start -- <args>`. A malformed value stops the bridge at boot. |
| `TELEGRAM_APPROVALS` | no | `1`/`true`/`yes`/`on` lets authorized chats approve or deny actions held by the gate's hook. Off by default; `fortytwo start` sets it when the gate is on (`fortytwo gate on`). |
| `TELEGRAM_BINDINGS_DB` | no | Bindings db path, relative to `FORTYTWO_ROOT` (default `state/telegram-bindings.db`). |
| `DB_PATH` | no | Memory db path, relative to `FORTYTWO_ROOT` (default `db/fortytwo.db`). |
| `EMBED_MODEL` / `OLLAMA_BASE_URL` | no | Ollama embedder handed to the conversation log (vectors are produced in the background). Without `EMBED_MODEL` the log gets memory's deterministic `FakeEmbedder`. |
| `ASSISTANT_NAME` / `ASSISTANT_ACTOR` / `OWNER_ACTOR` | no | Display name + conversation-log actor labels. Keep `OWNER_ACTOR` at its default `owner`: Oneiros counts only inbound Telegram messages with actor `owner` as owner evidence, so another label stops persona consolidation from learning from chat. |
| `FORTYTWO_ROOT` | no | Working root for the headless `claude` process + state files (`FORD_ROOT` is a deprecated alias). Default: the package directory (the parent of `dist/`). |

Proxy auth for the headless `claude` session is not read here. The CLI reads
`ANTHROPIC_*` from its own config. The bridge also loads
`config/adapters.toml` from `$FORTYTWO_ROOT/config/`.

## Running it

```sh
npm run build
node dist/bridge.js
```

Run under a restart loop (tmux/systemd), or under `fortytwo start`, which
supervises it together with the scheduler. Attachments: photo/document
captions are preserved in the same Claude turn as attachment details and
in inbound conversation-log text; message text takes precedence when present.

Exports: the package root (`dist/index.js`) exposes the transport, attachment,
binding, login and conversation-log APIs, plus `telegramNotifier` (a
scheduler `Notifier` for one chat) and `enqueueReply` (the deduped reply-job
enqueuer). The `./bridge` subpath exposes the bridge module itself, including
`withTelegramOutputPrompt`, `TELEGRAM_OUTPUT_PROMPT`, `createBridgeSessions`,
`handleInbound` and `pollLoop`.

## Notable API history

`1.0.0-4` removed approval buttons for deferred tools (intentional public API
change: `approvalKeyboard`, `ApprovalKeyboardOptions`, `formatApprovalCard`
are gone). Old buttons only report that the control is unsupported; they
never submit a Claude turn or change approval state.

`1.0.3` brought approval buttons back as an opt-in (`TELEGRAM_APPROVALS`),
built on the gate's approval store instead of bridge-owned state, with new
exports `Approvals` (type), `approvalsEnabled` and `formatApprovalRequest`;
the internal `ChatSessions` class (not exported) gained `resume()`. Without
the setting, the `1.0.0-4` behavior applies.

`1.2.0` adds the Telegram output note (see Session lifecycle and recovery).

## Testing

```sh
npm run build && npm test    # vitest run; fake runners only
```

An end-to-end concurrency check against a real Claude Code is documented in
the repo README (test bot, mid-turn second message, restart-resume).

## Scope

**In scope:** Telegram identity, pairing/bindings, message transport,
attachment ingestion + provenance, chat→session mapping, reply coalescing,
writing channel events through the injected `ConversationLog` (persistence is
owned by `@justfortytwo/transcript`).

**Out of scope:** agent execution (Claude Code), process lifecycle (runner),
proactive wakes (scheduler), durable tool authorization (Claude Code
permissions), policy enforcement (gate, optional), transcription of audio
attachments and video / video-note ingestion (tracked separately).
