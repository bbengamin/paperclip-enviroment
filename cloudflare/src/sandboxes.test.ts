import { describe, expect, it } from "vitest";
import { buildLeaseSandboxId, buildSentinelPath, isTimeoutError } from "./helpers.js";

describe("bridge sandbox helpers", () => {
  it("builds reusable lease IDs from environment IDs", () => {
    expect(buildLeaseSandboxId({
      environmentId: "Env_123",
      runId: "run-ignored",
      reuseLease: true,
      normalizeId: true,
    })).toBe("pc-env-env-123");
  });

  it("scopes reusable lease IDs per issue so different issues never share a sandbox", () => {
    const build = (issueId: string) =>
      buildLeaseSandboxId({
        environmentId: "env-1",
        runId: "run-ignored",
        reuseLease: true,
        normalizeId: true,
        issueId,
      });
    const a = build("LOC-48");
    const b = build("LOC-50");
    // Same issue is deterministic (so reuse re-targets the same sandbox).
    expect(build("LOC-48")).toBe(a);
    // Different issues never collide.
    expect(a).not.toBe(b);
    expect(a.startsWith("pc-env-env-1-i-")).toBe(true);
  });

  it("keeps reusable per-issue sandbox IDs within Cloudflare's 63-character limit", () => {
    // Both environment id and issue id are UUIDs in production; the full pair
    // is ~86 chars, which Cloudflare rejects. The hashed discriminator must
    // keep the id short.
    const id = buildLeaseSandboxId({
      environmentId: "7084ebfc-c668-4190-8293-70ba00f2d02e",
      runId: "run-ignored",
      reuseLease: true,
      normalizeId: true,
      issueId: "425ae019-a695-44a8-b11e-1efe05ffbfe1",
    });
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id.length).toBeGreaterThan(0);
  });

  it("builds ephemeral lease IDs from run IDs", () => {
    expect(buildLeaseSandboxId({
      environmentId: "env-1",
      runId: "Run_123",
      reuseLease: false,
      normalizeId: true,
      randomId: "ABCD1234",
    })).toBe("pc-run-123-abcd1234");
  });

  it("builds the workspace sentinel path", () => {
    expect(buildSentinelPath("/workspace/paperclip/")).toBe("/workspace/paperclip/.paperclip-lease.json");
  });

  it("detects timeout-shaped errors", () => {
    expect(isTimeoutError(new Error("command timed out after 10s"))).toBe(true);
    expect(isTimeoutError(new Error("some other error"))).toBe(false);
  });
});
