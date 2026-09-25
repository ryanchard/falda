/**
 * Unit tests for integrations/claude-code/hooks/lib/login.mjs — the
 * two-step (start/finish) Globus PKCE login that writes FALDA credentials
 * into ~/.claude/settings.json.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
import { startLogin, finishLogin, apiBase, writeClaudeSettings } from "../integrations/claude-code/hooks/lib/login.mjs";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "cc-login-")); }
function listen(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() })); });
}

describe("cc plugin: login", () => {
  test("apiBase strips /mcp", () => {
    assert.equal(apiBase("https://falda.cairnscore.ai/mcp"), "https://falda.cairnscore.ai");
    assert.equal(apiBase("http://localhost:8077/mcp/"), "http://localhost:8077");
  });
  test("start writes the state file and returns a PKCE authorize URL", async () => {
    const dir = tmp();
    const { url } = await startLogin({ clientId: "cid", stateDir: dir, open: async () => false });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, "https://auth.globus.org/v2/oauth2/authorize");
    assert.equal(u.searchParams.get("client_id"), "cid"); assert.equal(u.searchParams.get("redirect_uri"), "https://auth.globus.org/v2/web/auth-code");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256"); assert.equal(u.searchParams.get("scope"), "openid profile email");
    const st = JSON.parse(fs.readFileSync(path.join(dir, "login.json"), "utf8"));
    assert.equal(st.state, u.searchParams.get("state")); assert.ok(st.verifier.length >= 43);
    assert.equal((fs.statSync(path.join(dir, "login.json")).mode & 0o777), 0o600);
  });
  test("finish exchanges the code with PKCE, logs in to FALDA, writes settings with a backup", async () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ env: { KEEP: "1" }, other: true }));
    let tokenReq: any = null, loginReq: any = null;
    const globus = await listen((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { tokenReq = Object.fromEntries(new URLSearchParams(b)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id_token: "ID.TOKEN.X", access_token: "a" })); }); });
    const falda = await listen((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { loginReq = { path: req.url, body: JSON.parse(b) }; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ api_key: "falda_abc", tenant: "alice" })); }); });
    try {
      await startLogin({ clientId: "cid", stateDir: dir, open: async () => false });
      const st = JSON.parse(fs.readFileSync(path.join(dir, "login.json"), "utf8"));
      const out = await finishLogin("CODE123", { url: `${falda.url}/mcp`, clientId: "cid", stateDir: dir, tokenUrl: globus.url, settingsPath: settings, label: "test" });
      assert.equal(tokenReq.grant_type, "authorization_code"); assert.equal(tokenReq.code, "CODE123"); assert.equal(tokenReq.code_verifier, st.verifier); assert.equal(tokenReq.client_id, "cid");
      assert.equal(loginReq.path, "/auth/login"); assert.equal(loginReq.body.id_token, "ID.TOKEN.X"); assert.equal(loginReq.body.label, "test");
      assert.equal(out.tenant, "alice"); assert.equal(out.api_key, "falda_abc");
      const written = JSON.parse(fs.readFileSync(settings, "utf8"));
      assert.deepEqual(written.env, { KEEP: "1", FALDA_MCP_URL: `${falda.url}/mcp`, FALDA_TOKEN: "falda_abc", FALDA_TENANT: "alice" }); assert.equal(written.other, true);
      assert.ok(fs.existsSync(out.backupPath!)); assert.equal((fs.statSync(settings).mode & 0o777), 0o600);
      assert.ok(!fs.existsSync(path.join(dir, "login.json")), "state file removed");
    } finally { globus.close(); falda.close(); }
  });
  test("finish without start, or with a stale state file, fails clearly; write:false writes nothing", async () => {
    const dir = tmp();
    await assert.rejects(finishLogin("C", { stateDir: dir, clientId: "cid" }), /run .*start/);
    await startLogin({ clientId: "cid", stateDir: dir, open: async () => false, now: () => Date.now() - 11 * 60_000 });
    await assert.rejects(finishLogin("C", { stateDir: dir, clientId: "cid" }), /expired/);
  });
  test("invalid JSON in the existing settings file fails before the code is spent: state file kept, no backup", async () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, "{ not json");
    await startLogin({ clientId: "cid", stateDir: dir, open: async () => false });
    await assert.rejects(
      finishLogin("CODE", { stateDir: dir, clientId: "cid", settingsPath: settings }),
      (err: any) => {
        assert.match(err.message, new RegExp(settings.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
    assert.ok(fs.existsSync(path.join(dir, "login.json")), "state file kept for a retry");
    const files = fs.readdirSync(dir);
    assert.ok(!files.some((n) => n.includes(".bak-")), "no backup written");
  });
  test("writeClaudeSettings rejects invalid JSON directly, with the path in the message", () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, "{ not json");
    assert.throws(
      () => writeClaudeSettings(settings, { url: "https://x/mcp", token: "t", tenant: "u" }),
      (err: any) => { assert.match(err.message, /not valid JSON/); assert.ok(err.message.includes(settings)); return true; },
    );
  });
  test("first run (no existing settings file) succeeds with no backup, file written 0600", async () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    const globus = await listen((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id_token: "ID.TOKEN.X" })); }); });
    const falda = await listen((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ api_key: "falda_new", tenant: "bob" })); }); });
    try {
      await startLogin({ clientId: "cid", stateDir: dir, open: async () => false });
      const out = await finishLogin("CODE", { url: `${falda.url}/mcp`, clientId: "cid", stateDir: dir, tokenUrl: globus.url, settingsPath: settings });
      assert.equal(out.backupPath, undefined);
      assert.ok(fs.existsSync(settings));
      assert.equal((fs.statSync(settings).mode & 0o777), 0o600);
      const written = JSON.parse(fs.readFileSync(settings, "utf8"));
      assert.equal(written.env.FALDA_TOKEN, "falda_new");
    } finally { globus.close(); falda.close(); }
  });
  test("a symlinked settings file is preserved: the symlink stays, the real target is written", async () => {
    const dir = tmp(); const real = path.join(dir, "real-settings.json"); const link = path.join(dir, "settings.json");
    fs.writeFileSync(real, JSON.stringify({ env: { KEEP: "1" } }));
    fs.symlinkSync(real, link);
    const globus = await listen((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id_token: "ID.TOKEN.X" })); }); });
    const falda = await listen((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ api_key: "falda_link", tenant: "carol" })); }); });
    try {
      await startLogin({ clientId: "cid", stateDir: dir, open: async () => false });
      await finishLogin("CODE", { url: `${falda.url}/mcp`, clientId: "cid", stateDir: dir, tokenUrl: globus.url, settingsPath: link });
      assert.ok(fs.lstatSync(link).isSymbolicLink(), "symlink preserved");
      assert.equal(fs.realpathSync(link), fs.realpathSync(real));
      const written = JSON.parse(fs.readFileSync(real, "utf8"));
      assert.deepEqual(written.env, { KEEP: "1", FALDA_MCP_URL: `${falda.url}/mcp`, FALDA_TOKEN: "falda_link", FALDA_TENANT: "carol" });
    } finally { globus.close(); falda.close(); }
  });
});

describe("cc plugin: login — atomic write cleanup", () => {
  test("a failed rename leaves no temp file behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-login-rn-"));
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ env: {} }));
    // Make the directory read-only so the rename onto the target fails.
    fs.chmodSync(dir, 0o500);
    try {
      assert.throws(() => writeClaudeSettings(settings, { url: "u", token: "falda_t", tenant: "x" }));
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  });
});
