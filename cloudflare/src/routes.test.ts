import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
}));

import { handleBridgeRequest } from "./routes.js";
import { resolveSandbox } from "./sandboxes.js";

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
        TAILSCALE_AUTHKEY: "tskey-test",
        Sandbox: {} as never,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      capabilities: {
        dockerInDocker: true,
        namedSessions: true,
        previewUrls: true,
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

  it("writes lease sentinels through the named-session exec target", async () => {
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
    // it goes through the same session as the mkdir.
    expect(sandbox.writeFile).not.toHaveBeenCalled();

    // Both calls use a single command string — the SDK's exec API ignores
    // any `args` or `stdin` option, so the bridge folds them into the
    // command line itself.
    expect(sessionExec).toHaveBeenCalledTimes(3);
    for (const call of sessionExec.mock.calls) {
      const [commandArg, optionsArg] = call;
      expect(typeof commandArg).toBe("string");
      expect(commandArg).toMatch(/^sh -lc /);
      expect(optionsArg).toEqual({ cwd: "/", timeout: expect.any(Number) });
      expect(optionsArg).not.toHaveProperty("args");
      expect(optionsArg).not.toHaveProperty("stdin");
    }
    expect(sessionExec.mock.calls[0]?.[0]).toContain("tailscale-up");
    expect(sessionExec.mock.calls[1]?.[0]).toContain("mkdir");
    expect(sessionExec.mock.calls[1]?.[0]).toContain("/workspace/paperclip");
    expect(sessionExec.mock.calls[2]?.[0]).toContain("/workspace/paperclip/.paperclip-lease.json");
  });

  it("checks lease sentinels through the named-session exec target on resume", async () => {
    const sessionExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec: sessionExec }),
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
    expect(sessionExec.mock.calls[0]?.[0]).toContain("tailscale-up");
    const [commandArg, optionsArg] = sessionExec.mock.calls[1] ?? [];
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

  it("rejects lease setup when the required Tailscale secret is missing", async () => {
    const sandbox = {
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
});
