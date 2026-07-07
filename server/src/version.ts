import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface VersionInfo {
  version: string;
  build: number;
  releasedAt: string;
  codename?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// version.json lives at the repo root. From compiled dist/ that's ../../version.json,
// from tsx src/ it's also ../../version.json. Try a few candidates to be safe.
const candidates = [
  join(__dirname, "..", "..", "version.json"),
  join(__dirname, "..", "..", "..", "version.json"),
  join(process.cwd(), "version.json"),
];

export function getVersion(): VersionInfo {
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as VersionInfo;
    } catch {
      /* try next */
    }
  }
  return { version: "0.0.0", build: 0, releasedAt: new Date().toISOString() };
}
