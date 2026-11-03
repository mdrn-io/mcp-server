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
const sq = { ...env, database: "sqlite" };
const pg = { ...env, database: "postgres" };

const reads = [
  ["mdrn_list_builds", { ...env, deploymentId: "svc_1" }, "GET /v1/deploy/builds", "/v1/deploy/builds?serviceId=svc_1"],
  ["mdrn_list_builds", { ...env, deploymentId: "svc_1", cursor: "c 2" }, "GET /v1/deploy/builds", "/v1/deploy/builds?serviceId=svc_1&cursor=c+2"],
  ["mdrn_get_build", { ...env, buildId: "bld_1" }, "GET /v1/deploy/builds/bld_1", "/v1/deploy/builds/bld_1"],
  ["mdrn_get_build_logs", { ...env, buildId: "bld_1", cursor: "7" }, "GET /v1/deploy/builds/bld_1/logs", "/v1/deploy/builds/bld_1/logs?cursor=7"],
  ["mdrn_list_deployments", env, "GET /v1/deploy/services", "/v1/deploy/services"],
  ["mdrn_list_variables", { ...env, deploymentId: "svc_1" }, "GET /v1/deploy/services/svc_1/variables", "/v1/deploy/services/svc_1/variables"],
  ["mdrn_search_logs", { ...env, q: "timeout", level: "warn,error", from: 1, to: 2, deploymentId: "svc_1" }, "GET /v1/deploy/logs", "/v1/deploy/logs?from=1&to=2&q=timeout&level=warn%2Cerror&service=svc_1"],
  ["mdrn_get_request_logs", { ...env, traceId: "4bf92f3577b34da6a3ce929d0e0e4736", from: 1, to: 2 }, "GET /v1/deploy/logs/trace/4bf92f3577b34da6a3ce929d0e0e4736", "/v1/deploy/logs/trace/4bf92f3577b34da6a3ce929d0e0e4736?from=1&to=2"],
  ["mdrn_get_request_logs", { ...env, traceId: "tr_1" }, "GET /v1/deploy/logs/trace/tr_1", "/v1/deploy/logs/trace/tr_1"],
  // The databases' management API, scoped by the same two headers.
  ["mdrn_get_database_config", pg, "GET /v1/postgres/configuration", "/v1/postgres/configuration"],
  ["mdrn_list_records", { ...pg, collection: "tasks" }, "GET /v1/postgres/collections/tasks/records", "/v1/postgres/collections/tasks/records"],
  ["mdrn_get_database_config", sq, "GET /v1/sqlite/configuration", "/v1/sqlite/configuration"],
  ["mdrn_list_collections", sq, "GET /v1/sqlite/collections", "/v1/sqlite/collections"],
  ["mdrn_list_records", { ...sq, collection: "tasks" }, "GET /v1/sqlite/collections/tasks/records", "/v1/sqlite/collections/tasks/records"],
  ["mdrn_list_records", { ...sq, collection: "tasks", limit: 20, cursor: "c 2" }, "GET /v1/sqlite/collections/tasks/records", "/v1/sqlite/collections/tasks/records?limit=20&cursor=c+2"],
  ["mdrn_get_record", { ...sq, collection: "tasks", recordId: "rec_1" }, "GET /v1/sqlite/collections/tasks/records/rec_1", "/v1/sqlite/collections/tasks/records/rec_1"],
  ["mdrn_list_database_backups", sq, "GET /v1/sqlite/backups", "/v1/sqlite/backups"],
  ["mdrn_get_database_operation", { ...sq, operationId: "op_1" }, "GET /v1/sqlite/operations/op_1", "/v1/sqlite/operations/op_1"],
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
  ["mdrn_roll_back", { ...env, deploymentId: "svc_1", artifactId: "art_1" }, "POST /v1/deploy/deployments", { serviceId: "svc_1", artifactId: "art_1" }],
  ["mdrn_enable_product", { projectId: "prj_1", product: "postgres" }, "POST /v1/platform/projects/prj_1/products/postgres/enable", {}],
  ["mdrn_enable_product", { projectId: "prj_1", product: "sqlite" }, "POST /v1/platform/projects/prj_1/products/sqlite/enable", {}],
  ["mdrn_enable_product", { projectId: "prj_1", product: "objects" }, "POST /v1/platform/projects/prj_1/products/objects/enable", {}],
  ["mdrn_disable_product", { projectId: "prj_1", product: "logs" }, "POST /v1/platform/projects/prj_1/products/logs/disable", {}],
  ["mdrn_set_variable", { ...env, deploymentId: "svc_1", name: "API_URL", value: "https://x.test", secret: false }, "PUT /v1/deploy/services/svc_1/variables/API_URL", { value: "https://x.test", secret: false }],
  ["mdrn_unset_variable", { ...env, deploymentId: "svc_1", name: "API_URL" }, "DELETE /v1/deploy/services/svc_1/variables/API_URL", undefined],
  ["mdrn_deploy_example", { ...env, deploymentId: "svc_1", example: "saas-starter" }, "POST /v1/deploy/builds", { serviceId: "svc_1", example: "saas-starter" }],
  ["mdrn_clear_build_cache", { ...env, deploymentId: "svc_1" }, "DELETE /v1/deploy/services/svc_1/build-cache", undefined],
  ["mdrn_create_deployment", { ...env, name: "shop" }, "POST /v1/deploy/services", { name: "shop" }],
  ["mdrn_create_project", { workspaceId: "ws_1", name: "Blog" }, "POST /v1/platform/projects", { workspaceId: "ws_1", name: "Blog" }],
  ["mdrn_delete_object", { ...env, objectId: "obj_1" }, "DELETE /v1/platform/projects/prj_1/environments/sandbox/objects/obj_1", undefined],
  ["mdrn_send_test_email", { ...env, to: "ann@example.com" }, "POST /v1/mail/messages", { recipient: "ann@example.com", subject: "A test email from MDRN", text: "This is a test email sent by an AI assistant through MDRN. If you can read it, your app can send mail." }],
  ["mdrn_set_database_restore_history", { ...pg, restoreHistoryDays: 7 }, "PATCH /v1/postgres/configuration", { restoreHistoryDays: 7 }],
  ["mdrn_set_database_restore_history", { ...pg, restoreHistoryDays: 0 }, "PATCH /v1/postgres/configuration", { restoreHistoryDays: 0 }],
  ["mdrn_run_sql", { ...sq, sql: "SELECT 1" }, "POST /v1/sqlite/sql", { sql: "SELECT 1" }],
  ["mdrn_run_sql", { ...pg, sql: "SELECT 1" }, "POST /v1/postgres/sql", { sql: "SELECT 1" }],
  ["mdrn_run_sql", { ...sq, sql: "SELECT * FROM t WHERE a = ?1 AND b = ?2", params: ["x", null] }, "POST /v1/sqlite/sql", { sql: "SELECT * FROM t WHERE a = ?1 AND b = ?2", params: ["x", null] }],
  ["mdrn_database_connection", { ...pg, action: "on" }, "POST /v1/postgres/connection", {}],
  ["mdrn_database_connection", { ...pg, action: "rotate", redeploy: false }, "POST /v1/postgres/connection/rotate", { redeploy: false }],
  ["mdrn_database_connection", { ...pg, action: "off" }, "DELETE /v1/postgres/connection", {}],
  ["mdrn_database_connection", { ...pg, action: "stop_previous" }, "DELETE /v1/postgres/connection/previous", undefined],
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

test("mdrn_list_variables answers a plain variable's value and never a secret's, whatever the API answers", async () => {
  const items = [
    { name: "API_URL", secret: 0, build: 1, updatedAt: "2026-10-30T00:00:00Z", value: "https://x.test" },
    { name: "PLAIN_TOO", secret: false, build: false, updatedAt: "2026-10-30T00:00:00Z", value: "on" },
    // Deploy never sends these values; the tool drops them all the same.
    { name: "STRIPE_KEY", secret: 1, build: 0, updatedAt: "2026-10-30T00:00:00Z", value: "sk_live_leak" },
    { name: "TOKEN", secret: true, build: 0, updatedAt: "2026-10-30T00:00:00Z", value: "tok_leak" },
    { name: "ODD", build: 0, updatedAt: "2026-10-30T00:00:00Z", value: "odd_leak" },
  ];
  const api = fakeApi({ "GET /v1/deploy/services/svc_1/variables": { items, nextCursor: null } });
  const result = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher }), "mdrn_list_variables", { ...env, deploymentId: "svc_1" });
  assert.equal(result.result.isError, false, result.result.content[0].text);
  const text = result.result.content[0].text;
  for (const leak of ["sk_live_leak", "tok_leak", "odd_leak"]) assert.ok(!text.includes(leak), `${leak} came back`);
  const answer = JSON.parse(text);
  assert.deepEqual(answer.items.map(item => [item.name, item.value]), [["API_URL", "https://x.test"], ["PLAIN_TOO", "on"], ["STRIPE_KEY", undefined], ["TOKEN", undefined], ["ODD", undefined]]);
  assert.deepEqual(Object.keys(answer.items[2]).sort(), ["build", "name", "secret", "updatedAt"]);
  // A read: no Idempotency-Key, and refused to a connection without deploy:read.
  assert.equal(api.calls[0].headers.get("idempotency-key"), null);
  const refused = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["deploy:write"] }), "mdrn_list_variables", { ...env, deploymentId: "svc_1" });
  assert.equal(refused.result.isError, true);
  assert.equal(api.calls.length, 1);
});

test("deploying a connected repository connects it again as it is, which builds the branch head", async () => {
  const connection = { installationId: "11", repositoryId: "22", repository: "acme/shop", branch: "main", autoDeploy: true };
  const api = fakeApi({ "GET /v1/deploy/services/svc_1/github": connection, "PUT /v1/deploy/services/svc_1/github": { serviceId: "svc_1", branch: "main" } });
  const result = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher }), "mdrn_deploy_from_github", { ...env, deploymentId: "svc_1" });
  assert.equal(result.result.isError, false, result.result.content[0].text);
  assert.deepEqual(api.calls.map((c) => c.method), ["GET", "PUT"]);
  assert.deepEqual(api.calls[1].body, { installationId: "11", repositoryId: "22", branch: "main", autoDeploy: true });
  assert.ok(api.calls[1].headers.get("idempotency-key"));
  assert.match(result.result.content[0].text, /mdrn_list_builds/);
});

test("deploying a service with no connected repository, or one set to manual, changes nothing", async () => {
  for (const [answer, said] of [[null, /NOT_CONNECTED/], [{ installationId: "1", repositoryId: "2", branch: "main", autoDeploy: false }, /MANUAL/]]) {
    const api = fakeApi({ "GET /v1/deploy/services/svc_1/github": answer });
    const result = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher }), "mdrn_deploy_from_github", { ...env, deploymentId: "svc_1" });
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, said);
    assert.deepEqual(api.calls.map((c) => c.method), ["GET"]);
  }
});

test("mdrn_open_app asks for a link to the service's generated address and says how long it works", async () => {
  const grant = { url: "https://shop.apps.mdrn.io/_mdrn/v1/preview?grant=g1", expiresAt: "2026-10-16T12:15:00Z", ownerOnly: true };
  const api = fakeApi({ "GET /v1/deploy/services/svc_1": { id: "svc_1", hostname: "shop.apps.mdrn.io" }, "POST /v1/platform/projects/prj_1/environments/sandbox/preview-grants": grant });
  const result = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["deploy:read"] }), "mdrn_open_app", { ...env, deploymentId: "svc_1" });
  assert.equal(result.result.isError, false, result.result.content[0].text);
  const answer = JSON.parse(result.result.content[0].text);
  assert.equal(answer.url, grant.url);
  assert.equal(answer.ownerOnly, true);
  assert.match(answer.note, /only the person can open it\. The link works for 15 minutes; the browser that opens it stays signed in to the app for 8 hours\.$/);
  assert.deepEqual(answer.nextSteps, [{ step: "Give the person this link to open the app within 15 minutes", url: grant.url }]);
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["GET /v1/deploy/services/svc_1", "POST /v1/platform/projects/prj_1/environments/sandbox/preview-grants"]);
  assert.equal(api.calls[0].headers.get("mdrn-project"), "prj_1");
  assert.deepEqual(api.calls[1].body, { hostname: "shop.apps.mdrn.io" });
  // A public app: the link only opens it. A service with no address yet is said, before any grant.
  const open = fakeApi({ "GET /v1/deploy/services/svc_1": { id: "svc_1", hostname: "shop.apps.mdrn.io" }, "POST /v1/platform/projects/prj_1/environments/sandbox/preview-grants": { ...grant, ownerOnly: false } });
  assert.match(JSON.parse((await call(new MdrnMcpServer({ token: "tok_secret", fetcher: open.fetcher }), "mdrn_open_app", { ...env, deploymentId: "svc_1" })).result.content[0].text).note, /^The app is public: https:\/\/shop\.apps\.mdrn\.io opens it too\./);
  const none = fakeApi({ "GET /v1/deploy/services/svc_1": { id: "svc_1", hostname: null } });
  const refused = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: none.fetcher }), "mdrn_open_app", { ...env, deploymentId: "svc_1" });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /^NO_ADDRESS/);
  assert.equal(none.calls.length, 1);
});

test("reads of objects, mail and auth go to the Platform's relays for the environment", async () => {
  const base = "/v1/platform/projects/prj_1/environments/sandbox";
  for (const [name, args, route, path] of [
    ["mdrn_list_objects", { ...env, limit: 20 }, `GET ${base}/objects`, `${base}/objects?limit=20`],
    ["mdrn_list_mail_messages", { ...env, status: "bounced" }, `GET ${base}/mail/messages`, `${base}/mail/messages?status=bounced`],
    ["mdrn_get_mail_message", { ...env, messageId: "msg_1" }, `GET ${base}/mail/messages/msg_1`, `${base}/mail/messages/msg_1`],
    ["mdrn_list_auth_users", { ...env, email: "ann" }, `GET ${base}/auth/users`, `${base}/auth/users?email=ann`],
  ]) {
    const api = fakeApi({ [route]: { items: [] } });
    const result = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher }), name, args);
    assert.equal(result.result.isError, false, result.result.content[0].text);
    assert.deepEqual(api.calls.map((c) => c.path), [path], name);
  }
});

test("mdrn_set_sign_in serves sign-in at the deployment's address and saves its policy under If-Match; mdrn_get_auth_settings reads one row per deployment", async () => {
  const base = "/v1/platform/projects/prj_1/environments/sandbox";
  const calls = [];
  const fetcher = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method, path: pathname, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (pathname === "/v1/deploy/services/svc_1") return Response.json({ id: "svc_1", name: "shop", hostname: "shop.apps.mdrn.io" });
    if (pathname === "/v1/deploy/services") return Response.json({ items: [{ id: "svc_1", name: "shop", hostname: "shop.apps.mdrn.io" }, { id: "svc_2", name: "api" }] });
    if (pathname === "/v1/platform/identity/activations") return Response.json({ enabled: true });
    if (pathname === `${base}/auth/configuration` && init.method === "GET") return Response.json({ routePolicies: [{ serviceId: "svc_2", mode: "mixed" }], settingsUi: { enabled: true, path: "/account" } }, { headers: { ETag: '"v3"' } });
    if (pathname === `${base}/auth/configuration`) return Response.json({ accepted: true });
    return Response.json({ error: { code: "NOT_FOUND", message: pathname } }, { status: 404 });
  };
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher });
  const set = await call(server, "mdrn_set_sign_in", { ...env, deploymentId: "svc_1", mode: "everyone", publicPaths: ["/", "/pricing"] });
  assert.equal(set.result.isError, false, set.result.content[0].text);
  assert.deepEqual(calls.find((c) => c.path === "/v1/platform/identity/activations").body, { origin: "https://shop.apps.mdrn.io", projectId: "prj_1", environmentId: "sandbox" });
  const patch = calls.find((c) => c.method === "PATCH");
  assert.equal(patch.headers.get("if-match"), '"v3"');
  assert.deepEqual(patch.body, { routePolicies: [{ serviceId: "svc_2", mode: "mixed" }, { serviceId: "svc_1", mode: "require_sign_in", publicPaths: ["/", "/pricing"] }] });
  const read = JSON.parse((await call(server, "mdrn_get_auth_settings", env)).result.content[0].text);
  assert.deepEqual(read.deployments.map((d) => [d.deploymentId, d.signIn]), [["svc_1", "off"], ["svc_2", "app_decides"]]);
  assert.deepEqual(read.accountPage, { enabled: true, path: "/account" });
  assert.equal(read.secondFactor, "off", "absent is off for an app");
  assert.equal((await call(server, "mdrn_set_sign_in", { ...env, deploymentId: "svc_1", mode: "off", publicPaths: ["/"] })).result.isError, true, "public paths only with everyone");
  // Each public path is checked against the item schema, not only the list's length.
  for (const publicPaths of [["*"], [42], [null], ["/ok", "javascript:x"], ["/" + "a".repeat(300)]]) {
    const refused = await call(server, "mdrn_set_sign_in", { ...env, deploymentId: "svc_1", mode: "everyone", publicPaths });
    assert.match(refused.result.content[0].text, /Invalid argument publicPaths/, JSON.stringify(publicPaths));
  }
});

test("mdrn_upload_object waits for the upload to open, sends the parts to their own links without the bearer, and completes", async () => {
  const base = "/v1/platform/projects/prj_1/environments/sandbox/objects";
  const calls = [];
  const fetcher = async (url, init) => {
    const { pathname, origin } = new URL(url);
    calls.push({ method: init.method, origin, path: pathname, headers: new Headers(init.headers), body: init.body });
    if (origin === "https://parts.example") return Response.json({ etag: `e${pathname.slice(1)}` });
    if (pathname === `${base}/uploads` && init.method === "POST") return Response.json({ id: "upl_1", objectId: "obj_1", state: "opening", partBytes: 4 });
    if (pathname === `${base}/uploads/upl_1`) return Response.json({ id: "upl_1", objectId: "obj_1", state: "uploading", partBytes: 4 });
    if (pathname === `${base}/uploads/upl_1/parts`) return Response.json({ url: `https://parts.example/${JSON.parse(init.body).partNumber}`, method: "PUT" });
    if (pathname === `${base}/uploads/upl_1/complete`) return Response.json({ id: "obj_1", state: "verifying" });
    return Response.json({ error: { code: "NOT_FOUND", message: pathname } }, { status: 404 });
  };
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher, sleep: async () => {} });
  const result = await call(server, "mdrn_upload_object", { ...env, filename: "notes.txt", text: "hello world" });
  assert.equal(result.result.isError, false, result.result.content[0].text);
  const answer = JSON.parse(result.result.content[0].text);
  assert.equal(answer.id, "obj_1");
  assert.equal(answer.bytes, 11);
  const puts = calls.filter((c) => c.origin === "https://parts.example");
  assert.deepEqual(puts.map((c) => new TextDecoder().decode(c.body)), ["hell", "o wo", "rld"]);
  assert.ok(puts.every((c) => !c.headers.has("authorization")));
  assert.deepEqual(JSON.parse(calls.find((c) => c.path.endsWith("/complete")).body), { parts: [{ partNumber: 1, etag: "e1" }, { partNumber: 2, etag: "e2" }, { partNumber: 3, etag: "e3" }] });
  assert.equal((await call(server, "mdrn_upload_object", { ...env, filename: "x", text: "a", base64: "YQ==" })).result.isError, true);
  assert.equal((await call(server, "mdrn_upload_object", { ...env, filename: "x", base64: "not base64!" })).result.isError, true);
});

test("a connection may change Production only when the person allowed it; MDRN's own tables are never queried or listed", async () => {
  const api = fakeApi({ "POST /v1/deploy/services": { id: "svc_1" }, "POST /v1/sqlite/sql": { results: [{ name: "tasks" }, { name: "_mdrn_records" }, { name: "_cf_KV" }], meta: {} } });
  const readOnly = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["deploy:write", "database:write", "project:read", "mail:write"] });
  const refused = await call(readOnly, "mdrn_create_deployment", { projectId: "prj_1", environmentId: "production", name: "x" });
  assert.match(refused.result.content[0].text, /may only read Production/);
  assert.match((await call(readOnly, "mdrn_enable_product", { projectId: "prj_1", product: "mail" })).result.content[0].text, /may only read Production/);
  assert.equal(api.calls.length, 0);
  assert.equal((await call(readOnly, "mdrn_create_deployment", { ...env, name: "x" })).result.isError, false, "Sandbox is allowed");
  const allowed = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["deploy:write", "production:write"] });
  assert.equal((await call(allowed, "mdrn_create_deployment", { projectId: "prj_1", environmentId: "production", name: "x" })).result.isError, false);
  // Where: an environment left unticked is out of reach, to read as to write; a product change needs both.
  const before0 = api.calls.length;
  const sandboxOnly = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["deploy:read", "deploy:write", "mail:write", "sandbox:access"] });
  assert.match((await call(sandboxOnly, "mdrn_list_deployments", { projectId: "prj_1", environmentId: "production" })).result.content[0].text, /may not use Production/);
  const productionOnly = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["deploy:read", "mail:write", "production:access", "production:write"] });
  assert.match((await call(productionOnly, "mdrn_list_deployments", env)).result.content[0].text, /may not use Sandbox/);
  assert.match((await call(productionOnly, "mdrn_enable_product", { projectId: "prj_1", product: "mail" })).result.content[0].text, /may not use Sandbox/);
  assert.equal(api.calls.length, before0, "refused before any request");
  assert.equal((await call(sandboxOnly, "mdrn_create_deployment", { ...env, name: "x" })).result.isError, false, "Sandbox is allowed");
  // Tables named _mdrn_ or _cf_: refused before any request, and left out of a listing.
  const before = api.calls.length;
  for (const sql of ["SELECT * FROM _mdrn_records", 'DELETE FROM "_cf_KV"', "select * from main._MDRN_metadata"]) {
    const result = await call(readOnly, "mdrn_run_sql", { ...sq, sql });
    assert.match(result.result.content[0].text, /^INTERNAL_TABLE/, sql);
  }
  assert.equal(api.calls.length, before);
  const listed = JSON.parse((await call(readOnly, "mdrn_run_sql", { ...sq, sql: "SELECT name FROM sqlite_master" })).result.content[0].text);
  assert.deepEqual(listed.results, [{ name: "tasks" }]);
});

test("a write the token's scopes do not cover is refused before any request", async () => {
  const api = fakeApi();
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["deploy:read", "project:read"] });
  for (const [name, args, scope] of [
    ["mdrn_list_workspaces", {}, "workspace:read"],
    ["mdrn_roll_back", { ...env, deploymentId: "s", artifactId: "a" }, "deploy:write"],
    ["mdrn_enable_product", { projectId: "prj_1", product: "mail" }, "mail:write"],
    ["mdrn_create_deployment", { ...env, name: "x" }, "deploy:write"],
    ["mdrn_get_database_config", sq, "database:read"],
    ["mdrn_run_sql", { ...sq, sql: "DROP TABLE t" }, "database:write"],
    ["mdrn_restore_database", { ...sq, backupId: "bak_1", confirmOverwrite: true }, "database:write"],
    ["mdrn_database_connection", { ...pg, action: "off" }, "database:write"],
  ]) {
    const result = await call(server, name, args);
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, new RegExp(`insufficient_scope: .*${scope}`));
  }
  assert.equal(api.calls.length, 0);
});

test("the API's own refusal of a write comes back as a tool error", async () => {
  const api = fakeApi({ "POST /v1/deploy/services": [403, { error: { code: "FORBIDDEN", message: "Developers and Admins create services" } }] });
  const result = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["deploy:write"] }), "mdrn_create_deployment", { ...env, name: "x" });
  assert.equal(result.result.isError, true);
  assert.equal(result.result.content[0].text, "FORBIDDEN: Developers and Admins create services\nNext: Read what FORBIDDEN means and what to do: https://mdrn.io/docs/errors/#any-request");
});

test("a connection string is answered once with how to treat it, and each service's redeploy", async () => {
  const issued = { connectionString: "postgresql://mdrn_app_a:pw@db.example/mdrn?sslmode=require", role: "mdrn_app_a", host: "db.example", database: "mdrn", createdAt: 1, rotatedAt: 1, previous: { role: "mdrn_app_b", since: 1, state: "kept", waitingFor: [] }, redeploy: { requested: true, services: [{ serviceId: "svc_1", name: "api", outcome: "redeploying", deploymentId: "dep_1" }] } };
  const api = fakeApi({ "POST /v1/postgres/connection/rotate": issued, "DELETE /v1/postgres/connection/previous": { connection: { role: "mdrn_app_a", host: "db.example", database: "mdrn", createdAt: 1, rotatedAt: 1, previous: null } } });
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["database:write"] });
  const rotated = JSON.parse((await call(server, "mdrn_database_connection", { ...pg, action: "rotate" })).result.content[0].text);
  assert.equal(rotated.connectionString, issued.connectionString);
  assert.match(rotated.note, /in this answer only: give it to the person now/);
  assert.deepEqual(rotated.nextSteps.map((step) => step.tool), ["mdrn_get_database_config", "mdrn_database_connection", "mdrn_get_rollout"]);
  assert.deepEqual(rotated.nextSteps[1].arguments, { ...pg, action: "stop_previous" });
  assert.deepEqual(rotated.nextSteps[2].arguments, { ...env, rolloutId: "dep_1" });
  const stopped = JSON.parse((await call(server, "mdrn_database_connection", { ...pg, action: "stop_previous" })).result.content[0].text);
  assert.equal(stopped.connection.previous, null);
  assert.equal(api.calls[1].headers.get("content-type"), null, "stop_previous sends no body");
  assert.equal(api.calls[0].headers.get("mdrn-project"), "prj_1");
});

test("a restore reads the revision and sends it as If-Match, with the target and confirmOverwrite", async () => {
  const api = fakeApi({ "GET /v1/postgres/configuration": { revision: 9 }, "POST /v1/postgres/restores": [202, { id: "op_7", state: "accepted", kind: "restore" }], "GET /v1/sqlite/configuration": { revision: 4 }, "POST /v1/sqlite/restores": [202, { id: "op_8", state: "accepted", kind: "restore" }] });
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher });
  const result = await call(server, "mdrn_restore_database", { ...pg, timestamp: "2026-10-09T16:00:00+02:00", confirmOverwrite: true, idempotencyKey: "rst-1" });
  assert.equal(result.result.isError, false, result.result.content[0].text);
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["GET /v1/postgres/configuration", "POST /v1/postgres/restores"]);
  assert.equal(api.calls[1].headers.get("if-match"), "9");
  assert.equal(api.calls[1].headers.get("idempotency-key"), "rst-1");
  assert.equal(api.calls[1].headers.get("mdrn-environment"), "sandbox");
  assert.deepEqual(api.calls[1].body, { timestamp: "2026-10-09T14:00:00.000Z", confirmOverwrite: true });
  const answer = JSON.parse(result.result.content[0].text);
  assert.deepEqual(answer.nextSteps, [{ step: "The restore is still running: read the operation again shortly", tool: "mdrn_get_database_operation", arguments: { ...pg, operationId: "op_7" } }]);
  await call(server, "mdrn_restore_database", { ...sq, backupId: "bak_1", confirmOverwrite: true });
  assert.deepEqual(api.calls.slice(2).map((c) => `${c.method} ${c.path}`), ["GET /v1/sqlite/configuration", "POST /v1/sqlite/restores"]);
  assert.deepEqual(api.calls[3].body, { backupId: "bak_1", confirmOverwrite: true });
  // No revision, no restore.
  const bare = fakeApi({ "GET /v1/sqlite/configuration": { state: "enabled" } });
  const refused = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: bare.fetcher }), "mdrn_restore_database", { ...sq, backupId: "bak_1", confirmOverwrite: true });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /without its revision; nothing was restored/);
  assert.equal(bare.calls.length, 1);
});

test("arguments are checked before any request", async () => {
  const api = fakeApi();
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher });
  for (const [name, args] of [
    ["mdrn_enable_product", { projectId: "prj_1", product: "billing" }],
    ["mdrn_enable_product", { projectId: "prj_1", product: "postgres", engine: "postgres" }],
    ["mdrn_enable_product", { projectId: "prj_1", product: "database" }],
    // A database tool names its database; one only the other database has is refused.
    ["mdrn_run_sql", { ...env, sql: "SELECT 1" }],
    ["mdrn_run_sql", { ...env, database: "mysql", sql: "SELECT 1" }],
    ["mdrn_database_connection", { ...sq, action: "on" }],
    ["mdrn_set_database_restore_history", { ...sq, restoreHistoryDays: 7 }],
    ["mdrn_list_database_backups", pg],
    ["mdrn_restore_database", { ...pg, backupId: "bak_1", confirmOverwrite: true }],
    ["mdrn_enable_product", { ...env, product: "mail" }],
    ["mdrn_list_products", env],
    ["mdrn_set_variable", { ...env, deploymentId: "s", name: "BAD NAME", value: "v" }],
    ["mdrn_set_variable", { ...env, deploymentId: "s", name: "A", value: "v", secret: "yes" }],
    ["mdrn_set_variable", { ...env, deploymentId: "s", name: "A" }],
    ["mdrn_search_logs", { ...env, level: "fatal" }],
    ["mdrn_search_logs", { ...env, from: 1.5 }],
    ["mdrn_create_deployment", { ...env, name: "-x" }],
    ["mdrn_roll_back", { ...env, deploymentId: "s", artifactId: "a", idempotencyKey: "has space" }],
    ["mdrn_roll_back", { ...env, deploymentId: "s", artifactId: "a", force: true }],
    ["mdrn_list_builds", { ...env, deploymentId: "s", environmentId: "development" }],
    // A trace id is one path segment of the allowlisted route: letters, digits, _ and - only.
    ["mdrn_get_request_logs", { ...env, traceId: "tr 1" }],
    ["mdrn_get_request_logs", { ...env, traceId: "a/b" }],
    ["mdrn_get_request_logs", { ...env, traceId: "t", from: -1 }],
    ["mdrn_list_records", { ...sq, collection: "a/b" }],
    ["mdrn_list_records", { ...sq, collection: "tasks", limit: 500 }],
    ["mdrn_get_record", { ...sq, collection: "tasks" }],
    ["mdrn_set_database_restore_history", { ...pg, restoreHistoryDays: 3 }],
    ["mdrn_run_sql", { ...sq, sql: "" }],
    ["mdrn_run_sql", { ...sq, sql: "SELECT ?1", params: [{ a: 1 }] }],
    ["mdrn_run_sql", { ...sq, sql: "SELECT ?1", params: "x" }],
    ["mdrn_run_sql", { ...sq, sql: "SELECT 1", params: Array(101).fill(1) }],
    ["mdrn_database_connection", { ...pg, action: "flip" }],
    ["mdrn_database_connection", { ...pg, action: "stop_previous", redeploy: false }],
    ["mdrn_restore_database", { ...sq, backupId: "bak_1" }],
    ["mdrn_restore_database", { ...sq, backupId: "bak_1", confirmOverwrite: false }],
    ["mdrn_restore_database", { ...sq, confirmOverwrite: true }],
    ["mdrn_restore_database", { ...sq, backupId: "bak_1", timestamp: "2026-10-09T14:00:00Z", confirmOverwrite: true }],
    ["mdrn_restore_database", { ...pg, timestamp: "yesterday", confirmOverwrite: true }],
    ["mdrn_restore_database", { ...pg, timestamp: "2026-10-09T14:00:00", confirmOverwrite: true }],
  ]) {
    const result = await call(server, name, args);
    assert.equal(result.result.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(api.calls.length, 0);
});

// The writes that can take away what cannot be brought back: a stored file, restore history, data
// (SQL, a restore) and a connection string; each with whether repeating it changes nothing more.
const DESTRUCTIVE = { mdrn_delete_object: true, mdrn_set_database_restore_history: true, mdrn_run_sql: false, mdrn_database_connection: false, mdrn_restore_database: false };

test("writes are annotated as changes that are not destructive, but for the five that can take something away, and nothing deletes a deployment, product or domain", async () => {
  const { result } = await new MdrnMcpServer({ token: "tok_secret" }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const tool of result.tools) {
    assert.equal(tool.annotations.destructiveHint, tool.name in DESTRUCTIVE, tool.name);
    if (tool.name in DESTRUCTIVE) assert.equal(tool.annotations.idempotentHint, DESTRUCTIVE[tool.name], tool.name);
    if (tool.name in DESTRUCTIVE) assert.match(tool.description, /Ask the person first|ask the person/, tool.name);
    if (!tool.annotations.readOnlyHint) assert.ok("idempotencyKey" in tool.inputSchema.properties, tool.name);
    if (tool.name !== "mdrn_delete_object") assert.doesNotMatch(tool.name, /delete|remove/);
  }
  assert.ok(SCOPES_SUPPORTED.includes("deploy:write"));
  assert.ok(SCOPES_SUPPORTED.includes("production:write"));
  for (const scope of ["database:read", "database:write"]) assert.ok(SCOPES_SUPPORTED.includes(scope));
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
  assert.equal(third.result.content[0].text, "UNAUTHENTICATED: refused [REDACTED]\nNext: Read what UNAUTHENTICATED means and what to do: https://mdrn.io/docs/errors/#any-request");
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
