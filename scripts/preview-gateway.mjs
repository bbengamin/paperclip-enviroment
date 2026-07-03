#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";

export const DEFAULT_ALLOWED_PORTS = Object.freeze([3000, 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 9000]);
export const DEFAULT_LISTEN_HOST = "0.0.0.0";
export const DEFAULT_LISTEN_PORT = 3999;

function base64Url(input) {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function parseAllowedPorts(value) {
  if (!value || !value.trim()) return DEFAULT_ALLOWED_PORTS;
  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
}

export function canonicalPreviewPayload({ target, issue, run, port, exp }) {
  return [
    "paperclip-preview-v1",
    `target=${target}`,
    `issue=${issue}`,
    `run=${run}`,
    `port=${port}`,
    `exp=${exp}`,
  ].join("\n");
}

export function signPreviewPayload(secret, payload) {
  return base64Url(crypto.createHmac("sha256", secret).update(payload).digest());
}

export function getEnvironmentId(env = process.env) {
  return env.PAPERCLIP_PREVIEW_ENVIRONMENT_ID || env.PAPERCLIP_ENVIRONMENT_ID || env.PAPERCLIP_RUNTIME_ENVIRONMENT_ID || os.hostname();
}

export function parsePreviewPath(pathname) {
  const parts = pathname.split("/");
  if (parts.length < 4 || parts[1] !== "preview") return null;
  const target = decodeURIComponent(parts[2] ?? "");
  const portSegment = parts[3] ?? "";
  const upstreamPath = `/${parts.slice(4).join("/")}`;
  return { target, portSegment, upstreamPath };
}

function jsonResponse(res, status, error, message, details) {
  const body = JSON.stringify({ error, message, ...(details === undefined ? {} : { details }) });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function verifyPreviewRequest(url, options) {
  const parsed = parsePreviewPath(url.pathname);
  if (!parsed || !parsed.target || !parsed.portSegment) {
    return { ok: false, status: 400, error: "invalid_request", message: "Preview URL must be /preview/<environmentId>/<port>/..." };
  }

  if (!/^\d+$/.test(parsed.portSegment)) {
    return { ok: false, status: 400, error: "invalid_request", message: "Preview port must be an integer from 1 to 65535." };
  }

  const port = Number(parsed.portSegment);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, status: 400, error: "invalid_request", message: "Preview port must be an integer from 1 to 65535." };
  }

  if (!options.allowedPorts.includes(port)) {
    return { ok: false, status: 400, error: "unsupported_port", message: "Preview port is not in the allowed preview port set." };
  }

  if (parsed.target !== options.environmentId) {
    return { ok: false, status: 404, error: "preview_target_not_found", message: "Preview target does not match this SSH environment." };
  }

  if (!options.secret) {
    return {
      ok: false,
      status: 503,
      error: "preview_signing_unavailable",
      message: "PREVIEW_SIGNING_SECRET is required for signed preview links.",
    };
  }

  const issue = url.searchParams.get("pc_issue");
  const run = url.searchParams.get("pc_run");
  const exp = url.searchParams.get("pc_exp");
  const sig = url.searchParams.get("pc_sig");
  if (!issue || !run || !exp || !sig) {
    return { ok: false, status: 401, error: "unauthorized", message: "Missing signed preview query parameters." };
  }

  if (!/^\d+$/.test(exp)) {
    return { ok: false, status: 401, error: "unauthorized", message: "Invalid preview expiry." };
  }

  const expSeconds = Number(exp);
  if (!Number.isSafeInteger(expSeconds) || expSeconds <= 0) {
    return { ok: false, status: 401, error: "unauthorized", message: "Invalid preview expiry." };
  }

  if (expSeconds <= options.nowSeconds) {
    return { ok: false, status: 410, error: "preview_expired", message: "Signed preview link has expired." };
  }

  const payload = canonicalPreviewPayload({ target: parsed.target, issue, run, port, exp });
  const expected = signPreviewPayload(options.secret, payload);
  if (!timingSafeEqualString(expected, sig)) {
    return { ok: false, status: 401, error: "unauthorized", message: "Invalid signed preview URL." };
  }

  const upstreamUrl = new URL(`http://127.0.0.1:${port}${parsed.upstreamPath || "/"}`);
  for (const [key, value] of url.searchParams.entries()) {
    if (!key.startsWith("pc_")) upstreamUrl.searchParams.append(key, value);
  }
  return { ok: true, target: parsed.target, port, upstreamUrl };
}

function sanitizedHeaders(headers) {
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower.startsWith("x-paperclip-") || lower === "host") {
      delete next[key];
    }
  }
  return next;
}

export function createPreviewGateway(options = {}) {
  const environmentId = options.environmentId ?? getEnvironmentId();
  const allowedPorts = options.allowedPorts ?? parseAllowedPorts(process.env.PAPERCLIP_PREVIEW_ALLOWED_PORTS);
  const secret = options.secret ?? process.env.PREVIEW_SIGNING_SECRET;

  return http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://preview-gateway.local");
    if (requestUrl.pathname === "/health") {
      const body = JSON.stringify({
        ok: true,
        provider: "ssh",
        environmentId,
        signingConfigured: Boolean(secret),
        allowedPorts,
      });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    const verification = verifyPreviewRequest(requestUrl, {
      environmentId,
      allowedPorts,
      secret,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!verification.ok) {
      jsonResponse(res, verification.status, verification.error, verification.message);
      req.resume();
      return;
    }

    const proxyReq = http.request(verification.upstreamUrl, {
      method: req.method,
      headers: sanitizedHeaders(req.headers),
    }, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      delete headers["connection"];
      delete headers["keep-alive"];
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (error) => {
      jsonResponse(res, 502, "preview_upstream_unavailable", "Preview upstream did not respond as HTTP.", error.message);
    });

    req.pipe(proxyReq);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.PAPERCLIP_PREVIEW_GATEWAY_HOST || DEFAULT_LISTEN_HOST;
  const port = Number(process.env.PAPERCLIP_PREVIEW_GATEWAY_PORT || DEFAULT_LISTEN_PORT);
  const server = createPreviewGateway();
  server.listen(port, host, () => {
    console.error(`paperclip preview gateway listening on ${host}:${port} for environment ${getEnvironmentId()}`);
  });
}
