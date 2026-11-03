import test from "node:test";
import assert from "node:assert/strict";
import { MdrnMcpServer, consoleOrigin, errorDocs } from "../src/server.js";

// A fake MDRN API answering from `routes` ("METHOD /path" -> body or [status, body]).
function fakeApi(routes = {}) {
  return async (url, init) => {
    const route = routes[`${init.method} ${new URL(url).pathname}`];
    const answer = typeof route === "function" ? route(new URL(url).searchParams) : route;
    if (answer === undefined) return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    const [status, body] = Array.isArray(answer) ? answer : [200, answer];
    return Response.json(body, { status });
  };
}
const env = { projectId: "prj_1", environmentId: "sandbox" };
const sq = { ...env, database: "sqlite" };
const pg = { ...env, database: "postgres" };
async function answer(routes, name, args, options = {}) {
  const server = new MdrnMcpServer({ token: "tok_secret", fetcher: fakeApi(routes), ...options });
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { isError: response.result.isError, text: response.result.content[0].text, json: response.result.isError ? undefined : JSON.parse(response.result.content[0].text) };
}
const tools = (steps) => steps.map((step) => step.tool ?? step.url);

test("every next step names a tool the server lists, with arguments it takes", async () => {
  const listed = (await new MdrnMcpServer({ token: "x" }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
  const cases = [
    [{ "GET /v1/platform/projects": { items: [{ id: "prj_1" }], nextCursor: null } }, "mdrn_list_projects", { workspaceId: "ws_1" }],
    [{ "GET /v1/deploy/services": { items: [] } }, "mdrn_list_deployments", env],
    [{ "GET /v1/deploy/services": { items: [{ id: "svc_1" }] } }, "mdrn_list_deployments", env],
    [{ "POST /v1/deploy/services": { id: "svc_1", name: "web" } }, "mdrn_create_deployment", { ...env, name: "web" }],
    [{ "GET /v1/deploy/services/svc_1": { id: "svc_1", hostname: "web.apps.mdrn.io" }, "POST /v1/platform/projects/prj_1/environments/sandbox/preview-grants": { url: "https://web.apps.mdrn.io/_mdrn/v1/preview?grant=g", expiresAt: "2026-10-16T12:15:00Z", ownerOnly: true } }, "mdrn_open_app", { ...env, deploymentId: "svc_1" }],
    [{ "POST /v1/platform/projects": [201, { id: "prj_2", name: "Blog" }] }, "mdrn_create_project", { workspaceId: "ws_1", name: "Blog" }],
    [{ "POST /v1/mail/messages": [202, { id: "msg_1", state: "queued" }] }, "mdrn_send_test_email", { ...env, to: "ann@example.com" }],
    [{ "POST /v1/deploy/deployments": { deploymentId: "dep_1", operationId: "op_1", state: "accepted" } }, "mdrn_roll_back", { ...env, deploymentId: "svc_1", artifactId: "art_1" }],
    [{ "POST /v1/platform/projects/prj_1/products/postgres/enable": [202, { product: "postgres", action: "enable", state: "working", operations: [{ environment: "sandbox", id: "op_1", state: "accepted", kind: "postgres.enable" }], environments: { production: { state: "waiting", reason: "go_live" } } }] }, "mdrn_enable_product", { projectId: "prj_1", product: "postgres" }],
    [{ "GET /v1/platform/projects/prj_1/products": { items: [{ product: "mail", state: "disabled", environments: { sandbox: { state: "disabled" }, production: { state: "provisioning", operationId: "op_2" } } }] } }, "mdrn_list_products", { projectId: "prj_1" }],
    [{ "GET /v1/deploy/builds/bld_1": { id: "bld_1", state: "failed", errorCode: "BUILD_FAILED" } }, "mdrn_get_build", { ...env, buildId: "bld_1" }],
    [{ "GET /v1/deploy/deployments/dep_1": { id: "dep_1", serviceId: "svc_1", state: "failed", errorCode: "RELEASE_REFUSED" } }, "mdrn_get_rollout", { ...env, rolloutId: "dep_1" }],
    [{ "GET /v1/sqlite/collections": { items: [{ name: "tasks", rowCount: 2, rowCountCapped: false }] } }, "mdrn_list_collections", sq],
    [{ "GET /v1/postgres/collections/tasks/records": { items: [{ id: "rec_1" }], nextCursor: "c2" } }, "mdrn_list_records", { ...pg, collection: "tasks", limit: 1 }],
    [{ "GET /v1/sqlite/operations/op_1": { id: "op_1", state: "running", kind: "restore" } }, "mdrn_get_database_operation", { ...sq, operationId: "op_1" }],
    [{ "GET /v1/postgres/operations/op_1": { id: "op_1", state: "succeeded", kind: "restore" } }, "mdrn_get_database_operation", { ...pg, operationId: "op_1" }],
    [{ "GET /v1/postgres/operations/op_1": { id: "op_1", state: "failed", kind: "restore", error: { code: "RESTORE_HISTORY_OFF" } } }, "mdrn_get_database_operation", { ...pg, operationId: "op_1" }],
    [{ "DELETE /v1/postgres/connection": { connection: null, redeploy: { requested: true, services: [] } } }, "mdrn_database_connection", { ...pg, action: "off" }],
    [{ "GET /v1/postgres/configuration": { revision: 1, state: "enabled", created: false } }, "mdrn_get_database_config", pg],
  ];
  for (const [routes, name, args] of cases) {
    const { json } = await answer(routes, name, args);
    assert.ok(Array.isArray(json.nextSteps) && json.nextSteps.length, name);
    for (const step of json.nextSteps) {
      assert.equal(typeof step.step, "string", name);
      if (step.url) { assert.match(step.url, /^https:\/\//); continue; }
      const tool = listed.find((t) => t.name === step.tool);
      assert.ok(tool, `${name} points at ${step.tool}`);
      for (const key of Object.keys(step.arguments)) assert.ok(key in tool.inputSchema.properties, `${step.tool} takes no ${key}`);
    }
  }
});

test("listing projects leads to their deployments; none leads to creating one", async () => {
  const one = await answer({ "GET /v1/platform/projects": { items: [{ id: "prj_1", name: "Shop" }], nextCursor: null } }, "mdrn_list_projects", { workspaceId: "ws_1" });
  assert.deepEqual(one.json.nextSteps[0], { step: "List the project's deployments", tool: "mdrn_list_deployments", arguments: { projectId: "prj_1", environmentId: "sandbox" } });
  const none = await answer({ "GET /v1/platform/projects": { items: [], nextCursor: null } }, "mdrn_list_projects", { workspaceId: "ws_1" });
  assert.deepEqual(none.json.nextSteps, [{ step: "The workspace has no project: create one", tool: "mdrn_create_project", arguments: { workspaceId: "ws_1" } }]);
});

test("an environment without a deployment leads to deploying with the CLI; a new deployment to the CLI or GitHub", async () => {
  const empty = await answer({ "GET /v1/deploy/services": { items: [] } }, "mdrn_list_deployments", env);
  assert.match(empty.json.nextSteps[0].step, /^The environment has no deployment yet\. Deploy this folder with the MDRN CLI: `npx @mdrnio\/cli login`, then `npx @mdrnio\/cli deploy`/);
  const created = await answer({ "POST /v1/deploy/services": { id: "svc_1", name: "web" } }, "mdrn_create_deployment", { ...env, name: "web" });
  assert.equal(created.json.nextSteps[0].step, "Deploy to it with the MDRN CLI: `npx @mdrnio/cli deploy --project prj_1 --deployment svc_1`, or connect its GitHub repository in the console");
  assert.equal(created.json.nextSteps[0].url, "https://console.mdrn.io/?project=prj_1");
});

test("a deploy leads to its build, the build to its deployment, a live deployment to its address and a product", async () => {
  const connection = { installationId: "11", repositoryId: "22", branch: "main", autoDeploy: true };
  const deployed = await answer({ "GET /v1/deploy/services/svc_1/github": connection, "PUT /v1/deploy/services/svc_1/github": { serviceId: "svc_1", branch: "main" } }, "mdrn_deploy_from_github", { ...env, deploymentId: "svc_1" });
  assert.equal(deployed.json.building, true);
  assert.deepEqual(deployed.json.nextSteps, [{ step: "Find the new build and follow it", tool: "mdrn_list_builds", arguments: { ...env, deploymentId: "svc_1" } }]);
  const running = await answer({ "GET /v1/deploy/builds/bld_1": { id: "bld_1", state: "building" } }, "mdrn_get_build", { ...env, buildId: "bld_1" });
  assert.deepEqual(tools(running.json.nextSteps), ["mdrn_get_build_logs", "mdrn_get_build"]);
  const built = await answer({ "GET /v1/deploy/builds/bld_1": { id: "bld_1", state: "succeeded", deploymentId: "dep_1" } }, "mdrn_get_build", { ...env, buildId: "bld_1" });
  assert.deepEqual(built.json.nextSteps, [{ step: "Follow it being put live until it is ready", tool: "mdrn_get_rollout", arguments: { ...env, rolloutId: "dep_1" } }]);
  const live = await answer({ "GET /v1/deploy/deployments/dep_1": { id: "dep_1", serviceId: "svc_1", state: "ready", hostname: "shop.apps.mdrn.io" } }, "mdrn_get_rollout", { ...env, rolloutId: "dep_1" });
  assert.deepEqual(live.json.nextSteps, [{ step: "Get a link to open the app", tool: "mdrn_open_app", arguments: { ...env, deploymentId: "svc_1" } }]);
});

test("a failed build or deployment carries the end of its own log, and leads to the full log and the docs for its code", async () => {
  // Two pages of build output, then an empty one: the tail is the last 20 lines, as the build printed them.
  const lines = Array.from({ length: 25 }, (_, index) => ({ sequence: index + 1, message: `line ${index + 1}`, createdAt: 1 }));
  const pages = { 0: [lines.slice(0, 20), "20"], 20: [lines.slice(20), "25"], 25: [[], "25"] };
  const buildLogs = (search) => { const [items, nextCursor] = pages[search.get("cursor")]; return { items, nextCursor, state: "failed", complete: true }; };
  const failed = await answer({ "GET /v1/deploy/builds/bld_1": { id: "bld_1", state: "failed", errorCode: "BUILD_FAILED" }, "GET /v1/deploy/builds/bld_1/logs": buildLogs }, "mdrn_get_build", { ...env, buildId: "bld_1" });
  assert.deepEqual(failed.json.logTail, lines.slice(5).map((line) => line.message));
  assert.deepEqual(failed.json.nextSteps, [
    { step: "logTail is the end of its own output, which says why it failed; read all of it from the start", tool: "mdrn_get_build_logs", arguments: { ...env, buildId: "bld_1" } },
    { step: "Read what BUILD_FAILED means and what to do", url: "https://mdrn.io/docs/errors/#builds" },
  ]);
  // A build that is not failed reads no log.
  const built = await answer({ "GET /v1/deploy/builds/bld_1": { id: "bld_1", state: "succeeded", deploymentId: "dep_1" } }, "mdrn_get_build", { ...env, buildId: "bld_1" });
  assert.equal(built.json.logTail, undefined);
  const deploymentLogs = (search) => (search.get("cursor") === "0" ? { items: [{ sequence: 1, cursor: 1, createdAt: 1, stage: "migration", message: "0001_init.sql applied" }, { sequence: 2, cursor: 2, createdAt: 1, stage: "readiness", message: "GET /health answered 500" }], nextCursor: 2 } : { items: [], nextCursor: 2 });
  const refused = await answer({ "GET /v1/deploy/deployments/dep_1": { id: "dep_1", serviceId: "svc_1", state: "failed", errorCode: "DEPLOYMENT_FAILED" }, "GET /v1/deploy/deployments/dep_1/logs": deploymentLogs }, "mdrn_get_rollout", { ...env, rolloutId: "dep_1" });
  assert.deepEqual(refused.json.logTail, ["[migration] 0001_init.sql applied", "[readiness] GET /health answered 500"]);
  assert.deepEqual(tools(refused.json.nextSteps), ["https://mdrn.io/docs/errors/#releases", "mdrn_list_builds"]);
  // A log that cannot be read leaves logTail null; the deployment still comes back.
  const unread = await answer({ "GET /v1/deploy/deployments/dep_1": { id: "dep_1", serviceId: "svc_1", state: "failed", errorCode: "DEPLOYMENT_FAILED" } }, "mdrn_get_rollout", { ...env, rolloutId: "dep_1" });
  assert.equal(unread.isError, false);
  assert.equal(unread.json.logTail, null);
});

test("switching a product on leads to each environment's operation, and the operation to the product states", async () => {
  const enabled = await answer({ "POST /v1/platform/projects/prj_1/products/sqlite/enable": [202, { product: "sqlite", action: "enable", state: "working", operations: [{ environment: "sandbox", id: "op_1", state: "accepted", kind: "sqlite.enable" }], environments: { production: { state: "waiting", reason: "go_live" } } }] }, "mdrn_enable_product", { projectId: "prj_1", product: "sqlite" });
  assert.deepEqual(enabled.json.nextSteps, [
    { step: "sandbox is still changing: read its operation again shortly", tool: "mdrn_get_operation", arguments: { operationId: "op_1" } },
    { step: "See the product states", tool: "mdrn_list_products", arguments: { projectId: "prj_1" } },
  ]);
  const done = await answer({ "GET /v1/platform/operations/op_1": { id: "op_1", state: "succeeded", kind: "sqlite.enable", ...env } }, "mdrn_get_operation", { operationId: "op_1" });
  assert.deepEqual(done.json.nextSteps, [{ step: "See the product states", tool: "mdrn_list_products", arguments: { projectId: "prj_1" } }]);
  const unpaid = await answer({ "GET /v1/platform/operations/op_1": { id: "op_1", state: "failed", kind: "mail.enable", ...env, error: { code: "PAYMENT_REQUIRED", message: "x", retryable: false, requestId: "r" } } }, "mdrn_get_operation", { operationId: "op_1" });
  assert.deepEqual(tools(unpaid.json.nextSteps), ["https://console.mdrn.io/go-live", "https://mdrn.io/docs/errors/#billing", "mdrn_list_products"]);
  const products = await answer({ "GET /v1/platform/projects/prj_1/products": { items: [
    { product: "sqlite", state: "enabled", environments: { sandbox: { state: "enabled" }, production: { state: "waiting", reason: "go_live" } } },
    { product: "mail", state: "disabled", environments: { sandbox: { state: "disabled" }, production: { state: "waiting", reason: "go_live" } } },
    { product: "objects", state: "working", environments: { sandbox: { state: "provisioning", operationId: "op_2" }, production: { state: "waiting", reason: "go_live" } } },
  ] } }, "mdrn_list_products", { projectId: "prj_1" });
  assert.deepEqual(products.json.nextSteps, [
    { step: "objects is being switched on in sandbox: follow its operation", tool: "mdrn_get_operation", arguments: { operationId: "op_2" } },
    { step: "Switch a product on (off now: mail)", tool: "mdrn_enable_product", arguments: { projectId: "prj_1" } },
  ]);
});

test("a refusal for want of a plan says the workspace needs the $25 plan and links the console's go-live screen", async () => {
  const refused = await answer({ "POST /v1/platform/projects/prj_1/products/mail/enable": [402, { error: { code: "PRODUCT_ENTITLEMENT_REQUIRED", message: "An active plan is required" } }] }, "mdrn_enable_product", { projectId: "prj_1", product: "mail" });
  assert.equal(refused.isError, true);
  assert.equal(refused.text, "PRODUCT_ENTITLEMENT_REQUIRED: An active plan is required\nNext: The workspace needs the $25 plan: an Admin goes live in the console: https://console.mdrn.io/go-live\nNext: Read what PRODUCT_ENTITLEMENT_REQUIRED means and what to do: https://mdrn.io/docs/errors/#every-product");
  // The development stage's console is its own.
  const development = await answer({ "POST /v1/deploy/deployments": [402, { error: { code: "PAYMENT_REQUIRED", message: "No active plan" } }] }, "mdrn_roll_back", { ...env, deploymentId: "svc_1", artifactId: "art_1" }, { origin: "https://development.api.mdrn.io" });
  assert.match(development.text, /\nNext: The workspace needs the \$25 plan: an Admin goes live .*: https:\/\/development\.console\.mdrn\.io\/go-live\n/);
  const limit = await answer({ "POST /v1/deploy/deployments": [402, { error: { code: "BUILD_LIMIT_REACHED", message: "Build mode limit reached" } }] }, "mdrn_roll_back", { ...env, deploymentId: "svc_1", artifactId: "art_1" });
  assert.equal(limit.text, "BUILD_LIMIT_REACHED: Build mode limit reached\nNext: Build mode limit reached: tell the person. Going live (an Admin, in the console) lifts it: https://console.mdrn.io/go-live\nNext: Read what BUILD_LIMIT_REACHED means and what to do: https://mdrn.io/docs/errors/#billing");
  const openApp = await answer({ "GET /v1/deploy/services/svc_1": [403, { error: { code: "NOT_LIVE_YET", message: "This app isn't live yet." } }] }, "mdrn_open_app", { ...env, deploymentId: "svc_1" });
  assert.equal(openApp.text, "NOT_LIVE_YET: This app isn't live yet.\nNext: The app is in build mode and only the person can open it: get them a link with mdrn_open_app; or an Admin goes live in the console: https://console.mdrn.io/go-live\nNext: Read what NOT_LIVE_YET means and what to do: https://mdrn.io/docs/errors/#visitors-to-your-app");
  const live = await answer({ "POST /v1/deploy/deployments": [402, { error: { code: "BUILD_MODE_GO_LIVE_REQUIRED", message: "Go live" } }] }, "mdrn_roll_back", { ...env, deploymentId: "svc_1", artifactId: "art_1" });
  assert.equal(live.text, "BUILD_MODE_GO_LIVE_REQUIRED: Go live\nNext: This comes with going live: tell the person instead of working around it. An Admin goes live in the console: https://console.mdrn.io/go-live\nNext: Read what BUILD_MODE_GO_LIVE_REQUIRED means and what to do: https://mdrn.io/docs/errors/#billing");
  // A Postgres database being made at its first use: the same call again shortly goes through.
  const starting = await answer({ "POST /v1/postgres/sql": [503, { error: { code: "DATABASE_STARTING", message: "Your Postgres database is being created. This takes a few seconds the first time; try again shortly." } }] }, "mdrn_run_sql", { ...pg, sql: "SELECT 1" });
  assert.equal(starting.text, "DATABASE_STARTING: Your Postgres database is being created. This takes a few seconds the first time; try again shortly.\nNext: The Postgres database is being made, the first time it is used: call the same tool again in a few seconds, with the same idempotencyKey: https://mdrn.io/docs/errors/#database");
  const blocked = await answer({ "POST /v1/deploy/deployments": [403, { error: { code: "WORKSPACE_BLOCKED", message: "Stopped" } }] }, "mdrn_roll_back", { ...env, deploymentId: "svc_1", artifactId: "art_1" });
  assert.equal(blocked.text, "WORKSPACE_BLOCKED: Stopped\nNext: MDRN stopped this workspace: if you think this is a mistake, contact us from the console: https://console.mdrn.io\nNext: Read what WORKSPACE_BLOCKED means and what to do: https://mdrn.io/docs/errors/#billing");
  for (const text of [refused.text, development.text, limit.text, live.text, openApp.text]) assert.doesNotMatch(text, /trial's|free trial|card/i);
  const recipient = await answer({ "POST /v1/deploy/deployments": [403, { error: { code: "BUILD_MAIL_RECIPIENT", message: "Own address only" } }] }, "mdrn_roll_back", { ...env, deploymentId: "svc_1", artifactId: "art_1" });
  assert.equal(recipient.text, "BUILD_MAIL_RECIPIENT: Own address only\nNext: In build mode mail goes only to members of your workspace: send to one of them, or an Admin goes live in the console: https://console.mdrn.io/go-live\nNext: Read what BUILD_MAIL_RECIPIENT means and what to do: https://mdrn.io/docs/errors/#mail");
  // A refusal without a code adds nothing.
  const bare = await answer({ "POST /v1/deploy/deployments": [500, {}] }, "mdrn_roll_back", { ...env, deploymentId: "svc_1", artifactId: "art_1" });
  assert.doesNotMatch(bare.text, /Next:/);
});

test("the console and the docs a step links", () => {
  assert.equal(consoleOrigin("https://api.mdrn.io"), "https://console.mdrn.io");
  assert.equal(consoleOrigin("https://development.api.mdrn.io"), "https://development.console.mdrn.io");
  assert.equal(consoleOrigin("http://127.0.0.1:8787"), "https://console.mdrn.io");
  assert.equal(errorDocs("SPENDING_CAP_REACHED"), "https://mdrn.io/docs/errors/#billing");
  assert.equal(errorDocs("SOMETHING_NEW"), "https://mdrn.io/docs/errors/");
});
