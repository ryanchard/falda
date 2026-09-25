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
/** A server that is not there: startLogin must fall back to the id_token scopes. */
const offline: typeof fetch = async () => { throw new Error("connection refused"); };
function listen(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() })); });
}

describe("cc plugin: login", () => {
  test("apiBase strips /mcp", () => {
    assert.equal(apiBase("https://falda.cairnscore.ai/mcp"), "https://falda.cairnscore.ai");
    assert.equal(apiBase("http://localhost:8077/mcp/"), "http://localhost:8077");
  });
  test("start falls back to the id_token scopes when /auth/config is unreachable", async () => {
    const dir = tmp();
    const { url } = await startLogin({ clientId: "cid", stateDir: dir, open: async () => false, fetch: offline });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, "https://auth.globus.org/v2/oauth2/authorize");
    assert.equal(u.searchParams.get("client_id"), "cid"); assert.equal(u.searchParams.get("redirect_uri"), "https://auth.globus.org/v2/web/auth-code");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256"); assert.equal(u.searchParams.get("scope"), "openid profile email");
    assert.equal(u.searchParams.get("access_type"), "online");
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
      await startLogin({ clientId: "cid", stateDir: dir, open: async () => false, fetch: offline });
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
    await startLogin({ clientId: "cid", stateDir: dir, open: async () => false, fetch: offline, now: () => Date.now() - 11 * 60_000 });
    await assert.rejects(finishLogin("C", { stateDir: dir, clientId: "cid" }), /expired/);
  });
  test("invalid JSON in the existing settings file fails before the code is spent: state file kept, no backup", async () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, "{ not json");
    await startLogin({ clientId: "cid", stateDir: dir, open: async () => false, fetch: offline });
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
      await startLogin({ clientId: "cid", stateDir: dir, open: async () => false, fetch: offline });
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
      await startLogin({ clientId: "cid", stateDir: dir, open: async () => false, fetch: offline });
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

describe("cc plugin: login — service scope from /auth/config", () => {
  const SCOPE = "https://auth.globus.org/scopes/ce244ab8-7c9d-48a4-aa55-fe82d615afd6/falda_all";

  test("start asks the server for the scope and requests it FIRST, offline", async () => {
    const dir = tmp();
    let configReq: any = null;
    const falda = await listen((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { configReq = { path: req.url, method: req.method, body: JSON.parse(b || "{}") }; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ login_client_id: "server-cid", service_scope: SCOPE })); }); });
    try {
      const { url } = await startLogin({ stateDir: dir, open: async () => false, url: `${falda.url}/mcp` });
      assert.equal(configReq.path, "/auth/config"); assert.equal(configReq.method, "POST"); assert.deepEqual(configReq.body, {});
      const u = new URL(url);
      // FALDA's scope must come first: Globus returns the top-level
      // access_token for the FIRST requested resource server.
      assert.equal(u.searchParams.get("scope"), `${SCOPE} openid profile email`);
      assert.equal(u.searchParams.get("access_type"), "offline");
      // With no --client-id and no env override, the server names the client.
      assert.equal(u.searchParams.get("client_id"), "server-cid");
      const st = JSON.parse(fs.readFileSync(path.join(dir, "login.json"), "utf8"));
      assert.equal(st.service_scope, SCOPE);
    } finally { falda.close(); }
  });

  test("a null service_scope keeps today's id_token scopes", async () => {
    const dir = tmp();
    const falda = await listen((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ login_client_id: "server-cid", service_scope: null })); });
    try {
      const { url } = await startLogin({ clientId: "cid", stateDir: dir, open: async () => false, url: `${falda.url}/mcp` });
      const u = new URL(url);
      assert.equal(u.searchParams.get("scope"), "openid profile email");
      assert.equal(u.searchParams.get("access_type"), "online");
      assert.equal(u.searchParams.get("client_id"), "cid", "an explicit client id still wins");
      const st = JSON.parse(fs.readFileSync(path.join(dir, "login.json"), "utf8"));
      assert.equal(st.service_scope, undefined);
    } finally { falda.close(); }
  });

  test("an explicit scope overrides the server's", async () => {
    const dir = tmp();
    const falda = await listen((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ login_client_id: "server-cid", service_scope: SCOPE })); });
    try {
      const { url } = await startLogin({ clientId: "cid", scope: "other_scope", stateDir: dir, open: async () => false, url: `${falda.url}/mcp` });
      assert.equal(new URL(url).searchParams.get("scope"), "other_scope openid profile email");
    } finally { falda.close(); }
  });

  test("finish posts the access_token (not the id_token) and returns the groups", async () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    let loginReq: any = null;
    const globus = await listen((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ access_token: "AT.FALDA", id_token: "ID.TOKEN.X", refresh_token: "RT" })); });
    const falda = await listen((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/auth/config") { res.end(JSON.stringify({ login_client_id: "cid", service_scope: SCOPE })); return; }
        loginReq = { path: req.url, body: JSON.parse(b) };
        res.end(JSON.stringify({ api_key: "falda_abc", tenant: "alice", user: "u1", created: true, groups: [{ id: "g1", name: "Argo Team", role: "admin" }], groups_status: "ok" }));
      });
    });
    try {
      await startLogin({ clientId: "cid", stateDir: dir, open: async () => false, url: `${falda.url}/mcp` });
      const out = await finishLogin("CODE", { url: `${falda.url}/mcp`, clientId: "cid", stateDir: dir, tokenUrl: globus.url, settingsPath: settings });
      assert.equal(loginReq.path, "/auth/login");
      assert.equal(loginReq.body.access_token, "AT.FALDA");
      assert.equal(loginReq.body.id_token, undefined, "the id_token path is not used when a scope was requested");
      assert.deepEqual(out.groups, [{ id: "g1", name: "Argo Team", role: "admin" }]);
      assert.equal(out.groups_status, "ok");
    } finally { globus.close(); falda.close(); }
  });

  test("a scoped login whose token response has no access_token falls back to the id_token", async () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    let loginReq: any = null;
    const globus = await listen((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id_token: "ID.ONLY" })); });
    const falda = await listen((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/auth/config") { res.end(JSON.stringify({ login_client_id: "cid", service_scope: SCOPE })); return; }
        loginReq = { body: JSON.parse(b) };
        res.end(JSON.stringify({ api_key: "falda_abc", tenant: "alice" }));
      });
    });
    try {
      await startLogin({ clientId: "cid", stateDir: dir, open: async () => false, url: `${falda.url}/mcp` });
      await finishLogin("CODE", { url: `${falda.url}/mcp`, clientId: "cid", stateDir: dir, tokenUrl: globus.url, settingsPath: settings });
      assert.equal(loginReq.body.id_token, "ID.ONLY");
      assert.equal(loginReq.body.access_token, undefined);
    } finally { globus.close(); falda.close(); }
  });

  test("a token response with neither token is rejected before FALDA is called", async () => {
    const dir = tmp(); const settings = path.join(dir, "settings.json");
    const globus = await listen((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "invalid_grant", error_description: "code expired" })); });
    try {
      await startLogin({ clientId: "cid", stateDir: dir, open: async () => false, fetch: offline });
      await assert.rejects(
        finishLogin("CODE", { url: "http://127.0.0.1:1/mcp", clientId: "cid", stateDir: dir, tokenUrl: globus.url, settingsPath: settings }),
        /code expired/,
      );
    } finally { globus.close(); }
  });
});
