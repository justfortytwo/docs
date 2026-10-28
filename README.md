# fortytwo

**fortytwo** is a local-first personal-assistant spine, distributed as the
`@justfortytwo/*` packages. Start with the
[architecture overview](./architecture.md) or browse the
[package reference](./packages/).

This repository holds the canonical, publishable design and architecture
documentation for **fortytwo** — the decisions and contracts that span packages
and outlive any single implementation. Package-specific install and
configuration docs live in each package's own README.

fortytwo is not a replacement for agent runtimes such as Claude Code. It
provides the durable personal-assistant infrastructure *around* them: memory,
lifecycle, scheduling, channels, optional policy enforcement, and related
supporting components.

## Index

- [Architecture](./architecture.md) — the cross-repository system: who owns
  what, and how the packages fit together.
- [Scheduler & Durable Jobs](./scheduler.md) — the decoupled, token-gated job
  scheduler (the spine's *durable jobs* + *Pulse*): one `jobs` table drained by
  a standalone daemon, an LLM turn only behind a cheap "is there work?" gate.
- [Running fortytwo on a homelab](./homelab.md) — a deployment guide for an
  always-on setup in containers: Telegram, scheduler, memory with local
  embeddings, the transcript, and how to update. Compose files and
  configuration examples live in [`examples/homelab/`](https://github.com/justfortytwo/docs/tree/main/examples/homelab).

### Package reference

- [`@justfortytwo/installer`](./packages/installer.md) — bootstrap and
  lifecycle CLI (`create-fortytwo` / `fortytwo`).
- [`@justfortytwo/persona`](./packages/persona.md) — persona and context
  templates rendered into an installation.
- [`@justfortytwo/memory`](./packages/memory.md) — durable semantic-memory MCP
  server (facts only; extensible with MCP extensions).
- [`@justfortytwo/transcript`](./packages/transcript.md) *(new)* — searchable
  conversation log in the same database.
- [`@justfortytwo/runner`](./packages/runner.md) — Claude Code process/session
  runtime.
- [`@justfortytwo/scheduler`](./packages/scheduler.md) — durable scheduling and
  proactive job execution.
- [`@justfortytwo/telegram`](./packages/telegram.md) — Telegram
  transport/channel adapter.
- [`@justfortytwo/gate`](./packages/gate.md) — optional external safety/policy
  enforcement layer.
- [`@justfortytwo/salience`](./packages/salience.md) — optional model-driven
  salience extraction.
