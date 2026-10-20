# `@justfortytwo/gate`

A standalone, agent-agnostic **PreToolUse safety gate** for Claude Code. It
decides, *before any tool runs*, whether a call is safe to auto-run, must be
**deferred for a one-shot human approval**, or should be **denied outright** —
**fail-closed**: anything unrecognized, and anything that errors, is blocked
rather than waved through.

- **Version:** `0.1.1` · **Runtime:** Claude Code plugin, PreToolUse hook, or
  plain library · **Node:** >= 18 · **Leaf package** — no `@justfortytwo/*`
  peers, no database, no network

## Why this exists

LLM agents happily run whatever a tool, a web page, or a chat message tells
them to. A blocklist ("never run `rm -rf`") fails open: anything you didn't
think of slips through. The gate inverts that — the dangerous **and the
unknown** both stop and wait for you, while genuinely safe, known operations
stay fast.

## Three independent parts

1. **Capability policy engine** — every tool is tagged with an *autonomy tier*
   (`read`, `internal`, `draft`, `external`, `irreversible`) in a small TOML
   manifest. Auto tiers pass; outward/destructive tiers defer for approval.
2. **Fail-closed bash allowlist** — `Bash` defers by default; only explicitly
   allowlisted commands (anchored, chaining-safe globs in a JSONL file)
   fast-path. **Deny always wins**: a dangerous command (`git push`, `rm -rf`,
   `curl --data`, `sudo`, …) can never be laundered past the gate by a broad
   allowlist glob.
3. **PreToolUse hook** — reads the Claude Code hook event on stdin, emits the
   permission decision on stdout.

## Install & wire

```sh
npm install @justfortytwo/gate
```

**As a Claude Code plugin (recommended):** the package ships
`.claude-plugin/plugin.json` and `hooks/hooks.json` wiring a `PreToolUse`
matcher `"*"` to `dist/gate-hook.js` via `${CLAUDE_PLUGIN_ROOT}`. Plugin hooks
compose with project/user hooks — the gate adds to, never replaces, existing
setup.

**As a hand-wired hook:** add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command",
            "command": "node node_modules/@justfortytwo/gate/dist/gate-hook.js" }
        ]
      }
    ]
  }
}
```

The hook emits exactly one of `allow`, `deny`, or `defer`:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow | deny | defer",
    "permissionDecisionReason": "<reason>" } }
```

`defer` asks the host to **hold the call for a one-shot human approval**; the
defer → approval → re-fire loop only completes if the host actually pauses on
that decision. The gate emits the decision; it cannot itself stop a host that
ignores `defer`.

## How an approval flows

1. The agent calls an `external`/`irreversible` tool. The gate **defers** and
   stages a pending one-shot keyed by the call's `tool_use_id`.
2. You clear it out of band with the CLI — `fortytwo-gate approve
   <tool_use_id>` (or `deny`). A host integration can instead call
   `setDecisionByToolUseId(...)` on its own store.
3. The agent re-fires the same call. The gate **consumes the one-shot exactly
   once** and allows it; any later re-fire is denied.

`approve`/`deny` only act on a **pending** call — an already-consumed or
denied one-shot is immutable, so an approval can never be resurrected into a
second run.

## The `fortytwo-gate` CLI

```sh
fortytwo-gate list                   # what's waiting: status, tier, tool_use_id, target
fortytwo-gate approve <tool_use_id>  # allow it once (next re-fire consumes it)
fortytwo-gate deny <tool_use_id>     # block it
```

Run from the **same project root** the agent runs in: the default
`.gate/approvals.jsonl` resolves relative to the current directory.
`fortytwo-gate list` prints the resolved store path so a mismatch is obvious;
set `GATE_APPROVALS` to an absolute path to remove the ambiguity.

## Library usage

```ts
import { loadManifest, decide, JsonlApprovalStore } from '@justfortytwo/gate';

const manifest = loadManifest('.claude/policy/capabilities.toml');
const store = new JsonlApprovalStore('.gate/approvals.jsonl');

const decision = await decide(manifest, {
  toolName: 'Bash',
  toolInput: { command: 'git push origin main' },
  toolUseId: 'toolu_123',
  cwd: process.cwd(),
}, { store });
// decision.permission -> 'allow' | 'defer' | 'deny'
```

Bring your own durable store by implementing `ApprovalStore` /
`AuditLogger`. Ships `InMemoryApprovalStore` (library default) and
file-backed `JsonlApprovalStore` (used by the hook); `@justfortytwo/memory`
contributes a SQLite-backed `GateApprovalStore`.

There is also a content-trust policy engine (`decidePolicy`,
`classifyAuthority`, `canUseAsInstruction`, …) for the *"may this source
instruct the agent?"* question — the principled trusted/untrusted boundary
when ingesting web pages, messages, or tool output.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `GATE_MANIFEST` | `.claude/policy/capabilities.toml` | capability manifest TOML |
| `GATE_BASH_ALLOWLIST` | `rules/bash-allowlist.jsonl` | bash allowlist JSONL |
| `GATE_APPROVALS` | `.gate/approvals.jsonl` | durable one-shot approval store |
| `GATE_ACTOR` | `agent` | audit-log actor label |

## File formats

**Manifest** (TOML, see `examples/capabilities.toml`): `default_tier`
(recommended `external`); `[tiers]` exact tool name → tier plus trailing-`*`
prefix globs; `[bash]` regex patterns that only ever **elevate** Bash (and
double as the denylist, highest match wins); `[guard].files` — project-relative
paths whose edit is `irreversible` (point at the manifest, settings and
allowlist so the gate can't be silently weakened).

**Bash allowlist** (JSONL, see `examples/bash-allowlist.jsonl`):
`command_glob` (required, anchored, whole-command), `cwd_glob` (default `*`),
`expires_at` (ISO 8601), `approved_by`, `note`. Prefer exact commands; a
trailing `*` re-enables chaining — use sparingly.

## Contracts

`POLICY_SCHEMA_VERSION` (currently `1`) versions the **`policySchema`
contract**: the `Tier` model (capability manifest) and the `Authority` /
`MemoryClass` / `SourceKind` types and `decidePolicy()` outcomes. Siblings
depend on it via a caret range; any change to the *meaning* of these types or
decisions bumps `POLICY_SCHEMA_VERSION` **and** the package major.

## Consumers

- **`@justfortytwo/telegram`** — regular dependency for the
  `createSourceEnvelope` provenance helper; the policy hook stays optional.
- **`@justfortytwo/memory`** — optional peer, contributing
  `GateApprovalStore` (SQLite-backed `ApprovalStore` + `AuditLogger`).
- **`@justfortytwo/installer`** — `doctor` cross-checks
  `POLICY_SCHEMA_VERSION` compatibility.

## Testing

```sh
npm run build && npm test   # vitest run
```

## Scope

**In scope:** pre-tool-use decisions, one-shot approvals, bash allowlist,
capability tiers, content-trust classification, audit logging.

**Out of scope:** tool permission ownership (Claude Code), channel-side
approval UIs (Telegram deliberately shows none), runtime interception beyond
the emitted decision.
