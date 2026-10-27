# `@justfortytwo/scheduler`

Durable job scheduler daemon for fortytwo. Drains a `jobs` queue stored in
`@justfortytwo/memory` and fires LLM turns only behind a cheap "is there
work?" gate.

The design rationale — durable jobs, token gating, crash safety, event hooks —
is in [Scheduler & Durable Jobs](../scheduler.md). This page documents the
package as built.

- **Version:** `1.0.0` · **Runtime:** standalone daemon, `bin` is
  `fortytwo-scheduler` · **Node:** >= 20

## Why this exists

Proactive behavior (briefings, sweeps, reminders) needs *durable time*: work
that survives restarts, is de-duplicated, and never spends an LLM turn when
there is nothing to do. The scheduler owns **when** work happens, never how
the agent reasons about it.

## Components

| Component | File | Role |
|-----------|------|------|
| Handler registry | `src/registry.ts` | maps job `kind` → `Handler` |
| `tick()` | `src/tick.ts` | pure, fully injectable: claim due jobs → gate check → enqueue run → notify → reschedule/complete; backoff on error |
| Daemon | `src/daemon.ts` | croner + p-queue (concurrency 1) wiring around `tick()`, ~30 s poll |
| Recurring seeds | `src/seed.ts`, `src/handlers/index.ts` | idempotent seeding of `RECURRING_DEFS` on every boot; only inserts/updates rows when a definition changes |
| Heartbeat | `src/heartbeat.ts` | liveness file for `fortytwo doctor` |
| Oneiros | `src/oneiros.ts` | persona maintenance job (see below) |
| Notifier | `src/notifier.ts` | optional Telegram push |

## Library usage

```ts
import { createRegistry, tick } from '@justfortytwo/scheduler';

const registry = createRegistry([myHandler]);

await tick({
  claimDue, complete, fail, registry,
  recurrenceNext, enqueueRun, notify,
}, new Date().toISOString());
```

`Handler` shape: `{ kind, run(ctx), hasWork?(ctx) }`. A `hasWork` gate is the
cheap check that runs **before** an LLM turn is spent.

## Job kinds (as built)

| kind | schedule | gate | behavior |
|------|----------|------|----------|
| `daily_briefing` | `57 7 * * *` UTC | none | runs the daily-briefing skill and sends the rundown |
| `sweep` | `3 13,18 * * *` | pending approvals > 0 | open-thread sweep, one-line status |
| `learn_review` | `17 9 * * 0` | recent memory rows (7 d) > 0; counts facts only, since chat and notifications moved to the transcript | propose-only pattern promotion from recent memory |
| `notify_pending` | one-off | none | notify about pending items |
| `reply` | one-off | none | send a reply via the runner |
| `reminder` | one-off | none | send a reminder via the runner |
| `reembed_memory` | maintenance | none | re-embeds one memory by id in-place (**no LLM**, no notification) |
| `persona.oneiros` | `17 3 * * *` UTC | memory-head or transcript-head check | persona maintenance (below) |

## Oneiros maintenance

`persona.oneiros` runs daily at `17 3 * * *` UTC with null payload and the
existing durable retry/claim mechanism. The installer seeds it after
initializing persona's checkpoint; daemon boot reconciles the same job when
the checkpoint exists. The cheap gate checks both evidence heads: the memory
head and, when `@justfortytwo/transcript` loads, the transcript head
(`loadTranscriptSource` in `src/oneiros.ts` adapts `transcriptHead` /
`transcriptDelta`). Without transcript only the memory stream runs.

Persona validates and applies additions; the scheduler runs the private
prompt through `@justfortytwo/runner` in an isolated temporary cwd:

```text
--safe-mode --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'
--disable-slash-commands --no-session-persistence --setting-sources ''
--system-prompt <workerPrompt>
```

No tools, MCP, skills or session persistence are enabled; maintenance emits no
notification into memory. Authentication/provider configuration is preserved.
Requires a Claude CLI with `--safe-mode` — unsupported flags **fail closed**.

## Running it

The daemon is a long-running process — run it under a restart loop (tmux for
development, systemd for production) or under `fortytwo start`, which
supervises it together with the Telegram bridge.

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_PATH` | yes | absolute path to `fortytwo.db` |
| `EMBED_MODEL` | recommended | Ollama embedding model (falls back to FakeEmbedder) |
| `OLLAMA_BASE_URL` | no | default `http://localhost:11434` |
| `CLAUDE_BIN` | no | `claude` CLI path the runner spawns (default: `claude` on `PATH`) |
| `FORTYTWO_TURN_TIMEOUT` | no | per-turn timeout in seconds (default `300`) |
| `TELEGRAM_BOT_TOKEN` | optional | enables Telegram push notifications |
| `ALLOWED_CHAT_IDS` | optional | comma-separated chat IDs to push to |

### Liveness

On boot and on every 30-second poll tick — even while a previous tick is still
in flight — the daemon writes `$(dirname $DB_PATH)/scheduler.heartbeat`
containing `{ "pid", "ts" }`. The write is outside the poll's overlap guard so
a long-running turn never starves it. `fortytwo doctor` warns (non-fatal) if
the file is missing or older than 90 seconds.

## Notification journal

Every notification is fanned out to a journal notifier plus optional extra
notifiers (e.g. Telegram). The journal notifier no longer writes
`scheduler:wake` memories: it appends to the transcript through a
`ConversationLog` port that scheduler defines itself
(`src/conversation-log.ts`), with channel `scheduler`, direction `outbound`,
actor `assistant` and kind = the notification kind.

- The port is structural; scheduler imports no transcript or memory types for
  it. `loadConversationLog(h, embedder)` imports `@justfortytwo/transcript`
  dynamically and falls back to `noopConversationLog` (logged to stderr,
  journal entries then are not recorded) if it is missing or fails.
- **Fire-and-forget.** `makeJournalWrite` never propagates failures, so a
  broken transcript cannot affect the job or other notifiers.
- The `learn_review` gate (`recentCount`) counts memory rows from the last
  7 days. With chat and notifications gone from memory it counts facts only,
  so it fires less often; this is accepted as is.

## Dependencies

- `@justfortytwo/memory` (pinned `1.0.0`) — the `jobs` table and `JobStore`.
- `@justfortytwo/runner` — LLM turns for handlers.
- `@justfortytwo/persona` (pinned `1.0.0`) — Oneiros `hasWork`/`refine`/
  `workerPrompt`.
- `@justfortytwo/telegram` — **optional peer**; enables the Telegram notifier.
- `@justfortytwo/transcript` *(new)* — **optional peer**; receives journal
  entries and serves the Oneiros transcript stream.

## Testing

```sh
npm run build
npm test        # vitest run
```

## Scope

**In scope:** claiming, gating, recurrence math, retries/backoff, seeding,
heartbeat, notifications.

**Out of scope:** what the agent does during a turn (runner + Claude Code),
where jobs live (memory's `jobs` table), channel identity (telegram).
