#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ALLOWED_PORTS,
  canonicalPreviewPayload,
  createPreviewGateway,
  signPreviewPayload,
  verifyPreviewRequest,
} from "./preview-gateway.mjs";

const secret = "test-secret";
const environmentId = "ssh-env-1";
const run = "run-1";
const issue = "RL-1406";
const exp = "4102444800";

function signedUrl({ target = environmentId, port = 3000, expires = exp, signatureSecret = secret, path = "/app?tab=home" } = {}) {
  const payload = canonicalPreviewPayload({ target, issue, run, port, exp: expires });
  const sig = signPreviewPayload(signatureSecret, payload);
  return new URL(`http://gateway.test/preview/${encodeURIComponent(target)}/${port}${path}&pc_issue=${issue}&pc_run=${run}&pc_exp=${expires}&pc_sig=${sig}`);
}

function verify(url) {
  return verifyPreviewRequest(url, {
    environmentId,
    allowedPorts: DEFAULT_ALLOWED_PORTS,
    secret,
    nowSeconds: 1_700_000_000,
  });
}

assert.equal(verify(signedUrl()).ok, true, "valid signed preview URL should pass");
assert.equal(verify(signedUrl({ signatureSecret: "wrong" })).error, "unauthorized", "invalid signature should fail");
assert.equal(verify(signedUrl({ expires: "100" })).error, "preview_expired", "expired signature should fail");
assert.equal(verify(new URL("http://gateway.test/preview/ssh-env-1/nope/app")).error, "invalid_request", "malformed port should fail");
assert.equal(verify(signedUrl({ port: 22 })).error, "unsupported_port", "disallowed port should fail");
assert.equal(verify(signedUrl({ target: "other-env" })).error, "preview_target_not_found", "wrong target should fail");
assert.equal(
  verifyPreviewRequest(signedUrl(), { environmentId, allowedPorts: DEFAULT_ALLOWED_PORTS, secret: "", nowSeconds: 1_700_000_000 }).error,
  "preview_signing_unavailable",
  "missing secret should fail previews without crashing",
);

const upstream = http.createServer((req, res) => {
  assert.equal(req.headers.authorization, undefined, "gateway must strip Authorization");
  assert.equal(req.headers["x-paperclip-task-id"], undefined, "gateway must strip Paperclip headers");
  assert.equal(req.url, "/app?tab=home", "gateway must remove signing query parameters");
  res.end("preview ok");
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamPort = upstream.address().port;

const gateway = createPreviewGateway({ environmentId, allowedPorts: [upstreamPort], secret });
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
const gatewayPort = gateway.address().port;
const url = signedUrl({ port: upstreamPort });
url.host = `127.0.0.1:${gatewayPort}`;

const body = await new Promise((resolve, reject) => {
  const req = http.get(url, {
    headers: {
      Authorization: "Bearer bridge-token",
      "X-Paperclip-Task-Id": "RL-1406",
    },
  }, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => resolve(data));
  });
  req.on("error", reject);
});

assert.equal(body, "preview ok", "gateway should proxy valid signed HTTP previews");
await new Promise((resolve) => gateway.close(resolve));
await new Promise((resolve) => upstream.close(resolve));

const dynamicUpstream = http.createServer((_req, res) => {
  res.end("dynamic preview ok");
});
dynamicUpstream.listen(0, "127.0.0.1");
await once(dynamicUpstream, "listening");
const dynamicUpstreamPort = dynamicUpstream.address().port;

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preview-gateway-"));
const secretFile = path.join(tmpDir, "signing-secret");
const dynamicGateway = createPreviewGateway({ environmentId, allowedPorts: [dynamicUpstreamPort], secretFile });
dynamicGateway.listen(0, "127.0.0.1");
await once(dynamicGateway, "listening");
const dynamicGatewayPort = dynamicGateway.address().port;
const dynamicUrl = signedUrl({ port: dynamicUpstreamPort });
dynamicUrl.host = `127.0.0.1:${dynamicGatewayPort}`;

const unavailable = await new Promise((resolve, reject) => {
  const req = http.get(dynamicUrl, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, data }));
  });
  req.on("error", reject);
});
assert.equal(unavailable.status, 503, "gateway without boot-time or file secret should reject signed previews");
assert.match(unavailable.data, /preview_signing_unavailable/);

await fs.writeFile(secretFile, secret, { mode: 0o600 });
const metadata = await new Promise((resolve, reject) => {
  const req = http.get(`http://127.0.0.1:${dynamicGatewayPort}/.well-known/paperclip-preview`, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => resolve(JSON.parse(data)));
  });
  req.on("error", reject);
});
assert.equal(metadata.target, environmentId, "metadata endpoint should expose the gateway signing target");
assert.equal(metadata.signingConfigured, true, "metadata endpoint should reflect runtime-file secret availability");
assert.equal(metadata.signingSecretSource, "file", "metadata endpoint should report runtime file secret source");
assert.equal(metadata.environmentType, "ssh", "metadata endpoint should default the environment type to ssh");
assert.ok(Object.prototype.hasOwnProperty.call(metadata, "baseUrl"), "metadata endpoint should always include a baseUrl field");

// A gateway told its public origin must advertise it so the in-sandbox agent
// can sign a link against the real host instead of guessing a base URL.
const baseUrlGateway = createPreviewGateway({
  environmentId,
  allowedPorts: [dynamicUpstreamPort],
  secretFile,
  baseUrl: "http://100.100.100.100:3999/",
});
baseUrlGateway.listen(0, "127.0.0.1");
await once(baseUrlGateway, "listening");
const baseUrlGatewayPort = baseUrlGateway.address().port;
const baseUrlMetadata = await new Promise((resolve, reject) => {
  const req = http.get(`http://127.0.0.1:${baseUrlGatewayPort}/.well-known/paperclip-preview`, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => resolve(JSON.parse(data)));
  });
  req.on("error", reject);
});
assert.equal(
  baseUrlMetadata.baseUrl,
  "http://100.100.100.100:3999",
  "metadata endpoint should expose the configured public base URL without a trailing slash",
);
assert.equal(
  baseUrlMetadata.routePrefix,
  `/preview/${encodeURIComponent(environmentId)}`,
  "metadata endpoint should expose the signing route prefix",
);
await new Promise((resolve) => baseUrlGateway.close(resolve));

const dynamicBody = await new Promise((resolve, reject) => {
  const req = http.get(dynamicUrl, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => resolve(data));
  });
  req.on("error", reject);
});
assert.equal(dynamicBody, "dynamic preview ok", "gateway should accept signed previews after runtime secret file appears");

await new Promise((resolve) => dynamicGateway.close(resolve));
await new Promise((resolve) => dynamicUpstream.close(resolve));
await fs.rm(tmpDir, { recursive: true, force: true });

console.log("preview-gateway tests passed");
