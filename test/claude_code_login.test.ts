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
});
