# MDRN MCP server

`@mdrnio/mcp-server` gives an AI assistant MDRN's workspaces, projects, products, builds, releases
and logs, and a few safe changes: deploy a connected repository, roll back, turn a product on or
off, set or unset a service variable, create a service. Nothing it offers deletes a service, a
product's data or a domain.

The same tools are served two ways:

- **Hosted** (streamable HTTP, MCP protocol 2025-06-18) at `https://mcp.mdrn.io/mcp`
  (development stage: `https://development.mcp.mdrn.io/mcp`). You sign in with MDRN (OAuth 2.1)
  and choose one workspace and the scopes the assistant gets.
- **Local** (stdio): `npx -y @mdrnio/mcp-server`, signed in as you are on this machine (below).

## Install (local)

The local server needs Node.js 20 or later; `npx -y @mdrnio/mcp-server` fetches it on first use
and runs it, so there is nothing else to install. Sign in once with `mdrn login`
(`npm install -g @mdrnio/cli`), or set `MDRN_API_TOKEN` to a management token (a workspace Admin
creates one in the console under Settings, Tokens).

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
  `https://mcp.mdrn.io/mcp`. Claude opens MDRN's sign-in, then the consent page: pick the
  workspace and tick the scopes.
- **ChatGPT**: Settings, Connectors (developer mode), Create, URL `https://mcp.mdrn.io/mcp`,
  authentication OAuth; the same sign-in and consent follow.
- **Claude Code**: `claude mcp add --transport http mdrn https://mcp.mdrn.io/mcp`, then `/mcp`
  to sign in.

A connection is listed in the console under Settings, Tokens, Connected apps, where Revoke ends
it at once: the next tool call answers 401 and the client asks you to sign in again.

## Tools

| Tool | Arguments | Does |
| --- | --- | --- |
| `mdrn_list_workspaces` | optional `cursor` | The workspaces this credential reaches, with your role in each (their ids are what the other tools take) |
| `mdrn_list_projects` | `workspaceId` | The workspace's projects you are authorized for |
| `mdrn_list_products` | `projectId`, `environmentId` | Product state in one project environment |
| `mdrn_list_identity_origins` | `projectId`, `environmentId` | The app hostnames with sign-in registered, and whether it is on |
| `mdrn_get_operation` | `operationId` | A durable operation; pending is not success |
| `mdrn_get_billing` | `workspaceId` | Workspace billing state (never opens checkout) |
| `mdrn_get_usage` | `workspaceId`, optional `periodId` | Raw and normalized usage, optionally one period statement |
| `mdrn_list_deploy_services` | `projectId`, `environmentId` | Deployment services in the environment |
| `mdrn_get_deployment` | `projectId`, `environmentId`, `deploymentId` | One deployment |
| `mdrn_list_domains` | `projectId`, `environmentId` | Custom domains with their DNS records and state, and the workspace quota (adding one is not available here) |
| `mdrn_get` | `path`, optional `projectId`, `environmentId` | One exact allowlisted inspection route (the reads above it, and the trace below) |
| `mdrn_list_builds` | `projectId`, `environmentId`, `serviceId`, optional `cursor` | A service's builds and the artifact each produced |
| `mdrn_get_build` | `projectId`, `environmentId`, `buildId` | One build's progress and artifact |
| `mdrn_get_build_logs` | `projectId`, `environmentId`, `buildId`, optional `cursor` | A build's output, while it runs or after |
| `mdrn_list_releases` | `projectId`, `environmentId`, `serviceId`, optional `cursor` | A service's releases (their artifacts are what a rollback publishes) |
| `mdrn_list_deployments` | `projectId`, `environmentId`, `serviceId`, optional `cursor` | Every release attempt for a service |
| `mdrn_search_logs` | `projectId`, `environmentId`, optional `q`, `level`, `from`, `to`, `service`, `cursor` | Searches the environment's application logs |
| `mdrn_get_logs_trace` | `projectId`, `environmentId`, `traceId`, optional `from`, `to` | Every log item of one request across the environment's services, joined on its trace id |
| `mdrn_deploy_connected_repo` | `projectId`, `environmentId`, `serviceId`, optional `idempotencyKey` | **Write** (deploy:write): builds and releases what the connected branch holds now |
| `mdrn_rollback` | `projectId`, `environmentId`, `serviceId`, `artifactId`, optional `idempotencyKey` | **Write** (deploy:write): releases an earlier artifact again |
| `mdrn_enable_product` | `projectId`, `environmentId`, `product`, optional `engine`, `idempotencyKey` | **Write** (the product's write scope, workspace Admin): turns a product on |
| `mdrn_disable_product` | `projectId`, `environmentId`, `product`, optional `idempotencyKey` | **Write** (the product's write scope, workspace Admin): turns a product off, keeping its data |
| `mdrn_set_variable` | `projectId`, `environmentId`, `serviceId`, `name`, `value`, optional `secret`, `build`, `idempotencyKey` | **Write** (deploy:write): sets a service variable; the value is never shown again |
| `mdrn_unset_variable` | `projectId`, `environmentId`, `serviceId`, `name`, optional `idempotencyKey` | **Write** (deploy:write): removes a service variable |
| `mdrn_create_service` | `projectId`, `environmentId`, `name`, optional `idempotencyKey` | **Write** (deploy:write): creates a deployment service |

`environmentId` is `sandbox` or `production`; `product` is `database`, `storage`, `mail`, `logs`
or `auth`. Tool schemas reject unknown arguments. Every write sends an `Idempotency-Key`: the
`idempotencyKey` you pass (repeat it to retry safely), or a fresh one per call. Writes are
annotated `readOnlyHint: false, destructiveHint: false`; reads `readOnlyHint: true`.

## Behaviour

API requests have a 10-second deadline and reject redirects. Login, checkout, arbitrary URLs and
private routes are excluded, and `mdrn_get` reads only its allowlist. The bearer is redacted from
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
