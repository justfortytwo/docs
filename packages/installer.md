# `@justfortytwo/installer`

The all-in-one installer and lifecycle CLI for **fortytwo** — it scaffolds the
persona surface and provisions the npm engine (memory MCP, safety gate, channel
adapters, embedder). One package ships two bins:

- **`create-fortytwo`** — the install-time alias; with no verb it runs `init`.
- **`fortytwo`** — the everyday lifecycle alias.

- **Version:** `1.0.0-15` *planned* (published: `1.0.0-14`) · **Runtime:** one-shot CLI · **Node:** >= 20
  (20/22 LTS recommended, for `better-sqlite3` prebuilds)

## Why this exists

The ecosystem is a set of small, independently versioned packages. Someone has
to own the *assembly*: pick compatible versions, wire `.mcp.json`, render the
personal persona, provision local infra, and keep the result updatable and
rollback-able. That is this CLI — the bootstrap and lifecycle entry point of
fortytwo.

## Quick start

```sh
npx @justfortytwo/installer init   # in a new, empty directory
fortytwo start                     # run fortytwo (foreground; Ctrl+C stops it)
fortytwo pair                      # in a second terminal: connect Telegram
```

`pair` prints a code; send `/login <code>` to your bot from the chat you want
to connect. Until then the bot ignores everyone.

## The two-surface model

fortytwo is delivered as **two surfaces**, and this CLI is the single operator
interface over both:

1. **The npm engine.** The reusable machinery — the memory MCP server, the
   safety gate, the channel adapters, the local embedder — published as
   `@justfortytwo/*` packages and wired in as Claude Code plugins.
2. **The scaffolded persona.** `CLAUDE.md` + `context/*` — who the assistant
   is and who it serves. **Not** a plugin: per-user, personal, gitignored. The
   CLI scaffolds it by rendering `@justfortytwo/persona`'s `templates/`
   (guided by its `manifest.json`) against the captured answers in
   `.fortytwo/identity.json`. Re-rendering is idempotent and never clobbers
   captured or hand-edited fields.

Secrets live only in a gitignored `.env`; captured identity lives in the
gitignored `.fortytwo/identity.json`; neither is ever committed.

## Verbs

| Verb | What it does |
|------|--------------|
| `start` | Run fortytwo in the foreground: load the project `.env` (process env wins over it), start every installed and configured service, prefix and forward their logs, stop them all on Ctrl+C/SIGTERM. Never daemonizes or restarts — the surrounding service manager owns that. |
| `status` | Show whether fortytwo, the Telegram bridge and the scheduler are running, and whether memory is configured. Exits 0 when running, 3 when not (usable as a health check). |
| `stop` | Stop this project's `fortytwo start`. Signals only the process recorded in `.fortytwo/runtime.json`, and only while its heartbeat is fresh **and** its OS process-start identity matches; never looks for processes by name. |
| `init` | Install missing engine packages, pin the CLI into the project and install the `fortytwo` launcher, capture identity (interactive or flags/env for CI), write `.fortytwo/identity.json` + `.env`, wire `.mcp.json`, render the persona, provision local infra (embedder model, memory DB migration), record the installed version set. |
| `pair` | Issue a one-time `/login` pairing code, persisted to the bridge's bindings db (dynamic counterpart of the static `ALLOWED_CHAT_IDS` allowlist). Refuses when Telegram isn't running, unless `--force`. |
| `doctor` | Health-check the engine: gate package compatibility (`POLICY_SCHEMA_VERSION`), memory's `MEMORY_TOOL_CONTRACT_VERSION`, migrated DB, installed sibling versions vs. the declared compatibility ranges, embedder model present (warn-only). |
| `update` | Resolve the latest in-range version of each **installed** engine package, plus `@justfortytwo/transcript` when memory is installed and transcript is missing, install it, rotate the rollback baseline, then run `doctor`. `--dry-run` reports without installing. |
| `rollback` | Re-install the previous version set recorded before the last `update`, then run `doctor`. Manual by design — never auto-triggered. |
| `enrich` | Capture more answers to deepen the persona, then re-render (no clobber). |
| `forget` | Permanently delete memories selected by `--id` / `--query` (semantic) / `--tag` / `--source` / `--since`/`--until` — previewed and confirmed (or `--yes`). Owner-only: deletes via the memory library API, never exposed to the assistant. |
| `unbind` | Revoke a channel binding (un-pair a chat / drop it from the allowlist). |

## Versioning and compatibility

Engine versions live only in `package.json` `fortytwo.compat` — deliberately
**not** in `peerDependencies`, so upgrading the installer never trips npm's
peer resolution:

```jsonc
"fortytwo": {
  "compat": {
    "@justfortytwo/memory": "1.0.0-3",
    "@justfortytwo/gate": "^0.1.0",
    "@justfortytwo/persona": "1.0.0-3",
    "@justfortytwo/telegram": "1.0.0-8",
    "@justfortytwo/scheduler": "1.0.0-4",
    "@justfortytwo/transcript": "^1.0.0-0"
  }
}
```

`init` installs these ranges, `doctor` cross-checks the *installed* siblings
against them, `update` resolves latest-in-range and records the set into
`.fortytwo/state.json` for rollback. `update` moves only the siblings already
installed, with one exception: when memory is installed and a declared memory
companion (today `@justfortytwo/transcript`) is missing, `update` installs it,
so chat keeps being recorded. `doctor` and `status` warn (without failing) when
memory is installed but the declared transcript is not. This compat block is
the planned `1.0.0-15` contract. telegram and scheduler pull in
`@justfortytwo/runner` themselves — the installer never installs runner
directly. Pass `--no-install` to manage engine packages yourself.

Distribution is **semver-ranges, latest-compatible** — no curated
bill-of-materials. Rollback is manual by design.

## The `fortytwo` launcher

No global npm install. `init`:

1. Pins the CLI into the project (`--save-exact`), so `package-lock.json`
   records it and every project runs its own version.
2. Installs a small launcher named `fortytwo` into the first writable dir on
   `PATH` of `~/.local/bin`, `~/bin`, or npm's global bin (`FORTYTWO_BIN_DIR`
   overrides). Shell config and `PATH` are never edited.

The launcher holds no version and no project path: it finds the nearest
directory containing `.fortytwo/` and runs that project's own pinned
`node_modules/.bin/fortytwo` — only if you own that project's `.fortytwo/` and
CLI, so code another user plants in a shared directory is never run. It never
replaces a `fortytwo` it did not write.

## Running as a service

`fortytwo start` stays in the foreground on purpose, so the thing that runs it
owns restarts and logs:

```yaml
# docker-compose.yml (excerpt)
services:
  fortytwo:
    command: ["npx", "fortytwo", "start"]
    working_dir: /workspace
    init: true                     # reap processes the bridge's sessions leave
    restart: unless-stopped
```

```ini
# systemd unit (excerpt)
[Service]
WorkingDirectory=/path/to/project
ExecStart=/usr/bin/env npx fortytwo start
Restart=on-failure
```

**Environment precedence:** process env (shell/container/systemd) > project
`.env` > defaults. `FORTYTWO_ROOT` defaults to the project directory. On
SIGTERM it stops its services (SIGKILL after 10 s) and exits 0; if a service
dies on its own it stops the rest and exits non-zero, so `restart` policies
kick in.

For development, each service still ships its own bin (`fortytwo-telegram-bridge`,
`fortytwo-scheduler`) — export `.env` and `FORTYTWO_ROOT` yourself.

## The embedder

The engine uses a **local** embedder for privacy — personal data never leaves
the machine. Standard model `qwen3-embedding:0.6b` served by Ollama; `init`
makes sure it is available (`GET /api/tags`, pulling over `POST /api/pull` —
no `ollama` CLI needed on the installer's machine) and `doctor` verifies it.
`--ollama-base-url` (or the interactive question) threads the endpoint into
both `.env` and the memory server's `.mcp.json` entry.

## MCP extensions and the transcript

When `@justfortytwo/transcript` is installed, `init` and `update` wire it into
the `fortytwo-memory` entry of `.mcp.json` (planned for the 1.0.0 prerelease
train; not yet published):

- `FORTYTWO_MCP_EXTENSIONS=@justfortytwo/transcript` is set in the entry's
  `env`. memory reads it and loads the extension (see
  [memory](./memory.md#extension-seam)). Without transcript installed the
  variable is removed.
- **The entry is rewritten, its env preserved.** Each re-wire rewrites
  `command` and `args`, sets `DB_PATH` and sets or removes
  `FORTYTWO_MCP_EXTENSIONS`. Every other env key already in the entry is kept,
  so a hand-set remote embedder (`EMBED_PROVIDER`, `EMBED_API_KEY`,
  `EMBED_MODEL`, `EMBED_BASE_URL`) survives `init` and `update`. `EMBED_MODEL`
  and `OLLAMA_BASE_URL` get their defaults only when absent; `update` keeps the
  entry's `OLLAMA_BASE_URL`, `init` writes the endpoint it resolved.
- **A malformed `.mcp.json` is never overwritten.** `init` and `update` stop
  with an error naming the file before installing or recording anything.
- **Launch form.** Without extensions the entry runs
  `npx -y @justfortytwo/memory`. With extensions it runs
  `npx -y -p @justfortytwo/memory -p @justfortytwo/transcript fortytwo-memory`.
  memory resolves extensions from its *own* npx install, so every package must
  share one npx prefix; `-p` for each package guarantees that.
- **`update` re-wires `.mcp.json` first** (`reconcileRuntime`), before the chat
  migration, so moving chat out of memory never leaves the agent without
  transcript search. The `doctor` results `update` prints come from a run
  after this reconciliation, so they show the re-wired entry.
- **`doctor`** has a warn-only `mcp extensions` check: it warns if transcript
  is installed but not listed in `FORTYTWO_MCP_EXTENSIONS` (re-run
  `fortytwo init`), if the variable names a package that is not installed or
  that the entry's `args` do not pass with `-p <package>`, or if memory is
  installed without the declared transcript (chat is not being recorded; run
  `fortytwo update`). `status` prints the same warnings.
  A missing extension loses its tools but memory itself still works.

### Chat migration

`init` and `update` run a one-off, idempotent move of chat history out of
memory into the transcript (`src/transcript-migration.ts`). It is skipped when
memory or transcript is not installed. Order:

1. Map every `telegram:*` and `scheduler:wake` memory row to a transcript row
   (pure; a malformed row fails before any write).
2. Import in batches of 100, one transaction each. Import is idempotent on
   `legacy_memory_id`, so a re-run after a crash imports nothing twice.
   Vectors are copied from `memory_vec`; no embedder is needed.
3. Verify every source row has a transcript row with identical content.
4. Only then delete from memory with `deleteByIds`, all in one transaction;
   any failure leaves memory intact.
5. If persona is installed and has a memory checkpoint but no transcript
   checkpoint, initialize the transcript cursor so Oneiros resumes where it
   left off (never overwriting an existing cursor).

Output reports `moved N chat row(s) from memory to the transcript` when rows
moved. A failed migration (a malformed legacy row, a busy database) does not
abort `init` or `update`: it reports `chat migration skipped: <reason>`, memory
stays intact, and the next `init` or `update` retries it.

## Oneiros installation and upgrades

`init` automatically initializes Oneiros at the current memory head and seeds
one `persona.oneiros` scheduler job — no extra questions. An empty DB starts at
zero; an existing DB starts at its insertion high watermark. `update` never
re-renders persona/context files; after installation and health checks it
initializes only missing Oneiros state and reconciles the job via
`UpdateDeps.reconcile` — the seam for explicit, idempotent machine-owned
asset/state migrations. Curated context and historical memory are never
replayed implicitly.

## Runtime ownership across container restarts

`.fortytwo/runtime.json` records `processIdentity` alongside the supervisor
PID and heartbeat:

- **Linux:** kernel boot ID + PID namespace + start ticks (field 22) of
  `/proc/<pid>/stat` — a stale file from an earlier container cannot claim a
  new process merely because its PID was reused.
- **macOS/other:** `ps -p <pid> -o lstart=` compared with a fixed
  locale/timezone; second-level precision (cannot distinguish same-second PID
  reuse).

Missing or unreadable identity is never accepted as proof of ownership;
a supervisor that cannot read its own identity refuses to start services.
Legacy PID-only records are treated as stale. Identity is rechecked
immediately before `SIGTERM`, though Node's PID-based signal API does not make
check-and-signal atomic (eliminating that final race would need a native
process handle such as Linux pidfd).

## Update safety

Existing installations pinned to an older installer coordinate through an
explicit one-time version:

```sh
fortytwo stop
npx @justfortytwo/installer@<newer> update
fortytwo start
```

The invoked installer refuses a live runtime (an old scheduler must not claim
jobs it does not understand), persists itself with `--save-exact`, and
continues with its own compatibility matrix. Engine rollback does not roll
back the installer; `update` does not query for newer installer versions.

## Scope

**In scope:** assembly, versioning policy, persona rendering, infra
provisioning, foreground supervision, update/rollback, owner-privileged
memory deletion, channel pairing lifecycle.

**Out of scope:** the engine behavior itself (owned by each sibling), the
persona content (owned by `@justfortytwo/persona`), daemonization/restarts
(owned by the surrounding service manager), tool permissions (owned by Claude
Code — gate adds optional policy only through explicitly configured hooks).
