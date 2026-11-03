import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalResource, handle, TOKEN_INFO } from "../src/worker.js";
import { ALERT_PATH, resetAlertState, sign, THRESHOLD, tokenCheckAnswered, tokenCheckFailed } from "../src/alert.js";

const env = { STAGE: "development", MCP_RESOURCE: "https://development.mcp.mdrn.io/mcp", API_ORIGIN: "https://development.api.mdrn.io" };
const MCP = "https://development.mcp.mdrn.io/mcp";
const METADATA = "https://development.mcp.mdrn.io/.well-known/oauth-protected-resource/mcp";

// A fake Platform: token-info answers per token, and every other call is recorded and answered
// from `routes` ("METHOD /path" -> [status, body]).
function platform({ tokens = {}, routes = {} } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const { origin, pathname } = new URL(url);
    assert.equal(origin, env.API_ORIGIN, "only ever the stage's own API");
    // The Workers runtime throws on redirect "error" before sending anything (every check failed so).
    assert.notEqual(init.redirect, "error");
    const token = /^Bearer (.+)$/.exec(new Headers(init.headers).get("authorization"))?.[1];
    calls.push({ method: init.method, path: pathname, token });
    if (pathname === TOKEN_INFO) {
      const info = tokens[token];
      if (info === "down") return new Response("upstream", { status: 502 });
      return info ? Response.json(info) : Response.json({ error: { code: "UNAUTHENTICATED", message: "x" } }, { status: 401 });
    }
    const [status, body] = routes[`${init.method} ${pathname}`] ?? [404, { error: { code: "NOT_FOUND", message: "Not found" } }];
    return Response.json(body, { status });
  };
  return { calls, fetcher };
}
const good = { resource: MCP, scopes: ["project:read", "deploy:read"] };
const post = (message, { token = "good", headers = {} } = {}) =>
  new Request(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof message === "string" ? message : JSON.stringify(message),
  });

test("protected resource metadata names this server and the stage's Platform", async () => {
  for (const url of [METADATA, "https://development.mcp.mdrn.io/.well-known/oauth-protected-resource"]) {
    const response = await handle(new Request(url), env, platform().fetcher);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.resource, MCP);
    assert.deepEqual(body.authorization_servers, ["https://development.api.mdrn.io"]);
    assert.ok(body.scopes_supported.includes("deploy:write"));
    assert.deepEqual(body.bearer_methods_supported, ["header"]);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  }
});

test("a request without a bearer gets the 401 challenge pointing at the metadata, before Platform is asked", async () => {
  const api = platform();
  const response = await handle(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: null }), env, api.fetcher);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), `Bearer resource_metadata="${METADATA}"`);
  assert.equal(api.calls.length, 0);
});

test("an unknown, expired or revoked token gets 401 invalid_token and no tool runs", async () => {
  const api = platform({ tokens: {} });
  const response = await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mdrn_list_projects", arguments: { workspaceId: "w" } } }, { token: "revoked" }), env, api.fetcher);
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /^Bearer resource_metadata="[^"]+", error="invalid_token"/);
  assert.deepEqual(api.calls.map((c) => c.path), [TOKEN_INFO]);
});

test("an OAuth token is accepted only for this server; a console management token (no grant, no resource) too", async () => {
  const api = platform({
    tokens: {
      other: { resource: "https://evil.test/mcp", scopes: ["project:read"], grantId: "oag_1" },
      mine: { resource: "HTTPS://Development.MCP.mdrn.io/mcp/", scopes: [], grantId: "oag_2" },
      plain: { resource: null, scopes: [], grantId: null },
      // The CLI from 0.4 names MDRN's API; a CLI before it, or another client, named nothing.
      cli: { resource: "https://development.api.mdrn.io", scopes: ["project:read"], grantId: "oag_3" },
      unnamed: { resource: null, scopes: ["project:read"], grantId: "oag_4" },
    },
  });
  for (const token of ["other", "cli", "unnamed"]) {
    const refused = await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }), env, api.fetcher);
    assert.equal(refused.status, 401, token);
    assert.match(refused.headers.get("www-authenticate"), /not issued for this server/);
  }
  for (const token of ["mine", "plain"]) assert.equal((await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }), env, api.fetcher)).status, 200, token);
});

test("initialize, tools/list and a tool call answer JSON, forwarding the caller's own bearer", async () => {
  const api = platform({ tokens: { good }, routes: { "GET /v1/platform/projects": [200, { items: [{ id: "prj_1" }] }] } });
  const init = await handle(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { headers: { "MCP-Protocol-Version": "" } }), env, api.fetcher);
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("content-type"), "application/json");
  const initialized = await init.json();
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  // The hosted server reports the package's version, bundled from package.json.
  assert.equal(initialized.result.serverInfo.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  const list = await (await handle(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env, api.fetcher)).json();
  assert.ok(list.result.tools.some((tool) => tool.name === "mdrn_deploy_from_github"));
  const called = await (await handle(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mdrn_list_projects", arguments: { workspaceId: "w" } } }), env, api.fetcher)).json();
  assert.equal(called.id, 3);
  assert.equal(called.result.isError, false);
  assert.match(called.result.content[0].text, /prj_1/);
  assert.doesNotMatch(called.result.content[0].text, /good/);
  const forwarded = api.calls.filter((c) => c.path !== TOKEN_INFO);
  assert.deepEqual(forwarded, [{ method: "GET", path: "/v1/platform/projects", token: "good" }]);
});

test("a write outside the token's scopes is a tool error and reaches nothing", async () => {
  const api = platform({ tokens: { good } });
  const response = await handle(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mdrn_create_deployment", arguments: { projectId: "p", environmentId: "sandbox", name: "shop" } } }), env, api.fetcher);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /insufficient_scope: .*deploy:write/);
  assert.deepEqual(api.calls.map((c) => c.path), [TOKEN_INFO]);
});

test("a token revoked between the check and the call answers the 401 challenge, not a tool result", async () => {
  const api = platform({ tokens: { good }, routes: { "GET /v1/deploy/builds": [401, { error: { code: "UNAUTHENTICATED", message: "Token revoked" } }] } });
  const response = await handle(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mdrn_list_builds", arguments: { projectId: "p", environmentId: "sandbox", deploymentId: "s" } } }), env, api.fetcher);
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /error="invalid_token"/);
});

test("notifications and client responses are accepted with 202 and no body", async () => {
  const api = platform({ tokens: { good } });
  for (const message of [{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 9, result: {} }]) {
    const response = await handle(post(message), env, api.fetcher);
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  }
});

test("the transport refuses what streamable HTTP and this stateless server do not take", async () => {
  const api = platform({ tokens: { good } });
  const status = async (request) => (await handle(request, env, api.fetcher)).status;
  assert.equal(await status(new Request(MCP, { headers: { Accept: "text/event-stream", Authorization: "Bearer good" } })), 405, "no SSE stream");
  assert.equal(await status(new Request(MCP, { method: "DELETE", headers: { Authorization: "Bearer good" } })), 405, "no session");
  assert.equal(await status(post([{ jsonrpc: "2.0", id: 1, method: "ping" }])), 400, "no batches");
  assert.equal(await status(post("{not json")), 400);
  assert.equal(await status(post({ id: 1, method: "ping" })), 400, "jsonrpc 2.0 only");
  assert.equal(await status(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "MCP-Protocol-Version": "1999-01-01" } })), 400);
  assert.equal(await status(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { Origin: "https://evil.test" } })), 403, "a foreign browser origin");
  assert.equal(await status(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "Content-Type": "text/plain" } })), 415);
  assert.equal(await status(post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(1024 * 1024) }))), 413);
  assert.equal(await status(new Request("https://development.mcp.mdrn.io/other")), 404);
  assert.equal(await status(post({ jsonrpc: "2.0", id: 1, method: "ping" })), 200);
});

test("each client address has a budget, spent before Platform is asked; a limiter that fails lets the request on", async () => {
  const api = platform({ tokens: { good } });
  const keys = [];
  let left = 1;
  const MCP_LIMITER = { limit: async ({ key }) => { keys.push(key); return { success: left-- > 0 }; } };
  const send = (limited) => handle(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: "made-up", headers: { "CF-Connecting-IP": "203.0.113.9" } }), { ...env, MCP_LIMITER: limited }, api.fetcher);
  assert.equal((await send(MCP_LIMITER)).status, 401, "within the budget the token is checked");
  const over = await send(MCP_LIMITER);
  assert.equal(over.status, 429);
  assert.equal(over.headers.get("retry-after"), "60");
  assert.deepEqual(keys, ["203.0.113.9", "203.0.113.9"]);
  assert.equal(api.calls.filter((c) => c.path === TOKEN_INFO).length, 1, "over the budget Platform is not asked");
  assert.equal((await send({ limit: async () => { throw new Error("down"); } })).status, 401);
});

test("a body with no length is read only until it passes 1 MiB", async () => {
  const api = platform({ tokens: { good } });
  let pulled = 0;
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  const body = new ReadableStream({ pull(controller) { pulled += 1; if (pulled > 1000) controller.close(); else controller.enqueue(chunk); } });
  const request = new Request(MCP, { method: "POST", body, duplex: "half", headers: { "Content-Type": "application/json", Authorization: "Bearer good" } });
  assert.equal((await handle(request, env, api.fetcher)).status, 413);
  assert.ok(pulled <= 18, `stopped after ${pulled} chunks`);
  assert.equal(api.calls.length, 0, "Platform was never asked");
});

test("Platform unable to check the token is a 503, never a pass", async () => {
  resetAlertState();
  const response = await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "down" }), env, platform({ tokens: { down: "down" } }).fetcher);
  assert.equal(response.status, 503);
});

test("503 means only a real 5xx, timeout or network fault; any other failed check is our fault (500), and neither is a pass", async () => {
  resetAlertState();
  const answer = (respond) => handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), env, async () => respond());
  assert.equal((await answer(() => { throw new TypeError("fetch failed"); })).status, 503, "network");
  assert.equal((await answer(() => new Response("bad gateway", { status: 502 }))).status, 503, "5xx");
  // Cloudflare refusing a fetch to our own zone (error 1042) is no 401/403 and no 5xx.
  assert.equal((await answer(() => new Response("error code: 1042", { status: 404 }))).status, 500, "1042");
  assert.equal((await answer(() => new Response("<html>", { status: 200 }))).status, 500, "unreadable body");
  assert.equal((await answer(() => Response.json({ scopes: "all" }))).status, 500, "unsound body");
  assert.equal((await answer(() => Response.json({ error: "x" }, { status: 401 }))).status, 401, "a refused token stays a 401");
});

test("with the PLATFORM binding the token is checked over it, never through the public API; an unknown token is the 401 challenge", async () => {
  resetAlertState();
  const checks = [];
  const PLATFORM = {
    fetch: async (url, init) => {
      assert.notEqual(init.redirect, "error");
      const token = /^Bearer (.+)$/.exec(new Headers(init.headers).get("authorization"))?.[1];
      checks.push({ url, token });
      return token === "good" ? Response.json(good) : Response.json({ error: { code: "UNAUTHENTICATED", message: "x" } }, { status: 401 });
    },
  };
  const api = platform({ routes: { "GET /v1/platform/projects": [200, { items: [] }] } });
  const bound = { ...env, PLATFORM };
  const bogus = await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "bogus" }), bound, api.fetcher);
  assert.equal(bogus.status, 401);
  assert.match(bogus.headers.get("www-authenticate"), /^Bearer resource_metadata="[^"]+", error="invalid_token"/);
  const ok = await handle(post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mdrn_list_projects", arguments: { workspaceId: "w" } } }), bound, api.fetcher);
  assert.equal(ok.status, 200);
  assert.deepEqual(checks.map((c) => [new URL(c.url).pathname, c.token]), [[TOKEN_INFO, "bogus"], [TOKEN_INFO, "good"]]);
  assert.ok(checks.every((c) => new URL(c.url).origin !== env.API_ORIGIN));
  // The tools still call the public API with the caller's bearer; the check never does.
  assert.ok(api.calls.length > 0 && api.calls.every((c) => c.path !== TOKEN_INFO && c.token === "good"));
});

test("a fetch that throws is logged by its error's name, never its text", async () => {
  resetAlertState();
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(JSON.parse(line));
  try {
    const thrown = await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), env, async () => { throw new TypeError("Invalid redirect value <runtime text>"); });
    assert.equal(thrown.status, 503);
  } finally {
    console.error = original;
  }
  assert.equal(lines[0].cause, "network_TypeError");
  assert.doesNotMatch(JSON.stringify(lines), /runtime text/);
});

test("each failed check is logged with our own cause; failures that keep coming raise one signed Alert over PLATFORM", async () => {
  resetAlertState();
  const sent = [];
  const key = "a".repeat(43);
  // The token check and the Alert share the binding: the check is refused, the Alert is taken.
  const PLATFORM = {
    fetch: async (url, init) => {
      if (new URL(url).pathname === TOKEN_INFO) return new Response("error code: 1042 <secret provider text>", { status: 404 });
      sent.push({ url, init });
      return new Response(null, { status: 204 });
    },
  };
  const alerting = { ...env, MCP_ALERT_KEY: key, PLATFORM };
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(JSON.parse(line));
  try {
    const refused = async () => assert.fail("the check goes over the binding, never the public API");
    for (let i = 0; i < THRESHOLD - 1; i += 1) await handle(post({ jsonrpc: "2.0", id: i, method: "tools/list" }), alerting, refused);
    assert.equal(sent.length, 0, "not on a single failure");
    await handle(post({ jsonrpc: "2.0", id: 9, method: "tools/list" }), alerting, refused);
    assert.equal(sent.length, 1);
    await handle(post({ jsonrpc: "2.0", id: 10, method: "tools/list" }), alerting, refused);
    assert.equal(sent.length, 1, "once, then quiet");
  } finally {
    console.error = original;
  }
  assert.ok(lines.filter((line) => line.event === "mcp_token_check_failed").every((line) => line.cause === "status_404"));
  assert.doesNotMatch(JSON.stringify(lines), /secret provider text/);
  const [{ url, init }] = sent;
  assert.equal(new URL(url).pathname, ALERT_PATH);
  const alert = JSON.parse(init.body);
  assert.equal(alert.component, "mcp");
  assert.equal(alert.kind, "token_check_failing");
  assert.equal(alert.key, "development");
  assert.equal(init.headers["X-MDRN-Operator-Alert"], await sign(key, init.body));
  assert.doesNotMatch(init.body, /secret provider text/);
});

test("a check that passes ends the run of failures; without a key the Alert is one unsent line", async () => {
  resetAlertState();
  const lines = [];
  const log = (line) => lines.push(JSON.parse(line));
  for (let i = 0; i < THRESHOLD - 1; i += 1) await tokenCheckFailed(env, "network", { log });
  tokenCheckAnswered();
  assert.equal(await tokenCheckFailed(env, "network", { log }), false);
  for (let i = 0; i < THRESHOLD - 1; i += 1) await tokenCheckFailed(env, "network", { log });
  assert.ok(lines.some((line) => line.event === "operator_alert_unsent" && line.reason === "no key shared with Platform"));
});

test("the Alert is signed exactly as Platform verifies it (shared/operator_alert.rs holds the same vector)", async () => {
  assert.equal(await sign("k".repeat(40), '{"a":1}'), "9493cc27bc5916bd8b33d02710f5f2d6f9b0d8727ede9e78fad662a49f2c7246");
});

test("a misconfigured stage refuses everything rather than trusting a default", async () => {
  for (const bad of [{ ...env, MCP_RESOURCE: undefined }, { ...env, API_ORIGIN: "http://api.mdrn.io" }, { ...env, MCP_RESOURCE: "http://mcp.mdrn.io/mcp" }]) {
    assert.equal((await handle(post({ jsonrpc: "2.0", id: 1, method: "ping" }), bad, platform().fetcher)).status, 500);
  }
});

test("canonical resources compare case-insensitively in scheme and host, never in path", () => {
  assert.equal(canonicalResource("HTTPS://MCP.mdrn.io/mcp/"), "https://mcp.mdrn.io/mcp");
  assert.notEqual(canonicalResource("https://mcp.mdrn.io/MCP"), "https://mcp.mdrn.io/mcp");
  assert.equal(canonicalResource("https://mcp.mdrn.io/mcp#x"), null);
  assert.equal(canonicalResource("mcp.mdrn.io"), null);
});

test("each stage's Wrangler config serves its own MCP URL with its own Platform, and holds no secret", () => {
  const read = (stage) => JSON.parse(readFileSync(new URL(`../wrangler.${stage}.jsonc`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  for (const [stage, host, api] of [["development", "development.mcp.mdrn.io", "https://development.api.mdrn.io"], ["production", "mcp.mdrn.io", "https://api.mdrn.io"]]) {
    const config = read(stage);
    assert.equal(config.name, `mdrn-mcp-${stage}`);
    assert.equal(config.main, "src/worker.js");
    assert.equal(config.vars.MCP_RESOURCE, `https://${host}/mcp`);
    assert.equal(config.vars.API_ORIGIN, api);
    assert.deepEqual(config.routes.map((route) => route.pattern).sort(), [host, `${host}/*`]);
    // Cloudflare refuses a Worker's fetch to another Worker of our account (error 1042) without it.
    assert.ok(config.compatibility_flags.includes("global_fetch_strictly_public"));
    // One binding, to the stage's own Platform: the token check and the Alert.
    assert.deepEqual(config.services, [{ binding: "PLATFORM", service: `mdrn-platform-${stage}` }]);
    assert.equal(config.observability.logs.invocation_logs, false, "the Worker's own failure lines only, never a record per request");
    assert.deepEqual(config.ratelimits.map((limit) => [limit.name, limit.simple]), [["MCP_LIMITER", { limit: 300, period: 60 }]]);
    for (const binding of ["d1_databases", "r2_buckets", "kv_namespaces", "queues"]) assert.equal(config[binding], undefined, binding);
  }
});
