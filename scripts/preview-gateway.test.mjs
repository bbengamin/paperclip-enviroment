#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
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
upstream.listen(3000, "127.0.0.1");
await once(upstream, "listening");

const gateway = createPreviewGateway({ environmentId, allowedPorts: DEFAULT_ALLOWED_PORTS, secret });
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
const gatewayPort = gateway.address().port;
const url = signedUrl();
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

console.log("preview-gateway tests passed");
