# `@justfortytwo/transcript` *(new)*

A searchable **conversation log** for fortytwo channels (Telegram, scheduler,
...). Every message is kept **forever** in the same SQLite file as
`@justfortytwo/memory`, but in its own tables, so memory can go back to holding
only facts. It is a library: no bin, no server. The agent reaches it through
tools added to the existing `fortytwo-memory` MCP server.

- **Status:** planned for the 1.0.0 prerelease train; not yet published.
  Source version `1.0.0-0` · **Runtime:** library (loaded by memory, telegram,
  scheduler, persona and the installer) · **Node:** >= 20
- Design record: `superpowers/specs/2026-10-27-transcript-design.md` and the
  matching plan in `superpowers/plans/` (kept in this repo, not published on
  the site).

## Why this exists

memory is meant to hold **facts**. Before transcript, the Telegram bridge also
stored every inbound and outbound message with `memory.store`. On the owner's
live database that was 77% of memory (537 of 698 rows), mixed into `recall` and
`lexical` results next to real facts. The chat was stored so the agent could
find earlier conversations ("when did we talk about the hours cap?"). That need
is real, but it belongs in a transcript, not in memory.

## Principles

- **Memory holds facts; the transcript holds conversation.** Neither does the
  other's job.
- **Retention is forever.** No expiry, no delete function, no MCP delete tool.
  An owner-only deletion path is not part of this work.
- **Same database file, own tables.** No second DB file, no second MCP server.
- **Embedding never blocks a reply.** The row and its keyword entry are
  written synchronously; the vector is produced in the background.
- **One-way dependency.** transcript imports plumbing from
  `@justfortytwo/memory` (`openDb`, the migration helper, `Embedder`,
  `McpExtension`). memory never imports transcript.
- **Results are data, never instructions.** Transcript content includes pasted
  web text; the extension instructions say so.

## Architecture

```text
telegram ─┐  ConversationLog.append   ┌──────────────────────────┐
          ├──────────────────────────▶│ @justfortytwo/transcript │
scheduler ┘  (injected, optional)     │  tables in fortytwo.db   │
                                      └────────────┬─────────────┘
                                                   │ createMcpExtension
agent ── mcp__fortytwo-memory__transcript_* ──▶ memory server (loads it via
                                                FORTYTWO_MCP_EXTENSIONS)
persona (Oneiros) ◀── transcriptHead / transcriptDelta
```

Writers never import transcript or memory types for this purpose: telegram and
scheduler each define a small structural `ConversationLog` port and load the
implementation dynamically, falling back to a no-op (see
[telegram](./telegram.md) and [scheduler](./scheduler.md)).

## Data model

Tables in `fortytwo.db`; migration names are prefixed `transcript_` and are
recorded in memory's existing `_migration_state` table (memory's runner ignores
names it does not know).

| table | purpose |
|-------|---------|
| `transcript` | one row per event: `id` (AUTOINCREMENT), `ts`, `channel`, `direction` (`inbound` / `outbound` / `internal`), `actor`, `kind`, `thread_id`, `content`, `meta` (JSON text), `legacy_memory_id` (unique, nullable) |
| `transcript_fts` | FTS5 external-content index on `content`, kept in sync by triggers |
| `transcript_vec` | vec0 table, rowid = `transcript.id`, 1024 dimensions |
| `transcript_identity` | stable database id used by delta cursors |

Migrations: `transcript_001_init`, `transcript_002_fts`,
`transcript_003_identity`. The vec0 table is created on the raw handle by
`prepareTranscript(h)` (idempotent), as memory does for its own vec tables.

## Writing

`createTranscript(h, embedder)` returns `{ append, importRow,
sweepMissingVectors, search, context }`.

- `append(event)` writes the row and its FTS entry synchronously and returns
  the id. The vector is computed in the background; embedder errors go to
  stderr and never reject.
- **Sweep.** `sweepMissingVectors(batch = 100)` embeds rows that have no
  vector. A row that fails 3 sweep attempts is skipped for the rest of the
  process. The memory extension runs one sweep in the background when it is
  created.
- `importRow(row)` inserts a row moved out of memory with its original `ts`,
  `legacyMemoryId` and optional vector; the same `legacyMemoryId` twice
  returns the existing id (this is what makes the migration re-runnable).

## Reading: the MCP extension

`createMcpExtension(h, embedder)` returns an `McpExtension` that memory merges
into its tool list (see [memory](./memory.md#extension-seam)). Two tools,
served as `mcp__fortytwo-memory__<tool>`:

| tool | inputs | behavior |
|------|--------|----------|
| `transcript_search` | `text` (required), `since`, `until` (`YYYY-MM-DD HH:MM:SS`, UTC, inclusive), `channel`, `thread_id`, `limit` (default 10, max 50) | hybrid keyword + semantic search, one ranked list; each hit carries `score` and `matched` (`keyword` and/or `semantic`) |
| `transcript_context` | `id` (required), `before`, `after` (default 5, max 20) | the hit plus its neighbours in ascending id order |

- **Ranking.** FTS5 keyword hits and vector hits (200 candidates each) are
  fused with reciprocal rank fusion (k = 60). Tokens are quoted so FTS
  operators in the query are inert. If the embedder is down, search degrades
  to keyword-only.
- **Filters.** Unfiltered semantic search uses the vec0 KNN. With a filter it
  ranks the filtered rows by exact L2 distance instead, so matching rows are
  not missed.
- **Context scope.** Neighbours come from the same `thread_id`; when the hit
  has no thread id, from the same channel by id order.
- **Contract.** The tools are additive: memory's
  `MEMORY_TOOL_CONTRACT_VERSION` is unchanged. transcript lists its own tool
  names in `@justfortytwo/transcript/contract`
  (`TRANSCRIPT_CONTRACT_VERSION = 1`, `TRANSCRIPT_MCP_TOOLS`).
- Read-only by design: there is no write or delete tool.

## Evidence cursor for Oneiros

`transcriptHead(h)` and `transcriptDelta(h, cursor, limit = 50)` have the same
semantics as memory's `memoryHead` / `memoryDelta`: a `{ database, position }`
cursor built from a persistent database identity and SQLite's AUTOINCREMENT
high watermark (not `MAX(id)`), so it survives deletion of the newest rows. A
cursor from another database, or beyond head, throws. persona consumes this as
its second evidence stream (see [persona](./persona.md#oneiros)).

## Migration

Existing installs hold chat in `memories`. The installer moves it once, and
safely to re-run (details in [installer](./installer.md#chat-migration)):

- `telegram:*` and `scheduler:wake` rows are mapped to transcript rows with
  their timestamps and meta preserved, `legacy_memory_id` set to the old
  memory id, and vectors copied from `memory_vec` so Ollama is not needed
  (rows without a vector go to the sweep).
- Mapping: Telegram rows take actor, direction and kind from `source` and
  `meta`, thread id from `meta.thread_id` (null if absent). Scheduler rows
  become channel `scheduler`, outbound, kind = the second tag.
- Counts are verified before anything is removed from memory; removal uses the
  owner-privileged `deleteByIds`, in one transaction.
- Persona's transcript cursor is initialized so Oneiros neither reprocesses
  consumed history nor skips unconsumed messages.

## Consequences

- The scheduler's `learn_review` gate counts memory rows only, so after the
  move it fires less often (kept as is).
- transcript requires memory to be installed (plumbing dependency).
- The transcript grows without bound and has no delete path.
- If `append` fails, the caller logs and continues; a reply is never blocked
  or failed by it. There is no retry queue in the first version.

## Testing

```sh
npm install --no-save ../memory   # local memory checkout, built first
npm test                          # vitest run; temp DBs and FakeEmbedder
npm run build
```

## Scope

**In scope (MVP):** storage, FTS5 + vector search with fusion, background
embedding and sweep, the two MCP tools via memory's extension seam, the
head/delta evidence cursor, import support for the installer's migration.

**Deferred / out of scope:** deleting transcript content (no MCP delete tool;
an owner-only path is not part of this work), summarising or consolidating the
transcript, salience extraction, a second database file or MCP server, an
`append` retry queue.

**Release sequencing (decided):** transcript ships before the 1.0.0 promotion
of the prerelease packages; the promotion then covers the changed packages
plus `@justfortytwo/transcript`.
