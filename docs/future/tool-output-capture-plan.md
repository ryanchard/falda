# Tool Output Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Claude Code tool results into FALDA's T0 stream, bounded by a size cap, so facts that entered a session only through a tool are recallable in a later session.

**Architecture:** Two prerequisite robustness fixes bound what the distiller and embedder consume from any oversized stream row (Tasks 1–2, valuable independently of this feature). A pure truncation helper then bounds tool payloads at the hook (Task 3), and a `capture-tool` subcommand writes them to T0 under a `tool:<ToolName>` role behind an opt-in flag (Task 4). Task 5 is the A/B measurement runbook.

**Tech Stack:** TypeScript (server, `tsx --test` / `node:test`), dependency-free Node ESM `.mjs` (hooks), SQLite via better-sqlite3, MCP over JSON-RPC.

**Spec:** `docs/future/tool-output-capture.md`

**Branch:** `feat/tool-output-capture`

## Global Constraints

- **Hook invariants:** every hook process exits 0 on every path; nothing is written to stdout except the auto-recall injection. A non-zero exit on `UserPromptSubmit` erases the user's typed prompt (`falda-hook.mjs:16`).
- **Hooks are dependency-free.** No npm imports in `integrations/claude-code/hooks/**` — only `node:` builtins. This is why `lib/mcp.mjs` exists instead of the MCP SDK.
- **Test command:** `npx tsx --test test/<file>.test.ts`. Full suite: `npm test`.
- **Defaults (exact values):** `FALDA_CAPTURE_TOOLS=0` (opt-in), `FALDA_CAPTURE_TOOL_MAX_CHARS=16384`, `FALDA_DISTILL_WINDOW_MAX_CHARS=60000`, `FALDA_EMBED_MAX_CHARS=2048`.
- **Row conventions:** role is `tool:<ToolName>`; `turn_id` is `cc-<tool_use_id>-tool`.
- **Truncation:** head 75% / tail 25% of the budget, joined by `\n…[N chars elided]…\n`. The marker is overhead *on top of* the budget — the budget governs retained payload, not final string length.
- **No behaviour change when the feature is off.** Prose-only capture and prose-only distillation must be byte-identical with `FALDA_CAPTURE_TOOLS` unset.

## Deviation from the spec (deliberate, reduces risk)

The spec (§4) describes trimming the turn window "before the prompt is built," and flags the watermark as the riskiest edit — if `setWatermark` still advances to the untrimmed `lastTurn`, trimmed turns are skipped forever.

This plan trims **at the fetch site** (`src/distill/core.ts:408`), before `lastTurn` (`:429`), `pid`, `result.turns_processed`, and `recordPassStart` are derived from it. Every one of those then describes the trimmed window automatically, and `setWatermark` at `:743` needs no edit at all. The landmine is removed by construction rather than patched. Task 1 still tests the watermark behaviour directly, because the guarantee matters regardless of how it is achieved.

---

### Task 1: Char-budgeted L1 extraction window

Today `DEFAULT_WINDOW_SIZE = 20` is a row count and `extractionPrompt` concatenates full content with no character ceiling, so one large stream row can fail the L1 LLM call and abort the whole pass. This is a prerequisite for tool capture and a standalone robustness fix.

**Files:**
- Modify: `src/distill/core.ts` (add constant + `trimWindowToBudget`, extend `DistillOptions`, change the fetch site at `:408`)
- Test: `tests` → create `test/distill_window_budget.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function trimWindowToBudget<T extends { content: string }>(turns: T[], maxChars: number): T[]` from `src/distill/core.ts`; new `DistillOptions.windowMaxChars?: number`.

- [ ] **Step 1: Write the failing unit tests**

Create `test/distill_window_budget.test.ts`:

```ts
/**
 * Char-budgeted L1 extraction window (docs/future/tool-output-capture.md §4).
 *
 * Guarantees under test:
 *   1. trimWindowToBudget keeps a contiguous prefix within budget.
 *   2. A single turn larger than the whole budget is still processed alone.
 *   3. The watermark advances only to the last INCLUDED turn, and the
 *      remainder is picked up by the next pass (the data-loss landmine).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { trimWindowToBudget, distillOnce } from "../src/distill/core.js";

function makeStore(dim = 32) {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-window-"));
  const s = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(dim), dim });
  return { s, blobDir };
}

function cleanup(s: Falda, blobDir: string) {
  s.close();
  fs.rmSync(blobDir, { recursive: true, force: true });
}

describe("trimWindowToBudget", () => {
  test("returns an empty window unchanged", () => {
    assert.deepEqual(trimWindowToBudget([], 100), []);
  });

  test("keeps every turn when the window fits the budget", () => {
    const turns = [{ content: "a".repeat(10) }, { content: "b".repeat(10) }];
    assert.equal(trimWindowToBudget(turns, 100).length, 2);
  });

  test("keeps a turn that lands exactly on the budget", () => {
    const turns = [{ content: "a".repeat(50) }, { content: "b".repeat(50) }];
    assert.equal(trimWindowToBudget(turns, 100).length, 2);
  });

  test("drops the turn that would exceed the budget, and all after it", () => {
    const turns = [{ content: "a".repeat(50) }, { content: "b".repeat(51) }, { content: "c".repeat(1) }];
    const out = trimWindowToBudget(turns, 100);
    assert.equal(out.length, 1, "only the first turn fits");
    assert.equal(out[0].content[0], "a");
  });

  test("keeps a single oversized turn rather than returning nothing", () => {
    const turns = [{ content: "a".repeat(500) }];
    assert.equal(trimWindowToBudget(turns, 100).length, 1, "never deadlocks on one big row");
  });
});
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `npx tsx --test test/distill_window_budget.test.ts`
Expected: FAIL — `trimWindowToBudget` is not exported from `src/distill/core.js`.

- [ ] **Step 3: Implement `trimWindowToBudget` and the env knob**

In `src/distill/core.ts`, beside `DEFAULT_CONSOLIDATION_MAX_CHARS` (`:75`):

```ts
const DEFAULT_WINDOW_MAX_CHARS = 60000;

/** Character ceiling on the L1 extraction window. Unlike windowSize (a row
 *  count), this bounds what actually reaches the LLM: one 300KB tool-output
 *  row would otherwise fail the extraction call and abort the whole pass. */
function windowMaxChars(): number {
  const raw = Number(process.env.FALDA_DISTILL_WINDOW_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_MAX_CHARS;
}

/** Trim a seq-ordered turn window to a character budget, always keeping at
 *  least one turn so an oversized row can never deadlock a pass.
 *
 *  Trims from the TAIL, so the result stays a contiguous prefix of the
 *  fetched rows. That is what makes the watermark safe: it is derived from
 *  the last retained turn, so the dropped remainder has a strictly greater
 *  seq and is picked up by the next pass rather than skipped. */
export function trimWindowToBudget<T extends { content: string }>(turns: T[], maxChars: number): T[] {
  if (turns.length === 0) return turns;
  const out: T[] = [];
  let used = 0;
  for (const t of turns) {
    const cost = t.content.length;
    if (out.length > 0 && used + cost > maxChars) break;
    out.push(t);
    used += cost;
  }
  return out;
}
```

Add to `DistillOptions` (after `windowSize?: number;`, `:34`):

```ts
  /** Character ceiling on the extraction window (FALDA_DISTILL_WINDOW_MAX_CHARS).
   *  Distinct from windowSize, which caps the row COUNT. */
  windowMaxChars?: number;
```

- [ ] **Step 4: Change the fetch site**

Replace `src/distill/core.ts:408`:

```ts
  const turns = store.queryStreamSeq({ afterSeq: afterSeq ?? 0, limit: windowSize });
```

with:

```ts
  // Trim HERE, before lastTurn/pid/turns_processed/recordPassStart are all
  // derived from `turns` below — so every one of them describes the window
  // actually sent to the LLM, and setWatermark needs no separate guard.
  const fetched = store.queryStreamSeq({ afterSeq: afterSeq ?? 0, limit: windowSize });
  const budget = opts.windowMaxChars ?? windowMaxChars();
  const turns = trimWindowToBudget(fetched, budget);
  if (turns.length < fetched.length) {
    log(`[distill] window trimmed ${fetched.length} -> ${turns.length} turns (budget ${budget} chars)`);
  }
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npx tsx --test test/distill_window_budget.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing watermark integration test**

Append to `test/distill_window_budget.test.ts`:

```ts
/** Mock LLM keyed on prompt content, so the test does not depend on the
 *  exact number of L2/L3 calls a pass happens to make. Extraction returns
 *  no candidates, which keeps the pass focused on window/watermark logic. */
function makeQuietLLM() {
  return async (prompt: string): Promise<string> => {
    if (prompt.includes("memory distillation assistant")) return "";
    return "ok";
  };
}

describe("distillOnce window budget", () => {
  test("trims the window and resumes from the last included turn", async () => {
    const { s, blobDir } = makeStore();
    try {
      await s.addStream("sess-w", [
        { role: "user", content: "x".repeat(100) },
        { role: "tool:Bash", content: "y".repeat(5000) },
        { role: "tool:Bash", content: "z".repeat(5000) },
      ]);

      const first = await distillOnce(s, makeQuietLLM(), {
        storeKey: "test:self", windowMaxChars: 1000, verbose: false,
      });
      assert.equal(first.turns_processed, 1, "only the first turn fits the budget");

      const second = await distillOnce(s, makeQuietLLM(), {
        storeKey: "test:self", windowMaxChars: 1000, verbose: false,
      });
      assert.equal(second.turns_processed, 1, "next pass resumes at the trimmed remainder, not past it");

      const third = await distillOnce(s, makeQuietLLM(), {
        storeKey: "test:self", windowMaxChars: 1000, verbose: false,
      });
      assert.equal(third.turns_processed, 1, "third oversized row is reached, nothing was skipped");
    } finally { cleanup(s, blobDir); }
  });

  test("prose-only windows are unaffected by the default budget", async () => {
    const { s, blobDir } = makeStore();
    try {
      await s.addStream("sess-p", [
        { role: "user", content: "The deploy script lives in bin/release" },
        { role: "assistant", content: "Noted." },
      ]);
      const r = await distillOnce(s, makeQuietLLM(), { storeKey: "test:self", verbose: false });
      assert.equal(r.turns_processed, 2, "no trimming at the 60000-char default");
    } finally { cleanup(s, blobDir); }
  });
});
```

- [ ] **Step 7: Run the integration tests**

Run: `npx tsx --test test/distill_window_budget.test.ts`
Expected: PASS (7 tests). If pass 2 reports `turns_processed: 0`, the watermark advanced past the trimmed remainder — that is the data-loss bug this test exists to catch.

- [ ] **Step 8: Verify no regression in the existing distiller suite**

Run: `npx tsx --test test/distill_core.test.ts test/distill_worker.test.ts test/distill_l1_atomic.test.ts`
Expected: PASS, unchanged counts.

- [ ] **Step 9: Document the knob**

In `docs/OPERATIONS.md`, add to the environment-variable table:

```markdown
| `FALDA_DISTILL_WINDOW_MAX_CHARS` | `60000` | Character ceiling on the L1 extraction window. Bounds what reaches the LLM regardless of row count, so one oversized stream row cannot fail a whole pass. The window is trimmed from the tail; trimmed turns are processed by the next pass, never skipped. |
```

- [ ] **Step 10: Commit**

```bash
git add src/distill/core.ts test/distill_window_budget.test.ts docs/OPERATIONS.md
git commit -m "fix(distill): bound the L1 extraction window by characters, not just rows"
```

---

### Task 2: Bound the embedder's input

`addStream` embeds every row synchronously inside the insert loop and no embedder path truncates its input, so an oversized row can fail an entire ingest batch on the remote path. BGE truncates at 512 tokens anyway, so this makes existing behaviour explicit rather than changing what long rows mean.

**Files:**
- Modify: `src/falda.ts` (add helper; `:872` in `addStream`; `:1667` in `reembedAll`)
- Test: create `test/embed_input_bounds.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `export function embedInput(text: string, maxChars?: number): string` from `src/falda.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/embed_input_bounds.test.ts`:

```ts
/**
 * Bounded embedder input (docs/future/tool-output-capture.md §5).
 *
 * Guarantees under test:
 *   1. embedInput caps what reaches the embedder.
 *   2. addStream stores full content and indexes it in FTS even when the
 *      embedded excerpt is bounded — FTS is the real retrieval path for
 *      large rows.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Falda, embedInput } from "../src/falda.js";

function makeStore(dim = 32, embed?: (t: string) => Promise<number[]>) {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-embedbound-"));
  const fallback = async (t: string) => new Array(dim).fill(t.length / 100000);
  const s = new Falda({ dbPath: ":memory:", blobDir, embed: embed ?? fallback, dim });
  return { s, blobDir };
}

describe("embedInput", () => {
  test("passes short text through unchanged", () => {
    assert.equal(embedInput("hello", 2048), "hello");
  });

  test("caps long text at the budget", () => {
    assert.equal(embedInput("a".repeat(5000), 2048).length, 2048);
  });

  test("defaults to 2048 characters", () => {
    assert.equal(embedInput("a".repeat(5000)).length, 2048);
  });
});

describe("addStream embedding bounds", () => {
  test("embeds a bounded excerpt but stores and indexes full content", async () => {
    const seen: string[] = [];
    const { s, blobDir } = makeStore(32, async (t) => { seen.push(t); return new Array(32).fill(0.1); });
    try {
      const marker = "NEEDLE_AT_THE_END_9f3a";
      const content = "q".repeat(5000) + marker;
      await s.addStream("sess-e", [{ role: "tool:Bash", content }]);

      assert.equal(seen.length, 1, "one embed call");
      assert.equal(seen[0].length, 2048, "embedder saw a bounded excerpt");

      const { messages } = s.queryStream({ session_id: "sess-e" });
      assert.equal(messages[0].content, content, "full content is stored verbatim");

      const hits = await s.searchStream(marker, 5);
      assert.ok(hits.length > 0, "FTS finds a term beyond the embedding excerpt");
    } finally { s.close(); fs.rmSync(blobDir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/embed_input_bounds.test.ts`
Expected: FAIL — `embedInput` is not exported from `src/falda.js`.

`searchStream(query, limit)` is the existing T0 lexical-search method (`src/falda.ts:920`) and is `async` — the test awaits it. Do not add a new search method.

- [ ] **Step 3: Implement `embedInput`**

In `src/falda.ts`, near the FTS sanitizer (`:183`):

```ts
const DEFAULT_EMBED_MAX_CHARS = 2048;

/** Bound what reaches the embedder.
 *
 *  Not a behaviour change for prose: BGE's window is 512 tokens, so any long
 *  row was already embedded as roughly its first paragraph. This makes that
 *  explicit and stops the remote embedder path shipping multi-KB payloads
 *  per row. Full content is still stored and FTS-indexed — FTS, not the
 *  vector index, is the retrieval path for large rows. */
export function embedInput(text: string, maxChars = embedMaxChars()): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function embedMaxChars(): number {
  const raw = Number(process.env.FALDA_EMBED_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EMBED_MAX_CHARS;
}
```

- [ ] **Step 4: Apply it at both stream embed sites**

`src/falda.ts:872`, in `addStream`:

```ts
      insV.run(id, this.vecBuf(await this.embed(embedInput(m.content))));
```

`src/falda.ts:1667`, in `reembedAll` — the same bound, or `falda reembed` would produce stream vectors inconsistent with the ones `addStream` writes:

```ts
      insT.run(turns[i].id, this.vecBuf(await this.embed(embedInput(turns[i].content))));
```

Leave the atom and scene embed calls unbounded: atoms are a single sentence by construction (`prompts.ts:29`, ≤120 words) and scene text is a title plus summary.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test test/embed_input_bounds.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify no regression in retrieval and re-embedding**

Run: `npx tsx --test test/reembed.test.ts test/recall_budgets.test.ts test/gateway.test.ts`
Expected: PASS, unchanged counts.

- [ ] **Step 7: Document the knob**

In `docs/OPERATIONS.md`, add to the same table:

```markdown
| `FALDA_EMBED_MAX_CHARS` | `2048` | Characters of a stream row sent to the embedder. Full content is always stored and FTS-indexed; this bounds only the vector. Applies to `addStream` and `falda reembed` alike, so both produce comparable vectors. |
```

- [ ] **Step 8: Commit**

```bash
git add src/falda.ts test/embed_input_bounds.test.ts docs/OPERATIONS.md
git commit -m "fix(embed): bound embedder input for stream rows"
```

---

### Task 3: Truncation and serialization helper

A pure, dependency-free module so the size policy is unit-testable without spawning a hook or a server.

**Files:**
- Create: `integrations/claude-code/hooks/lib/payload.mjs`
- Test: `test/claude_code_libs.test.ts` (append)

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces, all from `lib/payload.mjs`:
  - `DEFAULT_TOOL_MAX_CHARS: number` (16384)
  - `TOOL_INPUT_MAX_CHARS: number` (1024)
  - `stringifyPayload(value: unknown): string`
  - `truncateMiddle(text: string, maxChars: number): string`
  - `toolMaxChars(env?: object): number`

- [ ] **Step 1: Write the failing tests**

Append to `test/claude_code_libs.test.ts` (add the import beside the existing dynamic imports at the top):

```ts
const payload: any = await import("../integrations/claude-code/hooks/lib/payload.mjs");
```

```ts
describe("cc plugin: payload serialization", () => {
  test("passes a string through unchanged", () => {
    assert.equal(payload.stringifyPayload("plain output"), "plain output");
  });

  test("serializes an object rather than yielding [object Object]", () => {
    const out = payload.stringifyPayload({ stdout: "ok", interrupted: false });
    assert.ok(out.includes('"stdout":"ok"'), `got: ${out}`);
    assert.ok(!out.includes("[object Object]"));
  });

  test("maps null and undefined to the empty string", () => {
    assert.equal(payload.stringifyPayload(null), "");
    assert.equal(payload.stringifyPayload(undefined), "");
  });

  test("survives a circular object without throwing", () => {
    const a: any = { name: "loop" };
    a.self = a;
    assert.equal(typeof payload.stringifyPayload(a), "string");
  });
});

describe("cc plugin: truncateMiddle", () => {
  test("leaves text at or under the budget untouched", () => {
    assert.equal(payload.truncateMiddle("a".repeat(100), 100), "a".repeat(100));
    assert.equal(payload.truncateMiddle("a".repeat(99), 100), "a".repeat(99));
  });

  test("keeps head 75% and tail 25% of the budget", () => {
    const text = "H".repeat(500) + "M".repeat(9000) + "T".repeat(500);
    const out = payload.truncateMiddle(text, 100);
    assert.ok(out.startsWith("H".repeat(75)), "head is 75 chars");
    assert.ok(out.endsWith("T".repeat(25)), "tail is 25 chars");
  });

  test("reports the true elided count in the marker", () => {
    const out = payload.truncateMiddle("a".repeat(1000), 100);
    const m = out.match(/\[(\d+) chars elided\]/);
    assert.ok(m, `no elision marker in: ${out.slice(0, 120)}`);
    assert.equal(Number(m![1]), 900, "1000 total - 75 head - 25 tail");
  });

  test("returns the empty string for a non-string input", () => {
    assert.equal(payload.truncateMiddle(undefined, 100), "");
  });
});

describe("cc plugin: toolMaxChars", () => {
  test("defaults to 16384", () => {
    assert.equal(payload.toolMaxChars({}), 16384);
  });

  test("honours a valid override", () => {
    assert.equal(payload.toolMaxChars({ FALDA_CAPTURE_TOOL_MAX_CHARS: "512" }), 512);
  });

  test("falls back to the default on junk or non-positive values", () => {
    assert.equal(payload.toolMaxChars({ FALDA_CAPTURE_TOOL_MAX_CHARS: "banana" }), 16384);
    assert.equal(payload.toolMaxChars({ FALDA_CAPTURE_TOOL_MAX_CHARS: "0" }), 16384);
    assert.equal(payload.toolMaxChars({ FALDA_CAPTURE_TOOL_MAX_CHARS: "-5" }), 16384);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test test/claude_code_libs.test.ts`
Expected: FAIL — cannot resolve `lib/payload.mjs`.

- [ ] **Step 3: Implement the helper**

Create `integrations/claude-code/hooks/lib/payload.mjs`:

```js
/**
 * Tool-payload serialization and size policy.
 *
 * Pure and dependency-free so the size policy is testable without spawning
 * a hook process or a server. See docs/future/tool-output-capture.md §2.
 */

/** Verbatim ceiling for a tool result before head+tail truncation. */
export const DEFAULT_TOOL_MAX_CHARS = 16384;

/** Ceiling for the echoed tool_input. A Write call's `content` argument can
 *  be arbitrarily large and is already visible in the resulting file, so the
 *  echo exists for provenance, not fidelity. */
export const TOOL_INPUT_MAX_CHARS = 1024;

/** Fraction of the budget kept from the head. Headers, schemas and commands
 *  sit at the top; results, errors and exit status sit at the bottom. */
const HEAD_FRACTION = 0.75;

/** Render any tool payload as text. Most tools return an object
 *  ({stdout, stderr, interrupted} for Bash), so a bare String() would yield
 *  "[object Object]" and silently discard the output. */
export function stringifyPayload(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    // Circular or otherwise unserializable — never throw inside a hook.
    return String(value);
  }
}

/**
 * Head+tail truncation with an explicit elision marker.
 *
 * The marker is load-bearing, not cosmetic: it tells distillation the row is
 * partial, so the extraction LLM does not state a confident fact drawn from a
 * severed table. `maxChars` governs RETAINED PAYLOAD; the marker is overhead
 * on top of it, so the returned string is slightly longer than the budget.
 */
export function truncateMiddle(text, maxChars) {
  if (typeof text !== "string") return "";
  if (!(maxChars > 0) || text.length <= maxChars) return text;
  const head = Math.floor(maxChars * HEAD_FRACTION);
  const tail = maxChars - head;
  const elided = text.length - head - tail;
  return `${text.slice(0, head)}\n…[${elided} chars elided]…\n${text.slice(text.length - tail)}`;
}

/** Resolve the verbatim ceiling, ignoring junk and non-positive overrides. */
export function toolMaxChars(env = process.env) {
  const raw = Number(env.FALDA_CAPTURE_TOOL_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOOL_MAX_CHARS;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/claude_code_libs.test.ts`
Expected: PASS — the 11 new tests plus the existing ones.

- [ ] **Step 5: Commit**

```bash
git add integrations/claude-code/hooks/lib/payload.mjs test/claude_code_libs.test.ts
git commit -m "feat(cc-plugin): add tool-payload serialization and truncation helper"
```

---

### Task 4: `capture-tool` subcommand and hook wiring

**Files:**
- Modify: `integrations/claude-code/hooks/lib/creds.mjs` (add `captureTools` to `features`)
- Modify: `integrations/claude-code/hooks/falda-hook.mjs` (new subcommand + docblock)
- Modify: `integrations/claude-code/hooks/hooks.json` (register `PostToolUse`, `PostToolUseFailure`)
- Modify: `integrations/claude-code/README.md` (the "What gets captured" section, which currently states the opposite)
- Test: `test/claude_code_hooks.test.ts` (append)

**Interfaces:**
- Consumes: `stringifyPayload`, `truncateMiddle`, `toolMaxChars`, `TOOL_INPUT_MAX_CHARS` from `lib/payload.mjs` (Task 3); the existing `capture(creds, env, sessionId, role, content, turnId)` helper at `falda-hook.mjs:44`.
- Produces: the `capture-tool` subcommand; `features(env).captureTools: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/claude_code_hooks.test.ts`. It needs a row reader alongside the existing `streamCount`; add this helper beside it:

```ts
/** Read back T0 rows for a session (role + content), newest last. */
function streamRows(sessionId: string): Array<{ role: string; content: string }> {
  const store = handle.runtime.pools.resolve("ccproj", undefined, false);
  return store.queryStream({ session_id: sessionId }).messages
    .map((m: any) => ({ role: m.role, content: m.content }));
}
```

```ts
describe("cc plugin: tool capture", () => {
  test("is off unless FALDA_CAPTURE_TOOLS is exactly 1", async () => {
    const sid = "sess-tool-off";
    const r = await runHook("capture-tool", {
      session_id: sid, tool_name: "Bash",
      tool_input: { command: "echo hi" }, tool_response: { stdout: "hi" },
      tool_use_id: "tu-off-1",
    }, env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(streamCount(sid), 0, "opt-in: nothing captured without the flag");
  });

  test("is forced off when FALDA_CAPTURE=0", async () => {
    const sid = "sess-tool-forced-off";
    await runHook("capture-tool", {
      session_id: sid, tool_name: "Bash",
      tool_input: { command: "echo hi" }, tool_response: { stdout: "hi" },
      tool_use_id: "tu-forced-1",
    }, { ...env, FALDA_CAPTURE: "0", FALDA_CAPTURE_TOOLS: "1" });
    assert.equal(streamCount(sid), 0, "tool rows without prose rows is not a coherent state");
  });

  test("captures a tool result under a tool:<Name> role with the command echoed", async () => {
    const sid = "sess-tool-on";
    const r = await runHook("capture-tool", {
      session_id: sid, tool_name: "Bash",
      tool_input: { command: "psql -c '\\d users'" },
      tool_response: { stdout: "id | integer\nemail | text", interrupted: false },
      tool_use_id: "tu-on-1",
    }, { ...env, FALDA_CAPTURE_TOOLS: "1" });

    assert.equal(r.code, 0);
    assert.equal(r.stdout, "", "capture hooks never write to stdout");
    const rows = streamRows(sid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, "tool:Bash");
    assert.ok(rows[0].content.startsWith("$ Bash "), `got: ${rows[0].content.slice(0, 40)}`);
    assert.ok(rows[0].content.includes("psql"), "tool_input echoed for provenance");
    assert.ok(rows[0].content.includes("email | text"), "object tool_response serialized, not [object Object]");
  });

  test("replaying the same tool_use_id is a no-op", async () => {
    const sid = "sess-tool-idem";
    const input = {
      session_id: sid, tool_name: "Read",
      tool_input: { file_path: "/etc/hosts" }, tool_response: "127.0.0.1 localhost",
      tool_use_id: "tu-idem-1",
    };
    const e = { ...env, FALDA_CAPTURE_TOOLS: "1" };
    await runHook("capture-tool", input, e);
    await runHook("capture-tool", input, e);
    assert.equal(streamCount(sid), 1, "server-side turn_id idempotency");
  });

  test("truncates an oversized result and marks the elision", async () => {
    const sid = "sess-tool-big";
    await runHook("capture-tool", {
      session_id: sid, tool_name: "Bash",
      tool_input: { command: "cat big.log" },
      tool_response: "S".repeat(400) + "E".repeat(400),
      tool_use_id: "tu-big-1",
    }, { ...env, FALDA_CAPTURE_TOOLS: "1", FALDA_CAPTURE_TOOL_MAX_CHARS: "100" });

    const body = streamRows(sid)[0].content;
    assert.ok(body.includes("chars elided"), "elision marker present");
    assert.ok(body.includes("S".repeat(75)), "head retained");
    assert.ok(body.trimEnd().endsWith("E".repeat(25)), "tail retained");
  });

  test("captures a tool failure, which carries the error", async () => {
    const sid = "sess-tool-fail";
    await runHook("capture-tool", {
      session_id: sid, tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: "1 failing: expected 200, got 503",
      tool_use_id: "tu-fail-1",
    }, { ...env, FALDA_CAPTURE_TOOLS: "1" });

    const rows = streamRows(sid);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].content.includes("ERROR:"), "failures are labelled");
    assert.ok(rows[0].content.includes("got 503"));
  });

  test("skips a user interrupt, which is not a fact", async () => {
    const sid = "sess-tool-interrupt";
    await runHook("capture-tool", {
      session_id: sid, tool_name: "Bash",
      tool_input: { command: "sleep 300" },
      error: "interrupted", is_interrupt: true, tool_use_id: "tu-int-1",
    }, { ...env, FALDA_CAPTURE_TOOLS: "1" });
    assert.equal(streamCount(sid), 0);
  });

  test("exits 0 and stays silent with no tool_name or no payload", async () => {
    const e = { ...env, FALDA_CAPTURE_TOOLS: "1" };
    const a = await runHook("capture-tool", { session_id: "sess-tool-empty", tool_use_id: "tu-e1" }, e);
    const b = await runHook("capture-tool", { session_id: "sess-tool-empty", tool_name: "Bash", tool_use_id: "tu-e2" }, e);
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    assert.equal(a.stdout + b.stdout, "");
    assert.equal(streamCount("sess-tool-empty"), 0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test test/claude_code_hooks.test.ts`
Expected: FAIL — `capture-tool` is unhandled, so `main()` falls through and nothing is written. The gate tests may pass vacuously; the capture tests must fail.

- [ ] **Step 3: Add the feature flag**

In `integrations/claude-code/hooks/lib/creds.mjs`, replace the `features` docblock and return object:

```js
/** Feature gating. Every feature is on unless its var is exactly "0" —
 *  EXCEPT captureTools, which is opt-IN (must be exactly "1"). Tool capture
 *  multiplies row count and ships tool output to the distillation LLM, so it
 *  is not something a user should acquire by upgrading. */
export function features(env = process.env) {
  const on = (v) => v !== "0";
  const capture = on(env.FALDA_CAPTURE);
  return {
    capture,
    autoRecall: on(env.FALDA_AUTO_RECALL),
    distillOnCompact: on(env.FALDA_DISTILL_ON_COMPACT),
    // Post-compaction recall re-surfaces detail the compaction summary
    // dropped, which only exists in T0 if capture is writing there.
    recallOnCompact: capture && on(env.FALDA_RECALL_ON_COMPACT),
    // Same dependency, same reason: tool rows without prose rows is not a
    // coherent state.
    captureTools: capture && env.FALDA_CAPTURE_TOOLS === "1",
  };
}
```

- [ ] **Step 4: Implement the subcommand**

In `integrations/claude-code/hooks/falda-hook.mjs`, add the import beside the existing ones:

```js
import { stringifyPayload, truncateMiddle, toolMaxChars, TOOL_INPUT_MAX_CHARS } from "./lib/payload.mjs";
```

Add to the subcommand list in the file docblock (after the `capture-assistant` line):

```
 *   capture-tool        PostToolUse / PostToolUseFailure (async)
 *                                                  — tool results -> T0
```

Insert the branch after the `capture-assistant` branch (`:92`):

```js
  if (sub === "capture-tool") {
    if (!f.captureTools) return;

    const toolName = String(input.tool_name ?? "").trim();
    if (!toolName) return;

    // A user interrupt is not a fact about the world, just about timing.
    if (input.is_interrupt) return;

    // PostToolUse carries tool_response; PostToolUseFailure carries error
    // instead. A single call cannot produce both, so they share one turn_id
    // namespace without colliding.
    const body = input.error !== undefined
      ? `ERROR: ${stringifyPayload(input.error)}`
      : stringifyPayload(input.tool_response);
    if (!body.trim()) return;

    // Echo the call before the output so extraction sees what produced the
    // fact rather than a naked blob.
    const args = truncateMiddle(stringifyPayload(input.tool_input), TOOL_INPUT_MAX_CHARS);
    const content = `$ ${toolName} ${args}\n${truncateMiddle(body, toolMaxChars(env))}`;

    // tool_use_id is always present and unique, so unlike the prose paths
    // this turn_id has no missing-id fallback to worry about (see capture()).
    const turnId = input.tool_use_id ? `cc-${input.tool_use_id}-tool` : undefined;
    await capture(creds, env, sessionId, `tool:${toolName}`, content, turnId);
    return;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test test/claude_code_hooks.test.ts`
Expected: PASS — the 8 new tests plus the existing ones.

- [ ] **Step 6: Register the hooks**

In `integrations/claude-code/hooks/hooks.json`, add two entries as siblings of `Stop`. Both are `async` so they never sit in a turn's critical path:

```json
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/falda-hook.mjs\" capture-tool",
            "async": true
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/falda-hook.mjs\" capture-tool",
            "async": true
          }
        ]
      }
    ],
```

- [ ] **Step 7: Verify the JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('integrations/claude-code/hooks/hooks.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 8: Correct the README**

In `integrations/claude-code/README.md`, replace the first paragraph of "What gets captured" (`:123`), which currently asserts the opposite of this feature:

```markdown
## What gets captured

User prose and assistant prose by default. Tool results are captured too when
`FALDA_CAPTURE_TOOLS=1` — opt-in, because it multiplies row count and sends
tool output to the distillation LLM.

The original rationale for excluding them was that bash output and diffs are
noise the distiller has to filter back out, at an embedding cost per row.
That holds for the noise; it misses the facts. A value that enters a session
only through a tool — a config value, a schema shape, a version, an error
string — is never restated in prose, so it reaches neither T0 nor the
compaction summary. See `docs/future/tool-output-capture.md` for the design
and the measurement that settles which effect dominates.
```

Then add to the feature-flag table (`:110`):

```markdown
| `FALDA_CAPTURE_TOOLS` | **off** | capturing tool results to T0 (opt-in; requires `FALDA_CAPTURE`) |
| `FALDA_CAPTURE_TOOL_MAX_CHARS` | 16384 | verbatim ceiling per tool result before head+tail truncation |
```

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS. Prose-only behaviour must be unchanged — `FALDA_CAPTURE_TOOLS` is unset for every pre-existing test.

- [ ] **Step 10: Commit**

```bash
git add integrations/claude-code/hooks/falda-hook.mjs \
        integrations/claude-code/hooks/lib/creds.mjs \
        integrations/claude-code/hooks/hooks.json \
        integrations/claude-code/README.md \
        test/claude_code_hooks.test.ts
git commit -m "feat(cc-plugin): capture tool results to T0 behind FALDA_CAPTURE_TOOLS"
```

---

### Task 5: Measurement runbook

Spec §7. The deliverable is a runbook precise enough to re-run, not new product code.

**Files:**
- Create: `docs/future/tool-output-capture-measurement.md`

**Interfaces:**
- Consumes: the `FALDA_CAPTURE_TOOLS` flag from Task 4.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the runbook**

Create `docs/future/tool-output-capture-measurement.md`:

```markdown
# Measuring tool-output capture

A/B protocol for `docs/future/tool-output-capture.md` §7. Mirrors the
methodology of the earlier FALDA-vs-compaction evaluation.

## Arms

| Arm | Configuration |
|---|---|
| control | `FALDA_CAPTURE=1`, `FALDA_CAPTURE_TOOLS` unset |
| treatment | `FALDA_CAPTURE=1`, `FALDA_CAPTURE_TOOLS=1` |

Everything else is pinned identically across arms: same model, same
compression threshold, same `FALDA_DISTILL_WINDOW_MAX_CHARS`, same store
starting empty.

## Fact design

Plant facts that are reachable **only** through a tool result and never
restated in prose — the class the earlier evaluation showed both mechanisms
lose. Each fact is a distinctive token that cannot be guessed:

- a value inside a file read with `Read` and never quoted back
- a column type printed by a `Bash` command
- a version string from `--version` output
- an error string from a deliberately failing command

Do not mention any planted value in a user or assistant message. If it
appears in prose, the control arm can also recall it and the trial is void.

## Protocol

1. Start both arms against fresh, separate stores.
2. Run an identical scripted session that surfaces every planted fact
   through a tool call.
3. Continue until at least one compaction boundary has passed.
4. Wait for distillation to finish before probing — recall reads distilled
   tiers, not raw T0. Confirm with `npm run distill-inspect` rather than
   assuming.
5. Probe from a **new session**: in-context compression cannot carry
   information across a session boundary, so a same-session probe would mask
   the effect being measured.

## Metrics

**Primary.** Cross-session recall rate on planted tool-only facts.

**Secondary.**

| Metric | Source |
|---|---|
| rows written per session | `falda stats` |
| distillation pass wall time | `npm run distill-inspect` |
| extraction candidates per pass | `npm run distill-inspect` |
| atoms stored per pass | `distillOnce` result / inspect |

## Reading the result

A rise in candidates per pass with no rise in recall is the signal that tool
rows produce noise atoms rather than facts — the failure mode the README's
original rationale predicted, and the question this experiment exists to
settle. Report it as such rather than reporting only the primary metric.

Invalid runs (crashed session, distillation incomplete at probe time, a
planted value that leaked into prose) get an explicit footnote. They are
never quietly averaged into the results.
```

- [ ] **Step 2: Commit**

```bash
git add docs/future/tool-output-capture-measurement.md
git commit -m "docs: measurement runbook for tool-output capture"
```

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 what already works (no server change) | verified in Task 4 tests (`tool:Bash` role accepted end-to-end) |
| §2 capture layer, row shape, size cap | Tasks 3, 4 |
| §3 configuration (4 variables) | Task 1 (window), Task 2 (embed), Tasks 3–4 (both capture vars) |
| §4 char-budgeted window + watermark | Task 1 (trimmed at the fetch site; watermark tested directly) |
| §5 embedding | Task 2 |
| §6 testing | Tasks 1–4, every listed case |
| §7 measurement | Task 5 |
| §8 deferred redaction | out of scope by design; recorded in the spec |
| §9 blast radius | Tasks 1–2 land as separate `fix:` commits, so they can be offered upstream independently of the feature |

**Known gaps, deliberate:** §8 has no task. It is a stated non-goal for this branch and a stated blocker for upstreaming.

**Type consistency:** `trimWindowToBudget` / `windowMaxChars` / `DistillOptions.windowMaxChars` (Task 1); `embedInput` / `embedMaxChars` (Task 2); `stringifyPayload` / `truncateMiddle` / `toolMaxChars` / `TOOL_INPUT_MAX_CHARS` (Task 3, consumed under those exact names in Task 4); `features().captureTools` (Task 4). The `streamRows` test helper is defined once in Task 4 beside the existing `streamCount`.
