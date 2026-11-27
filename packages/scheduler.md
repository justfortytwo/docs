# `@justfortytwo/scheduler`

Durable job scheduler daemon for fortytwo. Owns the `jobs` queue (its schema
and API), kept in the database opened by `@justfortytwo/memory`, and fires LLM
turns only behind a cheap "is there work?" gate. It also ships the assistant's
job tools as an MCP server.

The design rationale (durable jobs, token gating, crash safety, event hooks)
is in [Scheduler & Durable Jobs](../scheduler.md). This page documents the
package as built.

- **Version:** `2.1.2` · **Runtime:** standalone daemon, `bin` is
  `fortytwo-scheduler`; second `bin` `fortytwo-scheduler-mcp` (stdio MCP) ·
  **Node:** >= 20

## Why this exists

Proactive behavior (briefings, sweeps, reminders) needs *durable time*: work
that survives restarts, is de-duplicated, and never spends an LLM turn when
there is nothing to do. The scheduler owns **when** work happens, never how
the agent reasons about it.

## Components

| Component | File | Role |
|-----------|------|------|
| Job API | `src/jobs.ts` | `enqueue`, `claimDue`, `complete`, `fail`, `listActive`, `requeueStale`, `existsPending`, `setRecurrence`, `cancel` |
| Migrations | `src/migrate.ts` | `SCHEDULER_MIGRATIONS` (`004_jobs`) + `runSchedulerMigrations()` |
| Handler registry | `src/registry.ts` | maps job `kind` → `Handler` |
| `tick()` | `src/tick.ts` | pure, fully injectable: claim due jobs → gate check → enqueue run → notify → reschedule/complete; backoff on error |
| Daemon | `src/daemon.ts` | croner + p-queue (concurrency 1) wiring around `tick()`, ~30 s poll |
| Recurring seeds | `src/seed.ts`, `src/handlers/index.ts` | idempotent seeding of `RECURRING_DEFS` on every boot; only inserts/updates rows when a definition changes |
| Heartbeat | `src/heartbeat.ts` | liveness file for `fortytwo doctor` |
| Oneiros | `src/oneiros.ts` | persona maintenance job (see below) |
| Notifier | `src/notifier.ts` | journal + optional Telegram push |
| Approval outbox | `src/approval-outbox.ts` | notifies staged approvals, then stamps them |
| Agent job tools | `src/mcp.ts`, `src/agent-jobs.ts` | `fortytwo-scheduler-mcp`: `enqueue_job`, `list_jobs`, `cancel_job` |

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

The package also exports the daemon (`startDaemon`, `DaemonOptions`),
`buildRegistry` and `RECURRING_DEFS`, the MCP server (`createJobsServer`,
`SCHEDULER_MCP_ID`), the agent-job rules and limits, and the
`schedules.json` helpers; see `src/index.ts`.

## Jobs queue

The `jobs` table and the job API used to live in `@justfortytwo/memory`; since
2.0.0 they are imported from here:

```ts
import { openDb, runMigrations } from '@justfortytwo/memory';
import { runSchedulerMigrations, enqueue } from '@justfortytwo/scheduler';

const h = openDb('fortytwo.db');
await runMigrations(h.k);          // memory's schema
await runSchedulerMigrations(h.k); // the jobs table (migration 004_jobs)
```

Exports: `enqueue`, `claimDue`, `complete`, `fail`, `listActive`,
`requeueStale`, `existsPending`, `setRecurrence`, `cancel`, `MAX_ATTEMPTS`,
`JobRow`, `NewJob`, `CancelResult`, `SCHEDULER_MIGRATIONS`,
`runSchedulerMigrations`.

- **Migration.** `004_jobs` keeps the name it had in memory and is recorded in
  memory's `_migration_state` under the same lock (`applyMigrations`); the DDL
  is `CREATE TABLE IF NOT EXISTS`. An install that got the table from memory
  1.x skips it; on a fresh database it runs after memory's migrations. The
  daemon, the Telegram bridge and the installer all run it.
- **`cancel(h, id, { kinds? })`** sets a **pending** job to `cancelled`, a
  terminal status. A running or finished job is refused, and so is a kind not
  in `kinds` when given. Check and change are one UPDATE, so a job the daemon
  claims at the same moment is reported as running.
- `countPendingApprovals` (the `sweep` gate) stays in memory, which owns the
  `approvals` table.
- **Retries.** A job whose run or gate throws is retried after 1 min, then
  5 min (`MAX_ATTEMPTS = 3`). On the third failure a one-off becomes `failed`
  with `last_error`; a recurring row keeps `last_error`, resets `attempts` and
  moves to its next slot (since 2.1.1; before, it became `failed` until the
  next boot). No notification is sent. A run with no Claude result (timed out
  or unparseable) counts as a failure. At boot,
  `running` rows older than 15 min (`STALE_RUNNING_MS`) go back to `pending`.

## Job kinds (as built)

| kind | schedule | gate | behavior |
|------|----------|------|----------|
| `daily_briefing` | `57 7 * * *` (07:57) | none | runs the `daily-briefing` skill and sends the rundown |
| `sweep` | `3 13,18 * * *` | pending rows in memory's `approvals` table > 0 (not the gate's approval file) | open-thread sweep, one-line status |
| `learn_review` | `17 9 * * 0` | recent memory rows (7 d) > 0; counts facts only, since chat and notifications moved to the transcript | runs the `learn-review` skill: propose-only rules, candidate skills and memory cleanups from the last 7 days |
| `notify_pending` | approval outbox (every poll) | un-notified pending approvals | notify about pending approvals (see [Approval notifications](#approval-notifications)); a queued job with the legacy `payload.id` still runs |
| `reply` | one-off | none | send a reply via the runner |
| `reminder` | one-off or cron (from `enqueue_job`) | none | send a reminder via the runner |
| `reembed_memory` | maintenance | none | re-embeds one memory by id in-place (**no LLM**, no notification). **No producer** since memory 2.0.0 (`store()` embeds in its own write); kept for jobs queued by older installs |
| `persona.oneiros` | `17 3 * * *` (03:17) | memory-head or transcript-head check | persona maintenance (below) |

### Choosing the built-in schedules

`daily_briefing`, `sweep` and `learn_review` can be switched on or off per
install. `fortytwo init` asks about each one (or takes
`--schedules all|none|<kind,kind>`) and writes
`<FORTYTWO_ROOT>/.fortytwo/schedules.json`:

```json
{ "version": 1, "timezone": "Europe/Rome", "schedules": { "daily_briefing": { "enabled": false } } }
```

`schedules.<kind>.enabled` must be a boolean. `timezone` is optional.

The daemon reads it once at boot. A job that is off has its active recurring
row retired (status `done`, not rescheduled; one-off rows of the same kind are
untouched). Switching it back on inserts a **fresh** row at the next boot; the
old `done` row stays in the table. A kind that is not listed is on, and so is
every kind when the file is missing, so installs that predate the file are
unchanged. A file that exists but cannot be understood (bad JSON, a non-boolean
`enabled`, an unusable `timezone`) stops the daemon with an error; it never
falls back to "everything on" or to UTC. Restart Fortytwo after a change. On an
existing install, change the choice with `fortytwo schedules` (it touches only
this file).

### Time zone

Since scheduler 1.0.6, `timezone` (an IANA name) is the clock the built-in
times **and** the Oneiros job are read in, across daylight saving. Absent means
UTC. At boot `realignRecurring` moves a recurring row to its next correct run
only if it is `pending`, in the future and has `attempts = 0`; overdue rows
still run (catch-up), running rows finish and retry backoffs keep their time.
That is how a zone change applies after a restart. Set the zone with
`fortytwo schedules --timezone <name|utc>` (installer 1.0.8); the daemon logs
`[scheduler] built-in schedules in <zone>` at start.

Only on/off and the zone are configurable: per-job custom times are not.

### Skills behind the schedules

`daily_briefing` and `learn_review` each name a Claude Code skill. The skills
ship in `@justfortytwo/persona`, and the installer copies them into
`<FORTYTWO_ROOT>/.claude/skills/` on `init` and on every `update`.

On every run the job checks for `<name>/SKILL.md` in that directory and in
`$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`). With the skill it
sends a short "run the skill" prompt. Without it, it sends a self-contained
prompt that states the task and its limits, so a scheduler running without the
installer still produces a sensible result.

### With the safety gate on

A scheduled run has nobody waiting to approve a held action. When the gate
holds a tool call, the run ends there and is not resumed; the job reports which
job stopped and the exact action that was held (`src/held.ts`, since 1.0.7). It
stops at the same point on the next run until that action is allowed in the
gate's policy. Oneiros runs in its own locked-down worker and sends no such
notice.

## Approval notifications

When the safety gate stages an approval, memory queues no job: the approval row
waits with `notified_at` unset (memory migration `006_approvals_notified_at`).
On every poll (`POLL_MS`, 30 s), inside the overlap guard and through the same
p-queue as `tick`, the daemon runs `notify_pending` for those approvals, sends
the result like any notification, and **then** stamps `notified_at`. Each
staged approval is notified at least once, including one staged while a
notification is already running. The delay is up to one poll period, plus any
job running ahead of it. A run that fails or produces no text stamps nothing
and is retried after 1, 5, then 30 minutes.

## Agent job tools

`fortytwo-scheduler-mcp` is a stdio MCP server that lets the assistant put jobs
on the durable queue instead of a session-local cron. The installer registers
it in `.mcp.json` as `fortytwo-scheduler` (tools
`mcp__fortytwo-scheduler__*`), on the same `DB_PATH` as memory:

```json
"fortytwo-scheduler": {
  "command": "npx",
  "args": ["-y", "-p", "@justfortytwo/scheduler", "fortytwo-scheduler-mcp"],
  "env": { "DB_PATH": "db/fortytwo.db" }
}
```

| Tool | What it does |
| --- | --- |
| `enqueue_job` | `{ kind, payload, run_at?, timezone?, recurrence? }`: creates a job the daemon fires with no session open |
| `list_jobs` | active jobs (**pending and running**), soonest first; system jobs without their payload; `cancellable` marks what `cancel_job` accepts |
| `cancel_job` | `{ id }`: cancels a pending reminder |

Rules (`src/agent-jobs.ts`):

- **Kinds:** `reminder` only. `reply`, `notify_pending`, `reembed_memory`,
  Oneiros and the built-in recurring kinds are system-owned: the agent can
  neither create nor cancel them.
- **Payload:** exactly `{ "text": "..." }`, one line, 1 to 500 characters. It
  reaches a prompt as `Reminder: <text>`, so the server treats it as untrusted
  and rejects other keys, newlines and control characters.
- **`run_at`:** ISO-8601 with `Z` or an offset, or without one plus `timezone`
  (IANA); stored as UTC. Malformed values and times in the past are rejected,
  and so are an offset together with `timezone`, and `timezone` without
  `run_at`.
- **`recurrence`:** a cron read in the install time zone, at most once an hour.
  Without `run_at` the first run is the cron's next one.
- **Cap:** at most 20 active agent jobs, checked in the insert's write
  transaction.
- **Cancel:** pending reminders only; running jobs and built-in or system jobs
  are refused.

The server runs **no migrations**: it opens `DB_PATH` (which must exist) with
memory's `openDb`; until the `jobs` table exists every tool returns an error.
Env: `DB_PATH` (required), `FORTYTWO_ROOT` (for the time zone in
`.fortytwo/schedules.json`).

**Safety gate:** the capability manifest the installer ships tiers `list_jobs`
and `enqueue_job` `internal` (they only write the local queue, within the caps
above, and every scheduled turn runs under the gate) and `cancel_job`
`irreversible`, so cancelling waits for the owner's approval. A manifest written
before these entries existed holds every call until the two `internal` lines
are added; `fortytwo doctor` names them.

## Oneiros maintenance

`persona.oneiros` runs daily at `17 3 * * *` (in the configured time zone, UTC
by default) with null payload and the existing durable retry/claim mechanism.
The installer seeds it after initializing persona's checkpoint; daemon boot
reconciles the same job when the checkpoint exists. The cheap gate checks both evidence heads: the memory
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
Requires a Claude CLI with `--safe-mode`; unsupported flags **fail closed**.
The worker runs with `CLAUDECODE` and `CLAUDE_CODE_SESSION_ID` unset, is
capped at 120 s, and its response is rejected above 16 384 bytes.

## Running it

The daemon is a long-running process. Run it under a restart loop (tmux for
development, systemd for production) or under `fortytwo start`, which
supervises it together with the Telegram bridge.

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_PATH` | recommended | path to the database (default `fortytwo.db` in the working directory); the heartbeat is written next to it |
| `FORTYTWO_TURN_TIMEOUT` | no | time limit in seconds for each scheduled `claude` turn (default `300`, since 2.1.1) |
| `EMBED_MODEL` | recommended | Ollama embedding model (falls back to FakeEmbedder) |
| `OLLAMA_BASE_URL` | no | default `http://localhost:11434` |
| `CLAUDE_BIN` | no | `claude` CLI path the runner spawns (default: `claude` on `PATH`) |
| `FORTYTWO_CLAUDE_ARGS` | no | Extra arguments for every `claude` run, as a JSON array of strings (e.g. `["--chrome"]`). Set by `fortytwo start -- <args>`. Applies to scheduled runs, not to the Oneiros worker. A malformed value stops the daemon at boot. |
| `TELEGRAM_BOT_TOKEN` | optional | enables Telegram push notifications |
| `ALLOWED_CHAT_IDS` | optional | comma-separated chat IDs; when set, push goes to the first id. When unset, push goes to every chat paired with `fortytwo pair` |
| `FORTYTWO_ROOT` | no | project root: holds `.fortytwo/schedules.json`, `.claude/skills` and the Telegram bindings db (default: working directory) |
| `CLAUDE_CONFIG_DIR` | no | Claude Code config dir, checked for user-level skills (default `~/.claude`) |
| `TELEGRAM_BINDINGS_DB` | no | bindings db path relative to the root (default `state/telegram-bindings.db`); must match the bridge |

Since scheduler 2.1.1 the daemon stops a scheduled turn after
`FORTYTWO_TURN_TIMEOUT` seconds (default 300). A turn that ends with no Claude
result, because it timed out or its output was not a result, fails the job
into the normal retry. A value that is not a whole number of seconds from 1 to
2147483 stops the daemon at boot. The Oneiros worker keeps its own 120 s limit.
Before 2.1.1 the variable was not read and scheduled turns had no limit.

### Liveness

On boot and on every 30-second poll tick, even while a previous tick is still
in flight, the daemon writes `$(dirname $DB_PATH)/scheduler.heartbeat`
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
- **Output notes** (scheduler 2.1.0+). A channel wired at boot can add a note
  to the system prompt of scheduled runs (`DaemonOptions.appendSystemPrompt`,
  passed as `--append-system-prompt`). Telegram adds one that asks for compact
  lists instead of Markdown tables. The bin adds it only when it wires the
  Telegram notifier, so journal-only installs and other channels run without
  it. If the operator sets `--append-system-prompt`, the daemon keeps that value
  and adds the note after it. The Oneiros worker never receives the note.
- The `learn_review` gate (`recentCount`) counts memory rows from the last
  7 days. With chat and notifications gone from memory it counts facts only,
  so it fires less often; this is accepted as is.

## Dependencies

- `@justfortytwo/memory` (pinned `2.0.0`): the database handle (`openDb`),
  `applyMigrations`, the approvals outbox and `countPendingApprovals`, plus
  `memoryHead`/`memoryDelta` (Oneiros), `query` (the `learn_review` gate),
  `reembed` and the embedders.
- `@justfortytwo/runner` (pinned `1.0.1`): LLM turns for handlers.
- `@modelcontextprotocol/sdk` (`^1.32.2`): the `fortytwo-scheduler-mcp` server.
- `croner` (`^10.0.0`): next-run computation for crons.
- `p-queue` (`^9.0.0`): the concurrency-1 run queue.
- `@justfortytwo/persona` (`^1.0.2`, a caret range since 2.1.2, so the
  installer's persona is shared instead of nested): Oneiros
  `hasWork`/`refine`/`workerPrompt`.
- `@justfortytwo/telegram` (`^0.1.5 || ^1.0.0`): **optional peer**; enables
  the Telegram notifier.
- `@justfortytwo/transcript` (`^1.0.0`): **optional peer**; receives journal
  entries and serves the Oneiros transcript stream.

## Testing

```sh
npm run build
npm test        # vitest run
```

## Scope

**In scope:** the `jobs` schema and job API, claiming, gating, recurrence math,
retries/backoff, seeding, heartbeat, notifications, the approval outbox drain,
the agent job tools.

**Out of scope:** what the agent does during a turn (runner + Claude Code), the
database file and its handle (memory), the approvals table (memory), channel
identity (telegram).
