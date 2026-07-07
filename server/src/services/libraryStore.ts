import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";
import type { MediaItem } from "../scrapers/types.js";

export interface LibrarySnapshot {
  providerId: string;
  scrapedAt: string;
  count: number;
  items: MediaItem[];
}

function file(providerId: string) {
  return join(paths.library, `${providerId}.json`);
}

export function saveLibrary(providerId: string, items: MediaItem[]): LibrarySnapshot {
  const snapshot: LibrarySnapshot = {
    providerId,
    scrapedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
  writeFileSync(file(providerId), JSON.stringify(snapshot, null, 2), "utf8");
  return snapshot;
}

export function loadLibrary(providerId: string): LibrarySnapshot | null {
  const f = file(providerId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as LibrarySnapshot;
  } catch {
    return null;
  }
}
