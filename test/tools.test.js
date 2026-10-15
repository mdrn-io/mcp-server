import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MdrnMcpServer, SCOPES_SUPPORTED } from "../src/server.js";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// A fake MDRN API: records each request and answers from `routes` ("METHOD /path" -> body or
// [status, body]); anything else is a 404.
function fakeApi(routes = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const { pathname, search } = new URL(url);
    const call = { method: init.method, path: pathname + search, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const answer = routes[`${init.method} ${pathname}`];
    if (answer === undefined) return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    const [status, body] = Array.isArray(answer) ? answer : [200, answer];
    return Response.json(body, { status });
  };
  return { calls, fetcher };
}
const call = (server, name, args) => server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const env = { projectId: "prj_1", environmentId: "sandbox" };

const reads = [
  ["mdrn_list_builds", { ...env, serviceId: "svc_1" }, "GET /v1/deploy/builds", "/v1/deploy/builds?serviceId=svc_1"],
  ["mdrn_list_builds", { ...env, serviceId: "svc_1", cursor: "c 2" }, "GET /v1/deploy/builds", "/v1/deploy/builds?serviceId=svc_1&cursor=c+2"],
  ["mdrn_get_build", { ...env, buildId: "bld_1" }, "GET /v1/deploy/builds/bld_1", "/v1/deploy/builds/bld_1"],
  ["mdrn_get_build_logs", { ...env, buildId: "bld_1", cursor: "7" }, "GET /v1/deploy/builds/bld_1/logs", "/v1/deploy/builds/bld_1/logs?cursor=7"],
  ["mdrn_list_releases", { ...env, serviceId: "svc_1" }, "GET /v1/deploy/releases", "/v1/deploy/releases?serviceId=svc_1"],
  ["mdrn_list_deployments", { ...env, serviceId: "svc_1" }, "GET /v1/deploy/deployments", "/v1/deploy/deployments?serviceId=svc_1"],
  ["mdrn_search_logs", { ...env, q: "timeout", level: "warn,error", from: 1, to: 2, service: "svc_1" }, "GET /v1/deploy/logs", "/v1/deploy/logs?from=1&to=2&q=timeout&level=warn%2Cerror&service=svc_1"],
  ["mdrn_get_logs_trace", { ...env, traceId: "4bf92f3577b34da6a3ce929d0e0e4736", from: 1, to: 2 }, "GET /v1/deploy/logs/trace/4bf92f3577b34da6a3ce929d0e0e4736", "/v1/deploy/logs/trace/4bf92f3577b34da6a3ce929d0e0e4736?from=1&to=2"],
  ["mdrn_get_logs_trace", { ...env, traceId: "tr_1" }, "GET /v1/deploy/logs/trace/tr_1", "/v1/deploy/logs/trace/tr_1"],
];
for (const [name, args, route, path] of reads) {
  test(`${name} reads ${path} scoped to the project environment`, async () => {
    const api = fakeApi({ [route]: { items: [] } });
    const result = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher }), name, args);
    assert.equal(result.result.isError, false, result.result.content[0].text);
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].method, "GET");
    assert.equal(api.calls[0].path, path);
    assert.equal(api.calls[0].headers.get("mdrn-project"), "prj_1");
    assert.equal(api.calls[0].headers.get("mdrn-environment"), "sandbox");
    assert.equal(api.calls[0].headers.get("idempotency-key"), null);
  });
}

const writes = [
  ["mdrn_rollback", { ...env, serviceId: "svc_1", artifactId: "art_1" }, "POST /v1/deploy/deployments", { serviceId: "svc_1", artifactId: "art_1" }],
  ["mdrn_enable_product", { ...env, product: "database", engine: "postgres" }, "POST /v1/platform/projects/prj_1/environments/sandbox/products/database/enable", { engine: "postgres" }],
  ["mdrn_enable_product", { ...env, product: "storage" }, "POST /v1/platform/projects/prj_1/environments/sandbox/products/storage/enable", {}],
  ["mdrn_disable_product", { ...env, product: "logs" }, "POST /v1/platform/projects/prj_1/environments/sandbox/products/logs/disable", {}],
  ["mdrn_set_variable", { ...env, serviceId: "svc_1", name: "API_URL", value: "https://x.test", secret: false }, "PUT /v1/deploy/services/svc_1/variables/API_URL", { value: "https://x.test", secret: false }],
  ["mdrn_unset_variable", { ...env, serviceId: "svc_1", name: "API_URL" }, "DELETE /v1/deploy/services/svc_1/variables/API_URL", undefined],
  ["mdrn_create_service", { ...env, name: "shop" }, "POST /v1/deploy/services", { name: "shop" }],
];
for (const [name, args, route, body] of writes) {
  test(`${name} sends ${route} once, with an Idempotency-Key`, async () => {
    const api = fakeApi({ [route]: { ok: true } });
    const server = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher });
    const result = await call(server, name, args);
    assert.equal(result.result.isError, false, result.result.content[0].text);
    assert.equal(api.calls.length, 1);
    assert.equal(`${api.calls[0].method} ${api.calls[0].path}`, route);
    assert.deepEqual(api.calls[0].body, body);
    const derived = api.calls[0].headers.get("idempotency-key");
    assert.match(derived, /^[!-~]{1,128}$/);
    // Each call derives its own key; a key the caller gives is sent as given.
    await call(server, name, args);
    assert.notEqual(api.calls[1].headers.get("idempotency-key"), derived);
    await call(server, name, { ...args, idempotencyKey: "retry-1" });
    assert.equal(api.calls[2].headers.get("idempotency-key"), "retry-1");
  });
}

test("deploying a connected repository connects it again as it is, which builds the branch head", async () => {
  const connection = { installationId: "11", repositoryId: "22", repository: "acme/shop", branch: "main", autoDeploy: true };
  const api = fakeApi({ "GET /v1/deploy/services/svc_1/github": connection, "PUT /v1/deploy/services/svc_1/github": { serviceId: "svc_1", branch: "main" } });
  const result = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher }), "mdrn_deploy_connected_repo", { ...env, serviceId: "svc_1" });
  assert.equal(result.result.isError, false, result.result.content[0].text);
  assert.deepEqual(api.calls.map((c) => c.method), ["GET", "PUT"]);
  assert.deepEqual(api.calls[1].body, { installationId: "11", repositoryId: "22", branch: "main", autoDeploy: true });
  assert.ok(api.calls[1].headers.get("idempotency-key"));
  assert.match(result.result.content[0].text, /mdrn_list_builds/);
});

test("deploying a service with no connected repository, or one set to manual, changes nothing", async () => {
  for (const [answer, said] of [[null, /NOT_CONNECTED/], [{ installationId: "1", repositoryId: "2", branch: "main", autoDeploy: false }, /MANUAL/]]) {
    const api = fakeApi({ "GET /v1/deploy/services/svc_1/github": answer });
    const result = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher }), "mdrn_deploy_connected_repo", { ...env, serviceId: "svc_1" });
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, said);
    assert.deepEqual(api.calls.map((c) => c.method), ["GET"]);
  }
});

test("a write the token's scopes do not cover is refused before any request", async () => {
  const api = fakeApi();
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["deploy:read", "project:read"] });
  for (const [name, args, scope] of [
    ["mdrn_list_workspaces", {}, "workspace:read"],
    ["mdrn_rollback", { ...env, serviceId: "s", artifactId: "a" }, "deploy:write"],
    ["mdrn_enable_product", { ...env, product: "mail" }, "mail:write"],
    ["mdrn_create_service", { ...env, name: "x" }, "deploy:write"],
  ]) {
    const result = await call(server, name, args);
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, new RegExp(`insufficient_scope: .*${scope}`));
  }
  assert.equal(api.calls.length, 0);
});

test("the API's own refusal of a write comes back as a tool error", async () => {
  const api = fakeApi({ "POST /v1/deploy/services": [403, { error: { code: "FORBIDDEN", message: "Developers and Admins create services" } }] });
  const result = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["deploy:write"] }), "mdrn_create_service", { ...env, name: "x" });
  assert.equal(result.result.isError, true);
  assert.equal(result.result.content[0].text, "FORBIDDEN: Developers and Admins create services");
});

test("arguments are checked before any request", async () => {
  const api = fakeApi();
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher });
  for (const [name, args] of [
    ["mdrn_enable_product", { ...env, product: "billing" }],
    ["mdrn_enable_product", { ...env, product: "mail", engine: "postgres" }],
    ["mdrn_set_variable", { ...env, serviceId: "s", name: "BAD NAME", value: "v" }],
    ["mdrn_set_variable", { ...env, serviceId: "s", name: "A", value: "v", secret: "yes" }],
    ["mdrn_set_variable", { ...env, serviceId: "s", name: "A" }],
    ["mdrn_search_logs", { ...env, level: "fatal" }],
    ["mdrn_search_logs", { ...env, from: 1.5 }],
    ["mdrn_create_service", { ...env, name: "-x" }],
    ["mdrn_rollback", { ...env, serviceId: "s", artifactId: "a", idempotencyKey: "has space" }],
    ["mdrn_rollback", { ...env, serviceId: "s", artifactId: "a", force: true }],
    ["mdrn_list_builds", { ...env, serviceId: "s", environmentId: "development" }],
    // A trace id is one path segment of the allowlisted route: letters, digits, _ and - only.
    ["mdrn_get_logs_trace", { ...env, traceId: "tr 1" }],
    ["mdrn_get_logs_trace", { ...env, traceId: "a/b" }],
    ["mdrn_get_logs_trace", { ...env, traceId: "t", from: -1 }],
  ]) {
    const result = await call(server, name, args);
    assert.equal(result.result.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(api.calls.length, 0);
});

test("writes are annotated as changes that are not destructive, and nothing deletes a service, product or domain", async () => {
  const { result } = await new MdrnMcpServer({ token: "tok_secret" }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const tool of result.tools) {
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    if (!tool.annotations.readOnlyHint) assert.ok("idempotencyKey" in tool.inputSchema.properties, tool.name);
    assert.doesNotMatch(tool.name, /delete|remove/);
  }
  assert.ok(SCOPES_SUPPORTED.includes("deploy:write"));
  for (const excluded of ["billing:write", "team:write", "workspace:write", "project:delete"]) assert.ok(!SCOPES_SUPPORTED.includes(excluded));
});

test("a token getter is asked per call; a bearer the API refuses is renewed once and the call sent again only with a new one", async () => {
  const asked = [];
  const valid = new Set(["tok_one"]);
  const sent = [];
  const fetcher = async (url, init) => {
    const bearer = init.headers.get("authorization").slice("Bearer ".length);
    sent.push(bearer);
    return valid.has(bearer) ? Response.json({ items: [{ id: "prj_1", echo: bearer }] }) : Response.json({ error: { code: "UNAUTHENTICATED", message: `refused ${bearer}` } }, { status: 401 });
  };
  let current = "tok_one";
  const token = { get: async () => { asked.push("get"); return current; }, refresh: async () => { asked.push("refresh"); return current; } };
  const server = new MdrnMcpServer({ token, fetcher });
  const first = await call(server, "mdrn_list_projects", { workspaceId: "w" });
  assert.equal(first.result.isError, false, first.result.content[0].text);
  assert.deepEqual(asked, ["get"]);
  assert.deepEqual(sent, ["tok_one"]);
  assert.doesNotMatch(first.result.content[0].text, /tok_one/, "the bearer the getter answered is redacted");
  // Revoked meanwhile: the refusal renews the bearer once, and the call goes again with the new one.
  valid.delete("tok_one");
  valid.add("tok_two");
  token.refresh = async () => { asked.push("refresh"); current = "tok_two"; return current; };
  const second = await call(server, "mdrn_list_projects", { workspaceId: "w" });
  assert.equal(second.result.isError, false, second.result.content[0].text);
  assert.deepEqual(asked, ["get", "get", "refresh"]);
  assert.deepEqual(sent, ["tok_one", "tok_one", "tok_two"]);
  assert.doesNotMatch(second.result.content[0].text, /tok_one|tok_two/, "both bearers of the call are redacted");
  // A renewal that answers the same bearer sends nothing again: the refusal is the answer.
  valid.clear();
  token.refresh = async () => { asked.push("refresh"); return current; };
  const third = await call(server, "mdrn_list_projects", { workspaceId: "w" });
  assert.equal(third.result.isError, true);
  assert.equal(third.result.content[0].text, "UNAUTHENTICATED: refused [REDACTED]");
  assert.deepEqual(sent.slice(3), ["tok_two"]);
  // A renewal that fails (the sign-in ended) is the tool error, in the getter's words.
  token.refresh = async () => { throw new Error("The sign-in has expired; run mdrn login again"); };
  const fourth = await call(server, "mdrn_list_projects", { workspaceId: "w" });
  assert.equal(fourth.result.isError, true);
  assert.equal(fourth.result.content[0].text, "The sign-in has expired; run mdrn login again");
  assert.deepEqual(sent.slice(4), ["tok_two"]);
  // A getter with nothing to give says so before any request.
  const empty = await call(new MdrnMcpServer({ token: { get: async () => { throw new Error("Sign in with mdrn login, or set MDRN_API_TOKEN to a management token"); }, refresh: async () => "x" }, fetcher }), "mdrn_list_projects", { workspaceId: "w" });
  assert.equal(empty.result.isError, true);
  assert.match(empty.result.content[0].text, /Sign in with mdrn login/);
  assert.equal(sent.length, 5);
  // A string token is what it is: refused once, never sent again.
  const fixed = await call(new MdrnMcpServer({ token: "tok_fixed", fetcher }), "mdrn_list_projects", { workspaceId: "w" });
  assert.equal(fixed.result.isError, true);
  assert.deepEqual(sent.slice(5), ["tok_fixed"]);
});

// The local server as a process: one JSON line in, one out. `fake` is an MDRN API and
// authorization server on this machine (fakePlatform below); the child's environment is this
// process's without any MDRN_* setting, plus `env`.
const STDIO = new URL("../src/stdio.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
async function stdio(env, messages) {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) if (key.startsWith("MDRN_")) delete inherited[key];
  const child = spawn(process.execPath, [STDIO], { env: { ...inherited, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (const message of messages) child.stdin.write(JSON.stringify(message) + "\n");
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, err);
  return out.trim().split("\n").map((line) => JSON.parse(line));
}
const INITIALIZE = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", method: "notifications/initialized" }];
const LIST_PROJECTS = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mdrn_list_projects", arguments: { workspaceId: "w" } } };

// A fake MDRN at one loopback origin: the OAuth metadata and token endpoint the CLI's refresh
// uses (a refresh token is good once and answers the next numbered pair), and the one API route
// the tests call, which answers 401 to any bearer not in `valid`.
async function fakePlatform() {
  const seen = [];
  const refreshed = [];
  const valid = new Set();
  let issued = 1;
  let origin;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const json = (status, value) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url === "/.well-known/oauth-authorization-server") return json(200, { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke` });
      if (request.url === "/oauth/token") {
        const form = Object.fromEntries(new URLSearchParams(body));
        refreshed.push(form);
        if (form.grant_type !== "refresh_token" || !/^refresh_\w+_live$/.test(form.refresh_token)) return json(400, { error: "invalid_grant", error_description: "The refresh token is invalid." });
        issued += 1;
        valid.add(`access_${issued}`);
        return json(200, { access_token: `access_${issued}`, refresh_token: `refresh_${issued}_live`, token_type: "Bearer", expires_in: 3600, scope: "project:read" });
      }
      seen.push({ url: request.url, authorization: request.headers.authorization });
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      if (!valid.has(bearer)) return json(401, { error: { code: "UNAUTHENTICATED", message: "The credential is invalid." } });
      json(200, { items: [{ id: "prj_1" }] });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, seen, refreshed, valid, close: () => new Promise((resolve) => server.close(resolve)) };
}

// A CLI configuration file in a directory of its own, with the given profiles.
function configFile(profiles) {
  const dir = mkdtempSync(join(tmpdir(), "mdrn-mcp-"));
  const path = join(dir, "mdrn", "config.json");
  mkdirSync(join(dir, "mdrn"), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, profiles, clients: {} }));
  return { path, read: () => JSON.parse(readFileSync(path, "utf8")), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const signIn = (n, expiresAt) => ({ type: "oauth", clientId: "cli_1", accessToken: `access_${n}`, refreshToken: `refresh_${n}_live`, expiresAt, scopes: ["project:read"], account: "ann@example.com" });
const now = () => Math.floor(Date.now() / 1000);

test("stdio with MDRN_API_TOKEN is unchanged: the token from the environment, the version from package.json", async () => {
  const fake = await fakePlatform();
  fake.valid.add("stdio-token");
  try {
    const lines = await stdio({ MDRN_API_TOKEN: "stdio-token", MDRN_API_ORIGIN: fake.origin, MDRN_CONFIG: join(tmpdir(), "mdrn-mcp-none", "config.json") }, [...INITIALIZE, LIST_PROJECTS]);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].result.protocolVersion, "2025-06-18");
    assert.deepEqual(lines[0].result.serverInfo, { name: "mdrn", version: PACKAGE_VERSION });
    assert.equal(lines[1].result.isError, false, lines[1].result.content[0].text);
    assert.match(lines[1].result.content[0].text, /prj_1/);
    assert.deepEqual(fake.seen, [{ url: "/v1/platform/projects?workspaceId=w", authorization: "Bearer stdio-token" }]);
    assert.deepEqual(fake.refreshed, []);
  } finally {
    await fake.close();
  }
});

test("stdio without MDRN_API_TOKEN signs in as the CLI profile: a fresh access token is sent as it is, to the profile's origin", async () => {
  const fake = await fakePlatform();
  fake.valid.add("access_1");
  const config = configFile({ default: { origin: fake.origin, auth: signIn(1, now() + 3600) } });
  try {
    const lines = await stdio({ MDRN_CONFIG: config.path }, [...INITIALIZE, LIST_PROJECTS]);
    assert.equal(lines[1].result.isError, false, lines[1].result.content[0].text);
    assert.match(lines[1].result.content[0].text, /prj_1/);
    assert.doesNotMatch(lines[1].result.content[0].text, /access_1/);
    assert.deepEqual(fake.seen, [{ url: "/v1/platform/projects?workspaceId=w", authorization: "Bearer access_1" }]);
    assert.deepEqual(fake.refreshed, []);
    assert.equal(config.read().profiles.default.auth.accessToken, "access_1", "nothing was rewritten");
  } finally {
    await fake.close();
    config.done();
  }
});

test("stdio refreshes an expired sign-in once before the call, under MDRN_PROFILE, and saves the rotated pair", async () => {
  const fake = await fakePlatform();
  const config = configFile({ default: { origin: fake.origin, token: "mdrn_mgmt_other" }, work: { origin: fake.origin, auth: signIn(1, now() - 10) } });
  try {
    const lines = await stdio({ MDRN_CONFIG: config.path, MDRN_PROFILE: "work" }, [...INITIALIZE, LIST_PROJECTS]);
    assert.equal(lines[1].result.isError, false, lines[1].result.content[0].text);
    assert.deepEqual(fake.refreshed, [{ grant_type: "refresh_token", refresh_token: "refresh_1_live", client_id: "cli_1" }]);
    assert.deepEqual(fake.seen, [{ url: "/v1/platform/projects?workspaceId=w", authorization: "Bearer access_2" }]);
    const saved = config.read().profiles.work.auth;
    assert.equal(saved.accessToken, "access_2");
    assert.equal(saved.refreshToken, "refresh_2_live");
    assert.ok(saved.expiresAt > now() + 3000);
    assert.equal(config.read().profiles.default.token, "mdrn_mgmt_other", "the other profile is untouched");
  } finally {
    await fake.close();
    config.done();
  }
});

test("stdio renews a sign-in the API refuses although it looked fresh, and sends the call once again", async () => {
  const fake = await fakePlatform();
  const config = configFile({ default: { origin: fake.origin, auth: signIn(1, now() + 3600) } });
  try {
    // access_1 is not valid at the API (revoked, say), so the first attempt is refused.
    const lines = await stdio({ MDRN_CONFIG: config.path }, [...INITIALIZE, LIST_PROJECTS]);
    assert.equal(lines[1].result.isError, false, lines[1].result.content[0].text);
    assert.deepEqual(fake.seen.map((call) => call.authorization), ["Bearer access_1", "Bearer access_2"]);
    assert.equal(fake.refreshed.length, 1);
    assert.equal(config.read().profiles.default.auth.accessToken, "access_2");
  } finally {
    await fake.close();
    config.done();
  }
});

test("stdio with neither a token nor a sign-in starts, and each tool call says how to sign in", async () => {
  const fake = await fakePlatform();
  const config = configFile({});
  try {
    const lines = await stdio({ MDRN_CONFIG: config.path, MDRN_API_ORIGIN: fake.origin }, [...INITIALIZE, LIST_PROJECTS]);
    assert.equal(lines[0].result.protocolVersion, "2025-06-18");
    assert.equal(lines[1].result.isError, true);
    assert.match(lines[1].result.content[0].text, /Sign in with mdrn login, or set MDRN_API_TOKEN/);
    assert.deepEqual(fake.seen, []);
  } finally {
    await fake.close();
    config.done();
  }
});
