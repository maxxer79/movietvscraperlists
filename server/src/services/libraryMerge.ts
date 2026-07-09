import { createHash } from "node:crypto";
import type { MediaItem } from "../scrapers/types.js";

export interface RetailerPresence {
  provider: string;
  providerName: string;
  itemId: string;
  quality?: string;
  url?: string;
}

export interface MergedItem {
  id: string;
  title: string;
  type: MediaItem["type"];
  year?: number;
  quality?: string;
  posterUrl?: string;
  url?: string;
  meta?: MediaItem["meta"];
  retailers: RetailerPresence[];
  provider: string;
  providerName: string;
}

export interface ProviderLibraryInput {
  providerId: string;
  providerName: string;
  items: MediaItem[];
}

type TaggedItem = MediaItem & { providerId: string; providerName: string };

function metaString(meta: MediaItem["meta"], key: string): string | undefined {
  const v = meta?.[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

/** Normalize title for fallback matching. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Strip trailing "(1999)" style year suffixes from display titles. */
export function cleanDisplayTitle(title: string): string {
  return title.replace(/\s*\(\s*(19|20)\d{2}\s*\)\s*$/, "").trim();
}

/**
 * Strongest match key for deduplication. Always returns a unique key string;
 * when no external id or year is available, falls back to a per-item unique key.
 */
export function matchKey(item: MediaItem): { key: string; strength: "id" | "titleYear" | "unique" } {
  const imdb = metaString(item.meta, "imdbId") ?? metaString(item.meta, "imdb");
  if (imdb) return { key: `imdb:${item.type}:${imdb.toLowerCase()}`, strength: "id" };

  const tmdb = metaString(item.meta, "tmdbId") ?? metaString(item.meta, "tmdb");
  if (tmdb) return { key: `tmdb:${item.type}:${tmdb}`, strength: "id" };

  const ma = metaString(item.meta, "moviesAnywhereId") ?? metaString(item.meta, "maId");
  if (ma) return { key: `ma:${item.type}:${ma}`, strength: "id" };

  const nt = normalizeTitle(cleanDisplayTitle(item.title));
  if (item.year) {
    return {
      key: `ty:${item.type}:${nt}:${item.year}`,
      strength: "titleYear",
    };
  }

  return {
    key: `unique:${item.type}:${nt}:${item.id}`,
    strength: "unique",
  };
}

/** All keys an item can contribute to union-find (ids + title+year + title bridge). */
function unionKeys(item: MediaItem): string[] {
  const keys: string[] = [];
  const imdb = metaString(item.meta, "imdbId") ?? metaString(item.meta, "imdb");
  if (imdb) keys.push(`imdb:${item.type}:${imdb.toLowerCase()}`);

  const tmdb = metaString(item.meta, "tmdbId") ?? metaString(item.meta, "tmdb");
  if (tmdb) keys.push(`tmdb:${item.type}:${tmdb}`);

  const ma = metaString(item.meta, "moviesAnywhereId") ?? metaString(item.meta, "maId");
  if (ma) keys.push(`ma:${item.type}:${ma}`);

  const nt = normalizeTitle(cleanDisplayTitle(item.title));
  if (item.year) keys.push(`ty:${item.type}:${nt}:${item.year}`);
  return keys;
}

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function pickPoster(current?: string, next?: string): string | undefined {
  if (!current) return next;
  if (!next) return current;
  const score = (u: string) => {
    let s = 0;
    if (/(\d{3,4})x(\d{3,4})/.test(u)) s += 2;
    if (!/thumb|small|tiny/i.test(u)) s += 1;
    return s;
  };
  return score(next) > score(current) ? next : current;
}

function mergeTaggedGroup(group: TaggedItem[]): MergedItem {
  const retailers: RetailerPresence[] = [];
  let title = "";
  let year: number | undefined;
  let quality: string | undefined;
  let posterUrl: string | undefined;
  let url: string | undefined;
  let meta: MediaItem["meta"];
  let type: MediaItem["type"] = "movie";

  for (const item of group) {
    type = item.type;
    const display = cleanDisplayTitle(item.title);
    if (display.length > title.length) title = display;
    if (item.year && !year) year = item.year;
  }
  for (const item of group) {
    if (!year && item.year) year = item.year;
  }

  for (const item of group) {
    const presence: RetailerPresence = {
      provider: item.providerId,
      providerName: item.providerName,
      itemId: item.id,
      quality: item.quality,
      url: item.url,
    };
    if (!retailers.some((r) => r.provider === presence.provider && r.itemId === presence.itemId)) {
      retailers.push(presence);
    }
    posterUrl = pickPoster(posterUrl, item.posterUrl);
    if (!url && item.url) url = item.url;
    if (item.quality && (!quality || item.quality.includes("4K"))) quality = item.quality;
    if (item.meta) meta = { ...(meta ?? {}), ...item.meta };
  }

  retailers.sort((a, b) => a.providerName.localeCompare(b.providerName));
  const first = retailers[0]!;
  const idSource =
    metaString(meta, "imdbId") ??
    metaString(meta, "tmdbId") ??
    metaString(meta, "moviesAnywhereId") ??
    `ty:${type}:${normalizeTitle(title)}:${year ?? "?"}`;
  const idHash = createHash("sha1").update(idSource).digest("hex").slice(0, 16);

  return {
    id: idHash,
    title,
    type,
    year,
    quality,
    posterUrl,
    url,
    meta,
    retailers,
    provider: first.provider,
    providerName: first.providerName,
  };
}

export function mergeLibraries(inputs: ProviderLibraryInput[]): MergedItem[] {
  const tagged: TaggedItem[] = [];
  for (const input of inputs) {
    for (const item of input.items) {
      tagged.push({
        ...item,
        title: cleanDisplayTitle(item.title),
        providerId: input.providerId,
        providerName: input.providerName,
      });
    }
  }

  const uf = new UnionFind();
  const keyToItem = new Map<string, string>();

  for (const item of tagged) {
    const itemKey = `item:${item.providerId}:${item.id}`;
    uf.find(itemKey);
    for (const k of unionKeys(item)) {
      const existing = keyToItem.get(k);
      if (existing) uf.union(itemKey, existing);
      else keyToItem.set(k, itemKey);
      uf.union(itemKey, keyToItem.get(k)!);
    }
  }

  // Title bridge: merge year-less items with a titled group when exactly one year exists.
  const byTitle = new Map<string, TaggedItem[]>();
  for (const item of tagged) {
    const tk = `title:${item.type}:${normalizeTitle(item.title)}`;
    const list = byTitle.get(tk) ?? [];
    list.push(item);
    byTitle.set(tk, list);
  }

  for (const items of byTitle.values()) {
    const years = new Set(items.map((i) => i.year).filter((y): y is number => y != null));
    if (years.size !== 1) continue;
    const anchors = items.filter((i) => i.year != null);
    if (anchors.length === 0) continue;
    const anchorKey = `item:${anchors[0]!.providerId}:${anchors[0]!.id}`;
    for (const item of items) {
      if (item.year != null) continue;
      uf.union(`item:${item.providerId}:${item.id}`, anchorKey);
    }
  }

  const groups = new Map<string, TaggedItem[]>();
  for (const item of tagged) {
    const root = uf.find(`item:${item.providerId}:${item.id}`);
    const list = groups.get(root) ?? [];
    list.push(item);
    groups.set(root, list);
  }

  const out = [...groups.values()].map(mergeTaggedGroup);
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

/** True if merged title currently lists the given provider id. */
export function hasRetailer(item: MergedItem, providerId: string): boolean {
  return item.retailers.some((r) => r.provider === providerId);
}
