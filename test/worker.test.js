import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalResource, handle, TOKEN_INFO } from "../src/worker.js";

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

test("a token issued for another resource is refused; one for this server or none is accepted", async () => {
  const api = platform({ tokens: { other: { resource: "https://evil.test/mcp", scopes: ["project:read"] }, mine: { resource: "HTTPS://Development.MCP.mdrn.io/mcp/", scopes: [] }, plain: { resource: null, scopes: [] } } });
  const refused = await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "other" }), env, api.fetcher);
  assert.equal(refused.status, 401);
  assert.match(refused.headers.get("www-authenticate"), /not issued for this server/);
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
  assert.ok(list.result.tools.some((tool) => tool.name === "mdrn_deploy_connected_repo"));
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
  const response = await handle(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mdrn_create_service", arguments: { projectId: "p", environmentId: "sandbox", name: "shop" } } }), env, api.fetcher);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /insufficient_scope: .*deploy:write/);
  assert.deepEqual(api.calls.map((c) => c.path), [TOKEN_INFO]);
});

test("a token revoked between the check and the call answers the 401 challenge, not a tool result", async () => {
  const api = platform({ tokens: { good }, routes: { "GET /v1/deploy/builds": [401, { error: { code: "UNAUTHENTICATED", message: "Token revoked" } }] } });
  const response = await handle(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mdrn_list_builds", arguments: { projectId: "p", environmentId: "sandbox", serviceId: "s" } } }), env, api.fetcher);
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

test("Platform unable to check the token is a 503, never a pass", async () => {
  const response = await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "down" }), env, platform({ tokens: { down: "down" } }).fetcher);
  assert.equal(response.status, 503);
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
    for (const binding of ["services", "d1_databases", "r2_buckets", "kv_namespaces", "queues"]) assert.equal(config[binding], undefined, binding);
  }
});
