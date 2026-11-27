# Scheduler & Durable Jobs

This is the design for fortytwo's **scheduler**, the subsystem that runs work on a
clock and on demand without a human in the loop. It implements two of
fortytwo's spine items: **durable jobs** and **Pulse** (proactive wakes). It replaced the proactive-wake loop that used to live inside
the Telegram bridge. This is the design record; the shipped behavior of the
package is in [`packages/scheduler.md`](./packages/scheduler.md).

## Why this exists

Before the scheduler, the proactive-wake scheduler was embedded in the Telegram bridge
(`schedulerLoop` + a hard-coded `SCHEDULES` array). It had two problems:

1. **Coupled to one channel.** No bridge running ⇒ no wakes. The assistant
   cannot do anything proactively unless Telegram is up.
2. **Wakes always spend tokens.** A scheduled wake fires a full LLM turn
   unconditionally: the afternoon "open-thread sweep" runs even when there are
   zero pending approvals and nothing to report.

And there was no durable **one-off** job queue at all: the deferred-jobs runner
was never extracted, there was no `jobs` table, and the bridge's `jobLoop` was a
stub.

The goal: a **channel-agnostic, token-frugal, durable** scheduler that fires the
LLM **only when there is real work**, and handles recurring *and* one-off jobs
through one mechanism.

## Principles

- **The LLM is the only expensive resource.** Scheduling, claiming, gating, and
  recurrence math are pure DB/JS and effectively free. An LLM turn happens *only*
  behind a gate that has already confirmed there is work.
- **One database, owned schemas.** Jobs are assistant state and live in the
  same SQLite file as memory, not in a second store. The scheduler owns the
  `jobs` schema and the job API; memory owns the file handle (`openDb`, WAL,
  `busy_timeout`) and the shared migration mechanism. Memory produces no jobs.
- **Channel-agnostic output.** Every result is written to the conversation log
  (the transcript when `@justfortytwo/transcript` is installed; otherwise
  dropped); channels (Telegram today, others later) are *optional notifiers*,
  never a dependency.
- **One mechanism for every job shape.** Recurring, one-off, and reactive jobs
  are all rows in the same table, drained by the same loop.

## Architecture

Four packages, each with one job:

- **`@justfortytwo/scheduler`** *(new)*: the daemon. A long-running process
  (managed by the installer, like the bridge) built from:
  - [`croner`](https://www.npmjs.com/package/croner) for cron parsing and
    next-fire computation,
  - a **cheap ~30s catch-all poll** that calls `claimDue(now)` (a single
    indexed SQL query, **zero tokens**), so jobs enqueued by other processes are
    picked up without any IPC,
  - [`p-queue`](https://www.npmjs.com/package/p-queue) with **concurrency 1** to
    serialize LLM turns so they never overlap (as built, each scheduled turn is
    a fresh `claude -p` run; none resumes a session),
  - a **handler registry** keyed by job `kind`.
- **`@justfortytwo/runner`** *(new, tiny)*: the shared headless invocation,
  `claude -p --output-format json`. Both the scheduler and the Telegram bridge
  depend on it; neither depends on the other. (The bridge's `runClaude` moves
  here.)
- **`@justfortytwo/memory`** provides the database handle (`openDb`) and the
  locked migration runner (`applyMigrations`) the scheduler's own migration
  uses. It owns the `approvals` table, which doubles as an **outbox** the
  scheduler polls (see [Event hooks](#event-hooks-reactive-jobs)).
- **`@justfortytwo/telegram`** loses the embedded `schedulerLoop` /
  `SCHEDULES` / `state.fired`; gains a **Telegram notifier** the scheduler
  delivers through, plus the event-enqueue call-sites it owns.

The scheduler owns the `jobs` table (migration `004_jobs`) and the job API
(`enqueue`, `claimDue`, `complete`, `fail`, `cancel`, …). It also ships the
assistant's job tools, a second bin `fortytwo-scheduler-mcp` (see [Agent job
tools](#agent-job-tools)).

```
                         ┌─────────────────────────────┐
   producers (enqueue)   │   @justfortytwo/scheduler    │
   bridge  ──────────▶   │  croner + ~30s claimDue poll │
   assistant (MCP) ──▶   │  p-queue(1) + handler reg.   │
                         │                              │
                         │   tick(now):                 │
                         │     claimDue → gate?         │
   ┌──────────────┐      │       skip (0 tokens) ──┐    │
   │ fortytwo.db  │◀────▶│       run → runner ─────┼─▶ claude -p
   │  jobs table  │      │     notify(result) ─────┘    │
   │  approvals   │◀────▶│   approval outbox drain      │
   └──────────────┘      └──────────────┬──────────────┘
                                        │ notify
                  conversation log (always) + Telegram (if configured)
```

**This changed after the MVP.** The first design put the `jobs` table and a
`JobStore` in memory, and had memory and the gate enqueue jobs themselves
(`reembed_memory`, `notify_pending`). That made memory depend on the
scheduler's queue, and memory must not: it is a standalone store. Memory 2.0.0
and scheduler 2.0.0 moved the schema and the API to the scheduler and removed
memory's enqueues (below).

## Data model

A single migration in `scheduler`, `004_jobs` (`runSchedulerMigrations`). It
keeps the name it had when memory shipped it and is recorded in memory's
`_migration_state` table under the same lock, so a database that already has
the table skips it; the DDL is `CREATE TABLE IF NOT EXISTS`. Every process that
opens the database and touches jobs runs it after memory's migrations: the
daemon, the Telegram bridge and the installer.

```
jobs(
  id          integer primary key,
  kind        text    not null,   -- 'daily_briefing' | 'sweep' | 'reminder' | 'reply' | ...
  payload     text,               -- JSON, job-specific arguments
  run_at      text    not null,   -- ISO timestamp: when it is due
  recurrence  text,               -- cron string; NULL = one-off
  status      text    not null,   -- 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  attempts    integer not null default 0,
  last_error  text,
  created_at  text    not null,
  updated_at  text    not null
)
-- index (status, run_at) for cheap claimDue
```

`recurrence = NULL` ⇒ one-off: terminal `done` (or `failed`) after it runs.
`recurrence` set ⇒ recurring: after each run (or skip) the daemon computes the
next `run_at` via croner and **resets the row to `pending`**, so `claimDue`
selects it again at its next slot. The design called a recurring row never
terminal. As built, it ends when it fails 3 times in a row (`failed`), is
retired (`done`) or is cancelled; a built-in kind gets a fresh row at the next
boot. No `skipped` status is written: a skip is a plain `complete`.

## Components

Each is small and independently testable.

- **Job API** (in `scheduler`, `src/jobs.ts`; first designed as a `JobStore`
  in `memory`): `enqueue(job)`, `claimDue(now)` (atomically flips due
  `pending` rows to `running` and returns them), `complete(id, { reschedule? })`,
  `fail(id, error, { retryAt? })`, `listActive()`, `requeueStale()`,
  `existsPending()`, `setRecurrence()`, and `cancel(id, { kinds? })` (a
  **pending** row becomes `cancelled`; running rows are refused). Unit-tested
  against a file database.
- **Handler registry** (in `scheduler`): each `kind` registers
  `{ hasWork?(ctx), run(ctx) }`.
  - `hasWork` is the **cheap, non-LLM gate**: a pure DB query. Absent ⇒ the job
    always runs.
  - `run` does the work: fires an LLM turn via the runner, or does pure work
    (e.g. `reembed_memory`, kept for jobs queued by older installs).
- **`tick(now)`**: the pure core of the loop, dependency-injected so it tests
  without a network or an LLM. For each claimed-due job: evaluate `hasWork`; if
  false, `complete` + reschedule (**0 tokens**; a one-off becomes `done`); if
  true, push `run` onto the p-queue; on completion, notify and (if recurring)
  reschedule.
- **`daemon`**: the only impure part. Wires croner + the ~30s poll + the real
  job API + the approval outbox + the runner + the notifier.
- **`Notifier`** interface: `notify(result)`. The default appends to the
  **conversation log** (the transcript when `@justfortytwo/transcript` is
  installed; otherwise dropped). An optional **Telegram notifier** (push to the
  owner chat) is injected only when configured.

## Job kinds: one table, four uses

| Use | Example | `recurrence` | Gate (`hasWork`) |
| --- | --- | --- | --- |
| Built-in recurring | `daily_briefing`, `sweep`, `learn_review` | cron | `sweep` and `learn_review`: skip if nothing to do; `daily_briefing` always runs |
| User-defined recurring | "check my emails every morning" | cron | optional (default: always run) |
| One-off durable | `reminder` | `NULL` | optional |
| Reactive (event-driven) | `reply`; `notify_pending` (run by the approval outbox, not queued) | `NULL` | inherent, only runs when real |

User-defined recurring jobs generalize the built-ins: a cron string plus a
trigger prompt. This is why external adapters (calendar, email) can wait: for
now, recurring prompts that use whatever tools/skills the assistant has that
turn cover them. As shipped, the assistant creates them only as
`reminder` rows, one-off or with a cron, through its [job
tools](#agent-job-tools).

## Control flow

1. **Boot.** Read the owner's choice (see [Owner-selectable
   built-ins](#owner-selectable-built-ins)). Retire the recurring rows of
   disabled kinds, then seed the enabled built-ins (briefing, sweep,
   learn-review), then Oneiros when persona's checkpoint
   (`.fortytwo/oneiros/checkpoint.json`) exists; Oneiros is not switchable in
   `schedules.json`. Seeding is keyed by `kind` (one active recurring row per
   built-in). The code definition is **authoritative for built-ins**: if a
   built-in's cron string changed in code, the daemon updates its row's
   `recurrence`/`run_at`. User-defined jobs are DB-authoritative and never
   overwritten from code. Finally, realign recurring rows to the configured
   time zone.
2. **Loop.** Every ~30s, call `tick(now)`: `claimDue` → per job, gate →
   *skip + reschedule* or *run on the p-queue* → notify + reschedule. The
   design also had croner wake the loop; as built, the poll is the only wake
   source, so a job fires up to one poll period after its `run_at`.
3. **Reschedule.** After a recurring job runs (or is skipped), the daemon
   computes the next `run_at` from `recurrence` and writes it back.

## Owner-selectable built-ins

The built-in recurring jobs are the assistant's defaults; the owner decides
which run and in which time zone. The choice is a small file,
`<FORTYTWO_ROOT>/.fortytwo/schedules.json`, **owned by the scheduler** (the
installer only asks and writes it):

```json
{ "version": 1, "timezone": "Europe/Rome",
  "schedules": { "daily_briefing": { "enabled": false } } }
```

- A kind not listed is **on**; a missing file means every built-in is on, so
  installs that predate the file are unchanged. Unknown kinds are ignored.
- The daemon reads the file **once at boot**; changes apply after a restart.
- A disabled kind has its active recurring row **retired** (`complete`, no
  reschedule, status `done`). One-off rows of the same kind are untouched.
  Re-enabling inserts a **fresh** row at the next boot; the old `done` row
  stays.
- `timezone` (optional IANA name, absent = UTC) is the clock the built-in times
  and the Oneiros job are read in, across daylight saving. A zone change applies
  at boot by moving a recurring row only if it is `pending`, in the future and
  has made no attempt; overdue rows still run, running rows finish, retry
  backoffs keep their time.
- **Fail closed.** A file that exists but cannot be understood (bad JSON, a
  non-boolean `enabled`, an unusable `timezone`) stops the daemon with an error.
  It never falls back to "everything on" or to UTC. This was an explicit owner
  decision: a silent fallback would send briefings the owner switched off, or at
  the wrong hour.

Only on/off and the zone are configurable; custom per-job times are not.

## Token-gating: the core guarantee

The design gave every recurring job a pure-DB `hasWork` predicate, e.g.
`sweep.hasWork = pendingApprovals > 0 || unansweredThreads > 0`. As built,
`sweep` checks `pendingApprovals > 0` only, `learn_review` checks for memories
from the last 7 days, and `daily_briefing` has no gate. When a gate returns
false the job is completed and rescheduled with **no LLM turn and zero
tokens**. The poll, the claim, the gate, and the recurrence math are all free.
The *only* token cost in the system is a `run` whose gate has already passed.

## Event hooks (reactive jobs)

An "event hook" here is **a point in another component's code where, when
something real happens, it calls the scheduler's `enqueue(...)`**. The scheduler
never polls the outside world for work; producers tell it there is work by
writing a row. The one exception is memory's approval outbox (below), which the
scheduler polls so that memory never has to write a job.

Producers as shipped:

| Producer | Event | Enqueues |
| --- | --- | --- |
| `telegram` bridge | inbound while a turn is mid-flight / owner unreachable | `reply` |
| assistant (`enqueue_job`) | owner says "remind me at 5pm" | `reminder` |

The MVP table also listed memory (a stored memory → `reembed_memory`) and the
gate (a deferred tool call → `notify_pending`, enqueued when memory's approval
store staged it). Both are gone since memory
2.0.0: `store()` embeds in the same write, so there is nothing to re-embed, and
an approval is announced through the outbox instead. The `reembed_memory`
handler stays for jobs queued by older installs; nothing enqueues it.

Because producers are **separate processes** and SQLite has no pub/sub, the
daemon notices newly-enqueued jobs through the **cheap ~30s `claimDue` poll**,
with no IPC, no signalling, and (because it never calls the LLM) no token cost.
Latency is at most the poll interval (`POLL_MS`, a constant). As built, croner
only computes next run times; it is not a wake source.

Reactive jobs have **no `hasWork` gate**. Being enqueued *is* the signal that
there is work, so they always run. De-duplication therefore happens at the
**enqueue site**: a producer must not enqueue a second job of the same kind for
the same target while one is still `pending`/`running` (the bridge checks
`existsPending` before it queues a `reply`). This is what keeps reactive wakes
from duplicating.

### Approval outbox

Staging an approval queues no job. Memory's `approvals` row is the outbox:
`notified_at` (migration `006_approvals_notified_at`) stays `NULL` until the
owner has been told, and `addPending` resets it when an approval is staged
again. On every ~30s poll, inside the same overlap guard and through the same
p-queue as `tick`, the daemon lists the un-notified pending approvals
(`listUnnotifiedApprovals`), runs the `notify_pending` handler for them,
delivers its text, and **only then** stamps them (`markApprovalsNotified`). So
every staged approval is notified **at least once**, including one staged while
a notification is running. A run that fails or produces no text stamps nothing
and backs off 1, 5, then 30 minutes. Latency is up to one poll period plus any
job running ahead of it. Approvals still pending when migration 006 runs start
un-notified and are announced once more. The `sweep` gate cannot do this job:
it runs twice a day.

External adapters (`triage` from calendar/email) are **deferred**; they attach as
new producers later, or are served in the meantime by user-defined recurring
jobs.

## Agent job tools

The assistant schedules work on the durable queue, not on a session-local cron
that dies with the session. The scheduler ships a second bin,
`fortytwo-scheduler-mcp`: a stdio MCP server (id `fortytwo-scheduler`) with
three tools.

| Tool | Does |
| --- | --- |
| `enqueue_job` | creates a `reminder` at `run_at` and/or on a cron |
| `list_jobs` | lists active (pending and running) jobs; system jobs without payload |
| `cancel_job` | cancels a pending reminder |

Limits, enforced in code (`src/agent-jobs.ts`):

- **`reminder` only.** `reply`, `notify_pending`, `reembed_memory`, Oneiros and
  the built-in kinds are system-owned: the agent can neither create nor cancel
  them.
- **Text is untrusted.** Payload is exactly `{ "text": "..." }`, one line, at
  most 500 characters; it reaches a prompt as `Reminder: <text>`.
- **No flooding.** A past `run_at` is rejected; a cron may fire at most hourly;
  at most 20 active agent jobs, counted in the insert's write transaction.
- **Cancel** refuses running jobs and seeded (system) jobs.

The server runs no migrations: it opens the same `DB_PATH` as memory and waits
for the daemon or the installer to create the table. The installer writes its
`.mcp.json` entry, and the gate manifest it ships tiers `list_jobs` and
`enqueue_job` `internal` (they only write the local queue, and every scheduled
turn runs under the gate) and `cancel_job` `irreversible` (owner approval). The
persona's `context/INDEX.md` tells the agent to use these tools for reminders
and never `CronCreate`.

## Decoupling from Telegram

The transition removes `schedulerLoop`, `SCHEDULES`, and `state.fired` from the
bridge. The four schedules become seeded recurring jobs in the table. The bridge
keeps its poll loop and gains (a) a Telegram notifier the scheduler delivers
through, and (b) its event-enqueue call-sites. Schedule logic now lives in
exactly one place, so there is no double-firing. If the daemon is not running,
nothing proactive fires. This is documented, and the bridge still serves
interactive messages.

## Crash-safety & errors

- **Single writer of the `running` transition.** Producers only ever
  `INSERT … status='pending'`; the daemon is the only process that claims. So
  `claimDue` is one statement, run with the database in **WAL** mode:
  `UPDATE jobs SET status='running', updated_at=… WHERE status='pending' AND run_at <= now RETURNING *`.
  There is no cross-process race on the
  claim itself; the only cross-process interaction is the poll noticing new
  `pending` inserts, which is the intended behavior. `cancel_job` (another
  process) changes only `pending` rows, in one UPDATE, so a row the daemon
  claims at the same moment is reported as running and left alone.
- **Stale-claim recovery.** On restart (or after a crash), the daemon returns
  `running` rows older than `STALE_RUNNING_MS` (default **15 min**, a config
  constant) to `pending` so they re-run.
- **Failures.** Increment `attempts`, store `last_error`, and retry with a fixed
  MVP schedule. The design had **3 attempts** at 1 min → 5 min → 30 min and a
  note to the conversation log after the cap. As built, a job is retried after
  **1 min**, then **5 min**; on the third failure a one-off becomes `failed`
  and a recurring row skips to its next slot (2.1.1). No notification is sent. The 30 min step is used only by the approval outbox.
  (A tunable backoff policy is deferred.)
- **Serialized turns.** p-queue concurrency 1 keeps LLM turns from overlapping.

## Testing

- Job API (in `scheduler`): `claimDue` atomicity, `complete`/`fail`,
  reschedule, `cancel`, against a file database.
- `tick()` (in `scheduler`): pure, with a fake store + a DI'd registry:
  gate-skips-without-LLM, gate-runs-with-work, recurring reschedule, one-off
  completion, failure/backoff. No network, no LLM.
- Thin croner + p-queue wiring smoke test.

## Scope

**MVP:** the four built-in recurring gated jobs; `reembed_memory` (the first
durable one-off, closing an existing stub) with its enqueue point in memory's
store path; `notify_pending` and `reply` reactive jobs; the `reminder` one-off.
(The `reembed_memory` and `notify_pending` enqueues in memory were removed in
2.0.0; see [Event hooks](#event-hooks-reactive-jobs).)
**Deferred:** external channel adapters (`triage`), richer retry/backoff policy,
and a `fortytwo` CLI surface for inspecting/managing the queue.

**Since the MVP:** owner-selectable built-ins and a time zone (above); output
goes to the conversation log in `@justfortytwo/transcript` rather than to a
memory journal; the `jobs` table and job API moved from memory to the
scheduler, approvals are announced through an outbox, and the assistant
schedules reminders with its [job tools](#agent-job-tools).

**Open:**

- The `sweep` gate counts memory's `approvals` table, not the gate's approval
  file, so it does not see actions held by the gate hook.
- Per-job custom times are not configurable.
