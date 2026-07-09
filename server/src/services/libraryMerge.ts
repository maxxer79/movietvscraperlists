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

/**
 * Strongest match key. Returns null when only a weak title-only key would
 * be available (no external id and no year) — caller uses unique per-item key.
 */
export function matchKey(item: MediaItem): { key: string; strength: "id" | "titleYear" | "unique" } {
  const imdb = metaString(item.meta, "imdbId") ?? metaString(item.meta, "imdb");
  if (imdb) return { key: `imdb:${imdb.toLowerCase()}`, strength: "id" };

  const tmdb = metaString(item.meta, "tmdbId") ?? metaString(item.meta, "tmdb");
  if (tmdb) return { key: `tmdb:${item.type}:${tmdb}`, strength: "id" };

  const ma = metaString(item.meta, "moviesAnywhereId") ?? metaString(item.meta, "maId");
  if (ma) return { key: `ma:${ma}`, strength: "id" };

  if (item.year) {
    return {
      key: `ty:${item.type}:${normalizeTitle(item.title)}:${item.year}`,
      strength: "titleYear",
    };
  }

  return {
    key: `unique:${item.type}:${normalizeTitle(item.title)}:${item.id}`,
    strength: "unique",
  };
}

function pickPoster(current?: string, next?: string): string | undefined {
  if (!current) return next;
  if (!next) return current;
  // Prefer larger-looking URLs / non-thumbnail paths when obvious.
  const score = (u: string) => {
    let s = 0;
    if (/(\d{3,4})x(\d{3,4})/.test(u)) s += 2;
    if (!/thumb|small|tiny/i.test(u)) s += 1;
    return s;
  };
  return score(next) > score(current) ? next : current;
}

export function mergeLibraries(inputs: ProviderLibraryInput[]): MergedItem[] {
  const groups = new Map<
    string,
    {
      title: string;
      type: MediaItem["type"];
      year?: number;
      quality?: string;
      posterUrl?: string;
      url?: string;
      meta?: MediaItem["meta"];
      retailers: RetailerPresence[];
    }
  >();

  for (const input of inputs) {
    for (const item of input.items) {
      const { key } = matchKey(item);
      const existing = groups.get(key);
      const presence: RetailerPresence = {
        provider: input.providerId,
        providerName: input.providerName,
        itemId: item.id,
        quality: item.quality,
        url: item.url,
      };

      if (!existing) {
        groups.set(key, {
          title: item.title,
          type: item.type,
          year: item.year,
          quality: item.quality,
          posterUrl: item.posterUrl,
          url: item.url,
          meta: item.meta,
          retailers: [presence],
        });
        continue;
      }

      // Prefer a more complete display title (longer non-empty) when IMDb-merged.
      if (item.title && item.title.length > existing.title.length) {
        existing.title = item.title;
      }
      if (item.year && !existing.year) existing.year = item.year;
      existing.posterUrl = pickPoster(existing.posterUrl, item.posterUrl);
      if (!existing.url && item.url) existing.url = item.url;
      if (item.quality && (!existing.quality || item.quality.includes("4K"))) {
        existing.quality = item.quality;
      }
      if (item.meta) {
        existing.meta = { ...(existing.meta ?? {}), ...item.meta };
      }
      if (!existing.retailers.some((r) => r.provider === presence.provider && r.itemId === presence.itemId)) {
        existing.retailers.push(presence);
      }
    }
  }

  const out: MergedItem[] = [];
  for (const [key, g] of groups) {
    const retailers = [...g.retailers].sort((a, b) => a.providerName.localeCompare(b.providerName));
    const first = retailers[0];
    const idHash = createHash("sha1").update(key).digest("hex").slice(0, 16);
    out.push({
      id: idHash,
      title: g.title,
      type: g.type,
      year: g.year,
      quality: g.quality,
      posterUrl: g.posterUrl,
      url: g.url,
      meta: g.meta,
      retailers,
      provider: first.provider,
      providerName: first.providerName,
    });
  }

  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

/** True if merged title currently lists the given provider id. */
export function hasRetailer(item: MergedItem, providerId: string): boolean {
  return item.retailers.some((r) => r.provider === providerId);
}
