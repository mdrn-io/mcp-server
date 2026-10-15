import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MdrnMcpServer, safeApiPath } from "../src/server.js";

// The raw-path rule the MCP server shares with the CLI, tested against the CLI's table.
const paths = JSON.parse(readFileSync(new URL("../../cli/test/api-paths.json", import.meta.url), "utf8"));

test("lists only the bounded tools", async () => {
  const response = await new MdrnMcpServer({ token: "x" }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(response.result.tools.map(tool => tool.name), ["mdrn_list_workspaces", "mdrn_list_projects", "mdrn_list_products", "mdrn_list_identity_origins", "mdrn_get_operation", "mdrn_get_billing", "mdrn_get_usage", "mdrn_list_deploy_services", "mdrn_get_deployment", "mdrn_list_domains", "mdrn_get",
    "mdrn_list_builds", "mdrn_get_build", "mdrn_get_build_logs", "mdrn_list_releases", "mdrn_list_deployments", "mdrn_search_logs", "mdrn_get_logs_trace",
    "mdrn_deploy_connected_repo", "mdrn_rollback", "mdrn_enable_product", "mdrn_disable_product", "mdrn_set_variable", "mdrn_unset_variable", "mdrn_create_service"]);
});

test("initialize reports the version the transport gives, which each transport takes from package.json", async () => {
  const response = await new MdrnMcpServer({ token: "x", version: "9.9.9" }).handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.deepEqual(response.result.serverInfo, { name: "mdrn", version: "9.9.9" });
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(version, /^\d+\.\d+\.\d+$/);
  // Without one, the server says it has none rather than claiming a release.
  assert.equal((await new MdrnMcpServer({ token: "x" }).handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).result.serverInfo.version, "0.0.0");
});

test("the two new reads: workspaces need no id, and a trace is scoped to the project environment", async () => {
  const calls = [];
  const server = new MdrnMcpServer({ token: "x", fetcher: async (url, init) => { calls.push({ url, method: init.method, project: init.headers.get("mdrn-project"), environment: init.headers.get("mdrn-environment") }); return Response.json({ items: [] }); } });
  const workspaces = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mdrn_list_workspaces", arguments: {} } });
  assert.equal(workspaces.result.isError, false, workspaces.result.content[0].text);
  const paged = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mdrn_list_workspaces", arguments: { cursor: "c 2" } } });
  assert.equal(paged.result.isError, false);
  const trace = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mdrn_get_logs_trace", arguments: { projectId: "p", environmentId: "sandbox", traceId: "tr_1", from: 1, to: 2 } } });
  assert.equal(trace.result.isError, false, trace.result.content[0].text);
  assert.deepEqual(calls, [
    { url: "https://api.mdrn.io/v1/platform/workspaces", method: "GET", project: null, environment: null },
    { url: "https://api.mdrn.io/v1/platform/workspaces?cursor=c+2", method: "GET", project: null, environment: null },
    { url: "https://api.mdrn.io/v1/deploy/logs/trace/tr_1?from=1&to=2", method: "GET", project: "p", environment: "sandbox" },
  ]);
  // Both are on mdrn_get's allowlist as well, with their own query keys and nothing else.
  for (const [path, ok] of [["/v1/platform/workspaces", true], ["/v1/platform/workspaces?cursor=x", true], ["/v1/platform/workspaces?limit=5", false], ["/v1/deploy/logs/trace/tr_1?from=1", true], ["/v1/deploy/logs/trace/tr_1?q=x", false], ["/v1/deploy/logs/trace", false], ["/v1/deploy/logs", false]]) {
    const result = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mdrn_get", arguments: { path, projectId: "p", environmentId: "sandbox" } } });
    assert.equal(result.result.isError, !ok, path);
  }
  // A trace without the project environment is refused before any request.
  const before = calls.length;
  const unscoped = await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mdrn_get", arguments: { path: "/v1/deploy/logs/trace/tr_1" } } });
  assert.equal(unscoped.result.isError, true);
  assert.equal(calls.length, before);
});

test("calls MDRN without disclosing the token", async () => {
  let request;
  const server = new MdrnMcpServer({ token: "secret", fetcher: async (url, init) => { request = { url, init }; return Response.json({ items: [] }); } });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mdrn_list_projects", arguments: { workspaceId: "workspace one" } } });
  assert.equal(request.url, "https://api.mdrn.io/v1/platform/projects?workspaceId=workspace%20one");
  assert.equal(request.init.headers.get("authorization"), "Bearer secret");
  assert.doesNotMatch(response.result.content[0].text, /secret/);
});

test("rejects paths outside the read-only allowlist", async () => {
  const server = new MdrnMcpServer({ token: "x" });
  const response = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mdrn_get", arguments: { path: "https://example.com" } } });
  assert.equal(response.result.isError, true);
});

test("a malformed percent escape is refused as outside the allowlist, before any request", async () => {
  for (const path of ["/v1/platform/operations/%zz", "/v1/platform/operations/100%", "/v1/platform/operations/%E0%A4%A"]) {
    let calls = 0;
    const server = new MdrnMcpServer({ token: "secret", fetcher: async () => { calls++; return Response.json({}); } });
    const result = await server.handle({ id: 1, method: "tools/call", params: { name: "mdrn_get", arguments: { path } } });
    assert.equal(result.result.isError, true, path);
    assert.match(JSON.stringify(result.result.content), /Path outside read-only allowlist/, path);
    assert.equal(calls, 0);
  }
});

for (const path of ['/v1/platform/login/start','/v1/platform/workspaces/w/billing/checkout','/v1/platform/projects/../usage','/v1/platform/projects?workspaceId=w&next=https://evil.test','/v1/platform/projects?workspaceId=w&workspaceId=v','/v1/deploy/services/anything','/internal/platform/usage']) test(`rejects ${path}`,async()=>{
 let calls=0;const server=new MdrnMcpServer({token:'secret',fetcher:async()=>{calls++;return Response.json({})}});
 const result=await server.handle({id:1,method:'tools/call',params:{name:'mdrn_get',arguments:{path}}});assert.equal(result.result.isError,true);assert.equal(calls,0);
});
test('usage inspection is GET only and redacts echoed credential',async()=>{
 const server=new MdrnMcpServer({token:'private-token',fetcher:async(url,init)=>{assert.equal(url,'https://api.mdrn.io/v1/platform/usage?workspaceId=w&periodId=p');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.ok(init.signal);return Response.json({echo:'private-token'});}});
 const r=await server.handle({id:1,method:'tools/call',params:{name:'mdrn_get_usage',arguments:{workspaceId:'w',periodId:'p'}}});assert.equal(r.result.isError,false);assert.doesNotMatch(r.result.content[0].text,/private-token/);
});

test('operation tool uses canonical resource without client-selected ownership',async()=>{const server=new MdrnMcpServer({token:'t',fetcher:async url=>{assert.equal(url,'https://api.mdrn.io/v1/platform/operations/op_one');return Response.json({state:'waiting'})}});const r=await server.handle({id:1,method:'tools/call',params:{name:'mdrn_get_operation',arguments:{operationId:'op_one'}}});assert.equal(r.result.isError,false)});

test('customer environment tools reject the internal Development stage',async()=>{const server=new MdrnMcpServer({token:'private-token',fetcher:async()=>{assert.fail('must not fetch')}});const r=await server.handle({id:1,method:'tools/call',params:{name:'mdrn_list_products',arguments:{projectId:'p',environmentId:'development'}}});assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/sandbox or production/)});

test("domains are inspected with their quota, and no tool can add a paid one", async () => {
  let request;
  const server = new MdrnMcpServer({ token: "x", fetcher: async (url, init) => { request = { url, init }; return Response.json({ items: [], quota: { included: 5, used: 0 } }); } });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mdrn_list_domains", arguments: { projectId: "p", environmentId: "sandbox" } } });
  assert.equal(response.result.isError, false);
  assert.match(request.url, /\/v1\/deploy\/domains$/);
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.headers.get("mdrn-project"), "p");
  const listed = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.ok(listed.result.tools.every(tool => !/domain/.test(tool.name) || tool.annotations.readOnlyHint));
});

test('lists the app hostnames that have sign-in, read-only',async()=>{let seen;const server=new MdrnMcpServer({token:'t',fetcher:async(url,init)=>{seen={url,method:init.method};return Response.json({items:[{origin:'https://app.example.com',serviceId:'svc_1',enabled:true}]})}});const r=await server.handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'mdrn_list_identity_origins',arguments:{projectId:'p',environmentId:'sandbox'}}});assert.equal(r.result.isError,false);assert.equal(seen.method,'GET');assert.ok(seen.url.endsWith("/v1/platform/projects/p/environments/sandbox/identity/origins"));});
test('refuses a plain http API origin so the token never travels unencrypted',()=>{assert.throws(()=>new MdrnMcpServer({token:'t',origin:'http://api.mdrn.io'}),/https origin/);assert.ok(new MdrnMcpServer({token:'t',origin:'http://localhost:8787'}));});

test("the README documents every tool the server lists", async () => {
  const { readFile } = await import("node:fs/promises");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const { result } = await new MdrnMcpServer({ token: "x" }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const tool of result.tools) assert.ok(readme.includes("`" + tool.name + "`"), `${tool.name} missing from README.md`);
});

test("the README's tool table matches the server: no extra tools, and each tool's arguments", async () => {
  const { readFile } = await import("node:fs/promises");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const { result } = await new MdrnMcpServer({ token: "x" }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
  const rows = readme.split(/\r?\n/).map((line) => line.match(/^\| `(mdrn_\w+)` \| ([^|]*) \|/)).filter(Boolean);
  assert.deepEqual(rows.map((row) => row[1]).sort(), [...tools.keys()].sort());
  for (const [, name, argumentsCell] of rows) {
    const documented = [...argumentsCell.matchAll(/`(\w+)`/g)].map((m) => m[1]).sort();
    assert.deepEqual(documented, Object.keys(tools.get(name).inputSchema.properties).sort(), `${name} arguments in README.md`);
  }
});

test("every path the shared rule refuses is outside the allowlist, before any request", async () => {
  for (const path of paths.safe) assert.equal(safeApiPath(path, "https://mdrn.invalid"), true, path);
  for (const path of paths.unsafe) {
    assert.equal(safeApiPath(path, "https://mdrn.invalid"), false, path);
    let calls = 0;
    const server = new MdrnMcpServer({ token: "secret", fetcher: async () => { calls++; return Response.json({}); } });
    const result = await server.handle({ id: 1, method: "tools/call", params: { name: "mdrn_get", arguments: { path, projectId: "p", environmentId: "sandbox" } } });
    assert.equal(result.result.isError, true, path);
    assert.match(JSON.stringify(result.result.content), /Path outside read-only allowlist/, path);
    assert.equal(calls, 0, path);
  }
});
