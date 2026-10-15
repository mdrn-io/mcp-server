// The hosted MCP server: MCP's streamable HTTP transport (protocol 2025-06-18), stateless, one
// JSON-RPC message per POST answered with one JSON body (no SSE, no session). It is an OAuth
// protected resource (RFC 9728) whose authorization server is the stage's Platform API.
//
// It holds no credential. Each request's bearer is checked with Platform (TOKEN_INFO below): an
// unknown, expired or revoked token, or one issued for another resource, is answered 401 with
// the challenge that points the client at this server's metadata. A token that passes is then
// forwarded to MDRN's API for the tools, which is the whole of what the token can do anyway: the
// API enforces the grant's workspace, role and scopes on every call, and the token's audience is
// this server or none (a management token made in the console).
import { ApiUnauthorized, MdrnMcpServer, SCOPES_SUPPORTED } from "./server.js";
// The package's version, which initialize reports (wrangler bundles the JSON).
import pkg from "../package.json" with { type: "json" };

/** Platform answers who a bearer is: 200 {resource, scopes} for a live token, 401 otherwise. */
export const TOKEN_INFO = "/v1/platform/oauth/token-info";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
const MAX_BODY = 1024 * 1024;
const METADATA = "/.well-known/oauth-protected-resource";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const rpcError = (status, code, message, id = null) => json({ jsonrpc: "2.0", id, error: { code, message } }, status);

/** A resource URI compared the way RFC 8707 asks: scheme and host lowercase, no trailing slash, no fragment. */
export function canonicalResource(uri) {
  try {
    const url = new URL(uri);
    if (url.hash || url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return null;
  }
}

function settings(env) {
  const resource = canonicalResource(env.MCP_RESOURCE ?? "");
  let issuer;
  try {
    issuer = new URL(env.API_ORIGIN ?? "");
  } catch {}
  if (!resource || !resource.startsWith("https://") || issuer?.protocol !== "https:") return null;
  const endpoint = new URL(resource).pathname || "/";
  return { resource, issuer: issuer.origin, endpoint, metadataPath: `${METADATA}${endpoint === "/" ? "" : endpoint}` };
}

function challenge(config, error) {
  const metadata = new URL(config.metadataPath, config.resource).href;
  const value = `Bearer resource_metadata="${metadata}"${error ? `, error="invalid_token", error_description="${error}"` : ""}`;
  return json({ error: error ? "invalid_token" : "unauthorized", error_description: error ?? "Sign in to MDRN to use this server." }, 401, { "WWW-Authenticate": value });
}

// What Platform says of the token: {ok, scopes, resource}, {invalid}, or {unavailable}.
async function tokenInfo(config, token, fetcher) {
  let response;
  try {
    response = await fetcher(config.issuer + TOKEN_INFO, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { unavailable: true };
  }
  if (response.status === 401 || response.status === 403) return { invalid: true };
  if (!response.ok) return { unavailable: true };
  let body;
  try {
    body = await response.json();
  } catch {
    return { unavailable: true };
  }
  if (!Array.isArray(body?.scopes) || !body.scopes.every((scope) => typeof scope === "string")) return { unavailable: true };
  return { ok: true, scopes: body.scopes, resource: body.resource ?? null };
}

export async function handle(request, env, fetcher) {
  const config = settings(env);
  if (!config) return json({ error: "misconfigured", error_description: "MCP_RESOURCE and API_ORIGIN must be https URLs." }, 500);
  const url = new URL(request.url);

  if (url.pathname === config.metadataPath || url.pathname === METADATA) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "MCP-Protocol-Version" };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    return json({
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: SCOPES_SUPPORTED,
      bearer_methods_supported: ["header"],
      resource_name: "MDRN",
    }, 200, { ...cors, "Cache-Control": "public, max-age=300" });
  }
  if (url.pathname !== config.endpoint) return json({ error: "not_found" }, 404);
  // Stateless: no SSE stream to open (GET) and no session to end (DELETE).
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  // DNS rebinding and cross-site calls: a browser page of another origin is refused. Clients
  // that are not browsers send no Origin.
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return rpcError(403, -32600, "Origin not allowed");

  const bearer = /^Bearer ([!-~]+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!bearer) return challenge(config);
  const version = request.headers.get("MCP-Protocol-Version");
  if (version && !PROTOCOL_VERSIONS.includes(version)) return rpcError(400, -32600, `Unsupported MCP-Protocol-Version ${version}`);
  if (!/^application\/json(;|$)/i.test(request.headers.get("Content-Type") ?? "")) return rpcError(415, -32600, "Content-Type must be application/json");
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY) return rpcError(413, -32600, "Request too large");
  const raw = await request.text();
  if (raw.length > MAX_BODY) return rpcError(413, -32600, "Request too large");
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return rpcError(400, -32700, "Parse error");
  }
  if (Array.isArray(message)) return rpcError(400, -32600, "Batched messages are not supported");
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return rpcError(400, -32600, "Invalid Request");

  const info = await tokenInfo(config, bearer, fetcher);
  if (info.unavailable) return rpcError(503, -32603, "MDRN could not check this token; try again shortly", message.id ?? null);
  if (info.invalid) return challenge(config, "The token is unknown, expired or revoked");
  if (info.resource !== null && canonicalResource(info.resource) !== config.resource) return challenge(config, "The token was not issued for this server");

  // A notification or a client's response: accepted, nothing to answer.
  if (typeof message.method !== "string" || !("id" in message)) return new Response(null, { status: 202 });
  const server = new MdrnMcpServer({ token: bearer, version: pkg.version, origin: config.issuer, fetcher, scopes: info.scopes, rethrowUnauthorized: true });
  try {
    return json(await server.handle(message));
  } catch (error) {
    // Revoked or expired between the check and the call: the client signs in again.
    if (error instanceof ApiUnauthorized) return challenge(config, "The token is unknown, expired or revoked");
    return rpcError(500, -32603, "Internal error", message.id);
  }
}

export default {
  fetch(request, env) {
    // fetch is called through a wrapper: the runtime refuses it detached from the global scope.
    return handle(request, env, (input, init) => fetch(input, init));
  },
};
