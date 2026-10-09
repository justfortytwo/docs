# AGENTS.md — justfortytwo/docs

Guidance for AI coding agents working in this repository.

## What this repo is

Canonical, publishable **design and architecture documentation** for
**fortytwo**, a local-first personal-assistant spine distributed as the
`@justfortytwo/*` npm packages. It holds the *cross-cutting* design — decisions
and contracts that span packages. Package-specific install/config docs live in
each package's own README, not here.

This is a **docs-only repo**: plain Markdown, no package manifest, no build,
no tests, no lint config, no CI. Remote: `git@github.com:justfortytwo/docs.git`.

## Layout

```
README.md      Repo intro + Index of design docs (keep in sync when adding docs)
scheduler.md   Scheduler & Durable Jobs design (jobs table, JobStore, tick,
               token-gating, event hooks, crash-safety, MVP scope)
.gitignore     Ignores .DS_Store only
```

## Commands

There are none. No `package.json`, Makefile, or scripts exist. Verify changes by
reading the rendered Markdown (e.g. on GitHub) and checking relative links.

## Conventions (observed in existing docs)

- One design topic per top-level `.md` file, named in lowercase kebab-case
  (`scheduler.md`).
- Every new doc gets an entry in the README `## Index` with a relative link
  (`./name.md`) and a one-sentence summary.
- Doc structure: H1 title, short framing paragraph, then `## Why this exists`,
  `## Principles`, `## Architecture`, data model, components, control flow,
  testing, and `## Scope` (MVP vs Deferred). Follow this shape for new designs.
- Packages are referred to by full scoped name in backticks
  (`@justfortytwo/memory`); new packages are marked *(new)*.
- Bold for key guarantees/terms; tables for enumerations (job kinds,
  producers); fenced code blocks for ASCII diagrams and SQL/schema sketches.
- Prose wrapped at ~80 columns.
- Product name is lowercase **fortytwo**; npm scope/org is `justfortytwo`.
- README footer: `MIT © 2026 Enrico Deleo` + "Created and maintained by" line.

## Key architecture notes (from scheduler.md)

- The LLM is the only expensive resource: scheduling, claiming, gating and
  recurrence math are pure DB/JS; an LLM turn runs only after a cheap
  `hasWork` gate passes.
- Durable state lives in `@justfortytwo/memory` (a `jobs` table, migration
  `004_jobs`, and a DI'd `JobStore`), next to the journal and registry.
- `@justfortytwo/scheduler` is a standalone daemon (croner + ~30s `claimDue`
  poll + p-queue concurrency 1 + handler registry keyed by `kind`).
- `@justfortytwo/runner` wraps headless `claude -p --output-format json`;
  scheduler and telegram both depend on it, not on each other.
- Output is channel-agnostic: always written to the memory journal; Telegram is
  an optional notifier.
- Producers only insert `pending` rows; the daemon is the single writer of the
  `running` transition (SQLite in WAL mode). Reactive jobs are de-duplicated
  at the enqueue site.

## Gotchas

- `scheduler.md` links to `./design-principles.md`, which **does not exist**
  in this repo yet. Don't assume it does; create it or fix the link only if
  asked.
- `scheduler.md` describes `scheduler` and `runner` as *(new)* and talks about
  the bridge's `schedulerLoop`/`SCHEDULES` in the present tense. Sibling repos
  `../scheduler` and `../runner` now exist, so the doc may lag the code. When
  documenting current behavior, verify against the sibling package source
  rather than trusting this doc; when editing, keep it framed as a design doc.
- Don't move package install/config instructions here — they belong in each
  package's README.
- Don't invent decisions: this repo is the record of agreed design. Mark open
  questions explicitly rather than stating them as settled.

## Sibling repos (in `../`, each its own git repo)

`gate`, `installer`, `marketplace`, `memory`, `persona`, `runner`, `salience`,
`scheduler`, `telegram` — the `@justfortytwo/*` packages this repo documents —
plus `website` (Nuxt site, `justfortytwo-website`). Most siblings have their own
`CLAUDE.md`/`AGENTS.md`; read those for package-level conventions. Only edit
this repo unless explicitly asked to change a sibling.

## fortytwo project context

This repository is part of **fortytwo**, a local-first personal-assistant spine built around existing agent runtimes and tool ecosystems.

The umbrella project is **fortytwo**. It is not intended to replace Claude Code, Codex, MCP servers, plugins, skills, or other agent runtimes. The project provides the durable personal-assistant infrastructure around them: memory, lifecycle, scheduling, channels, optional policy enforcement, and related supporting components.

Claude Code is currently the primary/reference runtime, but the architecture should avoid unnecessary coupling to a specific model provider. In particular, components should remain usable when Claude Code itself is configured against alternative compatible model providers.

The main bootstrap and lifecycle entry point is the **installer** repository (`justfortytwo/installer`).

### Canonical project locations

- Website: `forty-two.it`
- GitHub organization: `github.com/justfortytwo`
- Architecture/design documentation: `justfortytwo/docs`

### Repositories

The fortytwo project is intentionally split into small, focused repositories.

- **`justfortytwo/installer`**
  Main installer and lifecycle CLI (`create-fortytwo` / `fortytwo`). This is the primary bootstrap entry point for assembling a fortytwo installation.

- **`justfortytwo/runner`**
  Thin Claude Code process/session runtime. Owns process lifecycle and stream transport, including one-shot runs and persistent interactive sessions. It must not become an agent framework.

- **`justfortytwo/memory`**
  Durable semantic-memory MCP server backed by local storage and retrieval infrastructure.

- **`justfortytwo/scheduler`**
  Durable scheduling and proactive job execution. Owns *when* work should happen, not how the agent reasons about or performs that work.

- **`justfortytwo/telegram`**
  Telegram transport/channel adapter. Owns Telegram identity, pairing, message transport, attachment handling, and mapping chats to live agent sessions. It should delegate agent process lifecycle to `runner`.

- **`justfortytwo/persona`**
  Persona and context templates rendered by the installer into an individual fortytwo installation.

- **`justfortytwo/gate`**
  Optional external safety/policy enforcement layer for tool execution and approvals. Keep this separate from the agent runtime's own reasoning and permissions.

- **`justfortytwo/salience`**
  Optional model-driven salience extraction used to enrich durable memory.

- **`justfortytwo/marketplace`**
  Claude Code plugin marketplace and umbrella plugin used as a distribution surface for fortytwo components.

- **`justfortytwo/docs`**
  Cross-repository architecture, design, contracts, and project documentation.

- **`justfortytwo/website`**
  Public website for the project, served as `forty-two.it`.

- **`justfortytwo/.github`**
  GitHub organization metadata and shared organization-level project information.

### Cross-repository architecture

When changing one repository, treat the sibling repositories as parts of the same system.

The intended high-level ownership is:

```text
channels / scheduler
        |
        v
      runner
        |
        v
   agent runtime
  (Claude Code today)
        |
        +---- MCPs / plugins / skills / tools
        |
        +---- fortytwo memory

optional surrounding components:
- gate
- salience

bootstrap / distribution / documentation:
- installer
- persona
- marketplace
- docs
- website
```

A useful rule when deciding where code belongs:

> fortytwo should add continuity and infrastructure around an existing agent, not reimplement capabilities already owned by the agent runtime or its MCP/plugin ecosystem.

Examples:

- agent reasoning, planning, subagents, tools, MCP orchestration, and plugins belong to the agent runtime;
- Claude process/session lifecycle belongs to `runner`;
- durable memory belongs to `memory`;
- durable time and scheduled execution belong to `scheduler`;
- Telegram transport and Telegram identity belong to `telegram`;
- installation and lifecycle management belong to `installer`;
- browser automation should normally come from an existing MCP/plugin rather than a fortytwo-specific browser implementation.

Before introducing a new abstraction, check the relevant sibling repositories and the agent runtime's existing capabilities to avoid duplicating functionality elsewhere in the fortytwo stack.
