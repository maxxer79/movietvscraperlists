#!/usr/bin/env node
/**
 * Version bumper.
 *
 * Every build increments the build number so the running site always shows
 * exactly which build is live. Semver parts can be bumped explicitly.
 *
 * Usage:
 *   node scripts/bump-version.mjs            # bump build number only
 *   node scripts/bump-version.mjs --build    # bump build number only (explicit)
 *   node scripts/bump-version.mjs --patch    # 0.1.0 -> 0.1.1 (+ build)
 *   node scripts/bump-version.mjs --minor    # 0.1.0 -> 0.2.0 (+ build)
 *   node scripts/bump-version.mjs --major    # 0.1.0 -> 1.0.0 (+ build)
 *   node scripts/bump-version.mjs --set 1.2.3
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const versionFile = join(root, "version.json");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const getVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const raw = readFileSync(versionFile, "utf8");
if (raw.includes("<<<<<<<") || raw.includes(">>>>>>>") || raw.includes("=======")) {
  console.error(
    `ERROR: ${versionFile} contains unresolved git conflict markers.\n` +
      `Fix version.json before bumping. Expected clean JSON like:\n` +
      `{\n  "version": "0.1.0",\n  "build": 1,\n  "releasedAt": "...",\n  "codename": "..."\n}`
  );
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  console.error(`ERROR: Could not parse ${versionFile}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

let [major, minor, patch] = String(data.version).split(".").map((n) => parseInt(n, 10) || 0);

const setTo = getVal("--set");
if (setTo) {
  [major, minor, patch] = setTo.split(".").map((n) => parseInt(n, 10) || 0);
} else if (has("--major")) {
  major += 1;
  minor = 0;
  patch = 0;
} else if (has("--minor")) {
  minor += 1;
  patch = 0;
} else if (has("--patch")) {
  patch += 1;
}

data.version = `${major}.${minor}.${patch}`;
data.build = (parseInt(data.build, 10) || 0) + 1;
data.releasedAt = new Date().toISOString();

writeFileSync(versionFile, JSON.stringify(data, null, 2) + "\n");

// Keep root package.json version in sync for good measure.
try {
  const pkgFile = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  pkg.version = data.version;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
} catch {
  /* non-fatal */
}

console.log(`Version: v${data.version} (build ${data.build})`);
