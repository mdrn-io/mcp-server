# MDRN MCP server

`@mdrnio/mcp-server` connects an AI assistant to MDRN: your workspaces, projects and products,
deployments and their builds, logs, the SQLite and Postgres databases, stored files (Objects),
sent mail and sign-in (Auth), and the changes you allow it: put a build back live, set a variable,
turn a product on or off, store or delete a file, send a test email, set who must sign in, and
manage the databases. To deploy, the assistant uses the MDRN CLI (`npx @mdrnio/cli deploy`); the
server's instructions tell it so. Nothing it offers deletes a deployment, a product or a domain;
the tools that can take something away are annotated destructive and ask the person first.

The same tools are served two ways:

- **Hosted** (streamable HTTP, MCP protocol 2025-06-18) at `https://mcp.mdrn.io/mcp`
  (development stage: `https://development.mcp.mdrn.io/mcp`). You sign in with MDRN (OAuth 2.1),
  pick one workspace and answer two questions: what it can do (Read, or Read and write, the
  default; or per product) and where (Sandbox, ticked at first, and Production). An environment
  left unticked is out of its reach, to read as to write.
- **Local** (stdio): `npx -y @mdrnio/mcp-server`, signed in as you are on this machine (below).

## Install (local)

The local server needs Node.js 20 or later; `npx -y @mdrnio/mcp-server` fetches it on first use
and runs it, so there is nothing else to install. Sign in once with `mdrn login`
(`npm install -g @mdrnio/cli`), or set `MDRN_API_TOKEN` to a management token (a workspace Admin
creates one in the console under Workspace, Tokens).

- With `mdrn login`, the server uses the CLI profile (`MDRN_PROFILE`, or `default`) and its
  origin: the sign-in's access token, refreshed by the CLI's own code when it is about to expire
  or once after MDRN refuses it, so `mdrn logout` ends this server's access too.
- `MDRN_API_TOKEN` wins when set, with optional `MDRN_API_ORIGIN` (default
  `https://api.mdrn.io`; https only, except a development server on localhost).

Claude Desktop (`claude_desktop_config.json`, Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "mdrn": {
      "command": "npx",
      "args": ["-y", "@mdrnio/mcp-server"]
    }
  }
}
```

Cursor (`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "mdrn": {
      "command": "npx",
      "args": ["-y", "@mdrnio/mcp-server"]
    }
  }
}
```

Claude Code: `claude mcp add mdrn -- npx -y @mdrnio/mcp-server`.

To use a management token instead of the sign-in, add `"env": { "MDRN_API_TOKEN": "mdrn_mgmt_..." }`
to the entry (Claude Code: `claude mcp add mdrn -e MDRN_API_TOKEN=mdrn_mgmt_... -- npx -y @mdrnio/mcp-server`).

On Windows, a client that starts the command itself (not through a shell) needs `npx` run
through `cmd`:

```json
{
  "mcpServers": {
    "mdrn": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@mdrnio/mcp-server"]
    }
  }
}
```

## Connect (hosted)

- **Claude.ai** (and Claude Desktop): Settings, Connectors, Add custom connector, URL
  `https://mcp.mdrn.io/mcp`. Claude opens MDRN's sign-in, then the approval page ("Claude
  wants to connect to MDRN"): pick the workspace, what it can do and where.
- **ChatGPT**: Settings, Connectors (developer mode), Create, URL `https://mcp.mdrn.io/mcp`,
  authentication OAuth; the same sign-in and consent follow.
- **Claude Code**: `claude mcp add --transport http mdrn https://mcp.mdrn.io/mcp`, then `/mcp`
  to sign in.

A connection is listed in the console under Workspace, Tokens, Connected apps, where Revoke ends
it at once: the next tool call answers 401 and the client asks you to sign in again.

## Tools

| Tool | Arguments | Does |
| --- | --- | --- |
| `mdrn_list_workspaces` | optional `cursor` | List the workspaces you can reach, with your role in each. |
| `mdrn_list_projects` | `workspaceId` | List the projects of a workspace. |
| `mdrn_create_project` | `workspaceId`, `name`, optional `idempotencyKey` | **Change.** Create a project in a workspace, with its sandbox and production environments and every product on. |
| `mdrn_list_products` | `projectId` | Show which products a project has on (sqlite, postgres, objects, mail, logs, auth) and each one's state in sandbox and production. |
| `mdrn_enable_product` | `projectId`, `product`, optional `idempotencyKey` | **Change.** Turn a product back on for a project, in sandbox and production at once (each keeps its own data). |
| `mdrn_disable_product` | `projectId`, `product`, optional `idempotencyKey` | **Change.** Turn a product off for a project, in sandbox and production at once. |
| `mdrn_get_operation` | `operationId` | Check a change that takes a while (a product turned on or off): its state is accepted or running until it is succeeded or failed. |
| `mdrn_get_billing` | `workspaceId` | Read the workspace's plan, whether it is in build mode, its credit and invoices. |
| `mdrn_get_usage` | `workspaceId`, optional `periodId` | Read what the workspace used this period (or periodId), per meter. |
| `mdrn_list_deployments` | `projectId`, `environmentId` | List the deployments of a project environment: each serves one app at its own address (hostname). |
| `mdrn_create_deployment` | `projectId`, `environmentId`, `name`, optional `idempotencyKey` | **Change.** Create an empty deployment in a project environment. |
| `mdrn_list_builds` | `projectId`, `environmentId`, `deploymentId`, optional `cursor` | List a deployment's builds, newest first: its history. |
| `mdrn_get_build` | `projectId`, `environmentId`, `buildId` | Read one build: its steps, state and artifact. |
| `mdrn_get_build_logs` | `projectId`, `environmentId`, `buildId`, optional `cursor` | Read a build's output, while it runs or after. |
| `mdrn_get_rollout` | `projectId`, `environmentId`, `rolloutId` | Follow a build being put live (the rolloutId a build or mdrn_roll_back answers): accepted, publishing or verifying until it is ready or failed. |
| `mdrn_deploy_from_github` | `projectId`, `environmentId`, `deploymentId`, optional `idempotencyKey` | **Change.** Build and put live what a deployment's connected GitHub branch holds now, as a push would. |
| `mdrn_deploy_example` | `projectId`, `environmentId`, `deploymentId`, `example`, optional `idempotencyKey` | **Change.** Deploy one of MDRN's example apps into a deployment, built as an upload. |
| `mdrn_roll_back` | `projectId`, `environmentId`, `deploymentId`, `artifactId`, optional `idempotencyKey` | **Change.** Put an earlier build of a deployment back live, by its artifactId from mdrn_list_builds. |
| `mdrn_list_variables` | `projectId`, `environmentId`, `deploymentId` | List a deployment's environment variables: name, whether it is secret, whether its builds get it too, and when it was last set. A plain variable's value comes with it; a secret's value never does. |
| `mdrn_set_variable` | `projectId`, `environmentId`, `deploymentId`, `name`, `value`, optional `secret`, `build`, `idempotencyKey` | **Change.** Set an environment variable on a deployment. |
| `mdrn_unset_variable` | `projectId`, `environmentId`, `deploymentId`, `name`, optional `idempotencyKey` | **Change.** Remove an environment variable from a deployment; the serving build is put live again without it. |
| `mdrn_clear_build_cache` | `projectId`, `environmentId`, `deploymentId`, optional `idempotencyKey` | **Change.** Delete a deployment's build cache: its next build downloads and compiles everything again. Refused while a build of the deployment is running. |
| `mdrn_list_domains` | `projectId`, `environmentId` | List an environment's custom domains with their DNS records and state. A host's `error` is in MDRN's words, never the provider's. |
| `mdrn_list_owned_domains` | `projectId`, `environmentId` | List the environment's own domains (such as example.com) and what answers under each: the hosts serving a deployment or the downloads, and the mail senders, each with its state. Mail that cannot be read leaves the domains answered, with `mailRead` false. |
| `mdrn_set_mail_address` | `projectId`, `environmentId`, `address`, optional `idempotencyKey` | **Change.** Choose the address an environment's mail leaves from on one of its mail domains, such as orders@example.com (noreply@ until chosen). |
| `mdrn_open_app` | `projectId`, `environmentId`, `deploymentId` | Get a link that opens a deployment's app at its own address, signed in as the person. |
| `mdrn_search_logs` | `projectId`, `environmentId`, optional `q`, `level`, `from`, `to`, `deploymentId`, `cursor` | Search an environment's application logs (requests, console lines, errors), newest first. |
| `mdrn_get_request_logs` | `projectId`, `environmentId`, `traceId`, optional `from`, `to` | Read everything one request logged, across the environment's deployments, by its trace id (a search result's traceId); from and to are Unix milliseconds, the last hour when left out. |
| `mdrn_get_database_config` | `projectId`, `environmentId`, `database` | Read one environment's SQLite or Postgres database: state, created (false for a Postgres database not made yet), revision, restore window and history, and the Postgres connection string's role and host (the host only for an Admin or Developer; never its password). |
| `mdrn_list_collections` | `projectId`, `environmentId`, `database` | List the database's collections (what the app stores through the SDK's records API) by name, each with its record count up to 1000. |
| `mdrn_list_records` | `projectId`, `environmentId`, `database`, `collection`, optional `limit`, `cursor` | List one page of a collection's records, by id, each with its data and version. |
| `mdrn_get_record` | `projectId`, `environmentId`, `database`, `collection`, `recordId` | Read one record of a collection, with its data and version. |
| `mdrn_list_database_backups` | `projectId`, `environmentId`, `database` | List the snapshots the SQLite database can be restored to (taken before every restore and deletion, kept 7 days). |
| `mdrn_get_database_operation` | `projectId`, `environmentId`, `database`, `operationId` | Check a database restore or deletion: accepted or running until it is succeeded or failed. |
| `mdrn_set_database_restore_history` | `projectId`, `environmentId`, `database`, `restoreHistoryDays`, optional `idempotencyKey` | **Change, can take something away.** Set how far back Postgres can be restored: 0 turns it off, or 1, 7 or 30 days. |
| `mdrn_run_sql` | `projectId`, `environmentId`, `database`, `sql`, optional `params`, `idempotencyKey` | **Change, can take something away.** Run one SQL statement on the environment's SQLite or Postgres database, in its dialect, and answer the rows. |
| `mdrn_database_connection` | `projectId`, `environmentId`, `database`, `action`, optional `redeploy`, `idempotencyKey` | **Change, can take something away.** Change the Postgres connection string: on turns it on and rotate makes a new one (both answer it once), off stops it for good, stop_previous stops the string a rotation replaced. |
| `mdrn_restore_database` | `projectId`, `environmentId`, `database`, `confirmOverwrite`, optional `timestamp`, `backupId`, `idempotencyKey` | **Change, can take something away.** Restore the environment's SQLite or Postgres database to an earlier state: timestamp (an ISO 8601 moment in the restore window) or, for SQLite, backupId (from mdrn_list_database_backups). |
| `mdrn_list_objects` | `projectId`, `environmentId`, optional `limit`, `cursor` | List an environment's stored files (Objects), newest first: id, filename, size, content type and state. |
| `mdrn_get_object_link` | `projectId`, `environmentId`, `objectId` | Get a download link for one stored file. |
| `mdrn_upload_object` | `projectId`, `environmentId`, `filename`, optional `contentType`, `text`, `base64`, `idempotencyKey` | **Change.** Store a file in an environment's Objects: text, or base64 for anything else, at most 4 MiB. |
| `mdrn_delete_object` | `projectId`, `environmentId`, `objectId`, optional `idempotencyKey` | **Change, can take something away.** Delete a stored file. |
| `mdrn_list_mail_messages` | `projectId`, `environmentId`, optional `status`, `cursor` | List the emails an environment's app sent, newest first: id, status (queued, sending, accepted, delivered, bounced, complained, failed), recipient, subject and when. |
| `mdrn_get_mail_message` | `projectId`, `environmentId`, `messageId` | Read one sent email whole: status, why it failed or bounced, its timeline, and the body while it is still kept. |
| `mdrn_send_test_email` | `projectId`, `environmentId`, `to`, optional `idempotencyKey` | **Change.** Send one plain test email through the environment's Mail, as the app would, to see that mail works. It counts like any email the app sends: metered, and toward the hourly, daily and build-mode limits. |
| `mdrn_get_auth_settings` | `projectId`, `environmentId` | Read who must sign in to each deployment of an environment (signIn: everyone must sign in except on its publicPaths, the app decides, or off), the account page your users manage themselves on, and the sign-in session limits. |
| `mdrn_set_sign_in` | `projectId`, `environmentId`, `deploymentId`, `mode`, optional `publicPaths`, `idempotencyKey` | **Change.** Set who must sign in to one deployment: everyone (everyone must sign in, except on publicPaths such as / or /blog/*), app_decides (the app asks MDRN who is signed in and decides), or off. |
| `mdrn_list_auth_users` | `projectId`, `environmentId`, optional `email`, `cursor` | List the app's users (the people who signed in to it), newest first: id, email, name, whether disabled, when created and last signed in. |
| `mdrn_export_auth_users` | `projectId`, `environmentId`, optional `cursor`, `limit` | Export the app's users a page at a time in id order, with every sign-in method and the subject ID its provider knows each by, to move them to another system. |
| `mdrn_read_api` | `path`, optional `projectId`, `environmentId` | Read an MDRN API page no other tool covers, by its path: the workspaces, projects, usage, an operation, the products, billing, the deployments, domains, a rollout or a request's logs. |

`environmentId` is `sandbox` or `production`; `product` is `sqlite`, `postgres`, `objects`, `mail`,
`logs` or `auth`; `database` is `sqlite` or `postgres`; `deploymentId` is a deployment from
`mdrn_list_deployments`. Products belong to the project: a new project starts with every product
on, the product tools take no `environmentId` (one given is refused), and a change applies in
Sandbox and Production at once. Tool schemas reject unknown arguments. Every change sends an
`Idempotency-Key`: the `idempotencyKey` you pass (repeat it to retry safely), or a fresh one per
call. Changes are annotated `readOnlyHint: false, destructiveHint: false`, except five that can
take something away (`destructiveHint: true`): `mdrn_delete_object` and
`mdrn_set_database_restore_history` (`idempotentHint: true`), and `mdrn_run_sql`,
`mdrn_database_connection` and `mdrn_restore_database` (`idempotentHint: false`); reads are
`readOnlyHint: true`. `mdrn_restore_database` also needs `confirmOverwrite: true`.

**What a connection may do.** The hosted server checks each tool against what the person allowed
when connecting (Platform's token-info): a tool needing more answers `insufficient_scope` without
calling MDRN, and any change in Production (or to a product, which changes both environments) also
needs `production:write`, which the approval page gives only when Production is ticked under
Where. A connection reaches only the environments ticked there (`sandbox:access`,
`production:access`): a tool naming another answers `insufficient_scope` too, and Platform refuses
it either way. A local server signed in with
`mdrn login` acts with the person's full access, as their role allows.

**Databases.** SQLite and Postgres are two products, each with its own database in every
environment. The database tools name the one they work on with `database`. Records are read, never
written: the app's backend writes them. `mdrn_run_sql` refuses any statement naming MDRN's own
tables (`_mdrn_*`, and the provider's `_cf_*`) and leaves them out of a listing. The connection
string is in the answer of `on` and `rotate` only. A Postgres database is made the first time
something uses it; while it is being made the call answers `503 DATABASE_STARTING`, and the same
call a few seconds later goes through.

**Objects, Mail and Auth.** `mdrn_upload_object` stores up to 4 MiB given as text or base64 (the
CLI's `mdrn objects upload` takes larger files); its parts go to their own short-lived links,
never with the bearer. `mdrn_send_test_email` sends one plain message through the app's own Mail.
`mdrn_set_mail_address` chooses the part before the @ that a mail domain's mail leaves from
(`noreply` until chosen); the domain must already send mail, and needs `mail:write`.
`mdrn_set_sign_in` turns sign-in on at a deployment's address and saves who must sign in
(`everyone` except on `publicPaths`, `app_decides`, or `off`) under `If-Match`, so a change made
meanwhile in the console is kept.

The answers of the main flows carry `nextSteps`: each a `step` saying what to do, with the `tool`
to call and the `arguments` known so far, or a `url` to open. A refused call ends with `Next:`
lines: the docs for its error code and, when it comes with going live, the console's go-live
screen; the assistant tells the person rather than working around it.

## Behaviour

API requests have a 10-second deadline and reject redirects. Login, checkout, arbitrary URLs and
private routes are excluded, and `mdrn_read_api` reads only its allowlist. The bearer is redacted from
output, but authorized API data is returned to the client; grant the least scopes required.

The local server sends the sign-in's access token (or the management token) to the API and
nothing else; when the API answers 401 to a sign-in's token, the token is refreshed once and the
call sent again only if the refresh gave a new one. A sign-in that has ended answers each tool
call with what to do (`mdrn login`); a server started before `mdrn login` picks the sign-in up on
its next call.

The hosted server is stateless (one JSON answer per POST, no SSE stream or session; GET and
DELETE answer 405) and holds no credential. A request without a bearer answers 401 with
`WWW-Authenticate: Bearer resource_metadata="https://mcp.mdrn.io/.well-known/oauth-protected-resource/mcp"`;
that metadata (RFC 9728) names MDRN's API (`https://api.mdrn.io`) as the authorization server.
Every request's token is checked with Platform first: one unknown, expired, revoked or issued for
another resource answers 401 `invalid_token`. A tool needing a scope the connection was not
granted answers a tool error `insufficient_scope` without calling MDRN. The checked token is then
sent to MDRN's API, which enforces its workspace, role and scopes on every call; it was issued by
that same API for this server, so nothing is exchanged. A browser page of another origin is
refused (403).

Source: `src/server.js` (the tools, shared), `src/stdio.js` (the package's `mdrn-mcp` command,
which reads the CLI profile through `@mdrnio/cli/config`), `src/worker.js` (released as the `mcp`
Worker of each stage, `wrangler.<stage>.jsonc`; not part of the npm package).
Guide: https://mdrn.io/docs/mcp/

## Contributing

This repository is a mirror: the code is published here from MDRN's main repository on every
release, where it is tested together with the console, the API and the SDKs. Issues are welcome
here. Pull requests are reviewed here and merged in the main repository, from where the next
release brings them back.
