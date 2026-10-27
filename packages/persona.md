# `@justfortytwo/persona`

The templated **identity and runtime context** for a fortytwo personal
assistant. Ships the scaffolding the installer renders into a user's project
so the assistant has a name, a voice, owner facts, house rules, and a
recallable memory corpus — plus the internal **Oneiros** consolidation
library and prompt. It never ships an owner's real data.

- **Version:** `1.0.0-2` · **Runtime:** static templates + manifest + compiled
  Oneiros library (entry `dist/oneiros.js`)

## What's in here

```text
templates/
  CLAUDE.md.tmpl                       # root boot pointer
  context/
    INDEX.md.tmpl                      # wake routine + boundaries + policy
    OWNER.md.tmpl                      # owner facts (name, languages, timezone, locale)
    PROFILE.md.tmpl                    # concise, always-loaded owner profile
    SOUL.md.tmpl                       # assistant character and voice
    rules/
      APPROVED.md.tmpl                 # binding house rules
      PROPOSED.md.tmpl                 # pending rule ideas (not binding)
    memory/
      INDEX.md.tmpl                    # memory corpus index
      owner-profile.md.tmpl            # stable identity, bio anchors, positioning
      owner-beliefs.md.tmpl            # core beliefs / operating principles
      owner-voice-and-writing.md.tmpl  # tone, vocabulary, channel rules, quality test
      domain-positioning.md.tmpl       # primary venture / domain narrative
manifest.json                          # field manifest (drives `fortytwo init`)
fortytwo.compat.json                   # contract majors this persona relies on
oneiros/prompt.md                      # private Oneiros worker prompt
```

## How it works

Templates use `{{placeholder}}` tokens. The installer CLI drives the flow:

1. **`fortytwo init`** prompts for each field in `manifest.json` (or accepts
   flags/env for non-interactive installs) and writes the answers to a
   **gitignored `.fortytwo/identity.json`** — the single source of truth.
2. The CLI renders every `templates/**/*.tmpl` against `identity.json` and
   writes the result into the gitignored `context/` (and `CLAUDE.md` at the
   project root).
3. Re-running `init` re-renders managed templates and preserves captured
   files; `update` reconciles machine-owned runtime assets only — it never
   re-renders context.

The concise, always-loaded summary lives in `OWNER.md` / `PROFILE.md`; the
deep, atomized owner profile lives in the memory MCP (retrieved on demand).

## What ships — and what never does

The rendered output (`context/*`, `CLAUDE.md`), `.fortytwo/identity.json`,
and any uploaded profile material are **all gitignored** in the user's
project and **never** enter this repo. Every owner-specific value is a
`{{placeholder}}` resolved at install time on the user's machine. `owner_email`
and `owner_address` are captured for the owner record but deliberately have no
template token — they stay in the gitignored identity file.

## Field manifest

`manifest.json` carries `version`, `manifestVersion`, `description`, plus:

- **`files`** — template → output → render mode:
  - **`managed`** — re-rendered on every `init` (`CLAUDE.md`, the `INDEX.md`
    files); not meant for hand-editing.
  - **`captured`** — rendered **once** on first install, then owner-owned and
    never clobbered (`OWNER.md`, `PROFILE.md`, `SOUL.md`, `rules/`, the whole
    memory corpus).
- **`fields`** — descriptors like:

```json
{
  "key": "owner_name",
  "prompt": "Your full name (how the assistant refers to you)",
  "type": "string",
  "required": true,
  "default": null
}
```

`type` is `string`, `text` (multi-line), or `list` (entered one item at a
time). Every `{{placeholder}}` has a matching entry.

## Compatibility

`fortytwo.compat.json` declares the cross-component contract majors this
persona targets; `fortytwo doctor` reads it and warns on mismatch:

```json
{ "memoryToolContract": "^1", "policySchema": "^1" }
```

## Oneiros

Internal background maintenance of the persona over **two evidence streams**:
the memory corpus and the conversation transcript (planned for the 1.0.0
prerelease train; not yet published). Each stream has its own cursor and its
own state files:

- **Ownership:** the scheduler owns the daily `persona.oneiros` job
  (`17 3 * * *` UTC); runner executes a separate tool-free session
  (`--safe-mode`, no tools/MCP/skills/session persistence); persona exports
  `initialize(root, head, stream?)`, `hasWork(root, memory, transcript?)` and
  `refine({ root, memory, transcript?, worker })`. The `transcript` source is
  optional (`{ head(), delta(cursor) }`); without it only memory is read.
- **Input:** the worker receives a JSON baseline and a bounded memory delta;
  it returns `{ "additions": [] }` or evidence-backed additions.
- **Mutation boundary (deterministic, enforced in code):** only new
  plain-text bullets in existing PROFILE **Voice**, **Interests** and
  **Expertise** sections. All other files/sections are protected; existing
  bytes are preserved; evidence IDs are validated; inferred/imported/
  superseded evidence is rejected. Eligible evidence is live and
  `observed: "stated"`, with `source: "owner"` or Telegram inbound-message
  provenance; outbound assistant messages are excluded.
- **Transcript eligibility:** a transcript row is eligible only when channel
  is `telegram`, direction `inbound`, kind `message` and actor `owner` (the
  bridge only accepts paired chats). Assistant and scheduler rows are never
  eligible; ineligible rows are mapped to `observed: "internal"`, which the
  evidence filter always rejects. "Stated" is implied by inbound. These
  labels remain hints, not authentication.
- **Semantic fit:** Voice covers expression/tone, Interests topics, Expertise
  knowledge/depth. Observations without an allowed home stay in memory.
  Semantic classification is model policy; the deterministic validator
  enforces the narrow structural surface.
- **Cursor:** `{ database, position }` — persistent DB identity plus the
  AUTOINCREMENT high watermark (deleted IDs included). Memory supplies
  bounded ascending pages; the checkpoint records only the reviewed page.
  No-op reviews also advance; new memory arriving mid-run waits for a later
  run.
- **State:** private under `.fortytwo/oneiros/`, one checkpoint and one
  interrupted-write receipt per stream: `checkpoint.json` / `pending.json`
  (memory) and `transcript-checkpoint.json` / `transcript-pending.json`
  (transcript), plus PID locks. `hasWork` is true if either stream has new
  rows or a pending receipt. Any leftover receipt is settled before a round
  reads the shared profile. Writes use fsync + atomic
  rename. Recovery applies a validated receipt only if the context still
  matches its before/after hash; retries cannot double-apply. Oversized
  input (> 100 KB) fails closed without checkpointing.
- **Transcript cursor on upgrade:** the memory cursor is unchanged (memory
  ids only grow, so migrated chat rows simply leave its delta). The
  installer's migration initializes the transcript cursor just below the
  lowest transcript row not yet consumed, so consumed history is not
  reprocessed and unconsumed messages are not skipped; re-reading some
  consumed rows is the accepted safe direction.
- **Bootstrap:** fresh `init` initializes at the current memory head (zero
  for an empty DB) and seeds one persistent job. Updating an older install
  does the same only when state is missing — no historical backfill, no
  context rendering during update.

## Testing

```sh
npm test && npm run build
```

No live model call is required by the test suite.

## Scope

**In scope:** templates, field manifest, render-mode policy, compatibility
declaration, Oneiros consolidation library + worker prompt.

**Out of scope:** the rendering engine itself (installer), job scheduling
(scheduler), the model session (runner), durable memory (memory), the
conversation log (transcript).
