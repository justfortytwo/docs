# `@justfortytwo/memory`

A standalone **semantic-memory MCP server**. It stores text "memories" with
free-form provenance and recalls them by meaning (vector search), by keyword
(FTS5), or by structured filter. Backed by SQLite + [`sqlite-vec`], with
embeddings from a local Ollama model (or an opt-in remote provider).

It is **persona-agnostic**: no chat/persona/approval coupling, just a
generic memory store and tool surface. It can be used on its own, as a library,
or as a Claude Code plugin.

- **Version:** `1.0.0` · **Runtime:** MCP server over stdio, `bin` is
  `fortytwo-memory` · **Node:** >= 20

[`sqlite-vec`]: https://github.com/asg017/sqlite-vec

## Why this exists

An assistant without durable memory restarts from zero every session. memory
gives the spine a single, local, queryable long-term store: what was learned,
where it came from, and when — with corrections that keep history instead of
silently overwriting it.

## What it stores

A memory is `content` plus provenance:

| field | meaning |
|-------|---------|
| `content` | the text (embedded for recall) |
| `source` | where it came from — free-form (`owner`, `web`, `tool:foo`) |
| `observed` | how it was observed — free-form (`stated`, `inferred`, `imported`) |
| `date` | ISO date the memory pertains to (defaults to today, UTC) |
| `tags` | free-form tags for filtering |
| `supersedes` | id of a prior memory this one replaces (history is **kept**) |

Recall is hybrid: `recall` (semantic), `lexical` (FTS5 keyword), and `query`
(structured). `reindex` + `recall_docs` index/search a directory of markdown
documents separately from the memory store.

## MCP tools

The server registers under the id **`fortytwo-memory`**, so a consumer calls
the tools as `mcp__fortytwo-memory__<tool>`:

| tool | description |
|------|-------------|
| `store` | store a memory (+ provenance); set `supersedes` to replace one |
| `query` | structured query (source/observed/tag/time; live rows by default) |
| `recall` | semantic top-k recall by meaning |
| `recall_docs` | semantic recall over reindexed markdown |
| `lexical` | full-text keyword search (FTS5) |
| `reindex` | self-heal the doc index from a markdown directory |
| `export_range` | render a date range of memories to markdown |

On connect, the server sends usage **instructions** in the MCP `initialize`
result (when to search vs. store, which search tool fits, how to correct a
memory with `supersedes`). The text lives in `src/server.ts`.

### Contract version

Consumers depend on the **tool surface**, not the internals. The contract is
versioned:

```ts
import {
  MEMORY_TOOL_CONTRACT_VERSION,
  memoryToolContract,
} from '@justfortytwo/memory/contract';
```

- A **major** change to a tool name, its required inputs, or its result shape
  is a **contract break** → bump `MEMORY_TOOL_CONTRACT_VERSION`. Siblings pin
  a caret range on `@justfortytwo/memory`, so a major bump forces an explicit
  opt-in.
- Additive changes (new optional inputs, new tools) do **not** bump it.

`memoryToolContract` is the authoritative human-readable list of tools and
their guarantees, kept in sync with the wire schema in `src/tools.ts`.

## Extension seam

memory holds **facts only**. Sibling packages can add MCP tools to the same
server without memory depending on them, through the `McpExtension` interface
(`src/extension.ts`):

```ts
interface McpExtension {
  tools(): Tool[];
  call(name: string, args: Record<string, unknown>): Promise<unknown | undefined>;
  instructions?: string;
}
```

- `call` returns `undefined` for tools the extension does not own.
- `createServer(h, embedder, extensions = [])` is exported from the package
  index. Memory's tools come first, extension tools are appended, and
  extension `instructions` are appended to memory's. An extension tool whose
  name collides with an existing tool is skipped (logged to stderr).
- **`FORTYTWO_MCP_EXTENSIONS`** is a comma-separated list of package names.
  At startup memory imports each one dynamically and calls its exported
  `createMcpExtension(h, embedder)`. A module that fails to load or does not
  export that function is logged to stderr and skipped; the server still
  starts. When the variable is unset memory behaves as before.
- Extension tools are outside `memoryToolContract`; they never bump
  `MEMORY_TOOL_CONTRACT_VERSION`.

The first extension is `@justfortytwo/transcript`, which adds
`transcript_search` and `transcript_context` (see
[transcript](./transcript.md)). Conversation history is no longer stored in
memory: the Telegram bridge and scheduler write to the transcript, and the
installer migrates existing chat rows out.

## Data model

SQLite via `better-sqlite3` + `knex` migrations (`src/migrations/`, applied by
`fortytwo-memory-migrate` / `npm run migrate`):

| migration | creates |
|-----------|---------|
| `001_init` | `memories`, `index_state` |
| `002_fts` | `memory_fts` (FTS5, content-linked to `memories`) |
| `003_approvals` | `approvals`, `audit_log` (gate seam) |
| `004_jobs` | `jobs` (shared with the scheduler, see [Scheduler](../scheduler.md)) |
| `005_memory_identity` | `memory_identity` (stable database identity) |

Vector columns are fixed at **1024 dims** (`sqlite-vec`); a model with a
different dimensionality requires a schema change.

## Embedder

Default: **`OllamaEmbedder`** against a local Ollama `/api/embeddings`
endpoint.

```bash
OLLAMA_BASE_URL=http://localhost:11434   # default
EMBED_MODEL=qwen3-embedding:0.6b         # default model (1024-dim)
```

If `EMBED_MODEL` is **unset**, the server falls back to a deterministic,
dependency-free **`FakeEmbedder`** — for tests, CI, and first-run smoke checks
with zero infra.

Remote providers are opt-in via `EMBED_PROVIDER=openai`; only models that emit
(or truncate to) 1024 dims are accepted (`text-embedding-3-small/large`,
`voyage-3-large`, `BAAI/bge-m3`, `Qwen/Qwen3-Embedding-0.6B`). Any other
`EMBED_MODEL` fails at startup with the accepted list.

> **Switching models on an existing database:** two models with the same
> dimension do **not** share a vector space. Stored vectors are not comparable
> with new query vectors, and `recall` will not error — it will return
> plausible but wrong neighbours. Re-embed with the library's
> `reembed(h, embedder, id)` (one id at a time; no bulk command or MCP tool)
> and re-run `reindex` for docs after switching.

## Library API

```ts
import {
  openDb, runMigrations, OllamaEmbedder, embedderFromEnv,
  store, recall, deleteByIds, enrich, enrichFromTurn,
  memoryHead, memoryDelta,
} from '@justfortytwo/memory';
```

- `openDb(path)` / `runMigrations(knex)` — open and migrate the database.
- `store` / `recall` / `query` / `lexical` — same operations the MCP tools
  expose.
- `deleteByIds(h, ids)` — hard-delete (row + vector + FTS). Intentionally a
  **library API and NOT an MCP tool**: deletion is owner-privileged, and
  exposing it to the assistant's turn loop would let prompt-injected content
  trick it into erasing memories. Selecting which ids to remove is the
  caller's job — see the installer's `forget`.
- **Incremental reads:** `memoryHead(h)` returns `{ database, position }`
  using a persistent database identity and SQLite's AUTOINCREMENT high
  watermark (not timestamps or `MAX(id)`). `memoryDelta(h, cursor, limit)`
  returns ascending insertion pages, includes superseded rows as evidence,
  never skips unreturned rows; deleted-id gaps remain safe; invalid or
  backwards cursors fail closed. Library APIs only — the MCP tool contract
  is unchanged.

## Continuous enrichment

`enrich(h, embedder, candidates)` folds a batch of candidate memories into the
store: drops low-salience candidates, **dedupes** near-duplicates by meaning,
and writes the survivors with provenance — honoring an explicit `supersedes`
to replace a stale belief. `enrichFromTurn(h, embedder, turn, extractor)` runs
an injected `SalienceExtractor` and feeds its candidates to `enrich`.

The salience extractor itself is model-driven and lives in the sibling
**`@justfortytwo/salience`** — memory owns only the dedupe + write, never the
model call.

## Peer seams

memory depends on two sibling packages **one-directionally** (optional peers,
no cycle):

- **`@justfortytwo/gate`** — memory ships `GateApprovalStore`
  (`src/gate-approval-store.ts`), a durable SQLite-backed implementation of
  gate's `ApprovalStore` + `AuditLogger` interfaces. Pass it to gate's
  `decide(..., { store, audit })` to back the safety gate's one-shot approvals
  with memory's db instead of gate's standalone JSONL store.
- **`@justfortytwo/salience`** — the model-driven salience extractor injected
  into `enrichFromTurn`.

## Running it

```bash
npm install @justfortytwo/memory
npm run build                      # tsc; the server runs built JS
DB_PATH=./memory.db npm run migrate
DB_PATH=./memory.db EMBED_MODEL=qwen3-embedding:0.6b fortytwo-memory
```

Register in any MCP host via `.mcp.json` (`command: "npx"`,
`args: ["-y", "@justfortytwo/memory"]`). As a Claude Code plugin,
`.claude-plugin/plugin.json` + `.mcp.json` launch it with
`DB_PATH=${CLAUDE_PLUGIN_DATA}/memory.db`, which survives plugin updates.

## Testing

```bash
npm test                # vitest run
RUN_OLLAMA_TESTS=1 ...  # opt-in live-Ollama embedder test
```

## Scope

**In scope:** the memory store (facts), hybrid recall, contract-versioned MCP
tool surface, the MCP extension seam, doc indexing, enrichment intake, gate
approval store, incremental delta reads.

**Out of scope:** the salience model call (owned by `@justfortytwo/salience`),
deletion over MCP (owner-privileged, via the installer's `forget`), persona or
chat semantics, conversation history (owned by
`@justfortytwo/transcript`).
