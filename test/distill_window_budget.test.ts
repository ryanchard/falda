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

/** Run `fn` with FALDA_DISTILL_WINDOW_MAX_CHARS unset, then restore it.
 *  distillOnce falls back to process.env when opts.windowMaxChars is
 *  omitted, so the DEFAULT-budget assertion below would fail for any
 *  developer (or measurement run — docs/future/tool-output-capture-measurement.md
 *  pins this variable) that has it exported. */
async function withoutWindowMaxChars<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env.FALDA_DISTILL_WINDOW_MAX_CHARS;
  delete process.env.FALDA_DISTILL_WINDOW_MAX_CHARS;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.FALDA_DISTILL_WINDOW_MAX_CHARS;
    else process.env.FALDA_DISTILL_WINDOW_MAX_CHARS = saved;
  }
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
      const r = await withoutWindowMaxChars(() =>
        distillOnce(s, makeQuietLLM(), { storeKey: "test:self", verbose: false }));
      assert.equal(r.turns_processed, 2, "no trimming at the 60000-char default");
    } finally { cleanup(s, blobDir); }
  });
});
