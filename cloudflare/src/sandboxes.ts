import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { getSandbox } from "@cloudflare/sandbox";
import { buildLeaseSandboxId, buildSentinelPath, isTimeoutError } from "./helpers.js";

export interface BridgeEnv {
  Sandbox: DurableObjectNamespace<CloudflareSandbox>;
  BRIDGE_AUTH_TOKEN?: string;
  PREVIEW_SIGNING_SECRET?: string;
  // Operator-configured public origin of this bridge (e.g.
  // "https://paperclip-cloudflare-sandbox-bridge.<acct>.workers.dev"). Set as a
  // Worker var/secret. The bridge forwards it into every /exec sandbox env so
  // the in-sandbox agent can build a signed preview URL against the real bridge
  // host instead of guessing (Worker vars do not cross into the container by
  // themselves).
  PAPERCLIP_PREVIEW_BASE_URL?: string;
  // Idle window (seconds) a reused/preview sandbox is kept before it is allowed
  // to sleep after a run completes. On release the bridge arms this as the
  // sandbox `sleepAfter`, so a held preview sandbox scales to zero (disk wiped,
  // instance slot + billing freed) after this much inactivity instead of living
  // forever under keepAlive. Any later run on the same task renews activity and
  // resets the timer. Default 3600 (1h). See applySandboxPreviewHold.
  PREVIEW_HOLD_SECONDS?: string;
  TAILSCALE_AUTHKEY?: string;
  TAILSCALE_HOSTNAME?: string;
  TAILSCALE_EXTRA_ARGS?: string;
}

export interface BridgeLeaseConfig {
  keepAlive: boolean;
  sleepAfter: string;
  normalizeId: boolean;
}

export const DEFAULT_REMOTE_CWD = "/workspace/paperclip";
export const DEFAULT_SESSION_ID = "paperclip";
export const DEFAULT_TIMEOUT_MS = 1_800_000;
export const LEASE_SENTINEL_FILE = ".paperclip-lease.json";

export function toJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export function toErrorResponse(status: number, error: string, message: string, details?: unknown): Response {
  return toJsonResponse({ error, message, details }, status);
}

export async function resolveSandbox(
  env: BridgeEnv,
  sandboxId: string,
  config: BridgeLeaseConfig,
): Promise<CloudflareSandbox> {
  // Pure handle resolution: the constructor accepts keepAlive/sleepAfter so the
  // sandbox is created with the right defaults on first use, but we no longer
  // call `setKeepAlive` here. That side effect now lives in
  // `applySandboxKeepAlive` and is invoked only from lease-management routes,
  // so exec calls don't accidentally overwrite the lease's keepAlive policy.
  return getSandbox(env.Sandbox, sandboxId, {
    keepAlive: config.keepAlive,
    sleepAfter: config.sleepAfter,
  });
}

export async function applySandboxKeepAlive(
  sandbox: CloudflareSandbox,
  keepAlive: boolean,
): Promise<void> {
  await sandbox.setKeepAlive(keepAlive);
}

// Arm the preview hold on a retained (reuse) sandbox: stop keeping it alive and
// let it sleep after `sleepAfter` of inactivity. A slept container scales to
// zero — its disk is wiped and its instance slot + billing are freed — which is
// exactly the bounded "hold the preview for a while, then auto-clean" behavior
// we want, handled natively by the platform. Ordering: drop keepAlive first so
// the freshly-set sleepAfter is actually honored.
export async function applySandboxPreviewHold(
  sandbox: CloudflareSandbox,
  sleepAfter: string,
): Promise<void> {
  await sandbox.setKeepAlive(false);
  await sandbox.setSleepAfter(sleepAfter);
}

export { buildLeaseSandboxId, buildSentinelPath, isTimeoutError };
