# `@justfortytwo/marketplace`

The Claude Code plugin **marketplace** for fortytwo — an open-source
decomposition of the personal assistant into independent, composable pieces.
A single repo containing `.claude-plugin/marketplace.json` (the catalog of
the org's plugins) plus the umbrella **fortytwo** plugin under `plugins/`.

- **Version:** `0.1.0` · **Private package** (not published to npm; consumed
  by Claude Code's plugin system) · **Runtime:** none — manifests and skills
  only

## Why this exists

Claude Code users discover and install capabilities through plugin
marketplaces. This repo is fortytwo's distribution surface: it makes the
engine's plugin surfaces (`gate`, `memory`) installable with native commands,
and bundles the onboarding/self-update skills that drive the npm CLI.

## Install

```
/plugin marketplace add justfortytwo/marketplace
/plugin install gate@fortytwo
/plugin install memory@fortytwo
/plugin install fortytwo@fortytwo
```

Keep current with `/plugin marketplace update`.

## Plugins

| Plugin | Source | What it is |
|--------|--------|------------|
| **gate** | `justfortytwo/gate` (GitHub) | PreToolUse safety gate — inspects tool calls before they run, blocks/asks per policy. |
| **memory** | `justfortytwo/memory` (GitHub) | Semantic-memory MCP server (SQLite + Ollama embeddings) — stores and recalls journal, docs, deep profile. |
| **fortytwo** | `./plugins/fortytwo` (this repo) | Umbrella plugin — **skills only** (onboarding + self-update); no hooks, agents, or MCP servers of its own. |

Installing `fortytwo@fortytwo` alone gives the skills but neither the gate
hook nor the memory MCP — install `gate@fortytwo` and `memory@fortytwo`
alongside it for the full assistant.

## The skills

### `onboarding`

A warm, conversational first-run interview building an `ownerProfile` the
owner recognizes as themselves. Collects links, uploaded texts, and
personality-test results (Big Five preferred, 16Personalities as a softer
signal); auto-fetches the owner's links; delegates all writing to
`fortytwo init`; confirms a distilled profile with the owner and tags
provenance. Run once on first setup; re-runnable to refresh.

It is a **prompt-injection boundary**: everything fetched or uploaded is
treated as quarantined data, never instructions — embedded directives are
discarded, only descriptive facts and signals extracted.

### `self-update`

Refreshes fortytwo and its plugins, then verifies health. On-demand,
propose-then-apply. Wraps the native catalog refresh
(`/plugin marketplace update`) and the npm engine updater
(`fortytwo update`), surfaces the `fortytwo doctor` report, and points to
`fortytwo rollback` if anything breaks. **Not scheduled, never silent** —
silence is not consent, and it never touches the owner's persona or context.

## Requirements

- The onboarding/self-update skills drive the `fortytwo` npm CLI — it must be
  on `PATH` (`npm i -g @justfortytwo/installer`, or a project-local install
  from `fortytwo init`). A marketplace-only install won't have it.
- **memory** needs a local Ollama runtime with the embedding model pulled
  for semantic recall.

## Testing

```sh
npm test    # vitest run — manifest validation (test/manifests.test.ts)
```

## Scope

**In scope:** the marketplace catalog, the umbrella plugin, onboarding and
self-update skills.

**Out of scope:** the plugins' own implementations (their source repos), npm
distribution of the engine (the org's npm packages), version policy
(`fortytwo update` owns that).
