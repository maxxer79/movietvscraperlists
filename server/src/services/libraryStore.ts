import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";
import type { MediaItem } from "../scrapers/types.js";

/** A title that left the provider library (or was manually removed). */
export interface RemovedItem {
  id: string;
  title: string;
  type: MediaItem["type"];
  year?: number;
  quality?: string;
  posterUrl?: string;
  url?: string;
  /** ISO timestamp when we first noticed it was gone / deleted. */
  removedAt: string;
  /** Why it left the active library. */
  reason: "sync" | "manual";
  /** Last successful sync that still had this title. */
  lastSeenAt?: string;
}

export interface LibrarySnapshot {
  providerId: string;
  scrapedAt: string;
  count: number;
  items: MediaItem[];
  /** Titles no longer on the provider (or manually deleted). Newest first. */
  removed?: RemovedItem[];
  /**
   * Manually deleted ids — excluded from future syncs so misclassified /
   * duplicate cards do not come back until restored.
   */
  hiddenIds?: string[];
}

const MAX_REMOVED = 1000;

function file(providerId: string) {
  return join(paths.library, `${providerId}.json`);
}

function writeSnapshot(snapshot: LibrarySnapshot): LibrarySnapshot {
  writeFileSync(file(snapshot.providerId), JSON.stringify(snapshot, null, 2), "utf8");
  return snapshot;
}

function toRemoved(
  item: MediaItem,
  reason: "sync" | "manual",
  lastSeenAt?: string
): RemovedItem {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    year: item.year,
    quality: item.quality,
    posterUrl: item.posterUrl,
    url: item.url,
    removedAt: new Date().toISOString(),
    reason,
    lastSeenAt,
  };
}

function upsertRemoved(list: RemovedItem[], entry: RemovedItem): RemovedItem[] {
  const without = list.filter((r) => r.id !== entry.id);
  return [entry, ...without].slice(0, MAX_REMOVED);
}

/** Full replace used by tests / rare callers — prefer saveLibraryFromSync. */
export function saveLibrary(providerId: string, items: MediaItem[]): LibrarySnapshot {
  const prev = loadLibrary(providerId);
  return writeSnapshot({
    providerId,
    scrapedAt: new Date().toISOString(),
    count: items.length,
    items,
    removed: prev?.removed ?? [],
    hiddenIds: prev?.hiddenIds ?? [],
  });
}

/**
 * Persist a fresh scrape while detecting titles that disappeared since the
 * last sync, and while honoring manually hidden ids.
 */
export function saveLibraryFromSync(
  providerId: string,
  scrapedItems: MediaItem[]
): LibrarySnapshot {
  const prev = loadLibrary(providerId);
  const hidden = new Set(prev?.hiddenIds ?? []);
  const items = scrapedItems.filter((i) => !hidden.has(i.id));
  const newIds = new Set(items.map((i) => i.id));

  let removed = [...(prev?.removed ?? [])];

  // Titles that returned on the provider leave the removed list.
  removed = removed.filter((r) => !newIds.has(r.id));

  // Titles present last sync but missing now → record removal.
  if (prev?.items?.length) {
    for (const old of prev.items) {
      if (hidden.has(old.id)) continue;
      if (newIds.has(old.id)) continue;
      removed = upsertRemoved(removed, toRemoved(old, "sync", prev.scrapedAt));
    }
  }

  return writeSnapshot({
    providerId,
    scrapedAt: new Date().toISOString(),
    count: items.length,
    items,
    removed,
    hiddenIds: prev?.hiddenIds ?? [],
  });
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

/** Remove a title from the active library and hide it from future syncs. */
export function deleteLibraryItem(
  providerId: string,
  itemId: string
): { ok: true; snapshot: LibrarySnapshot } | { ok: false; error: string } {
  const prev = loadLibrary(providerId);
  if (!prev) return { ok: false, error: "No library for this provider" };

  const item = prev.items.find((i) => i.id === itemId);
  if (!item) return { ok: false, error: "Title not found" };

  const items = prev.items.filter((i) => i.id !== itemId);
  const hiddenIds = [...new Set([...(prev.hiddenIds ?? []), itemId])];
  const removed = upsertRemoved(
    prev.removed ?? [],
    toRemoved(item, "manual", prev.scrapedAt)
  );

  const snapshot = writeSnapshot({
    ...prev,
    count: items.length,
    items,
    hiddenIds,
    removed,
  });
  return { ok: true, snapshot };
}

/** Undo a manual hide so the next sync can bring the title back. */
export function restoreLibraryItem(
  providerId: string,
  itemId: string
): { ok: true; snapshot: LibrarySnapshot } | { ok: false; error: string } {
  const prev = loadLibrary(providerId);
  if (!prev) return { ok: false, error: "No library for this provider" };

  const hiddenIds = (prev.hiddenIds ?? []).filter((id) => id !== itemId);
  const removed = (prev.removed ?? []).filter((r) => r.id !== itemId);
  const snapshot = writeSnapshot({ ...prev, hiddenIds, removed });
  return { ok: true, snapshot };
}
