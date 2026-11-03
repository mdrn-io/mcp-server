import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MdrnMcpServer, safeApiPath } from "../src/server.js";

// The raw-path rule the MCP server shares with the CLI, tested against the CLI's table.
const paths = JSON.parse(readFileSync(new URL("../../cli/test/api-paths.json", import.meta.url), "utf8"));

test("lists only the bounded tools", async () => {
  const response = await new MdrnMcpServer({ token: "x" }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(response.result.tools.map(tool => tool.name), ["mdrn_list_workspaces", "mdrn_list_projects", "mdrn_create_project", "mdrn_list_products", "mdrn_enable_product", "mdrn_disable_product", "mdrn_get_operation", "mdrn_get_billing", "mdrn_get_usage",
    "mdrn_list_deployments", "mdrn_create_deployment", "mdrn_list_builds", "mdrn_get_build", "mdrn_get_build_logs", "mdrn_get_rollout", "mdrn_deploy_from_github", "mdrn_deploy_example", "mdrn_roll_back", "mdrn_list_variables", "mdrn_set_variable", "mdrn_unset_variable", "mdrn_clear_build_cache", "mdrn_list_domains", "mdrn_list_owned_domains", "mdrn_set_mail_address", "mdrn_open_app", "mdrn_search_logs", "mdrn_get_request_logs",
    "mdrn_get_database_config", "mdrn_list_collections", "mdrn_list_records", "mdrn_get_record", "mdrn_list_database_backups", "mdrn_get_database_operation", "mdrn_set_database_restore_history", "mdrn_run_sql", "mdrn_database_connection", "mdrn_restore_database",
    "mdrn_list_objects", "mdrn_get_object_link", "mdrn_upload_object", "mdrn_delete_object", "mdrn_list_mail_messages", "mdrn_get_mail_message", "mdrn_send_test_email",
    "mdrn_get_auth_settings", "mdrn_set_sign_in", "mdrn_list_auth_users", "mdrn_export_auth_users", "mdrn_read_api"]);
  // Today's words only: no services, identity, releases or preview tokens.
  for (const tool of response.result.tools) assert.doesNotMatch(tool.name, /service|identity|release|preview/, tool.name);
});

test("initialize reports the version the transport gives, which each transport takes from package.json", async () => {
  const response = await new MdrnMcpServer({ token: "x", version: "9.9.9" }).handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.deepEqual(response.result.serverInfo, { name: "mdrn", version: "9.9.9" });
  // The instructions the agent reads: deploy with the CLI, defer to its help and the docs, and say a refusal rather than work around it.
  assert.match(response.result.instructions, /npx @mdrnio\/cli --help/);
  assert.match(response.result.instructions, /https:\/\/mdrn\.io\/docs/);
  assert.match(response.result.instructions, /tell the person instead of working around it/);
  assert.doesNotMatch(response.result.instructions, /build mode|30 days|members/i);
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
  const trace = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mdrn_get_request_logs", arguments: { projectId: "p", environmentId: "sandbox", traceId: "tr_1", from: 1, to: 2 } } });
  assert.equal(trace.result.isError, false, trace.result.content[0].text);
  assert.deepEqual(calls, [
    { url: "https://api.mdrn.io/v1/platform/workspaces", method: "GET", project: null, environment: null },
    { url: "https://api.mdrn.io/v1/platform/workspaces?cursor=c+2", method: "GET", project: null, environment: null },
    { url: "https://api.mdrn.io/v1/deploy/logs/trace/tr_1?from=1&to=2", method: "GET", project: "p", environment: "sandbox" },
  ]);
  // Both are on mdrn_read_api's allowlist as well, with their own query keys and nothing else.
  for (const [path, ok] of [["/v1/platform/workspaces", true], ["/v1/platform/workspaces?cursor=x", true], ["/v1/platform/workspaces?limit=5", false], ["/v1/deploy/logs/trace/tr_1?from=1", true], ["/v1/deploy/logs/trace/tr_1?q=x", false], ["/v1/deploy/logs/trace", false], ["/v1/deploy/logs", false]]) {
    const result = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mdrn_read_api", arguments: { path, projectId: "p", environmentId: "sandbox" } } });
    assert.equal(result.result.isError, !ok, path);
  }
  // A trace without the project environment is refused before any request.
  const before = calls.length;
  const unscoped = await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mdrn_read_api", arguments: { path: "/v1/deploy/logs/trace/tr_1" } } });
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
  const response = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mdrn_read_api", arguments: { path: "https://example.com" } } });
  assert.equal(response.result.isError, true);
});

test("a malformed percent escape is refused as outside the allowlist, before any request", async () => {
  for (const path of ["/v1/platform/operations/%zz", "/v1/platform/operations/100%", "/v1/platform/operations/%E0%A4%A"]) {
    let calls = 0;
    const server = new MdrnMcpServer({ token: "secret", fetcher: async () => { calls++; return Response.json({}); } });
    const result = await server.handle({ id: 1, method: "tools/call", params: { name: "mdrn_read_api", arguments: { path } } });
    assert.equal(result.result.isError, true, path);
    assert.match(JSON.stringify(result.result.content), /Path outside read-only allowlist/, path);
    assert.equal(calls, 0);
  }
});

for (const path of ['/v1/platform/login/start','/v1/platform/workspaces/w/billing/checkout','/v1/platform/projects/../usage','/v1/platform/projects?workspaceId=w&next=https://evil.test','/v1/platform/projects?workspaceId=w&workspaceId=v','/v1/deploy/services/anything','/internal/platform/usage']) test(`rejects ${path}`,async()=>{
 let calls=0;const server=new MdrnMcpServer({token:'secret',fetcher:async()=>{calls++;return Response.json({})}});
 const result=await server.handle({id:1,method:'tools/call',params:{name:'mdrn_read_api',arguments:{path}}});assert.equal(result.result.isError,true);assert.equal(calls,0);
});
test('usage inspection is GET only and redacts echoed credential',async()=>{
 const server=new MdrnMcpServer({token:'private-token',fetcher:async(url,init)=>{assert.equal(url,'https://api.mdrn.io/v1/platform/usage?workspaceId=w&periodId=p');assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.ok(init.signal);return Response.json({echo:'private-token'});}});
 const r=await server.handle({id:1,method:'tools/call',params:{name:'mdrn_get_usage',arguments:{workspaceId:'w',periodId:'p'}}});assert.equal(r.result.isError,false);assert.doesNotMatch(r.result.content[0].text,/private-token/);
});

test('operation tool uses canonical resource without client-selected ownership',async()=>{const server=new MdrnMcpServer({token:'t',fetcher:async url=>{assert.equal(url,'https://api.mdrn.io/v1/platform/operations/op_one');return Response.json({state:'waiting'})}});const r=await server.handle({id:1,method:'tools/call',params:{name:'mdrn_get_operation',arguments:{operationId:'op_one'}}});assert.equal(r.result.isError,false)});

test('customer environment tools reject the internal Development stage',async()=>{const server=new MdrnMcpServer({token:'private-token',fetcher:async()=>{assert.fail('must not fetch')}});const r=await server.handle({id:1,method:'tools/call',params:{name:'mdrn_list_deployments',arguments:{projectId:'p',environmentId:'development'}}});assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/sandbox or production/)});

test('product tools take the project alone: an environment is refused, and mdrn_read_api reads the project route',async()=>{
 const urls=[];const server=new MdrnMcpServer({token:'tok_secret',fetcher:async url=>{urls.push(url);return Response.json({items:[]})}});
 for(const name of ['mdrn_list_products','mdrn_enable_product','mdrn_disable_product']){
  const r=await server.handle({id:1,method:'tools/call',params:{name,arguments:{projectId:'p',environmentId:'sandbox',...(name==='mdrn_list_products'?{}:{product:'mail'})}}});
  assert.equal(r.result.isError,true,name);assert.match(r.result.content[0].text,/Products belong to the project/);
 }
 assert.equal(urls.length,0);
 const listed=await server.handle({id:2,method:'tools/call',params:{name:'mdrn_list_products',arguments:{projectId:'p'}}});
 assert.equal(listed.result.isError,false,listed.result.content[0].text);
 for(const [path,ok]of[['/v1/platform/projects/p/products',true],['/v1/platform/projects/p/environments/sandbox/products',false],['/v1/platform/projects/p/environments/sandbox/identity/origins',true]]){
  const r=await server.handle({id:3,method:'tools/call',params:{name:'mdrn_read_api',arguments:{path}}});assert.equal(r.result.isError,!ok,path);
 }
 assert.deepEqual(urls,['https://api.mdrn.io/v1/platform/projects/p/products','https://api.mdrn.io/v1/platform/projects/p/products','https://api.mdrn.io/v1/platform/projects/p/environments/sandbox/identity/origins']);
});

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

test('exports the app users a page at a time, read-only, with the cursor to the next page',async()=>{
 const seen=[];const pages={'':['{"id":"u1","identities":[{"provider":"github","subject":"42"}]}\n{"id":"u2","identities":[]}\n','u2'],u2:['{"id":"u3","identities":[]}\n',null]};
 const server=new MdrnMcpServer({token:'export-bearer',fetcher:async(url,init)=>{const u=new URL(url);seen.push({path:u.pathname,search:u.search,method:init.method,accept:init.headers.get('Accept')});const [text,next]=pages[u.searchParams.get('cursor')??''];return new Response(text,{headers:{'Content-Type':'application/x-ndjson',...(next?{'MDRN-Next-Cursor':next}:{})}})}});
 const call=async(args)=>server.handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'mdrn_export_auth_users',arguments:{projectId:'p',environmentId:'production',...args}}});
 const first=await call({});assert.equal(first.result.isError,false);const page=JSON.parse(first.result.content[0].text);
 assert.deepEqual(page.items.map(u=>u.id),['u1','u2']);assert.deepEqual(page.items[0].identities,[{provider:'github',subject:'42'}]);assert.equal(page.nextCursor,'u2');
 assert.deepEqual(seen[0],{path:'/v1/platform/projects/p/environments/production/auth/users/export',search:'?limit=100',method:'GET',accept:'application/x-ndjson'});
 const last=JSON.parse((await call({cursor:'u2',limit:1000})).result.content[0].text);assert.deepEqual(last.items.map(u=>u.id),['u3']);assert.equal(last.nextCursor,null);assert.equal(seen[1].search,'?cursor=u2&limit=1000');
 const tool=(await server.handle({jsonrpc:'2.0',id:2,method:'tools/list'})).result.tools.find(t=>t.name==='mdrn_export_auth_users');assert.equal(tool.annotations.readOnlyHint,true);
 for(const limit of [0,1001,1.5])assert.equal((await call({limit})).result.isError,true,String(limit));assert.equal(seen.length,2,'refused before any request');
 const cut=new MdrnMcpServer({token:'export-bearer',fetcher:async()=>new Response('{"id":"u1"}\n{"id":',{headers:{'Content-Type':'application/x-ndjson'}})});
 const r=await cut.handle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'mdrn_export_auth_users',arguments:{projectId:'p',environmentId:'sandbox'}}});assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/cut short/);
 const refused=new MdrnMcpServer({token:'export-bearer',fetcher:async()=>Response.json({error:{code:'FORBIDDEN',message:'Exporting users needs the Admin or Developer role.'}},{status:403})});
 const f=await refused.handle({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'mdrn_export_auth_users',arguments:{projectId:'p',environmentId:'sandbox'}}});assert.equal(f.result.isError,true);assert.match(f.result.content[0].text,/FORBIDDEN: Exporting users needs the Admin or Developer role\./);
});
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
    const result = await server.handle({ id: 1, method: "tools/call", params: { name: "mdrn_read_api", arguments: { path, projectId: "p", environmentId: "sandbox" } } });
    assert.equal(result.result.isError, true, path);
    assert.match(JSON.stringify(result.result.content), /Path outside read-only allowlist/, path);
    assert.equal(calls, 0, path);
  }
});

test("mdrn_deploy_example names every example MDRN publishes, and no other", async () => {
  const { examples } = JSON.parse(readFileSync(new URL("../../templates/examples.json", import.meta.url), "utf8"));
  const response = await new MdrnMcpServer({ token: "x" }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tool = response.result.tools.find(item => item.name === "mdrn_deploy_example");
  const named = tool.description.match(/example is its name: ([^(]+)\(/)[1].split(/, | or /).map(name => name.trim()).filter(Boolean);
  assert.deepEqual(named.sort(), examples.map(example => example.slug).sort());
});
