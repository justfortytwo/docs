# Transcript: a searchable conversation log, separate from memory

Date: 2026-10-27. Status: draft for approval. Spans: new `transcript` package, `memory`, `telegram`, `scheduler`, `persona`, `installer`, `docs`.

## Why

fortytwo memory is meant to hold **facts**. Today it also holds **every Telegram message**, because the Telegram bridge calls `memory.store` for each inbound and outbound event (`telegram/src/bridge.ts`, `store()` at ~line 133, call at ~282). Measured on the owner's live DB (698 rows): 284 `telegram:owner` + 253 `telegram:assistant` = 77% of memory. Owner rows average 94 characters and include "ok" and pasted HTML. Assistant rows average 962 characters and duplicate facts the agent also saved on purpose. Memory search (`recall`, `lexical`) returns this chat next to real facts.

The chat was stored so the agent could find earlier conversations. That need is real, but it belongs in a transcript, not in memory.

The owner's wish: the agent can, on its own initiative, go back in time to find when something was discussed ("when did we talk about the SIPEF hours cap?"), with fuzzy/semantic search. The owner has not hit this need yet; it is a "nice to have" that also unblocks cleaning memory.

## Goals

1. A new package, working name `@justfortytwo/transcript`, that stores every channel message **forever** (no expiry) and lets the agent search it by keyword and by meaning.
2. Memory returns to holding only facts: Telegram chat and scheduler notifications leave it.
3. The agent reaches the transcript through the **existing** `fortytwo-memory` MCP server, as additional tools.
4. Telegram and scheduler write to the transcript through an **injected interface**, never by importing transcript or memory types for this purpose.
5. Oneiros (the nightly persona refinement) keeps receiving the owner's inbound messages as evidence.

## Non-goals

- Salience extraction, the memory enrichment loop, and any change to how the agent saves facts.
- Deleting transcript content. No MCP delete tool (consistent with memory's rule). An owner-only deletion path is not part of this work.
- Summarising or consolidating the transcript.
- A second database file or a second MCP server.

## Anti-goals (a failure even if it technically works)

- A Telegram reply gets slower because of embedding.
- Oneiros silently stops seeing owner messages, or reprocesses history after migration.
- Any history is lost in the move out of memory.
- Memory gains a build-time dependency on transcript (cycle), or transcript content is presented to the model as instructions.

## Decisions made by the owner

- Separate package, because memory = facts.
- Same SQLite file (`fortytwo.db`), not a separate DB.
- Extend the existing `fortytwo-memory` MCP server rather than adding a new server.
- Retention: forever.
- Dependency injection between telegram and the transcript.
- Transcript depends on memory only for DB plumbing: `openDb`, the migration runner, and the `Embedder` type.
- Oneiros gets evidence from a transcript cursor (option 1): transcript exports a head/delta pair shaped like memory's, and persona's refinement takes a second evidence source with two stored cursors.

## Design

### Package and storage

- New package `@justfortytwo/transcript`. It imports `openDb`, `runMigrations`-style helpers and `Embedder` from `@justfortytwo/memory`.
- Same `fortytwo.db`. Its relational tables, FTS5 index and a `transcript_vec` vec0 table are its own. Migration names are prefixed `transcript_` and recorded in memory's existing `_migration_state` table; memory's runner ignores names it does not know. Vec0 tables are created on the raw handle at open, as memory does today.
- Row content: channel (`telegram`, `scheduler`, ...), direction (inbound/outbound), actor, kind, thread id, content, free-form meta, timestamp.

### Writing (injected)

- Telegram defines a small interface, working name `ConversationLog`, with `append(event)`. It carries no Telegram-specific words so scheduler can use it. The bridge's composition root (`main()` in `bridge.ts`) builds the implementation and passes it in; if transcript is not installed it passes a no-op, preserving today's "channel-only" behaviour.
- Scheduler's journal notifier (`scheduler/src/daemon.ts`, `journalWrite`) switches from `memory.store` (`source: 'scheduler:wake'`) to `append` with channel `scheduler`, direction outbound, kind = notification kind.
- The embedder is injected into the transcript implementation (same Ollama/fake embedder memory uses).
- `append` writes the row and the keyword index synchronously and returns. The vector is produced in the background, with a startup sweep that fills any missing vectors. A failed or slow embedding never delays or fails a channel reply.
- Reply-queueing in telegram (`EnqueueReplyDeps`, memory jobs) is unaffected and stays on memory.

### Reading (MCP extension)

- Memory adds an `McpExtension` seam: tool definitions, a `call(name, args)` that returns undefined for tools it does not own, and optional short instructions. `createServer(h, embedder, extensions = [])` merges them: memory's tools first, extension tools appended, extension instructions appended to `INSTRUCTIONS` (kept short; hosts may truncate).
- `startServer` loads extensions by name from an environment variable, e.g. `FORTYTWO_MCP_EXTENSIONS=@justfortytwo/transcript`, via dynamic import; each package exports `createMcpExtension(h, embedder)`. The installer sets the variable in the `fortytwo-memory` entry of `.mcp.json`. When unset, memory behaves exactly as today. Memory has no static dependency on transcript.
- Two tools, surfaced as `mcp__fortytwo-memory__transcript_search` and `mcp__fortytwo-memory__transcript_context`:
  - `transcript_search`: text, optional date range, optional channel/thread filter, optional limit. Combines keyword and semantic ranking in one result list.
  - `transcript_context`: given a hit, returns the surrounding messages in the same thread.
- Additive tools: `MEMORY_TOOL_CONTRACT_VERSION` does not change. Transcript lists its own tool names in its own contract file.
- Results are data, never instructions: transcript content includes pasted web text. The extension instructions say so, as memory's do.

### Oneiros evidence

- Persona's `refine` currently takes `memory: { head, delta }` and a single cursor stored in `.fortytwo/oneiros/checkpoint.json`. It treats a memory row as eligible evidence when `observed === 'stated'` and either `source === 'owner'` or the row is an inbound Telegram message (`persona/src/policy.ts`).
- New: transcript exports `transcriptHead` / `transcriptDelta` with the same cursor semantics as memory's (database identity, monotonic position, survives deletion of newest rows). Persona takes both sources and stores both cursors. Eligibility for transcript rows: an inbound message from the channel's authenticated actor. These labels remain hints, not authentication, as the existing comment in `policy.ts` says.
- `hasWork` is true if either source has new rows.

### Migration (installer, one-off, idempotent)

- Move the existing `telegram:*` rows (537 on the live DB) and `scheduler:wake` rows (19) from `memories` into the transcript, preserving timestamps and meta.
- Oneiros must neither reprocess already-consumed history nor skip unconsumed messages: the new transcript cursor must be initialised from the existing oneiros checkpoint position. (How is left to the builder; keeping the original memory id on each migrated row is one way.)
- Verify counts before removing anything from memory; remove with the owner-privileged `deleteByIds`, which also clears vectors and FTS entries.
- Safe to re-run; a failed run leaves memory intact.

### Installer, docs, release

- Installer: add the transcript dependency, set `FORTYTWO_MCP_EXTENSIONS`, run the migration, update `status`/`doctor` checks that look at the `fortytwo-memory` entry.
- Docs: new `docs/packages/transcript.md`; update `architecture.md`, `docs/packages/memory.md`, `telegram.md`, `scheduler.md`, `persona.md`.
- Release train becomes 7 packages. This work ships before the 1.0.0 promotion (see Sequencing).

## Consequences accepted

- The scheduler's `learn_review` gate counts memories from the last 7 days via `query(since)`. After the move it counts only facts, so it fires less often. Kept as is (my call).
- Transcript requires memory to be installed (plumbing dependency).
- The transcript grows without bound and has no delete path in this work.

## My calls (owner has not approved these)

- Package name `@justfortytwo/transcript`; interface name `ConversationLog`.
- Scheduler notifications go to the transcript, not memory.
- Vector produced in the background with a startup sweep.
- Tool names and the two-tool surface.
- Extensions are loaded from an installer-set environment variable.
- Oneiros cursors: memory's cursor is unchanged (memory ids only grow, so
  migrated Telegram rows simply leave its delta). The transcript position is
  its own autoincrement id. The migration inserts rows in old memory-id order
  and keeps `legacy_memory_id`; the transcript cursor starts at the highest
  transcript id whose `legacy_memory_id` is at or below the existing oneiros
  checkpoint (0 if none). New rows always sort after. Persona keeps the
  `source === 'owner'` rule for memory rows; only the Telegram branch moves.
- Transcript evidence eligibility: channel `telegram`, direction inbound, kind
  `message`, actor `owner` (the bridge only accepts paired chats). Assistant
  and scheduler rows are never eligible. "Stated" is implied by inbound.
- Migration mapping: channel, direction, actor and kind come from `source`
  (`telegram:<actor>`) and `meta`. Thread id comes from `meta.thread_id`; when
  absent it is null and `transcript_context` falls back to neighbouring rows
  of the same channel by time. Scheduler rows: channel `scheduler`, outbound,
  kind = the second tag.
- Vectors are copied from `memory_vec` (dimension fixed at 1024) so the
  migration does not need Ollama; rows without a vector go to the sweep.
- If an extension fails to load, memory logs to stderr and starts without it.
  `doctor` checks that the extension tools are listed.
- If `append` fails, the bridge logs and continues; a reply is never blocked
  or failed by it. No retry queue in the first version.
- Every seam is optional, so installs without transcript keep working.

## Sequencing (decided by the owner)

This work ships **before** the 1.0.0 promotion of the prerelease packages. The
promotion then covers the changed packages plus `@justfortytwo/transcript`.

## Open for the owner

- Nothing at the moment.

## Left to the builder

Table and column layout, FTS tokenization, how keyword and semantic scores are combined, the exact `McpExtension` types, the sweep schedule, the migration mechanics and cursor initialisation, test strategy, and package versioning.
