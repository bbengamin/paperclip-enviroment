import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { isAuthorizedRequest } from "./auth.js";
import { executeInSandbox } from "./exec.js";
import { shellQuote } from "./helpers.js";
import {
  buildLeaseSandboxId,
  buildSentinelPath,
  DEFAULT_REMOTE_CWD,
  DEFAULT_SESSION_ID,
  DEFAULT_TIMEOUT_MS,
  resolveSandbox,
  applySandboxKeepAlive,
  applySandboxPreviewHold,
  toErrorResponse,
  toJsonResponse,
  type BridgeEnv,
} from "./sandboxes.js";
import type { SessionStrategy } from "./sessions.js";

interface ProbeRequestBody {
  requestedCwd?: string;
  keepAlive?: boolean;
  sleepAfter?: string;
  normalizeId?: boolean;
  sessionStrategy?: SessionStrategy;
  sessionId?: string;
  timeoutMs?: number;
}

interface AcquireLeaseRequestBody extends ProbeRequestBody {
  environmentId?: string;
  runId?: string;
  issueId?: string | null;
  reuseLease?: boolean;
}

interface ResumeLeaseRequestBody extends ProbeRequestBody {
  providerLeaseId?: string;
}

interface ReleaseLeaseRequestBody {
  providerLeaseId?: string;
  reuseLease?: boolean;
  keepAlive?: boolean;
}

interface ExecuteRequestBody {
  providerLeaseId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | null;
  timeoutMs?: number;
  streamOutput?: boolean;
  sessionStrategy?: SessionStrategy;
  sessionId?: string;
}


// Bumped manually on behavior changes so the /health route can prove which
// build is actually deployed (deploy drift has burned us before).
const BRIDGE_VERSION = "0.4.1";

// Preview hold: how long a retained (reuse) sandbox stays before it is allowed
// to sleep after a run completes. Armed as the sandbox `sleepAfter` on release.
const DEFAULT_PREVIEW_HOLD_SECONDS = 3600;
const MIN_PREVIEW_HOLD_SECONDS = 60;

function resolvePreviewHoldSeconds(env: BridgeEnv): number {
  const raw = env.PREVIEW_HOLD_SECONDS?.trim();
  if (!raw) return DEFAULT_PREVIEW_HOLD_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PREVIEW_HOLD_SECONDS;
  return Math.max(MIN_PREVIEW_HOLD_SECONDS, Math.trunc(parsed));
}

// The SDK's sleepAfter accepts duration strings; the codebase uses minute/hour
// units ("10m", "1h"). Express the hold in whole minutes (>=1) so we only rely
// on the "m" unit that is already exercised elsewhere.
function previewHoldSleepAfter(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

// A brand-new sandbox container can come up wedged (rootless DIND boot crash,
// tailscaled never ready). In that state every exec fails no matter how long
// exec.ts re-polls the session watcher — the only recovery is a *fresh*
// container. Under non-reuse the sandbox id carries a random suffix, so each
// attempt below provisions a genuinely new container; under reuse the id is
// deterministic and the retry just re-runs setup against the same sandbox.
const ACQUIRE_SETUP_MAX_ATTEMPTS = 3;
const ACQUIRE_SETUP_RETRY_DELAY_MS = 1_000;

// Cold-start setup failures worth a fresh-sandbox retry: the SDK's
// session-watcher ENOENT (surfaces after exec.ts's own retry budget is
// exhausted), a setup utility exiting non-zero (daemon not up yet), or a
// setup timeout. Deterministic configuration errors (missing Worker secret)
// must fail immediately instead of burning retries.
export function isColdStartSetupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Deterministic config error (Worker secret missing) — never retry. Match the
  // SPECIFIC message, not the bare word: a cold-start ENOENT during `tailscale-up`
  // echoes the whole command, which contains `TAILSCALE_AUTHKEY=…`, so a bare
  // /TAILSCALE_AUTHKEY/ guard mis-classified the retryable boot race as config
  // and skipped the recreate loop (the raw-ENOENT bug).
  if (/TAILSCALE_AUTHKEY Worker secret is required/i.test(message)) return false;
  return (
    /ENOENT: no such file or directory, watch '\/tmp\/session-/i.test(message) ||
    /failed with exit code/i.test(message) ||
    /timed out/i.test(message)
  );
}

const TAILSCALE_PROXY_ENV = {
  ALL_PROXY: "socks5://127.0.0.1:1055",
  all_proxy: "socks5://127.0.0.1:1055",
  HTTP_PROXY: "http://127.0.0.1:1056",
  http_proxy: "http://127.0.0.1:1056",
  HTTPS_PROXY: "http://127.0.0.1:1056",
  https_proxy: "http://127.0.0.1:1056",
};

function mergeNoProxy(existing: string | undefined): string {
  const values = new Set(
    (existing ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const value of ["127.0.0.1", "localhost", "::1"]) values.add(value);
  return Array.from(values).join(",");
}

function withTailscaleProxyEnv(env: BridgeEnv, commandEnv?: Record<string, string>): Record<string, string> | undefined {
  if (!env.TAILSCALE_AUTHKEY || env.TAILSCALE_AUTHKEY.trim().length === 0) return commandEnv;

  const next: Record<string, string> = {
    ...TAILSCALE_PROXY_ENV,
    ...(commandEnv ?? {}),
  };
  next.NO_PROXY = mergeNoProxy(commandEnv?.NO_PROXY ?? commandEnv?.no_proxy);
  next.no_proxy = next.NO_PROXY;
  return next;
}

// Forward the authoritative preview signing inputs into the in-sandbox command
// environment. The in-sandbox agent (via the `preview-handoff` skill) needs the
// bridge's public origin, the canonical signing target, and the signing secret
// to build a browser-clickable signed preview URL — but Worker vars/secrets do
// not automatically appear inside the container, so the bridge must inject them
// at exec time. These values are authoritative and override any same-named keys
// the caller passed, which guarantees the signer secret always matches the
// secret this same Worker verifies with (no two-copies drift).
// Tell the in-sandbox agent it is on Cloudflare so the preview-handoff skill
// opens a quick tunnel via `cloudflared` (the binary is baked into the image)
// rather than trying to reach a signing/proxy endpoint. Previews are fully
// agent-side now, so no base URL, target, or signing secret is injected.
function withPreviewEnv(commandEnv?: Record<string, string>): Record<string, string> | undefined {
  return { ...(commandEnv ?? {}), PAPERCLIP_PREVIEW_ENVIRONMENT_TYPE: "cloudflare" };
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : value === true;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function readSessionStrategy(value: unknown): SessionStrategy {
  return value === "default" ? "default" : "named";
}

function readPort(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return port;
}

function requireTailscaleAuthKey(env: BridgeEnv): string {
  const tailscaleAuthKey = env.TAILSCALE_AUTHKEY?.trim();
  if (!tailscaleAuthKey) {
    throw new Error("TAILSCALE_AUTHKEY Worker secret is required for Cloudflare sandbox leases and exec requests.");
  }
  return tailscaleAuthKey;
}

async function readJson<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

function encodeSseEvent(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function toSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

async function execLeaseUtility(
  sandbox: CloudflareSandbox,
  options: {
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    timeoutMs: number;
  },
  command: string,
  args: string[],
  cwd = "/",
) {
  return await executeInSandbox({
    sandbox,
    command,
    args,
    cwd,
    timeoutMs: options.timeoutMs,
    sessionStrategy: "default",
    sessionId: options.sessionId,
  });
}

function requireZeroExit(action: string, result: { exitCode: number | null; timedOut: boolean; stderr: string }) {
  if (result.timedOut) {
    throw new Error(`${action} timed out: ${result.stderr.trim()}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `${action} failed with exit code ${result.exitCode ?? "null"}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
    );
  }
}

// Warm the container's exec/session infra with a cheap idempotent no-op before
// running real setup. `executeInSandbox` retries the cold-start session-watcher
// race internally, so this absorbs the boot race here — on a command that
// carries no secrets and is safe to re-run — instead of letting `tailscale-up`
// (the old first command) take the brunt of it. Benefits: (1) the recreate loop
// classifies a wedged boot correctly (the probe's error can't echo
// TAILSCALE_AUTHKEY), and (2) a later `tailscale-up` failure is a *real*
// tailscale failure, not a mis-attributed boot race.
const READINESS_PROBE_TIMEOUT_MS = 60_000;

async function ensureSandboxReady(
  sandbox: CloudflareSandbox,
  options: { sessionId: string; timeoutMs: number },
) {
  const result = await executeInSandbox({
    sandbox,
    command: "true",
    cwd: "/",
    timeoutMs: Math.min(options.timeoutMs, READINESS_PROBE_TIMEOUT_MS),
    sessionStrategy: "default",
    sessionId: options.sessionId,
  });
  requireZeroExit("sandbox readiness probe", result);
}

async function ensureTailscale(
  sandbox: CloudflareSandbox,
  env: BridgeEnv,
  input: {
    providerLeaseId: string;
    timeoutMs: number;
    sessionStrategy: SessionStrategy;
    sessionId: string;
  },
) {
  const tailscaleAuthKey = requireTailscaleAuthKey(env);

  const result = await executeInSandbox({
    sandbox,
    command: "tailscale-up",
    cwd: "/",
    timeoutMs: input.timeoutMs,
    sessionStrategy: "default",
    sessionId: input.sessionId,
    env: {
      TAILSCALE_AUTHKEY: tailscaleAuthKey,
      TAILSCALE_HOSTNAME: env.TAILSCALE_HOSTNAME?.trim() || input.providerLeaseId,
      ...(env.TAILSCALE_EXTRA_ARGS ? { TAILSCALE_EXTRA_ARGS: env.TAILSCALE_EXTRA_ARGS } : {}),
    },
  });
  requireZeroExit("tailscale up", result);
}

async function ensureWorkspace(
  sandbox: CloudflareSandbox,
  options: {
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    timeoutMs: number;
  },
) {
  const result = await execLeaseUtility(sandbox, options, "mkdir", ["-p", options.remoteCwd], "/");
  requireZeroExit(`ensure workspace ${options.remoteCwd}`, result);
}

async function ensureDockerRuntime(
  sandbox: CloudflareSandbox,
  options: {
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    timeoutMs: number;
  },
) {
  const result = await execLeaseUtility(sandbox, options, "docker-runtime-smoke", [], "/");
  requireZeroExit("docker runtime smoke", result);
}

async function writeSentinel(
  sandbox: CloudflareSandbox,
  input: {
    providerLeaseId: string;
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    keepAlive: boolean;
    sleepAfter: string;
    normalizeId: boolean;
    resumedLease: boolean;
    timeoutMs: number;
  },
) {
  const sentinelPayload = JSON.stringify({
    provider: "cloudflare",
    providerLeaseId: input.providerLeaseId,
    remoteCwd: input.remoteCwd,
    sessionStrategy: input.sessionStrategy,
    sessionId: input.sessionId,
    keepAlive: input.keepAlive,
    sleepAfter: input.sleepAfter,
    normalizeId: input.normalizeId,
    resumedLease: input.resumedLease,
    updatedAt: new Date().toISOString(),
  }, null, 2);
  const sentinelPath = buildSentinelPath(input.remoteCwd);
  const result = await execLeaseUtility(
    sandbox,
    input,
    "sh",
    [
      "-c",
      `mkdir -p ${shellQuote(input.remoteCwd)} && printf '%s\\n' ${shellQuote(sentinelPayload)} > ${shellQuote(sentinelPath)}`,
    ],
    "/",
  );
  requireZeroExit(`write sentinel ${sentinelPath}`, result);
}

async function verifySentinel(
  sandbox: CloudflareSandbox,
  input: {
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    timeoutMs: number;
  },
): Promise<boolean> {
  const result = await execLeaseUtility(
    sandbox,
    input,
    "sh",
    ["-c", `test -s ${shellQuote(buildSentinelPath(input.remoteCwd))}`],
    "/",
  );
  return !result.timedOut && (result.exitCode ?? 0) === 0;
}

export async function handleBridgeRequest(request: Request, env: BridgeEnv): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "");

  const isAuthorized = await isAuthorizedRequest(request, env.BRIDGE_AUTH_TOKEN);

  // Every bridge route requires the bearer token. (Previews are opened by the
  // in-sandbox agent via cloudflared, not through the bridge.)
  if (!isAuthorized) {
    return toErrorResponse(401, "unauthorized", "Missing or invalid bridge bearer token.");
  }

  if (request.method === "GET" && pathname === "/api/paperclip-sandbox/v1/health") {
    return toJsonResponse({
      ok: true,
      provider: "cloudflare",
      bridgeVersion: BRIDGE_VERSION,
      tailscaleRequired: true,
      tailscaleConfigured: Boolean(env.TAILSCALE_AUTHKEY?.trim()),
      capabilities: {
        reuseLease: true,
        namedSessions: true,
        dockerInDocker: true,
        dockerHostNetworkSmoke: true,
        previewAgentTunnels: true,
        previewHoldSeconds: resolvePreviewHoldSeconds(env),
        acquireColdStartRetry: true,
        acquireReadinessGate: true,
        acquireReuseColdStartRecreate: true,
      },
    });
  }

  if (request.method === "POST" && pathname === "/api/paperclip-sandbox/v1/probe") {
    const body = await readJson<ProbeRequestBody>(request);
    const remoteCwd = readString(body.requestedCwd, DEFAULT_REMOTE_CWD);
    const keepAlive = readBoolean(body.keepAlive, false);
    const sleepAfter = readString(body.sleepAfter, "10m");
    const normalizeId = readBoolean(body.normalizeId, true);
    const sessionStrategy = readSessionStrategy(body.sessionStrategy);
    const sessionId = readString(body.sessionId, DEFAULT_SESSION_ID);
    const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
    const sandboxId = buildLeaseSandboxId({
      environmentId: "probe",
      runId: `probe-${Date.now()}`,
      reuseLease: false,
      normalizeId,
    });

    const sandbox = await resolveSandbox(env, sandboxId, { keepAlive, sleepAfter, normalizeId });
    await applySandboxKeepAlive(sandbox, keepAlive);
    try {
      await ensureSandboxReady(sandbox, { sessionId, timeoutMs });
      await ensureTailscale(sandbox, env, { providerLeaseId: sandboxId, timeoutMs, sessionStrategy, sessionId });
      await ensureDockerRuntime(sandbox, { remoteCwd, sessionStrategy, sessionId, timeoutMs });
      await ensureWorkspace(sandbox, { remoteCwd, sessionStrategy, sessionId, timeoutMs });
      const result = await executeInSandbox({
        sandbox,
        command: "pwd",
        cwd: remoteCwd,
        timeoutMs,
        sessionStrategy,
        sessionId,
      });
      return toJsonResponse({
        ok: true,
        summary: "Connected to Cloudflare sandbox bridge.",
        metadata: {
          provider: "cloudflare",
          remoteCwd,
          namedSessions: sessionStrategy === "named",
          stdout: result.stdout,
        },
      });
    } finally {
      await sandbox.destroy().catch(() => undefined);
    }
  }

  if (request.method === "POST" && pathname === "/api/paperclip-sandbox/v1/leases/acquire") {
    const body = await readJson<AcquireLeaseRequestBody>(request);
    if (!body.environmentId || !body.runId) {
      return toErrorResponse(400, "invalid_request", "environmentId and runId are required.");
    }

    const reuseLease = readBoolean(body.reuseLease, false);
    const keepAlive = readBoolean(body.keepAlive, false);
    const sleepAfter = readString(body.sleepAfter, "10m");
    const normalizeId = readBoolean(body.normalizeId, true);
    const remoteCwd = readString(body.requestedCwd, DEFAULT_REMOTE_CWD);
    const sessionStrategy = readSessionStrategy(body.sessionStrategy);
    const sessionId = readString(body.sessionId, DEFAULT_SESSION_ID);
    const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);

    for (let attempt = 1; ; attempt += 1) {
      // Non-reuse ids carry a fresh random suffix per attempt, so a retry
      // provisions a genuinely new container instead of re-polling a wedged
      // one. Reuse ids are deterministic — same sandbox every attempt.
      const providerLeaseId = buildLeaseSandboxId({
        environmentId: body.environmentId,
        runId: body.runId,
        reuseLease,
        normalizeId,
        issueId: body.issueId ?? null,
      });
      const sandbox = await resolveSandbox(env, providerLeaseId, { keepAlive, sleepAfter, normalizeId });
      // On a setup failure we always tear down this sandbox before retrying —
      // for reuse leases too. A healthy reattach re-runs setup idempotently and
      // never enters the catch, so only a *broken* sandbox reaches it; and
      // because a reuse id is deterministic, re-polling the same wedged
      // container (e.g. the cold-start `/tmp/session-*` watch ENOENT) never
      // recovers. Destroying lets the next attempt provision a genuinely fresh
      // container under the same id. Its disk is ephemeral and was unreachable
      // anyway, and Paperclip re-derives the deterministic id, so nothing leaks.
      try {
        await applySandboxKeepAlive(sandbox, keepAlive);
        await ensureSandboxReady(sandbox, { sessionId, timeoutMs });
        await ensureTailscale(sandbox, env, { providerLeaseId, timeoutMs, sessionStrategy, sessionId });
        await ensureDockerRuntime(sandbox, { remoteCwd, sessionStrategy, sessionId, timeoutMs });
        await ensureWorkspace(sandbox, { remoteCwd, sessionStrategy, sessionId, timeoutMs });
        await writeSentinel(sandbox, {
          providerLeaseId,
          remoteCwd,
          sessionStrategy,
          sessionId,
          keepAlive,
          sleepAfter,
          normalizeId,
          resumedLease: false,
          timeoutMs,
        });
      } catch (err) {
        await sandbox.destroy().catch(() => undefined);
        if (!isColdStartSetupError(err)) throw err;
        if (attempt >= ACQUIRE_SETUP_MAX_ATTEMPTS) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Cloudflare sandbox lease setup failed after ${attempt} cold-start attempts: ${message}`,
            { cause: err },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, ACQUIRE_SETUP_RETRY_DELAY_MS));
        continue;
      }

      return toJsonResponse({
        providerLeaseId,
        metadata: {
          provider: "cloudflare",
          remoteCwd,
          sandboxId: providerLeaseId,
          sessionStrategy,
          sessionId,
          keepAlive,
          sleepAfter,
          normalizeId,
          resumedLease: false,
          setupAttempts: attempt,
        },
      });
    }
  }

  if (request.method === "POST" && pathname === "/api/paperclip-sandbox/v1/leases/resume") {
    const body = await readJson<ResumeLeaseRequestBody>(request);
    if (!body.providerLeaseId) {
      return toErrorResponse(400, "invalid_request", "providerLeaseId is required.");
    }
    const keepAlive = readBoolean(body.keepAlive, false);
    const sleepAfter = readString(body.sleepAfter, "10m");
    const normalizeId = readBoolean(body.normalizeId, true);
    const remoteCwd = readString(body.requestedCwd, DEFAULT_REMOTE_CWD);
    const sessionStrategy = readSessionStrategy(body.sessionStrategy);
    const sessionId = readString(body.sessionId, DEFAULT_SESSION_ID);
    const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
    const sandbox = await resolveSandbox(env, body.providerLeaseId, { keepAlive, sleepAfter, normalizeId });
    // Resume always reattaches to a providerLeaseId the operator already
    // owns, so we deliberately do NOT destroy on failure here — the operator
    // has the ID and can issue an explicit release/destroy. Calling
    // `getSandbox` is idempotent on the Sandbox SDK side (no new sandbox is
    // created), so a failed resume doesn't leak a *new* sandbox.
    await applySandboxKeepAlive(sandbox, keepAlive);
    await ensureSandboxReady(sandbox, { sessionId, timeoutMs });
    await ensureTailscale(sandbox, env, {
      providerLeaseId: body.providerLeaseId,
      timeoutMs,
      sessionStrategy,
      sessionId,
    });
    await ensureDockerRuntime(sandbox, { remoteCwd, sessionStrategy, sessionId, timeoutMs });

    if (!(await verifySentinel(sandbox, { remoteCwd, sessionStrategy, sessionId, timeoutMs }))) {
      return toErrorResponse(409, "sandbox_state_lost", "Cloudflare sandbox state is no longer available.");
    }

    await ensureWorkspace(sandbox, { remoteCwd, sessionStrategy, sessionId, timeoutMs });
    await writeSentinel(sandbox, {
      providerLeaseId: body.providerLeaseId,
      remoteCwd,
      sessionStrategy,
      sessionId,
      keepAlive,
      sleepAfter,
      normalizeId,
      resumedLease: true,
      timeoutMs,
    });

    return toJsonResponse({
      providerLeaseId: body.providerLeaseId,
      metadata: {
        provider: "cloudflare",
        remoteCwd,
        sandboxId: body.providerLeaseId,
        sessionStrategy,
        sessionId,
        keepAlive,
        sleepAfter,
        normalizeId,
        resumedLease: true,
      },
    });
  }

  if (request.method === "POST" && pathname === "/api/paperclip-sandbox/v1/leases/release") {
    const body = await readJson<ReleaseLeaseRequestBody>(request);
    if (!body.providerLeaseId) {
      return toJsonResponse({ ok: true });
    }
    if (readBoolean(body.reuseLease, false)) {
      // Reuse: keep the sandbox (the operator wants to review the PR / preview),
      // but arm the preview hold so it sleeps after the idle window instead of
      // living forever under keepAlive. Sleeping scales it to zero (disk wiped,
      // instance slot + billing freed); a later run on the same task renews
      // activity and resets the timer. Best-effort: a failure here must not fail
      // the release.
      const holdSleepAfter = previewHoldSleepAfter(resolvePreviewHoldSeconds(env));
      try {
        const sandbox = await resolveSandbox(env, body.providerLeaseId, {
          keepAlive: false,
          sleepAfter: holdSleepAfter,
          normalizeId: true,
        });
        await applySandboxPreviewHold(sandbox, holdSleepAfter);
      } catch {
        // Sandbox still exists; it may just live longer than the hold window.
      }
      return toJsonResponse({ ok: true });
    }
    const sandbox = await resolveSandbox(env, body.providerLeaseId, {
      keepAlive: readBoolean(body.keepAlive, false),
      sleepAfter: "10m",
      normalizeId: true,
    });
    await sandbox.destroy().catch(() => undefined);
    return toJsonResponse({ ok: true });
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/paperclip-sandbox/v1/leases/")) {
    const providerLeaseId = decodeURIComponent(pathname.split("/").pop() ?? "");
    if (providerLeaseId.length === 0) {
      return toErrorResponse(400, "invalid_request", "providerLeaseId path parameter is required.");
    }
    const sandbox = await resolveSandbox(env, providerLeaseId, {
      keepAlive: false,
      sleepAfter: "10m",
      normalizeId: true,
    });
    await sandbox.destroy().catch(() => undefined);
    return toJsonResponse({ ok: true });
  }

  if (request.method === "POST" && pathname === "/api/paperclip-sandbox/v1/exec") {
    const body = await readJson<ExecuteRequestBody>(request);
    if (!body.providerLeaseId || !body.command) {
      return toErrorResponse(400, "invalid_request", "providerLeaseId and command are required.");
    }
    requireTailscaleAuthKey(env);
    const sessionStrategy = readSessionStrategy(body.sessionStrategy);
    const sessionId = readString(body.sessionId, DEFAULT_SESSION_ID);
    const sandbox = await resolveSandbox(env, body.providerLeaseId, {
      keepAlive: false,
      sleepAfter: "10m",
      normalizeId: true,
    });
    if (body.streamOutput === true) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let terminalSent = false;
          const streamMetadata = {
            provider: "cloudflare",
            providerLeaseId: body.providerLeaseId,
            command: body.command,
            sessionStrategy,
            sessionId,
          };
          // Stream-delivery observability (visible via `wrangler tail` / Workers
          // Logs): a live incident showed Codex output arriving as one ~187KB
          // chunk ~5 minutes after exec start, i.e. buffered upstream of this
          // Worker (container control plane / SDK), while every hop we own
          // forwards immediately. These logs prove per-run where the first
          // output actually surfaced in the Worker.
          const execStartedAt = Date.now();
          let firstOutputLogged = false;
          let outputEvents = 0;
          let outputBytes = 0;
          console.log(JSON.stringify({
            event: "bridge.exec.start",
            providerLeaseId: body.providerLeaseId,
            command: body.command,
            sessionStrategy,
            sessionId,
          }));
          const sendEvent = (type: string, payload: unknown): boolean => {
            try {
              controller.enqueue(encoder.encode(encodeSseEvent(type, payload)));
              return true;
            } catch {
              return false;
            }
          };
          const sendTerminal = (type: "complete" | "error", payload: unknown): boolean => {
            if (terminalSent) return true;
            terminalSent = sendEvent(type, payload);
            return terminalSent;
          };
          // Heartbeat keeps the SSE response alive during silent stretches
          // (e.g. npm install downloading silently). SSE comment lines (`:`)
          // are ignored by the client parser but keep the underlying HTTP
          // connection from idling out at the Cloudflare edge.
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              // Controller may already be closed; ignore.
            }
          }, 15_000);
          try {
            const result = await executeInSandbox({
              sandbox,
              command: body.command!,
              args: Array.isArray(body.args) ? body.args.filter((value): value is string => typeof value === "string") : [],
              cwd: typeof body.cwd === "string" ? body.cwd : undefined,
              env: withPreviewEnv(withTailscaleProxyEnv(env, body.env)),
              stdin: body.stdin ?? null,
              timeoutMs: readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS),
              sessionStrategy,
              sessionId,
              onOutput: async (streamName, data) => {
                outputEvents += 1;
                outputBytes += data.length;
                if (!firstOutputLogged) {
                  firstOutputLogged = true;
                  console.log(JSON.stringify({
                    event: "bridge.exec.first_output",
                    providerLeaseId: body.providerLeaseId,
                    stream: streamName,
                    bytes: data.length,
                    msSinceExecStart: Date.now() - execStartedAt,
                  }));
                }
                if (!sendEvent(streamName, { data })) {
                  throw new Error("Cloudflare sandbox bridge SSE stream closed while forwarding output.");
                }
              },
            });
            console.log(JSON.stringify({
              event: "bridge.exec.complete",
              providerLeaseId: body.providerLeaseId,
              exitCode: result.exitCode,
              outputEvents,
              outputBytes,
              durationMs: Date.now() - execStartedAt,
            }));
            sendTerminal("complete", { ...result, metadata: streamMetadata });
          } catch (error) {
            console.log(JSON.stringify({
              event: "bridge.exec.error",
              providerLeaseId: body.providerLeaseId,
              error: error instanceof Error ? error.message : String(error),
              outputEvents,
              outputBytes,
              durationMs: Date.now() - execStartedAt,
            }));
            sendTerminal("error", {
              error: error instanceof Error ? error.message : String(error),
              metadata: streamMetadata,
            });
          } finally {
            clearInterval(heartbeat);
            if (!terminalSent) {
              sendTerminal("error", {
                error: "Cloudflare sandbox bridge stream closed before completion event.",
                metadata: streamMetadata,
              });
            }
            try {
              controller.close();
            } catch {
              // Controller may already be closed by the client/runtime.
            }
          }
        },
      });
      return toSseResponse(stream);
    }
    const result = await executeInSandbox({
      sandbox,
      command: body.command,
      args: Array.isArray(body.args) ? body.args.filter((value): value is string => typeof value === "string") : [],
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      env: withPreviewEnv(withTailscaleProxyEnv(env, body.env)),
      stdin: body.stdin ?? null,
      timeoutMs: readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS),
      sessionStrategy,
      sessionId,
    });
    return toJsonResponse(result);
  }

  return toErrorResponse(404, "not_found", `No bridge route matched ${request.method} ${pathname}.`);
}
