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

const PREVIEW_ROUTE_PREFIX = "/api/paperclip-sandbox/v1/preview/";

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

function buildPreviewRequest(request: Request, url: URL, providerLeaseId: string, portSegment: string): Request | Response {
  const port = readPort(portSegment);
  if (port === null) {
    return toErrorResponse(400, "invalid_request", "Preview port must be an integer from 1 to 65535.");
  }

  const routePrefix = `${PREVIEW_ROUTE_PREFIX}${encodeURIComponent(providerLeaseId)}/${portSegment}`;
  const rawRemainder = url.pathname.startsWith(routePrefix)
    ? url.pathname.slice(routePrefix.length)
    : "";
  const upstreamUrl = new URL(url.toString());
  upstreamUrl.pathname = rawRemainder.length > 0 ? rawRemainder : "/";

  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("X-Paperclip-Environment-Id");
  headers.delete("X-Paperclip-Issue-Id");
  headers.set("X-Paperclip-Preview-Lease-Id", providerLeaseId);
  headers.set("X-Paperclip-Preview-Port", String(port));

  return new Request(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
    duplex: "half",
  } as RequestInit & { duplex: "half" });
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
    sessionStrategy: options.sessionStrategy,
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
    sessionStrategy: input.sessionStrategy,
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
  if (!(await isAuthorizedRequest(request, env.BRIDGE_AUTH_TOKEN))) {
    return toErrorResponse(401, "unauthorized", "Missing or invalid bridge bearer token.");
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "");

  if (request.method === "GET" && pathname === "/api/paperclip-sandbox/v1/health") {
    return toJsonResponse({
      ok: true,
        provider: "cloudflare",
        bridgeVersion: "0.1.0",
        tailscaleRequired: true,
        tailscaleConfigured: Boolean(env.TAILSCALE_AUTHKEY?.trim()),
        capabilities: {
          reuseLease: true,
          namedSessions: true,
          dockerInDocker: true,
          dockerBridgeNetworkSmoke: true,
          previewUrls: true,
      },
    });
  }

  if (pathname.startsWith(PREVIEW_ROUTE_PREFIX)) {
    const suffix = pathname.slice(PREVIEW_ROUTE_PREFIX.length);
    const [encodedProviderLeaseId, portSegment] = suffix.split("/", 2);
    const providerLeaseId = decodeURIComponent(encodedProviderLeaseId ?? "");
    if (!providerLeaseId || !portSegment) {
      return toErrorResponse(400, "invalid_request", "Preview URL must include providerLeaseId and port.");
    }

    const previewRequest = buildPreviewRequest(request, url, providerLeaseId, portSegment);
    if (previewRequest instanceof Response) return previewRequest;

    const sandbox = await resolveSandbox(env, providerLeaseId, {
      keepAlive: false,
      sleepAfter: "10m",
      normalizeId: true,
    });
    return await sandbox.containerFetch(previewRequest, readPort(portSegment)!);
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
    const providerLeaseId = buildLeaseSandboxId({
      environmentId: body.environmentId,
      runId: body.runId,
      reuseLease,
      normalizeId,
      issueId: body.issueId ?? null,
    });
    const sandbox = await resolveSandbox(env, providerLeaseId, { keepAlive, sleepAfter, normalizeId });
    // Guard against orphaning a keepAlive sandbox if workspace setup throws
    // after creation: Paperclip never sees the lease ID in that case, so it
    // can't clean up. Destroy here unless this is a reuseLease handshake
    // (where the sandbox may have been created by a prior acquire and we
    // shouldn't destroy it on a transient setup failure during reattachment).
    try {
      await applySandboxKeepAlive(sandbox, keepAlive);
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
      if (!reuseLease) {
        await sandbox.destroy().catch(() => undefined);
      }
      throw err;
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
      },
    });
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
              env: withTailscaleProxyEnv(env, body.env),
              stdin: body.stdin ?? null,
              timeoutMs: readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS),
              sessionStrategy,
              sessionId,
              onOutput: async (streamName, data) => {
                controller.enqueue(encoder.encode(encodeSseEvent(streamName, { data })));
              },
            });
            controller.enqueue(encoder.encode(encodeSseEvent("complete", result)));
          } catch (error) {
            controller.enqueue(encoder.encode(encodeSseEvent("error", {
              error: error instanceof Error ? error.message : String(error),
            })));
          } finally {
            clearInterval(heartbeat);
            controller.close();
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
      env: withTailscaleProxyEnv(env, body.env),
      stdin: body.stdin ?? null,
      timeoutMs: readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS),
      sessionStrategy,
      sessionId,
    });
    return toJsonResponse(result);
  }

  return toErrorResponse(404, "not_found", `No bridge route matched ${request.method} ${pathname}.`);
}
