# `@justfortytwo/runner`

A thin lifecycle and JSONL transport layer around Claude Code. Supports
one-shot jobs and persistent sessions. **Claude Code owns** agent execution,
tools, permissions, subagents, MCP, plugins, and memory. **Callers own**
channels, scheduling, profiles, and persistence. The runner must not become an
agent framework.

- **Version:** `1.0.0` · **Runtime:** library only (no bin) · **Node:** >= 20
- Internal design notes: `docs/runtime.md` in the runner repo

## Why this exists

Both the scheduler (headless job turns) and the telegram bridge (live chat
sessions) need to spawn and talk to Claude Code. runner is the single place
that owns that process lifecycle and stream transport, so neither channel nor
scheduler reinvents it — and neither depends on the other.

## One-shot jobs

```ts
import { createRunner } from '@justfortytwo/runner';

const runner = createRunner(); // CLAUDE_BIN or "claude" from PATH
const result = await runner.run({
  prompt: 'Summarize this repository',
  cwd: '/path/to/project',
  args: ['--model', 'my-model'],
  env: { ANTHROPIC_BASE_URL: 'https://provider.example' },
});
```

`run()` returns `RunResult`: `{ ok, text, raw }`. `ok` requires exit code zero
and no `is_error` in Claude's JSON. Invalid JSON returns `ok: false`, the
output as `text`, `raw: null`. Spawn failures reject with `RunnerSpawnError`;
invalid input rejects with `TypeError`. Optional per-job `timeoutMs` is a
**wall-clock** limit — a timeout returns `{ ok: false, text: '', raw: null }`
after termination and cleanup.

## Persistent sessions

```ts
const session = await runner.createSession({
  cwd: '/path/to/project',
  args: ['--model', 'my-model'],
  // resumeSessionId: previouslySavedId,
});

session.on('assistant', m => console.log(m.text));
session.on('result', r => console.log(r.text));

await session.send('user turn text');
// ...
await session.close();
```

Guarantees and semantics:

- Creation resolves on OS process spawn; `ready` means writable, not
  authenticated. `send(text)` resolves after the stdin write, **not** after a
  response — listen for `result` to observe turn completion.
- Concurrent sends serialize in invocation order; Claude controls processing
  of queued turns. Inputs sent mid-turn steer that turn (several inputs can
  share one `result`; the runner passes `--replay-user-messages` so `input`
  events fire when Claude consumes a submission).
- Output is decoded incrementally as UTF-8 JSONL, including fragmented lines
  and an unterminated final line. Malformed lines surface as a raw string plus
  `RunnerProtocolError` (`.line`, `.cause`), and parsing continues. Stderr is
  diagnostic, not automatically fatal.
- Session state: `starting` → `ready` → `running` → `closed`/`failed`, plus
  `sessionId`, `startedAt`, `lastActivityAt`, `exitCode`, `exitSignal`, and a
  copied/frozen `config`. Session IDs are captured from Claude output; the
  runner neither stores them nor implements conversation memory.

Events:

| Listener | Payload |
| --- | --- |
| `event` | `RunnerEvent` — discriminated union of all events |
| `raw` | Parsed Claude event, or original malformed line |
| `assistant` | `{ type: 'assistant', text, raw }` for assistant text |
| `result` | `RunResult` for each Claude result event |
| `stderr` | Text chunk |
| `exit` | `{ type: 'exit', code, signal }` |
| `error` | `Error` |

Errors always appear on `event`; a missing `error` listener does not trigger
EventEmitter's fatal unhandled-error behavior. Events are live — never
replayed or retained.

## Shutdown

`close()` is idempotent: rejects outstanding writes, ends stdin, waits
`shutdownGraceMs` (default 1000 ms), sends SIGTERM, then SIGKILL after another
grace period; resolves after the parent process is reaped and output closed.
Results may keep arriving during graceful shutdown; pipe draining after parent
exit is bounded by the same grace. Only the parent Claude process is
owned/signaled — descendants remain Claude's responsibility. No detached
process, daemon, global session registry, or process-tree orchestration. The
caller must keep its own process alive and close sessions during shutdown.

## Options

`createRunner(defaults)` accepts:

- `bin` — executable path; defaults to `CLAUDE_BIN` or `claude`.
- `spawn` — injectable `child_process.spawn` for tests.
- `cwd`, `env`, `args`, `resumeSessionId`, `shutdownGraceMs` — runtime
  defaults.
- `timeoutMs` — optional one-shot wall-clock limit.

Per-call arguments **append** to defaults; environment overlays copy onto the
parent environment (defaults first, per-call last); caller objects are never
mutated. The runner owns the format flags (`-p --input-format stream-json
--output-format stream-json --verbose`; `--resume <id>` for resumption) and
rejects conflicting format arguments. **No permission-bypass flags are added.**
All other Claude configuration — including alternative compatible providers,
via `env` such as `ANTHROPIC_BASE_URL` — passes through without provider
branches.

## Consumers

- **`@justfortytwo/scheduler`** — headless one-shot job turns.
- **`@justfortytwo/telegram`** — persistent interactive sessions per chat.

## Testing

```sh
npm ci && npm test && npm run build
```

Tests use a local fake executable and controlled streams — no Claude
installation, API credentials, or network access required.

## Scope

**In scope:** process spawn/reap, JSONL stream decode, session write
serialization, graceful shutdown, format-flag ownership.

**Out of scope:** agent reasoning and tools (Claude Code), channels and
scheduling (callers), session persistence/registry, daemons, provider-specific
branching, interpreting application env vars like `FORTYTWO_TURN_TIMEOUT`.
