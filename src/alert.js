// What the hosted MCP Worker does when it cannot check tokens with Platform: one log line per
// failure, and an admin-console Alert (ADR-92) once failures keep coming.
//
// The Worker is stateless and has no clock of its own, so "keep coming" is counted in the
// isolate that sees them: THRESHOLD failures in a row, with no check passing in between, raise
// the alert once; the isolate then stays quiet for QUIET_MS, and a passing check starts the count
// again. Platform keeps one row per component:kind:key, so isolates raising the same alert count
// toward one row rather than adding rows.
//
// The alert is signed like every other Worker's (shared/operator_alert.rs): HMAC-SHA256 over
// "mdrn-operator-alert-v1\n" + body under MCP_ALERT_KEY, sent over the PLATFORM service binding
// (the same one the token check uses). Without the key or the binding, the
// alert is one `operator_alert_unsent` line and nothing else happens.

export const THRESHOLD = 5;
export const QUIET_MS = 30 * 60 * 1000;
export const ALERT_PATH = "/internal/platform/operator-alerts";
const HEADER = "X-MDRN-Operator-Alert";
const PREFIX = "mdrn-operator-alert-v1\n";

let failures = 0;
let quietUntil = 0;

/** Forgets the isolate's count (tests). */
export function resetAlertState() {
  failures = 0;
  quietUntil = 0;
}

/** A token check that Platform answered (valid or not): the run of failures ends. */
export function tokenCheckAnswered() {
  failures = 0;
}

/** HMAC-SHA256 of the prefixed body under key, lowercase hex. */
export async function sign(key, body) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(PREFIX + body)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A token check Platform could not answer. `cause` is our own short code (network, status_502,
 * body), never provider text. Logs the failure and, once failures keep coming, raises the alert.
 * Never throws.
 */
export async function tokenCheckFailed(env, cause, { now = Date.now(), log = console.error } = {}) {
  failures += 1;
  log(JSON.stringify({ event: "mcp_token_check_failed", stage: env.STAGE ?? null, cause, failures }));
  if (failures < THRESHOLD || now < quietUntil) return false;
  quietUntil = now + QUIET_MS;
  await raise(env, {
    version: 1,
    component: "mcp",
    kind: "token_check_failing",
    key: env.STAGE ?? "unknown",
    severity: "critical",
    summary: "The MCP server keeps failing to check tokens with Platform, so every AI agent connected to MDRN gets an error.",
    details: { stage: env.STAGE ?? null, cause, failures },
    cost: null,
    link: null,
  }, log);
  return true;
}

async function raise(env, alert, log) {
  const unsent = (reason) => log(JSON.stringify({ event: "operator_alert_unsent", component: alert.component, kind: alert.kind, key: alert.key, reason }));
  try {
    const key = env.MCP_ALERT_KEY;
    if (typeof key !== "string" || key.length < 32) return unsent("no key shared with Platform");
    if (!env.PLATFORM?.fetch) return unsent("no binding to Platform");
    const body = JSON.stringify(alert);
    const response = await env.PLATFORM.fetch(`https://platform.internal${ALERT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [HEADER]: await sign(key, body) },
      body,
      redirect: "manual",
    });
    if (response.status !== 204) unsent(`platform answered ${response.status}`);
  } catch {
    unsent("binding call failed");
  }
}
