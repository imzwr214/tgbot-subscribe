import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const sourceFiles = [
  "src/index.ts",
  "src/mihomo/generate.ts",
  "wrangler.toml",
  "package.json",
  "package-lock.json",
  "tsconfig.json"
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
  if (result.status !== 0) return "unknown";
  return result.stdout.trim() || "unknown";
}

const hash = createHash("sha256");
for (const file of sourceFiles) {
  hash.update(file);
  hash.update("\0");
  hash.update(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  hash.update("\0");
}

const commit = run("git", ["rev-parse", "HEAD"]);
const dirty = run("git", ["status", "--short", "--", ...sourceFiles]) !== "unknown";
const sourceHash = hash.digest("hex");
const builtAt = new Date().toISOString();

const deploy = spawnSync(
  "wrangler",
  [
    "deploy",
    "--var",
    `BUILD_COMMIT:${commit}`,
    "--var",
    `BUILD_DIRTY:${dirty ? "true" : "false"}`,
    "--var",
    `BUILD_SOURCE_HASH:${sourceHash}`,
    "--var",
    `BUILD_TIME:${builtAt}`
  ],
  { stdio: "inherit", shell: process.platform === "win32" }
);

process.exit(deploy.status ?? 1);
