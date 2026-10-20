---
home: true
title: fortytwo
heroImage: null
tagline: A local-first personal-assistant spine, distributed as the @justfortytwo/* packages.
actions:
  - text: Architecture overview
    link: /architecture.html
    type: primary
  - text: Packages
    link: /packages/
    type: secondary
footer: MIT © 2026 Enrico Deleo · Created and maintained by Enrico Deleo
---

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

### Package reference

- [`@justfortytwo/installer`](./packages/installer.md) — bootstrap and
  lifecycle CLI (`create-fortytwo` / `fortytwo`).
- [`@justfortytwo/persona`](./packages/persona.md) — persona and context
  templates rendered into an installation.
- [`@justfortytwo/memory`](./packages/memory.md) — durable semantic-memory MCP
  server.
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
- [`@justfortytwo/marketplace`](./packages/marketplace.md) — Claude Code plugin
  marketplace and umbrella plugin.
