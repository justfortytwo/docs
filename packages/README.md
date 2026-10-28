---
title: Packages
---

Package reference for the `@justfortytwo/*` ecosystem — one page per package,
documenting each at its current release. Install and configuration details
also live in each package's own README; these pages describe what each
package is, how it is built, and how it connects to its siblings.

The 1.0.0 line includes the conversation transcript split. Until `1.0.0`
is published to npm, the prereleases remain under the `next` dist-tag and
`latest` still points at the previous release line.

| Package | Version | Role |
|---------|---------|------|
| [`@justfortytwo/installer`](./installer.md) | `1.0.0` | Bootstrap and lifecycle CLI (`create-fortytwo` / `fortytwo`) |
| [`@justfortytwo/persona`](./persona.md) | `1.0.0` | Persona and context templates + Oneiros |
| [`@justfortytwo/memory`](./memory.md) | `1.0.0` | Durable semantic-memory MCP server |
| [`@justfortytwo/transcript`](./transcript.md) *(new)* | `1.0.0` | Searchable conversation log, separate from memory |
| [`@justfortytwo/runner`](./runner.md) | `1.0.0` | Claude Code process/session runtime |
| [`@justfortytwo/scheduler`](./scheduler.md) | `1.0.0` | Durable scheduling and proactive jobs |
| [`@justfortytwo/telegram`](./telegram.md) | `1.0.0` | Telegram transport/channel adapter |
| [`@justfortytwo/gate`](./gate.md) | `0.1.1` | Optional safety/policy enforcement |
| [`@justfortytwo/salience`](./salience.md) | `0.1.1` | Optional model-driven salience extraction |
