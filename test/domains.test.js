import test from "node:test";
import assert from "node:assert/strict";
import { MdrnMcpServer } from "../src/server.js";

const SENDERS = "/v1/platform/projects/prj_1/environments/production/mail/senders";
const env = { projectId: "prj_1", environmentId: "production" };

// A fake MDRN API: each path answers its JSON, or the status given for it.
function fakeApi(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method, path: pathname, headers: init.headers });
    const answer = routes[pathname];
    if (typeof answer === "number") return Response.json({ error: { code: "UPSTREAM", message: "a provider's own words" } }, { status: answer });
    if (answer === undefined) return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    return Response.json(answer);
  };
  return { calls, fetcher };
}
const routes = (senders) => ({
  "/v1/deploy/owned-domains": { items: [
    { id: "od_1", name: "example.com", state: "verified", records: [{ purpose: "ownership", type: "TXT", name: "_mdrn.example.com", value: "v=1", optional: false, note: null }], verifiedAt: 1760000000, createdAt: 1, updatedAt: 1 },
    { id: "od_2", name: "other.dev", state: "pending", records: [], verifiedAt: null, createdAt: 1, updatedAt: 1 },
  ], nextCursor: null },
  "/v1/deploy/domains": { items: [
    { id: "dom_1", hostname: "www.example.com", use: "deployment", serviceId: "svc_1", ownedDomainId: "od_1", state: "active" },
    { id: "dom_2", hostname: "dl.example.com", use: "downloads", serviceId: null, ownedDomainId: "od_1", state: "ssl_pending" },
    { id: "dom_3", hostname: "example.com", use: "deployment", serviceId: "svc_1", ownedDomainId: null, state: "ownership_pending" },
    { id: "dom_4", hostname: "notexample.com", use: "deployment", serviceId: "svc_1", ownedDomainId: null, state: "active" },
  ], nextCursor: null, quota: {} },
  "/v1/deploy/services": { items: [{ id: "svc_1", name: "web" }] },
  [SENDERS]: senders,
});
const call = async (server, args = env) => {
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mdrn_list_owned_domains", arguments: args } });
  return { isError: response.result.isError, text: response.result.content[0].text, value: response.result.isError ? undefined : JSON.parse(response.result.content[0].text) };
};

test("mdrn_list_owned_domains is a read: each own domain with its hosts and mail senders", async () => {
  const api = fakeApi(routes({ items: [
    { id: "snd_1", domain: "mail.example.com", state: "ready", dnsInstructions: [], local: "hello", address: "hello@mail.example.com" },
    { id: "snd_2", domain: "example.com", state: "pending", dnsInstructions: [] },
    { id: "snd_3", domain: "example.com", state: "disabled", dnsInstructions: [] },
  ], nextCursor: null }));
  const { isError, text, value } = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher }));
  assert.equal(isError, false, text);
  assert.equal(value.mailRead, true);
  assert.equal(value.mailNote, undefined);
  assert.deepEqual(value.items.map((item) => [item.name, item.state]), [["example.com", "verified"], ["other.dev", "pending"]]);
  assert.equal(value.items[0].records[0].type, "TXT");
  assert.deepEqual(value.items[0].uses, [
    { use: "deployment", id: "dom_1", hostname: "www.example.com", deploymentId: "svc_1", deployment: "web", state: "active" },
    { use: "downloads", id: "dom_2", hostname: "dl.example.com", state: "ssl_pending" },
    { use: "deployment", id: "dom_3", hostname: "example.com", deploymentId: "svc_1", deployment: "web", state: "ownership_pending" },
    { use: "mail", id: "snd_1", address: "hello@mail.example.com", domain: "mail.example.com", state: "ready" },
    { use: "mail", id: "snd_2", address: "noreply@example.com", domain: "example.com", state: "pending" },
  ]);
  assert.deepEqual(value.items[1].uses, []);
  assert.ok(api.calls.every((c) => c.method === "GET"));
  const owned = api.calls.find((c) => c.path === "/v1/deploy/owned-domains");
  assert.equal(owned.headers.get("mdrn-project"), "prj_1");
  assert.equal(owned.headers.get("mdrn-environment"), "production");
  const { result } = await new MdrnMcpServer({ token: "x" }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(result.tools.find((tool) => tool.name === "mdrn_list_owned_domains").annotations.readOnlyHint, true);
});

test("Mail that cannot be read leaves the domains answered, in our words; Deploy refusing fails the tool", async () => {
  const api = fakeApi(routes(503));
  const { isError, value, text } = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher }));
  assert.equal(isError, false, text);
  assert.equal(value.mailRead, false);
  assert.match(value.mailNote, /^Mail could not be read just now/);
  assert.ok(!text.includes("provider"));
  assert.ok(value.items[0].uses.every((item) => item.use !== "mail"));
  const refused = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: fakeApi({ ...routes(503), "/v1/deploy/owned-domains": 409 }).fetcher }));
  assert.equal(refused.isError, true);
});

const tool = async (server, name, args) => {
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { isError: response.result.isError, text: response.result.content[0].text, value: response.result.isError ? undefined : JSON.parse(response.result.content[0].text) };
};

test("mdrn_list_domains and mdrn_read_api answer a host's error in our words, never the provider's", async () => {
  const OURS = "This hostname is already connected to another account elsewhere.";
  const hosts = { items: [
    { id: "dom_1", hostname: "a.example.com", state: "failed", error: "Custom hostname does not CNAME to this zone (provider code 1414)" },
    { id: "dom_2", hostname: "b.example.com", state: "failed", error: OURS },
    { id: "dom_3", hostname: "c.example.com", state: "ownership_pending", error: "Cloudflare has verified the CNAME, but this workspace has not yet proved it controls the hostname. Add the ownership TXT record below; the hostname is checked again on its own, or use Check now." },
    { id: "dom_4", hostname: "d.example.com", state: "ssl_pending", error: "caa_error: provider text" },
    { id: "dom_5", hostname: "e.example.com", state: "active", error: null },
  ], nextCursor: null, quota: {} };
  const api = fakeApi({ "/v1/deploy/domains": hosts, "/v1/deploy/domains/dom_1": hosts.items[0] });
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher });
  const { isError, text, value } = await tool(server, "mdrn_list_domains", env);
  assert.equal(isError, false, text);
  const errors = value.items.map((item) => item.error);
  assert.match(errors[0], /^This hostname could not be set up, so it is not served and not charged/);
  assert.equal(errors[1], OURS);
  assert.match(errors[2], /^The CNAME points to MDRN, but this workspace/);
  assert.match(errors[3], /^The certificate is not issued yet/);
  assert.equal(errors[4], null);
  assert.doesNotMatch(text, /provider|Cloudflare|1414|caa_error/);
  for (const path of ["/v1/deploy/domains", "/v1/deploy/domains/dom_1"]) {
    const read = await tool(server, "mdrn_read_api", { path, ...env });
    assert.equal(read.isError, false, read.text);
    assert.doesNotMatch(read.text, /provider|Cloudflare|1414|caa_error/);
  }
});

const SENDER_LIST = { items: [
  { id: "snd_old", domain: "example.com", state: "disabled", local: "noreply", address: "noreply@example.com", dnsInstructions: [] },
  { id: "snd_1", domain: "example.com", state: "ready", local: "noreply", address: "noreply@example.com", dnsInstructions: [] },
  { id: "snd_2", domain: "mail.example.com", state: "ready", local: "noreply", address: "noreply@mail.example.com", dnsInstructions: [] },
], nextCursor: null };

test("mdrn_set_mail_address changes the sender on that domain, with an Idempotency-Key, and is a change needing mail:write", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method, path: pathname, headers: new Headers(init.headers), body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (init.method === "GET") return Response.json(SENDER_LIST);
    return Response.json({ id: "snd_1", domain: "example.com", state: "ready", local: "orders", address: "orders@example.com", dnsInstructions: [] });
  };
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher });
  const { isError, text, value } = await tool(server, "mdrn_set_mail_address", { ...env, address: "orders@Example.com", idempotencyKey: "k1" });
  assert.equal(isError, false, text);
  assert.equal(value.address, "orders@example.com");
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [["GET", SENDERS], ["PATCH", `${SENDERS}/snd_1`]]);
  assert.deepEqual(calls[1].body, { local: "orders" });
  assert.equal(calls[1].headers.get("idempotency-key"), "k1");
  const { result } = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const listed = result.tools.find((t) => t.name === "mdrn_set_mail_address");
  assert.equal(listed.annotations.readOnlyHint, false);
  assert.equal(listed.annotations.destructiveHint, false);
  assert.deepEqual(listed.inputSchema.required, ["projectId", "environmentId", "address"]);
  // Scopes: mail:write, and in Production production:write too.
  const readOnly = await tool(new MdrnMcpServer({ token: "tok_secret", fetcher, scopes: ["mail:read"] }), "mdrn_set_mail_address", { ...env, address: "orders@example.com" });
  assert.match(readOnly.text, /insufficient_scope: this connection was not allowed changing mail settings \(mail:write\)/);
  const sandboxOnly = await tool(new MdrnMcpServer({ token: "tok_secret", fetcher, scopes: ["mail:write"] }), "mdrn_set_mail_address", { ...env, address: "orders@example.com" });
  assert.match(sandboxOnly.text, /may only read Production/);
  const sandbox = await tool(new MdrnMcpServer({ token: "tok_secret", fetcher, scopes: ["mail:write"] }), "mdrn_set_mail_address", { projectId: "prj_1", environmentId: "sandbox", address: "orders@example.com" });
  assert.equal(sandbox.isError, false, sandbox.text);
});

test("mdrn_set_mail_address refuses a bad address before asking, and a domain that sends no mail says where to add it", async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push(init.method); return Response.json(SENDER_LIST); };
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher });
  for (const address of ["orders", "Orders@example.com", "a+b@example.com", "a..b@example.com", ".a@example.com", "a-@example.com", `${"a".repeat(65)}@example.com`, "a@b@example.com"]) {
    const r = await tool(server, "mdrn_set_mail_address", { ...env, address });
    assert.equal(r.isError, true, address);
    assert.match(r.text, /Invalid argument address/, address);
  }
  assert.deepEqual(calls, []);
  const none = await tool(server, "mdrn_set_mail_address", { ...env, address: "orders@other.dev" });
  assert.equal(none.isError, true);
  assert.match(none.text, /^NO_MAIL_SENDER: other\.dev sends no mail yet/);
  assert.deepEqual(calls, ["GET"]);
});

test("a connection without mail:read reads no mail and says why; one without deploy:read is refused", async () => {
  const api = fakeApi(routes({ items: [], nextCursor: null }));
  const { value } = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["deploy:read"] }));
  assert.equal(value.mailRead, false);
  assert.match(value.mailNote, /not allowed to read mail/);
  assert.ok(!api.calls.some((c) => c.path === SENDERS));
  const refused = await call(new MdrnMcpServer({ token: "tok_secret", fetcher: api.fetcher, scopes: ["mail:read"] }));
  assert.equal(refused.isError, true);
  assert.match(refused.text, /insufficient_scope/);
});
