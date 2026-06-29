# fortytwo — design & architecture

Canonical, publishable design and architecture documentation for **fortytwo**, a
local-first personal-assistant spine distributed as the `@justfortytwo/*`
packages.

Package-specific install and configuration docs live in each package's own
README (`@justfortytwo/gate`, `/memory`, `/salience`, `/telegram`, `/persona`,
`/installer`, `/marketplace`). **This repo holds the cross-cutting design** — the
decisions and contracts that span packages and outlive any single
implementation.

## Index

- [Scheduler & Durable Jobs](./scheduler.md) — the decoupled, token-gated job
  scheduler (the spine's *durable jobs* + *Pulse*): one `jobs` table drained by a
  standalone daemon, an LLM turn only behind a cheap "is there work?" gate.

## License

MIT © 2026 Enrico Deleo

---

Created and maintained by [**Enrico Deleo**](https://enricodeleo.com).
