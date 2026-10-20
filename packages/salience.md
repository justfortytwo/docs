# `@justfortytwo/salience`

The **salience extraction** engine for fortytwo. Given a conversational turn,
it distils a small set of **atomic, self-contained candidate memories**, each
with a **salience score**, so the write-side (`@justfortytwo/memory`'s
enrichment loop) can dedupe, supersede, and persist only what is worth
keeping.

- **Version:** `0.1.1` · **Runtime:** pure library (ESM-only) · **Node:**
  >= 18 · **Zero runtime dependencies** — no provider SDK, no credentials

## Why this exists

This is the piece a **memory server must not embed**: storing and recalling is
memory's job; deciding *what is worth remembering* is a model-driven judgement,
and that judgement lives here. salience owns the contract plus a reference
implementation — **never a provider**. It does not depend on
`@justfortytwo/memory`; memory depends on salience (optional peer), never the
other way round, so salience can be used à la carte.

## Provider-agnostic by contract

The host injects a `LlmClient`; salience only needs text-in / text-out —
exactly mirroring how memory injects an `Embedder` rather than owning a model
client:

```ts
import {
  createSalienceExtractor, type LlmClient, type Candidate,
} from '@justfortytwo/salience';

const llm: LlmClient = {
  async complete({ system, prompt }) {
    // call your model of choice here
    return '...';
  },
};

const extractor = createSalienceExtractor(llm);
const candidates: Candidate[] = await extractor.extractSalient({
  text: 'the deploy script lives at scripts/deploy.sh; we ship on Fridays',
  source: 'owner',
  observed: 'stated',
});
```

## Shape

| Export | Role |
| --- | --- |
| `Turn` | a conversational turn (free-form text + optional provenance) |
| `Candidate` | a distilled, scored memory — aligned with memory's `EnrichmentCandidate`, so candidates flow into `enrich()` with no remapping |
| `LlmClient` | the injected, minimal completion seam |
| `SalienceExtractor` | the extraction contract; `extractSalient(turn, opts)` → scored `Candidate[]` |
| `createSalienceExtractor(llm)` | the reference implementation: frames the task, runs the client, parses, scores, filters, stamps provenance |
| `SALIENCE_SYSTEM_PROMPT` | the exported system framing — a plain `const` to read or override when tuning extraction policy without forking |

## Output convention

`extractSalient` expects the injected client's `complete()` to return a
**JSON array** of candidate objects:

```json
[{ "content": "the owner ships on Fridays", "salience": 0.9, "observed": "stated" }]
```

Each object needs `content` (non-empty) and `salience` (0–1); `source`,
`observed`, `date`, `tags`, `meta` are optional. Parsing is **lenient and
fail-soft**: the array is extracted even from prose- or fence-wrapped output,
malformed items are skipped, `salience` is clamped to `[0,1]`, and unparseable
output yields `[]` — never a throw, because one bad turn must not crash an
enrichment loop. Candidates inherit the turn's
`source`/`observed`/`date` where the model leaves them blank
(`opts.defaultObserved` is the final fallback).

`ExtractOptions` post-filters: `minSalience` drops low-confidence candidates,
`maxCandidates` caps the (salience-sorted) output.

## How it fits

```text
turn ──> @justfortytwo/salience (extract + score) ──> Candidate[]
                                                            │
                                                            ▼
                              @justfortytwo/memory.enrich (dedupe / supersede / write)
```

memory references salience from `src/enrichment.ts` (the salience step).
salience is a **pure npm engine** — not a Claude Code plugin, not in the
marketplace catalog.

## Testing

```sh
npm run build && npm test   # vitest run
```

## Scope

**In scope:** the extraction contract, the reference extractor, scoring,
lenient parsing, provenance stamping.

**Out of scope:** model/provider wiring (host-injected `LlmClient`),
dedupe/supersede/write policy (memory's `enrich`), storage and recall
(memory).
