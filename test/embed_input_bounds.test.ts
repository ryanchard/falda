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
