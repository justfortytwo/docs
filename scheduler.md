# Scheduler & Durable Jobs

This is the design for fortytwo's **scheduler** — the subsystem that runs work on
a clock and on demand without a human in the loop. It implements two spine items
from [Design Principles](./design-principles.md): **durable jobs** and **Pulse**
(proactive wakes). It is a decoupled successor to the proactive-wake loop that
currently lives inside the Telegram bridge.

## Why this exists

Today the proactive-wake scheduler is embedded in the Telegram bridge
(`schedulerLoop` + a hard-coded `SCHEDULES` array). Two problems:

1. **Coupled to one channel.** No bridge running ⇒ no wakes. The assistant
   cannot do anything proactively unless Telegram is up.
2. **Wakes always spend tokens.** A scheduled wake fires a full LLM turn
   unconditionally — the afternoon "open-thread sweep" runs even when there are
   zero pending approvals and nothing to report. That is pure waste.

And there is no durable **one-off** job queue at all: the deferred-jobs runner
was never extracted, there is no `jobs` table, and the bridge's `jobLoop` is a
stub.

The goal: a **channel-agnostic, token-frugal, durable** scheduler that fires the
LLM **only when there is real work**, and handles recurring *and* one-off jobs
through one mechanism.

## Principles

- **The LLM is the only expensive resource.** Scheduling, claiming, gating, and
  recurrence math are pure DB/JS and effectively free. An LLM turn happens *only*
  behind a gate that has already confirmed there is work.
- **Durable state lives in `memory`.** Jobs are assistant state and belong next
  to the journal and registry, in one database — not in a second store.
- **Channel-agnostic output.** Every result is written to the journal; channels
  (Telegram today, others later) are *optional notifiers*, never a dependency.
- **One mechanism for every job shape** — recurring, one-off, and reactive jobs
  are all rows in the same table, drained by the same loop.

## Architecture

Four packages, each with one job:

- **`@justfortytwo/scheduler`** *(new)* — the daemon. A long-running process
  (managed by the installer, like the bridge) built from:
  - [`croner`](https://www.npmjs.com/package/croner) for cron parsing and
    next-fire computation,
  - a **cheap ~30s catch-all poll** that calls `claimDue(now)` — a single
    indexed SQL query, **zero tokens** — so jobs enqueued by other processes are
    picked up without any IPC,
  - [`p-queue`](https://www.npmjs.com/package/p-queue) with **concurrency 1** to
    serialize LLM turns (they resume per-conversation sessions and must not
    overlap),
  - a **handler registry** keyed by job `kind`.
- **`@justfortytwo/runner`** *(new, tiny)* — the shared headless invocation,
  `claude -p --output-format json`. Both the scheduler and the Telegram bridge
  depend on it; neither depends on the other. (The bridge's `runClaude` moves
  here.)
- **`@justfortytwo/memory`** — gains the `jobs` table (migration `004_jobs`) and
  a dependency-injected **`JobStore`** API. This is where durability lives.
- **`@justfortytwo/telegram`** — loses the embedded `schedulerLoop` /
  `SCHEDULES` / `state.fired`; gains a **Telegram notifier** the scheduler
  delivers through, plus the event-enqueue call-sites it owns.

```
                         ┌─────────────────────────────┐
   producers (enqueue)   │   @justfortytwo/scheduler    │
   memory  ──────────▶   │  croner + ~30s claimDue poll │
   gate    ──────────▶   │  p-queue(1) + handler reg.   │
   bridge  ──────────▶   │                              │
   assistant ────────▶   │   tick(now):                 │
                         │     claimDue → gate?         │
   ┌──────────────┐      │       skip (0 tokens) ──┐    │
   │   memory db  │◀────▶│       run → runner ─────┼─▶ claude -p
   │  jobs table  │      │     notify(result) ─────┘    │
   └──────────────┘      └──────────────┬──────────────┘
                                        │ notify
                            journal (always) + Telegram (if configured)
```

## Data model

A single migration in `memory`, `004_jobs`:

```
jobs(
  id          integer primary key,
  kind        text    not null,   -- 'daily_briefing' | 'sweep' | 'reembed_memory' | 'reminder' | ...
  payload     text,               -- JSON, job-specific arguments
  run_at      text    not null,   -- ISO timestamp: when it is due
  recurrence  text,               -- cron string; NULL = one-off
  status      text    not null,   -- 'pending' | 'running' | 'done' | 'failed' | 'skipped'
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
selects it again at its next slot. A recurring row is never terminal.

## Components

Each is small and independently testable.

- **`JobStore`** (in `memory`, DI'd like the other stores): `enqueue(job)`,
  `claimDue(now)` (atomically flips due `pending` rows to `running` and returns
  them), `complete(id, { reschedule? })`, `fail(id, error, { retryAt? })`,
  `listRecurring()`. Unit-tested against a file database.
- **Handler registry** (in `scheduler`): each `kind` registers
  `{ hasWork?(ctx), run(ctx) }`.
  - `hasWork` is the **cheap, non-LLM gate** — a pure DB query. Absent ⇒ the job
    always runs.
  - `run` does the work: fires an LLM turn via the runner, or does pure work
    (e.g. `reembed_memory`).
- **`tick(now)`** — the pure heart of the loop, dependency-injected so it tests
  without a network or an LLM. For each claimed-due job: evaluate `hasWork`; if
  false, `complete(skipped)` + reschedule (**0 tokens**); if true, push `run`
  onto the p-queue; on completion, notify and (if recurring) reschedule.
- **`daemon`** — the only impure part. Wires croner + the ~30s poll + the real
  `JobStore` + the runner + the notifier.
- **`Notifier`** interface — `notify(result)`. The default writes to the
  **memory journal** (always). An optional **Telegram notifier** (push to the
  owner chat) is injected only when configured.

## Job kinds — one table, four uses

| Use | Example | `recurrence` | Gate (`hasWork`) |
| --- | --- | --- | --- |
| Built-in recurring | `daily_briefing`, `sweep`, `learn_review` | cron | yes — skip if nothing to do |
| User-defined recurring | "check my emails every morning" | cron | optional (default: always run) |
| One-off durable | `reminder`, `reembed_memory` | `NULL` | optional |
| Reactive (event-driven) | `notify_pending`, `reply` | `NULL` | inherent — only enqueued when real |

User-defined recurring jobs generalize the built-ins: a cron string plus a
trigger prompt. This is why external adapters (calendar, email) can wait — they
are absorbed for now by recurring prompts that use whatever tools/skills the
assistant has that turn.

## Control flow

1. **Boot.** Seed the built-in recurring jobs (briefing, sweeps, learn-review),
   keyed by `kind` (one row per built-in). The code definition is **authoritative
   for built-ins**: on boot, if a built-in's cron string changed in code, its
   row's `recurrence`/`run_at` are updated. User-defined jobs are
   DB-authoritative and never overwritten from code.
2. **Loop.** Every ~30s (and via croner for precise recurrence), call
   `tick(now)`: `claimDue` → per job, gate → *skip + reschedule* or *run on the
   p-queue* → notify + reschedule.
3. **Reschedule.** After a recurring job runs (or is skipped), the next `run_at`
   is computed from `recurrence` and written back.

## Token-gating — the core guarantee

Every recurring job carries a pure-DB `hasWork` predicate — e.g.
`sweep.hasWork = pendingApprovals > 0 || unansweredThreads > 0`. When it returns
false the job is marked `skipped` and rescheduled with **no LLM turn and zero
tokens**. The poll, the claim, the gate, and the recurrence math are all free.
The *only* token cost in the system is a `run` whose gate has already passed.

## Event hooks (reactive jobs)

An "event hook" here is simply **a point in another component's code where, when
something real happens, it calls `JobStore.enqueue(...)`**. The scheduler never
polls the outside world; producers tell it there is work by writing a row.

MVP producers:

| Producer | Event | Enqueues |
| --- | --- | --- |
| `memory` (store path) | a memory is stored | `reembed_memory` |
| `gate` | a tool call is deferred (pending approval) | `notify_pending` |
| `telegram` bridge | inbound while a turn is mid-flight / owner unreachable | `reply` |
| assistant | owner says "remind me at 5pm" | `reminder` |

Because producers are **separate processes** and SQLite has no pub/sub, the
daemon notices newly-enqueued jobs through the **cheap ~30s `claimDue` poll** —
no IPC, no signalling, and (because it never calls the LLM) no token cost.
Latency is at most the poll interval (tunable). Croner is retained for precise
recurrence math, not as the sole wake source.

Reactive jobs have **no `hasWork` gate** — being enqueued *is* the signal that
there is work, so they always run. De-duplication therefore happens at the
**enqueue site**: a producer must not enqueue a second job of the same kind for
the same target while one is still `pending`/`running` (e.g. the gate does not
enqueue a second `notify_pending` for an approval that already has one
outstanding). This is what keeps reactive wakes from duplicating.

External adapters (`triage` from calendar/email) are **deferred**; they attach as
new producers later, or are served in the meantime by user-defined recurring
jobs.

## Decoupling from Telegram

The transition removes `schedulerLoop`, `SCHEDULES`, and `state.fired` from the
bridge. The four schedules become seeded recurring jobs in the table. The bridge
keeps its poll loop and gains (a) a Telegram notifier the scheduler delivers
through, and (b) its event-enqueue call-sites. Schedule logic now lives in
exactly one place, so there is no double-firing. If the daemon is not running,
nothing proactive fires — this is documented, and the bridge still serves
interactive messages.

## Crash-safety & errors

- **Single writer of the `running` transition.** Producers only ever
  `INSERT … status='pending'`; the daemon is the only process that claims. So
  `claimDue` is one statement —
  `UPDATE jobs SET status='running', updated_at=… WHERE status='pending' AND run_at <= now RETURNING *`
  — with the database in **WAL** mode. There is no cross-process race on the
  claim itself; the only cross-process interaction is the poll noticing new
  `pending` inserts, which is the intended behavior.
- **Stale-claim recovery.** On restart (or after a crash), `running` rows older
  than `STALE_RUNNING_MS` (default **15 min**, a config constant) are returned to
  `pending` so they re-run.
- **Failures.** Increment `attempts`, store `last_error`, and retry with a fixed
  MVP schedule — **3 attempts** at **1 min → 5 min → 30 min**. After the cap the
  row is marked `failed` and a journal note is written. (A tunable backoff policy
  is deferred.)
- **Serialized turns.** p-queue concurrency 1 keeps LLM turns from overlapping.

## Testing

- `JobStore` (in `memory`): `claimDue` atomicity, `complete`/`fail`, reschedule —
  against a file database.
- `tick()` (in `scheduler`): pure, with a fake store + a DI'd registry —
  gate-skips-without-LLM, gate-runs-with-work, recurring reschedule, one-off
  completion, failure/backoff. No network, no LLM.
- Thin croner + p-queue wiring smoke test.

## Scope

**MVP:** the four built-in recurring gated jobs; `reembed_memory` (the first
durable one-off, closing an existing stub) with its enqueue point in memory's
store path; `notify_pending` and `reply` reactive jobs; the `reminder` one-off.
**Deferred:** external channel adapters (`triage`), richer retry/backoff policy,
and a `fortytwo` CLI surface for inspecting/managing the queue.
