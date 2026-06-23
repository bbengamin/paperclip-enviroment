import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cloudflareRoot = join(here, "..");
const repoRoot = join(cloudflareRoot, "..");
const outDir = join(cloudflareRoot, ".docker-tooling");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const source of [
  "tooling/apps.env",
  "scripts/install-common-tools.sh",
  "scripts/install-docker-tools.sh",
  "scripts/install-tailscale.sh",
]) {
  copyFileSync(join(repoRoot, source), join(outDir, source.split("/").at(-1)));
}

