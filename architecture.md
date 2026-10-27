# Architecture

**fortytwo** is a local-first personal-assistant spine built around existing
agent runtimes and tool ecosystems. It is not intended to replace Claude Code,
Codex, MCP servers, plugins, skills, or other agent runtimes. The project
provides the durable personal-assistant infrastructure around them: memory,
lifecycle, scheduling, channels, optional policy enforcement, and related
supporting components.

Claude Code is currently the primary/reference runtime, but the architecture
avoids unnecessary coupling to a specific model provider: components remain
usable when Claude Code itself is configured against alternative compatible
model providers.

## Why this exists

An agent runtime alone is stateless between sessions and reactive to input.
A personal assistant needs **continuity**: durable memory, durable time
(scheduling), channels that reach the user, and a lifecycle that survives
reboots and upgrades. fortytwo adds exactly that layer — and nothing more.

## Principles

- **Wrap, don't reimplement.** fortytwo adds continuity and infrastructure
  around an existing agent. Anything the runtime or its MCP/plugin ecosystem
  already owns stays there.
- **Local-first.** Durable state lives on the user's machine (SQLite + local
  files). No cloud service is required.
- **Small, focused repositories.** Each package owns one concern and is
  publishable and usable on its own.
- **The LLM is the only expensive resource.** Scheduling, claiming, gating and
  recurrence math are pure DB/JS; an LLM turn runs only after a cheap gate
  passes.

## System overview

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
        +---- fortytwo memory (facts)
        |        + transcript tools (extension seam)

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

## Ownership map

| Concern | Owner |
| --- | --- |
| Agent reasoning, planning, subagents, tools, MCP orchestration, plugins | the agent runtime |
| Claude process/session lifecycle | `@justfortytwo/runner` |
| Durable memory: **facts only** | `@justfortytwo/memory` |
| Conversation history (every channel message, kept forever, searchable) | `@justfortytwo/transcript` *(new)* |
| Durable time and scheduled execution | `@justfortytwo/scheduler` |
| Telegram transport and Telegram identity | `@justfortytwo/telegram` |
| Installation and lifecycle management | `@justfortytwo/installer` |
| Persona and context templates | `@justfortytwo/persona` |
| External safety/policy enforcement (optional) | `@justfortytwo/gate` |
| Model-driven salience extraction (optional) | `@justfortytwo/salience` |
| Plugin marketplace and umbrella plugin | `@justfortytwo/marketplace` |

A useful rule when deciding where code belongs:

> fortytwo should add continuity and infrastructure around an existing agent,
> not reimplement capabilities already owned by the agent runtime or its
> MCP/plugin ecosystem.

For example: browser automation should normally come from an existing
MCP/plugin rather than a fortytwo-specific browser implementation.

## Memory, transcript and the shared database

memory holds **facts**; conversation history belongs to
`@justfortytwo/transcript`. Both live in the same SQLite file (`fortytwo.db`)
but in separate tables, and there is one MCP server, not two.

```text
telegram ──┐ ConversationLog.append (injected, fire-and-forget)
scheduler ─┤                                   ┌─ memory tables (facts)
           └──▶ transcript tables ─────────────┤  same fortytwo.db
                      ▲                        └─ transcript_* tables
                      │ createMcpExtension
agent ──▶ fortytwo-memory MCP server ──loads──┘ via FORTYTWO_MCP_EXTENSIONS
          (memory tools + transcript_search / transcript_context)
```

- **Writers are decoupled.** telegram and scheduler each define a structural
  `ConversationLog` port and load the transcript implementation dynamically;
  without it they fall back to a no-op. Neither imports transcript or memory
  types for this.
- **Readers go through an extension seam.** memory exposes an `McpExtension`
  interface and loads extension packages named in `FORTYTWO_MCP_EXTENSIONS`.
  memory has no static dependency on transcript, so there is no cycle.
- **Dependency direction.** transcript depends on memory for DB plumbing
  only; memory never depends on transcript.
- **Oneiros reads two evidence streams** (memory and transcript), each with
  its own cursor.

`@justfortytwo/transcript` is planned for the 1.0.0 prerelease train and is
not yet published.

## Canonical project locations

- Website: `forty-two.it`
- GitHub organization: `github.com/justfortytwo`
- Architecture/design documentation: `justfortytwo/docs`

## Key guarantees

- **Channel-agnostic output.** Agent output is always written to the
  conversation log (the transcript when installed); Telegram (or any other
  channel) is an optional notifier, never the system of record.
- **Single writer for job execution.** Producers only insert `pending` rows;
  the scheduler daemon is the single writer of the `running` transition.
- **No scheduler↔telegram coupling.** Both depend on `runner`; neither depends
  on the other.

## Scope

**In scope (MVP):** installer bootstrap, persona rendering, memory (facts)
and registry, the transcript (conversation log), runner process lifecycle,
scheduler with durable jobs, Telegram channel.

**Deferred / optional:** gate policy enforcement, salience extraction,
additional channels beyond Telegram.
