# Capturing tool output into T0

**Status:** proposed — local measurement branch, not yet for upstream.
**Date:** 2026-08-20
**Scope:** `integrations/claude-code`, `src/distill/core.ts`, `src/falda.ts`, `src/embedder.ts`

## Problem

Neither harness integration captures tool results. The Claude Code plugin
records user prose (`UserPromptSubmit`) and the final assistant message
(`Stop`); the opencode plugin filters to text parts and drops everything
else (`integrations/opencode/plugin/falda-capture.ts:301`). The exclusion
is deliberate and documented — `integrations/claude-code/README.md:123`
argues that "bash output and diffs are noise it would have to filter back
out, while still costing embedding work per captured turn."

Measurement since then contradicts the premise. A fact that enters a
session only through a tool result — a config value read from a file, a
schema shape from `psql`, a version string, an error message — is never
restated in prose, so it reaches neither T0 nor the compaction summary.
Both mechanisms key off the conversation transcript, so both lose it. The
session knew the fact; nothing durable did.

This document proposes closing that gap on a local branch, with
measurement, and defers the upstream question until there are numbers.

## Goals

1. A fact that entered the session through a tool result is recallable in
   a later session.
2. Parity between what the session observed and what T0 holds, bounded by
   an explicit size cap rather than by content type.
3. Capture policy is tunable *after* capture, so competing filtering
   strategies can be compared against one fixed corpus without re-running
   sessions.

## Non-goals

- **Upstream default.** Ships default-off. Whether it becomes the norm for
  all FALDA users is a separate decision needing a cost story and §8.
- **Secret redaction.** Explicitly deferred; see §8.
- **opencode parity.** The opencode plugin keeps its current behaviour.
  The shared changes in §4 and §5 benefit it, but no capture change is
  proposed there.

## 1. What already works

No server-side change is needed to accept tool rows:

- `falda_stream_add` declares `role: z.string()` — unconstrained
  (`src/mcp/tools/capture.ts:28`).
- `stream.role` is bare `TEXT NOT NULL`, no CHECK constraint
  (`docs/schema/tables.sql:28`).
- L1 extraction renders each turn as `${t.role}: ${t.content}`
  (`src/distill/prompts.ts:24`), so a structured role string carries
  provenance into the prompt for free.

The hook payloads carry what is needed. Verified against the shipped
binary at version 2.1.235, not against published documentation — the
existing plugin already documents one case where that documentation is
wrong (`falda-hook.mjs:76`, `prompt` vs `user_prompt`):

| Event | Payload |
|---|---|
| `PostToolUse` | `{session_id, …, tool_name, tool_input, tool_response, tool_use_id, duration_ms}`, dispatched with `matchQuery: tool_name` so hooks.json matchers can scope by tool |
| `PostToolUseFailure` | `{session_id, …, tool_name, tool_input, tool_use_id, error, is_interrupt, duration_ms}` |
| `PostToolBatch` | `{session_id, …, tool_calls: [{tool_name, tool_input, tool_use_id, tool_response}]}` — one invocation per batch, no matcher support |

## 2. Capture layer

A `capture-tool` subcommand in `integrations/claude-code/hooks/falda-hook.mjs`,
registered `async` on `PostToolUse` and `PostToolUseFailure`. Tool failures
carry some of the highest-value facts ("this errored because X"); they are
a distinct event, so omitting them would silently drop that class entirely.

The subcommand reuses the existing `capture()` helper, `resolveCreds`, and
`features` unchanged, and inherits the module's two standing invariants:
always exit 0, and write nothing to stdout.

### Row shape

```
$ Bash {"command":"psql -c '\\d users'"}
<serialized tool_response>
```

The command line precedes the output so extraction sees what produced the
fact rather than a naked blob. `tool_input` is serialized compactly and
capped independently (1KB) — a `Write` call's `content` argument can be
arbitrarily large and is already visible in the resulting file.

- **`role`**: `tool:<ToolName>` (e.g. `tool:Bash`, `tool:Read`). Renders as
  `tool:Bash: …` through the existing extraction prompt.
- **`turn_id`**: `cc-<tool_use_id>-tool`. `tool_use_id` is always present
  and unique, so this is a sound idempotency key — the missing-`prompt_id`
  hazard documented at `falda-hook.mjs:44` does not apply.
- **`tool_response` serialization**: most tools return an object
  (`{stdout, stderr, interrupted}` for Bash), so the value is JSON-stringified
  when it is not already a string, before the size check.

### Size cap and degradation

Outputs under `FALDA_CAPTURE_TOOL_MAX_CHARS` (default 16384) are stored
verbatim. Above it, head+tail truncation keeps the first 75% and the last
25% of the budget (12288 and 4096 characters at the default cap, scaling
with it rather than hard-coded, so lowering the cap stays coherent),
joined by

```
\n…[N chars elided]…\n
```

Head and tail are the fact-bearing regions — headers, schemas and commands
at the top; results, errors and exit status at the bottom. The elision
marker is load-bearing: it tells distillation the row is partial, so the
extraction LLM does not state a confident fact drawn from a severed table.

**No summarization at capture time.** `PostToolUse` spawns a process per
tool call and must never stall a turn; an LLM call there is the wrong
place for one, and FALDA already has an LLM at distillation. If
measurement shows truncation loses facts, the response is to raise the
cap, not to add inference to the hook.

## 3. Configuration

| Variable | Default | Effect |
|---|---|---|
| `FALDA_CAPTURE_TOOLS` | `0` (off) | Enables tool capture. The single A/B switch for §7. |
| `FALDA_CAPTURE_TOOL_MAX_CHARS` | `16384` | Per-row verbatim ceiling before head+tail truncation. |
| `FALDA_DISTILL_WINDOW_MAX_CHARS` | `60000` | Extraction-window character budget (§4). |
| `FALDA_EMBED_MAX_CHARS` | `2048` | Bounded excerpt sent to the embedder (§5). |

`FALDA_CAPTURE_TOOLS` is additionally forced off when `FALDA_CAPTURE=0`,
matching the existing treatment of `FALDA_RECALL_ON_COMPACT`
(`integrations/claude-code/README.md:115`) — there is no coherent state in
which tool rows are written but prose rows are not.

## 4. Distiller: a char-budgeted extraction window

**This is mandatory, not an optimisation.** `DEFAULT_WINDOW_SIZE = 20`
(`src/distill/core.ts:69`) is a row count, and `extractionPrompt`
concatenates full content with no character budget
(`src/distill/core.ts:535`). Today twenty prose turns is a few KB. Twenty
rows containing tool output is up to 320KB even under the §2 cap — enough
to fail the L1 call and take the whole pass down with it
(`recordPassComplete({status:"failed"})`).

`queryStreamSeq` continues to fetch `windowSize` rows
(`src/distill/core.ts:408`). The returned array is then trimmed to fit
`FALDA_DISTILL_WINDOW_MAX_CHARS` before the prompt is built, always
retaining at least one turn so a single oversized row cannot deadlock a
pass.

### Watermark correctness

The riskiest edit in this change. The watermark currently advances to
`lastTurn`, computed as `turns[turns.length - 1]`
(`src/distill/core.ts:429`), and applied at `src/distill/core.ts:743`. Once the array is trimmed, it must advance
only to the last turn *actually included in the prompt*.

Getting this wrong silently skips every trimmed turn forever, and presents
exactly as "distillation ignored my tool output" — indistinguishable from
the capture layer failing. It must be tested directly (§6), not inferred
from a passing pass.

Trimming shrinks a pass's coverage, so the remaining turns are picked up
by the next pass rather than dropped. No change is needed to the sweep
worker for this: the watermark not having reached the newest turn is
already the condition that makes the next pass do work.

## 5. Embedding

`addStream` embeds every row synchronously inside the insert loop
(`src/falda.ts:872`), and no embedder path truncates its input — the ONNX
path passes raw text straight to `extractor(text, {pooling:"cls",
normalize:true})` (`src/embedder.ts:195`).

The embed input becomes a bounded excerpt of `FALDA_EMBED_MAX_CHARS`.

Being precise about what this buys: BGE's window is 512 tokens, so current
behaviour on any long row is already "embed roughly the first paragraph."
This makes that explicit and stops the remote embedder path shipping 16KB
payloads per row. It does not make semantic retrieval over tool rows good.

**FTS is the real retrieval path for tool content** — it indexes full
content (`src/falda.ts:871`) and exact-string matching is what tool output
is actually queried by: an error message, a config key, a version. The
vector index remains a first-paragraph proxy and should not be relied on
for this class of row.

## 6. Testing

Extending `test/claude_code_hooks.test.ts`:

- disabled by default; enabled only with `FALDA_CAPTURE_TOOLS=1`
- forced off when `FALDA_CAPTURE=0`
- object-valued `tool_response` is serialized, not `[object Object]`
- truncation boundary: exactly at, one under, one over the cap
- elision marker present and reports the true elided count
- `PostToolUseFailure` produces a row carrying the error
- `turn_id` derives from `tool_use_id`; a replayed identical event is a
  no-op rather than a duplicate row
- the always-exit-0 and empty-stdout invariants hold on every path

New distiller coverage:

- a window of oversized rows is trimmed to the char budget
- a single row larger than the whole budget is still processed alone
- **the watermark advances to the last included turn, and a following pass
  processes the trimmed remainder** — the §4 landmine, tested directly
- existing prose-only behaviour is byte-identical when the budget is not
  reached, guarding the opencode path against regression

## 7. Measurement

Mirrors the methodology of the earlier FALDA-vs-compaction evaluation.

**Design.** Plant facts reachable only through tool results — values that
appear in a file or command output and are never restated in prose, which
is precisely the class the earlier evaluation found both mechanisms lose.
Run past a compaction boundary, then probe from a *new session*, since
in-context compression cannot carry information across a session boundary
and would otherwise mask the effect being measured.

**Arms.** `FALDA_CAPTURE_TOOLS=0` versus `=1`, all else fixed. Pin the
compression threshold as in prior runs so triggering conditions are
consistent across arms.

**Primary metric.** Recall rate on tool-only facts, cross-session.

**Secondary metrics.** Rows written per session; distillation pass wall
time; extraction candidates per pass; atoms stored per pass. A large rise
in candidates with no rise in recall is the signal that tool rows are
producing noise atoms rather than facts — the failure mode the README's
original rationale predicted, and the one this experiment exists to
settle.

Distillation must be allowed to complete before probing; recall reads
distilled tiers, not raw T0. Invalid runs get explicit footnotes rather
than being averaged in.

## 8. Deferred: secret redaction

There is no redaction anywhere in the codebase today. The only related
code is an FTS *query* sanitizer (`src/falda.ts:183`).

Prose rarely contains credentials. Tool output routinely does: `cat .env`,
`env`, `gh auth token`, a connection string in a stack trace. Under this
design that material lands in SQLite, in the FTS index, and in every
distillation prompt sent to the configured LLM.

Acceptable on a local branch distilling against a local model. It is a
**blocker for upstreaming**, and no default-on proposal should be made
without it. Recording it here so that is a decision rather than an
oversight.

## 9. Blast radius

§4 and §5 modify `src/distill/core.ts`, `src/falda.ts` and
`src/embedder.ts` — shared with the opencode integration and every other
caller. Both are robustness fixes the repo wants independently of this
feature: today a single large `falda_stream_add` row can fail an entire
distillation pass or an entire ingest batch, with or without tool capture.

They should be presented upstream on that basis, separately from the
capture feature, rather than arriving as its dependencies.

This proposal also reverses the stated rationale at
`integrations/claude-code/README.md:123`. That README text needs updating
alongside any upstream change, and the reversal should be raised
explicitly rather than landing quietly.
