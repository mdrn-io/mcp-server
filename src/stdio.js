#!/usr/bin/env node
// The local MCP server: one JSON-RPC message per line of standard input, one answer per line of
// standard output. Its credential is MDRN_API_TOKEN (a management token, with MDRN_API_ORIGIN)
// when set; otherwise the CLI profile's (MDRN_PROFILE, or default, in the CLI's configuration
// file), so `mdrn login` signs in this server too: a browser sign-in's access token is refreshed
// by the CLI's own code, under its lock, two minutes before it expires or once after the API
// refuses it.
import readline from "node:readline";
import { createRequire } from "node:module";
import { credential, settings } from "@mdrnio/cli/config";
import { MdrnMcpServer } from "./server.js";

const { version } = createRequire(import.meta.url)("../package.json");
const env = process.env;

// The CLI profile, read when first needed and again while it holds no credential, so a sign-in
// made after this server started is picked up. A configuration the CLI cannot read is reported
// by the tool call, not at start.
let configured;
function profile() {
  if (configured?.token || configured?.auth) return configured;
  configured = settings(env, {}, {});
  return configured;
}
function fromProfile(force) {
  return credential(profile(), { force });
}

let origin = env.MDRN_API_ORIGIN;
let token = env.MDRN_API_TOKEN;
if (!token) {
  token = { get: () => fromProfile(false), refresh: () => fromProfile(true) };
  try { origin ??= profile().origin; } catch {}
}
const server = new MdrnMcpServer({ token, version, origin });
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  try {
    const response = await server.handle(JSON.parse(line));
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } }) + "\n");
  }
}
