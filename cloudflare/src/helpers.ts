export function normalizeLeaseIdPart(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

// Deterministic, dependency-free FNV-1a 32-bit hash rendered as 8 hex chars.
// Used to derive a short, stable per-issue discriminator for reusable sandbox
// ids so they never approach Cloudflare's 63-character sandbox-id limit (an
// env UUID + a full issue UUID would be ~86 chars and is rejected).
function shortStableToken(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildLeaseSandboxId(input: {
  environmentId: string;
  runId: string;
  reuseLease: boolean;
  normalizeId: boolean;
  issueId?: string | null;
  randomId?: string;
}): string {
  // Reusable leases are keyed per-issue when an issue id is present so that
  // different issues never land on the same physical sandbox (and thus never
  // share a `/workspace` checkout). A warm sandbox is only reused for the same
  // issue (fast continuation: comment / approval / unblock) within the sleep
  // window. Reuse without an issue id (e.g. ad-hoc) stays environment-scoped
  // for backwards compatibility.
  //
  // The issue discriminator is a short stable hash (not the raw issue id) so
  // the final sandbox id stays within Cloudflare's 1-63 character limit while
  // remaining deterministic per (environment, issue).
  const issuePart = input.issueId && input.issueId.trim().length > 0 ? input.issueId.trim() : null;
  const base = input.reuseLease
    ? issuePart
      ? `pc-env-${input.environmentId}-i-${shortStableToken(issuePart)}`
      : `pc-env-${input.environmentId}`
    : `pc-${input.runId}-${input.randomId ?? crypto.randomUUID().slice(0, 8)}`;
  return input.normalizeId ? normalizeLeaseIdPart(base) : base;
}

export function buildSentinelPath(remoteCwd: string): string {
  return `${remoteCwd.replace(/\/+$/, "")}/.paperclip-lease.json`;
}

export function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  return /timeout/i.test(name) || /timed out|timeout/i.test(message);
}

// Single-quote `value` for safe inclusion in a `sh -c` script. Single
// quotes inside the value are escaped via the standard `'"'"'` dance.
// Used by both `routes.ts` and `exec.ts` — keep one copy here so updates
// (e.g. handling additional shell special characters) stay in sync.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
