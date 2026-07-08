import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
}));

import { handleBridgeRequest, isColdStartSetupError } from "./routes.js";
import { resolveSandbox } from "./sandboxes.js";

describe("isColdStartSetupError", () => {
  it("treats a tailscale-up cold-start ENOENT as retryable even though the message echoes TAILSCALE_AUTHKEY", () => {
    // The exact live failure: the SDK error echoes the whole command, which
    // carries `TAILSCALE_AUTHKEY='tskey-…'`, on a /tmp/session- watch ENOENT.
    const msg =
      "Failed to execute command 'sh -lc '…exec env TAILSCALE_AUTHKEY='tskey-abc' TAILSCALE_HOSTNAME='pc-x' 'tailscale-up''' " +
      "in session 'sandbox-pc-x': ENOENT: no such file or directory, watch '/tmp/session-sandbox-pc-x-123'";
    expect(isColdStartSetupError(new Error(msg))).toBe(true);
  });

  it("does not retry the deterministic missing-secret config error", () => {
    expect(
      isColdStartSetupError(
        new Error("TAILSCALE_AUTHKEY Worker secret is required for Cloudflare sandbox leases and exec requests."),
      ),
    ).toBe(false);
  });

  it("retries generic cold-start signatures and skips unrelated errors", () => {
    expect(isColdStartSetupError(new Error("readiness probe failed with exit code 1"))).toBe(true);
    expect(isColdStartSetupError(new Error("tailscale up timed out"))).toBe(true);
    expect(isColdStartSetupError(new Error("some unrelated bridge error"))).toBe(false);
  });
});

vi.mock("./sandboxes.js", async () => {
  const actual = await vi.importActual<typeof import("./sandboxes.js")>("./sandboxes.js");
  return {
    ...actual,
    resolveSandbox: vi.fn(),
  };
});

function bridgeRequest(pathname: string, body: unknown): Request {
  return new Request(`https://bridge.example.test${pathname}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function authenticatedRequest(pathname: string, init: RequestInit = {}): Request {
  return new Request(`https://bridge.example.test${pathname}`, {
    ...init,
    headers: {
      Authorization: "Bearer secret-token",
      ...(init.headers ?? {}),
    },
  });
}

function base64Url(input: ArrayBuffer): string {
  let raw = "";
  for (const byte of new Uint8Array(input)) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signPreview(input: {
  secret?: string;
  target?: string;
  issue?: string;
  run?: string;
  port?: number;
  exp?: string;
} = {}) {
  const secret = input.secret ?? "preview-secret";
  const payload = [
    "paperclip-preview-v1",
    `target=${input.target ?? "pc-run-1-abcd1234"}`,
    `issue=${input.issue ?? "RL-1407"}`,
    `run=${input.run ?? "run-1"}`,
    `port=${input.port ?? 27451}`,
    `exp=${input.exp ?? "4102444800"}`,
  ].join("\n");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

describe("bridge routes", () => {
  beforeEach(() => {
    vi.mocked(resolveSandbox).mockReset();
  });

  it("reports Docker-in-Docker support in bridge health metadata", async () => {
    const response = await handleBridgeRequest(
      new Request("https://bridge.example.test/api/paperclip-sandbox/v1/health", {
        method: "GET",
        headers: {
          Authorization: "Bearer secret-token",
        },
      }),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        PREVIEW_SIGNING_SECRET: "preview-secret",
        PAPERCLIP_PREVIEW_BASE_URL: "https://bridge.example.workers.dev",
        TAILSCALE_AUTHKEY: "tskey-test",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      capabilities: {
        dockerHostNetworkSmoke: true,
        dockerInDocker: true,
        namedSessions: true,
        previewUrls: true,
        previewSigningConfigured: true,
        previewBaseUrlConfigured: true,
        previewHoldSeconds: 3600,
        reuseLease: true,
      },
    });
  });

  it("proxies preview requests to the selected sandbox port and strips bridge auth", async () => {
    const containerFetch = vi.fn().mockResolvedValue(new Response("preview ok", { status: 201 }));
    vi.mocked(resolveSandbox).mockResolvedValue({ containerFetch } as never);

    const response = await handleBridgeRequest(
      authenticatedRequest("/api/paperclip-sandbox/v1/preview/pc-run-1-abcd1234/27451/dashboard?tab=home", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Paperclip-Environment-Id": "env-1",
        },
        body: "hello",
      }),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(201);
    await expect(response.text()).resolves.toBe("preview ok");
    expect(resolveSandbox).toHaveBeenCalledWith(expect.anything(), "pc-run-1-abcd1234", {
      keepAlive: false,
      sleepAfter: "10m",
      normalizeId: true,
    });
    expect(containerFetch).toHaveBeenCalledTimes(1);
    const [proxiedRequest, port] = containerFetch.mock.calls[0] ?? [];
    expect(port).toBe(27451);
    expect(proxiedRequest).toBeInstanceOf(Request);
    expect((proxiedRequest as Request).url).toBe("https://bridge.example.test/dashboard?tab=home");
    expect((proxiedRequest as Request).headers.get("Authorization")).toBeNull();
    expect((proxiedRequest as Request).headers.get("X-Paperclip-Environment-Id")).toBeNull();
    expect((proxiedRequest as Request).headers.get("X-Paperclip-Preview-Lease-Id")).toBe("pc-run-1-abcd1234");
    expect((proxiedRequest as Request).headers.get("X-Paperclip-Preview-Port")).toBe("27451");
    await expect((proxiedRequest as Request).text()).resolves.toBe("hello");
  });

  it("proxies signed browser preview requests without bridge bearer auth", async () => {
    const containerFetch = vi.fn().mockResolvedValue(new Response("preview ok", { status: 200 }));
    vi.mocked(resolveSandbox).mockResolvedValue({ containerFetch } as never);
    const sig = await signPreview();

    const response = await handleBridgeRequest(
      new Request(
        `https://bridge.example.test/api/paperclip-sandbox/v1/preview/pc-run-1-abcd1234/27451/dashboard?tab=home&pc_issue=RL-1407&pc_run=run-1&pc_exp=4102444800&pc_sig=${sig}`,
      ),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        PREVIEW_SIGNING_SECRET: "preview-secret",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(200);
    expect(containerFetch).toHaveBeenCalledTimes(1);
    const [proxiedRequest, port] = containerFetch.mock.calls[0] ?? [];
    expect(port).toBe(27451);
    expect((proxiedRequest as Request).url).toBe("https://bridge.example.test/dashboard?tab=home");
    expect((proxiedRequest as Request).headers.get("Authorization")).toBeNull();
    expect((proxiedRequest as Request).headers.get("X-Paperclip-Preview-Lease-Id")).toBe("pc-run-1-abcd1234");
  });

  it("rejects signed preview requests with invalid signatures", async () => {
    const sig = await signPreview({ secret: "wrong-secret" });

    const response = await handleBridgeRequest(
      new Request(
        `https://bridge.example.test/api/paperclip-sandbox/v1/preview/pc-run-1-abcd1234/27451/dashboard?pc_issue=RL-1407&pc_run=run-1&pc_exp=4102444800&pc_sig=${sig}`,
      ),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        PREVIEW_SIGNING_SECRET: "preview-secret",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(401);
    expect(resolveSandbox).not.toHaveBeenCalled();
  });

  it("rejects expired signed preview requests", async () => {
    const sig = await signPreview({ exp: "100" });

    const response = await handleBridgeRequest(
      new Request(
        `https://bridge.example.test/api/paperclip-sandbox/v1/preview/pc-run-1-abcd1234/27451/dashboard?pc_issue=RL-1407&pc_run=run-1&pc_exp=100&pc_sig=${sig}`,
      ),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        PREVIEW_SIGNING_SECRET: "preview-secret",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(410);
    expect(resolveSandbox).not.toHaveBeenCalled();
  });

  it("rejects signed preview requests when the signing secret is missing", async () => {
    const sig = await signPreview();

    const response = await handleBridgeRequest(
      new Request(
        `https://bridge.example.test/api/paperclip-sandbox/v1/preview/pc-run-1-abcd1234/27451/dashboard?pc_issue=RL-1407&pc_run=run-1&pc_exp=4102444800&pc_sig=${sig}`,
      ),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(503);
    expect(resolveSandbox).not.toHaveBeenCalled();
  });

  it("rejects malformed preview ports before resolving the sandbox", async () => {
    const response = await handleBridgeRequest(
      authenticatedRequest("/api/paperclip-sandbox/v1/preview/pc-run-1-abcd1234/nope/"),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(400);
    expect(resolveSandbox).not.toHaveBeenCalled();
  });

  it("writes lease sentinels through direct sandbox exec during bootstrap", async () => {
    const sandboxExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sandbox = {
      exec: sandboxExec,
      getSession: vi.fn(),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", {
        environmentId: "env-1",
        runId: "run-1",
        requestedCwd: "/workspace/paperclip",
        sessionStrategy: "named",
        sessionId: "paperclip",
      }),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        TAILSCALE_AUTHKEY: "tskey-test",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(200);
    // Sentinel write must NOT use sandbox.writeFile (sandbox-level race);
    // it goes through exec so the shell creates the workspace atomically.
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    expect(sandbox.getSession).not.toHaveBeenCalled();

    // Both calls use a single command string — the SDK's exec API ignores
    // any `args` or `stdin` option, so the bridge folds them into the
    // command line itself.
    // A readiness probe (`true`) runs first to absorb the cold-start race, then
    // tailscale-up, docker smoke, workspace mkdir, and the sentinel write.
    expect(sandboxExec).toHaveBeenCalledTimes(5);
    for (const call of sandboxExec.mock.calls) {
      const [commandArg, optionsArg] = call;
      expect(typeof commandArg).toBe("string");
      expect(commandArg).toMatch(/^sh -lc /);
      expect(optionsArg).toEqual({ cwd: "/", timeout: expect.any(Number) });
      expect(optionsArg).not.toHaveProperty("args");
      expect(optionsArg).not.toHaveProperty("stdin");
    }
    expect(sandboxExec.mock.calls[0]?.[0]).toContain("true");
    expect(sandboxExec.mock.calls[1]?.[0]).toContain("tailscale-up");
    expect(sandboxExec.mock.calls[2]?.[0]).toContain("docker-runtime-smoke");
    expect(sandboxExec.mock.calls[3]?.[0]).toContain("mkdir");
    expect(sandboxExec.mock.calls[3]?.[0]).toContain("/workspace/paperclip");
    expect(sandboxExec.mock.calls[4]?.[0]).toContain("/workspace/paperclip/.paperclip-lease.json");
  });

  it("checks lease sentinels through direct sandbox exec on resume", async () => {
    const sandboxExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sandbox = {
      exec: sandboxExec,
      getSession: vi.fn(),
      createSession: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-run-1-abcd1234",
        requestedCwd: "/workspace/paperclip",
        sessionStrategy: "named",
        sessionId: "paperclip",
      }),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        TAILSCALE_AUTHKEY: "tskey-test",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(200);
    expect(sandbox.readFile).not.toHaveBeenCalled();
    expect(sandbox.getSession).not.toHaveBeenCalled();
    expect(sandboxExec.mock.calls[0]?.[0]).toContain("true");
    expect(sandboxExec.mock.calls[1]?.[0]).toContain("tailscale-up");
    expect(sandboxExec.mock.calls[2]?.[0]).toContain("docker-runtime-smoke");
    const [commandArg, optionsArg] = sandboxExec.mock.calls[3] ?? [];
    expect(typeof commandArg).toBe("string");
    expect(commandArg).toMatch(/^sh -lc /);
    expect(commandArg).toContain("test -s");
    expect(commandArg).toContain("/workspace/paperclip/.paperclip-lease.json");
    expect(optionsArg).toEqual({ cwd: "/", timeout: expect.any(Number) });
    expect(optionsArg).not.toHaveProperty("args");
  });

  it("streams exec stdout and completion metadata when requested", async () => {
    const sessionExec = vi.fn().mockImplementation(async (_command, options) => {
      await options?.onOutput?.("stdout", "hello\n");
      return { exitCode: 0, stdout: "hello\n", stderr: "" };
    });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec: sessionExec }),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/exec", {
        providerLeaseId: "pc-run-1-abcd1234",
        command: "echo",
        args: ["hello"],
        sessionStrategy: "named",
        sessionId: "paperclip",
        streamOutput: true,
      }),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        TAILSCALE_AUTHKEY: "tskey-test",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: stdout");
    expect(body).toContain("event: complete");
  });

  it("streams a terminal error event when sandbox exec throws", async () => {
    const sessionExec = vi.fn().mockRejectedValue(new Error("sandbox process disappeared"));
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec: sessionExec }),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/exec", {
        providerLeaseId: "pc-run-1-abcd1234",
        command: "codex",
        args: ["exec", "-"],
        sessionStrategy: "named",
        sessionId: "paperclip",
        streamOutput: true,
      }),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        TAILSCALE_AUTHKEY: "tskey-test",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: error");
    expect(body).toContain("sandbox process disappeared");
    expect(body).not.toContain("event: complete");
  });

  it("injects userspace Tailscale proxy env into sandbox exec commands", async () => {
    const sessionExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec: sessionExec }),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/exec", {
        providerLeaseId: "pc-run-1-abcd1234",
        command: "node",
        args: ["probe.js"],
        env: {
          CODEX_HOME: "/workspace/.codex",
          NO_PROXY: "metadata.google.internal",
        },
        sessionStrategy: "named",
        sessionId: "paperclip",
      }),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        TAILSCALE_AUTHKEY: "tskey-test",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(200);
    const commandArg = sessionExec.mock.calls[0]?.[0] as string;
    expect(commandArg).toContain("CODEX_HOME=");
    expect(commandArg).toContain("HTTP_PROXY=");
    expect(commandArg).toContain("http://127.0.0.1:1056");
    expect(commandArg).toContain("ALL_PROXY=");
    expect(commandArg).toContain("socks5://127.0.0.1:1055");
    expect(commandArg).toContain("NO_PROXY=");
    expect(commandArg).toContain("metadata.google.internal");
    expect(commandArg).toContain("127.0.0.1");
    expect(commandArg).toContain("localhost");
  });

  it("injects authoritative preview signing env into sandbox exec commands", async () => {
    const sessionExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec: sessionExec }),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/exec", {
        providerLeaseId: "pc-run-1-abcd1234",
        command: "codex",
        args: ["exec", "-"],
        // A caller-supplied signing secret must be overridden by the Worker's
        // own secret so the signer always matches this Worker's verifier.
        env: { PREVIEW_SIGNING_SECRET: "stale-caller-secret" },
        sessionStrategy: "named",
        sessionId: "paperclip",
      }),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        PREVIEW_SIGNING_SECRET: "worker-preview-secret",
        PAPERCLIP_PREVIEW_BASE_URL: "https://bridge.example.workers.dev",
        TAILSCALE_AUTHKEY: "tskey-test",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(200);
    const commandArg = sessionExec.mock.calls[0]?.[0] as string;
    expect(commandArg).toContain("PAPERCLIP_PREVIEW_BASE_URL=");
    expect(commandArg).toContain("https://bridge.example.workers.dev");
    expect(commandArg).toContain("PAPERCLIP_PREVIEW_ENVIRONMENT_TYPE=");
    expect(commandArg).toContain("cloudflare");
    // The canonical signing target and lease id are the providerLeaseId.
    expect(commandArg).toContain("PAPERCLIP_PREVIEW_TARGET_ID=");
    expect(commandArg).toContain("PAPERCLIP_PROVIDER_LEASE_ID=");
    expect(commandArg).toContain("pc-run-1-abcd1234");
    // Worker secret wins over the caller-supplied value.
    expect(commandArg).toContain("PREVIEW_SIGNING_SECRET=");
    expect(commandArg).toContain("worker-preview-secret");
    expect(commandArg).not.toContain("stale-caller-secret");
  });

  it("retries lease setup on a fresh sandbox when the container cold-boot wedges", async () => {
    // First sandbox: tailscale-up exits non-zero (daemon never came up).
    const wedgedExec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "tailscaled not running" });
    const wedgedSandbox = {
      exec: wedgedExec,
      getSession: vi.fn(),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    // Second sandbox: healthy.
    const healthyExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const healthySandbox = {
      exec: healthyExec,
      getSession: vi.fn(),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox)
      .mockResolvedValueOnce(wedgedSandbox as never)
      .mockResolvedValueOnce(healthySandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", {
        environmentId: "env-1",
        runId: "run-1",
        requestedCwd: "/workspace/paperclip",
      }),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        TAILSCALE_AUTHKEY: "tskey-test",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { providerLeaseId: string; metadata: { setupAttempts: number } };
    expect(payload.metadata.setupAttempts).toBe(2);

    // The wedged sandbox must be destroyed, and the retry must target a
    // different sandbox id (fresh random suffix under non-reuse).
    expect(wedgedSandbox.destroy).toHaveBeenCalledTimes(1);
    expect(healthySandbox.destroy).not.toHaveBeenCalled();
    const [, firstId] = vi.mocked(resolveSandbox).mock.calls[0] ?? [];
    const [, secondId] = vi.mocked(resolveSandbox).mock.calls[1] ?? [];
    expect(firstId).not.toBe(secondId);
    expect(payload.providerLeaseId).toBe(secondId);
    // Healthy sandbox ran the full setup sequence (readiness probe first).
    expect(healthyExec.mock.calls[0]?.[0]).toContain("true");
    expect(healthyExec.mock.calls[1]?.[0]).toContain("tailscale-up");
    expect(healthyExec.mock.calls[4]?.[0]).toContain(".paperclip-lease.json");
  });

  it("destroys and recreates a wedged REUSE sandbox so setup can recover", async () => {
    // A reuse lease id is deterministic, so a wedged container is re-resolved
    // under the same id every attempt. Setup must still tear it down and let the
    // next attempt provision a genuinely fresh container — otherwise reuse locks
    // onto the wedge (the raw `/tmp/session-*` ENOENT failure we hit in prod).
    const wedgedSandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "tailscaled not running" }),
      getSession: vi.fn(),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const healthySandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
      getSession: vi.fn(),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox)
      .mockResolvedValueOnce(wedgedSandbox as never)
      .mockResolvedValueOnce(healthySandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", {
        environmentId: "env-1",
        runId: "run-1",
        issueId: "RL-1",
        reuseLease: true,
        requestedCwd: "/workspace/paperclip",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", TAILSCALE_AUTHKEY: "tskey-test", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { providerLeaseId: string; metadata: { setupAttempts: number } };
    expect(payload.metadata.setupAttempts).toBe(2);
    // The wedged reuse sandbox is torn down (previously reuse skipped this and
    // re-polled the same wedge forever).
    expect(wedgedSandbox.destroy).toHaveBeenCalledTimes(1);
    expect(healthySandbox.destroy).not.toHaveBeenCalled();
    // Reuse id is deterministic: both attempts target the same lease id.
    const [, firstId] = vi.mocked(resolveSandbox).mock.calls[0] ?? [];
    const [, secondId] = vi.mocked(resolveSandbox).mock.calls[1] ?? [];
    expect(firstId).toBe(secondId);
    expect(payload.providerLeaseId).toBe(firstId);
  });

  it("gives up after the cold-start retry budget and reports the attempt count", async () => {
    const wedgedExec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "tailscaled not running" });
    const makeWedgedSandbox = () => ({
      exec: wedgedExec,
      getSession: vi.fn(),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    });
    const sandboxes = [makeWedgedSandbox(), makeWedgedSandbox(), makeWedgedSandbox()];
    for (const sandbox of sandboxes) {
      vi.mocked(resolveSandbox).mockResolvedValueOnce(sandbox as never);
    }

    await expect(handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", {
        environmentId: "env-1",
        runId: "run-1",
        requestedCwd: "/workspace/paperclip",
      }),
      {
        BRIDGE_AUTH_TOKEN: "secret-token",
        TAILSCALE_AUTHKEY: "tskey-test",
        Sandbox: {} as never,
      },
    )).rejects.toThrow(/after 3 cold-start attempts.*readiness probe failed/s);

    expect(resolveSandbox).toHaveBeenCalledTimes(3);
    for (const sandbox of sandboxes) {
      expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    }
  });

  it("retries lease setup when the SDK session-watcher race escapes the exec retry budget", async () => {
    const watchError = new Error(
      "Failed to execute command 'sh -lc ...' in session 'sandbox-pc-x': ENOENT: no such file or directory, watch '/tmp/session-sandbox-pc-x-123'",
    );
    const wedgedSandbox = {
      exec: vi.fn().mockRejectedValue(watchError),
      getSession: vi.fn(),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const healthySandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
      getSession: vi.fn(),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox)
      .mockResolvedValueOnce(wedgedSandbox as never)
      .mockResolvedValueOnce(healthySandbox as never);

    // The watch error first burns exec.ts's own ~45s in-place retry budget
    // before surfacing to the acquire loop — fast-forward through it.
    vi.useFakeTimers();
    try {
      const responsePromise = handleBridgeRequest(
        bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", {
          environmentId: "env-1",
          runId: "run-1",
          requestedCwd: "/workspace/paperclip",
        }),
        {
          BRIDGE_AUTH_TOKEN: "secret-token",
          TAILSCALE_AUTHKEY: "tskey-test",
          Sandbox: {} as never,
        },
      );
      await vi.runAllTimersAsync();
      const response = await responsePromise;

      expect(response.status).toBe(200);
      expect(wedgedSandbox.destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects lease setup when the required Tailscale secret is missing", async () => {
    const sandbox = {
      // Readiness probe (`true`) runs before ensureTailscale and must succeed so
      // the flow reaches the missing-secret check.
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
      getSession: vi.fn().mockResolvedValue({ exec: vi.fn() }),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    await expect(handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", {
        environmentId: "env-1",
        runId: "run-1",
        requestedCwd: "/workspace/paperclip",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    )).rejects.toThrow("TAILSCALE_AUTHKEY");

    expect(sandbox.destroy).toHaveBeenCalled();
  });

  it("arms the preview hold on reuse-lease release instead of destroying", async () => {
    const sandbox = {
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      setSleepAfter: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/release", {
        providerLeaseId: "pc-env-env1-i-abcd1234",
        reuseLease: true,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    // Retained, not destroyed, and switched from keepAlive to a bounded idle
    // sleep window (default 3600s -> "60m").
    expect(sandbox.destroy).not.toHaveBeenCalled();
    expect(sandbox.setKeepAlive).toHaveBeenCalledWith(false);
    expect(sandbox.setSleepAfter).toHaveBeenCalledWith("60m");
  });

  it("honors a custom PREVIEW_HOLD_SECONDS when arming the reuse hold", async () => {
    const sandbox = {
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      setSleepAfter: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/release", {
        providerLeaseId: "pc-env-env1-i-abcd1234",
        reuseLease: true,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", PREVIEW_HOLD_SECONDS: "5400", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    expect(sandbox.setSleepAfter).toHaveBeenCalledWith("90m");
    expect(sandbox.destroy).not.toHaveBeenCalled();
  });

  it("destroys the sandbox on a non-reuse release", async () => {
    const sandbox = {
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      setSleepAfter: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/release", {
        providerLeaseId: "pc-run-1-abcd1234",
        reuseLease: false,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(sandbox.setSleepAfter).not.toHaveBeenCalled();
  });
});
