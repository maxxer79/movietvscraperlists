import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

export const paths = {
  data: config.dataDir,
  sessions: join(config.dataDir, "sessions"),
  library: join(config.dataDir, "library"),
  debug: join(config.dataDir, "debug"),
};

export function ensureDataDirs() {
  for (const p of Object.values(paths)) {
    mkdirSync(p, { recursive: true });
  }
}
