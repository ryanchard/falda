/**
 * Unit tests for the Claude Code plugin's pool binding:
 *   - hooks/lib/settings.mjs  — the shared settings.json env writer
 *   - hooks/lib/pool.mjs      — listPools / resolvePool / writeProjectPool
 *   - hooks/pool.mjs          — the `/falda-memory:pool` CLI
 *
 * Everything runs against a fake /pools/mine server; no network.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeSettingsEnv } from "../integrations/claude-code/hooks/lib/settings.mjs";
import { listPools, resolvePool, writeProjectPool } from "../integrations/claude-code/hooks/lib/pool.mjs";

const CLI = fileURLToPath(new URL("../integrations/claude-code/hooks/pool.mjs", import.meta.url));

const ALPHA = "11111111-2222-3333-4444-555555555555";
const BETA = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const GAMMA = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "cc-pool-")); }

function listen(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }));
  });
}

/** A fake FALDA server whose /pools/mine returns `pools`, recording the last request. */
function poolsServer(pools: unknown[]) {
  const seen: { path?: string; method?: string; auth?: string; tenant?: string; body?: any } = {};
  return listen((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.path = req.url; seen.method = req.method;
      seen.auth = req.headers.authorization as string;
      seen.tenant = req.headers["x-falda-tenant"] as string;
      try { seen.body = JSON.parse(b || "{}"); } catch { seen.body = b; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ pools, groups_status: "ok" }));
    });
  }).then((s) => ({ ...s, seen }));
}

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("cc plugin: settings env writer", () => {
  test("adds keys, preserves the rest of the file, backs up, 0600", () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ env: { KEEP: "1" }, hooks: { x: 1 } }));
    const { backupPath } = writeSettingsEnv(settings, { FALDA_POOL: ALPHA });
    const doc = JSON.parse(fs.readFileSync(settings, "utf8"));
    assert.deepEqual(doc.env, { KEEP: "1", FALDA_POOL: ALPHA });
    assert.deepEqual(doc.hooks, { x: 1 });
    assert.ok(backupPath && fs.existsSync(backupPath), "backup written");
    assert.equal(fs.statSync(settings).mode & 0o777, 0o600);
    assert.equal(fs.statSync(backupPath!).mode & 0o777, 0o600);
  });

  test("a null value deletes just that key", () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ env: { KEEP: "1", FALDA_POOL: ALPHA } }));
    writeSettingsEnv(settings, { FALDA_POOL: null });
    const doc = JSON.parse(fs.readFileSync(settings, "utf8"));
    assert.deepEqual(doc.env, { KEEP: "1" });
  });

  test("creates the file when absent, with no backup", () => {
    const dir = tmp(); const settings = path.join(dir, "nested", "settings.json");
    const { backupPath } = writeSettingsEnv(settings, { FALDA_POOL: ALPHA });
    assert.equal(backupPath, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")).env, { FALDA_POOL: ALPHA });
    assert.equal(fs.statSync(settings).mode & 0o777, 0o600);
  });

  test("invalid JSON is refused with the path in the message, file untouched", () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, "{ not json");
    assert.throws(() => writeSettingsEnv(settings, { FALDA_POOL: ALPHA }), (err: any) => {
      assert.match(err.message, /not valid JSON/);
      assert.ok(err.message.includes(settings));
      return true;
    });
    assert.equal(fs.readFileSync(settings, "utf8"), "{ not json");
  });
});

describe("cc plugin: listPools", () => {
  test("POSTs an empty body to /pools/mine with the bearer and tenant, returns the pools", async () => {
    const s = await poolsServer([{ id: ALPHA, name: "Alpha", role: "member", kind: "group", access: "rw" }]);
    try {
      const pools = await listPools({ mcpUrl: `${s.url}/mcp`, token: "falda_k", tenant: "alice" });
      assert.equal(s.seen.path, "/pools/mine");
      assert.equal(s.seen.method, "POST");
      assert.equal(s.seen.auth, "Bearer falda_k");
      assert.equal(s.seen.tenant, "alice");
      assert.deepEqual(s.seen.body, {});
      assert.deepEqual(pools.map((p: any) => p.name), ["Alpha"]);
    } finally { s.close(); }
  });

  test("an error response throws with the status", async () => {
    const s = await listen((_req, res) => { res.statusCode = 401; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "invalid_key" })); });
    try {
      await assert.rejects(listPools({ mcpUrl: `${s.url}/mcp`, token: "bad", tenant: "alice" }), /401.*invalid_key/);
    } finally { s.close(); }
  });
});

describe("cc plugin: resolvePool", () => {
  const pools = [
    { id: ALPHA, name: "Alpha", role: "member", kind: "group" },
    { id: BETA, name: "beta team", role: "admin", kind: "group" },
    { id: GAMMA, name: "Beta Team", role: "member", kind: "group" },
  ];

  test("a UUID is accepted verbatim, lowercased, even when not listed", () => {
    assert.equal(resolvePool(ALPHA.toUpperCase(), pools).id, ALPHA);
    assert.equal(resolvePool(ALPHA, pools).name, "Alpha");
    const unlisted = "99999999-9999-9999-9999-999999999999";
    assert.equal(resolvePool(unlisted, pools).id, unlisted);
  });

  test("an exact, case-insensitively unique name resolves", () => {
    assert.equal(resolvePool("alpha", pools).id, ALPHA);
    assert.equal(resolvePool("  Alpha  ", pools).id, ALPHA);
  });

  test("an ambiguous name errors and lists every candidate", () => {
    assert.throws(() => resolvePool("beta team", pools), (err: any) => {
      assert.match(err.message, /matches 2/i);
      assert.ok(err.message.includes(BETA) && err.message.includes(GAMMA), "both UUIDs listed");
      return true;
    });
  });

  test("an unknown name errors without inventing a pool", () => {
    assert.throws(() => resolvePool("nope", pools), /no pool/i);
  });
});

describe("cc plugin: writeProjectPool", () => {
  test("sets and clears env.FALDA_POOL while keeping other keys", () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ env: { FALDA_TENANT: "alice" } }));
    writeProjectPool(settings, ALPHA);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")).env, { FALDA_TENANT: "alice", FALDA_POOL: ALPHA });
    writeProjectPool(settings, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")).env, { FALDA_TENANT: "alice" });
  });
});

describe("cc plugin: pool CLI", () => {
  test("no argument lists the pools as `name — uuid`", async () => {
    const s = await poolsServer([
      { id: ALPHA, name: "Alpha", role: "member", kind: "group", access: "rw" },
      { id: BETA, name: "beta team", role: "admin", kind: "group", access: "rw" },
    ]);
    try {
      const r = await runCli([], { FALDA_MCP_URL: `${s.url}/mcp`, FALDA_TOKEN: "falda_k", FALDA_TENANT: "alice" });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`Alpha — ${ALPHA}`));
      assert.match(r.stdout, new RegExp(`beta team — ${BETA}`));
      assert.ok(!r.stdout.includes("falda_k"), "never prints the key");
    } finally { s.close(); }
  });

  test("a name binds the project and names the group, not the key", async () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ env: { KEEP: "1" }, permissions: { allow: [] } }));
    const s = await poolsServer([{ id: ALPHA, name: "Alpha", role: "member", kind: "group", access: "rw" }]);
    try {
      const r = await runCli(["alpha", "--settings", settings], { FALDA_MCP_URL: `${s.url}/mcp`, FALDA_TOKEN: "falda_k", FALDA_TENANT: "alice" });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`Bound this project to Alpha \\(${ALPHA}\\)\\.`));
      assert.match(r.stdout, /new Claude Code session/);
      assert.ok(!r.stdout.includes("falda_k"));
      const doc = JSON.parse(fs.readFileSync(settings, "utf8"));
      assert.deepEqual(doc.env, { KEEP: "1", FALDA_POOL: ALPHA });
      assert.deepEqual(doc.permissions, { allow: [] });
      assert.ok(fs.readdirSync(dir).some((n) => n.includes(".bak-")), "backup written");
      assert.equal(fs.statSync(settings).mode & 0o777, 0o600);
    } finally { s.close(); }
  });

  test("--clear removes the key and keeps the others", async () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ env: { KEEP: "1", FALDA_POOL: ALPHA } }));
    const r = await runCli(["--clear", "--settings", settings], { FALDA_TOKEN: "falda_k", FALDA_TENANT: "alice" });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")).env, { KEEP: "1" });
  });

  test("an ambiguous name exits non-zero listing both candidates, writing nothing", async () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    const s = await poolsServer([
      { id: BETA, name: "beta team", role: "admin", kind: "group", access: "rw" },
      { id: GAMMA, name: "Beta Team", role: "member", kind: "group", access: "rw" },
    ]);
    try {
      const r = await runCli(["Beta Team", "--settings", settings], { FALDA_MCP_URL: `${s.url}/mcp`, FALDA_TOKEN: "falda_k", FALDA_TENANT: "alice" });
      assert.equal(r.code, 1);
      assert.ok(r.stderr.includes(BETA) && r.stderr.includes(GAMMA), r.stderr);
      assert.equal(fs.existsSync(settings), false, "nothing written on an ambiguous name");
    } finally { s.close(); }
  });

  test("without credentials it says so instead of calling the server", async () => {
    const r = await runCli([], { FALDA_TOKEN: "", FALDA_TENANT: "" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /login/i);
  });
});
