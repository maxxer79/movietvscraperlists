import type { APIRequestContext, Page } from "playwright";
import { createLogger } from "../logger.js";

const log = createLogger("vudu-api");
const API_BASE = "https://api.vudu.com/api2/";

export interface VuduAuth {
  sessionKey: string;
  userId: string;
}

/** Vudu wraps every scalar in a single-element array: { title: ["Matrix"] } */
export function vuduStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (Array.isArray(v) && v.length > 0) return String(v[0]);
  if (typeof v === "string") return v;
  return undefined;
}

export function parseVuduJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const inner = trimmed.startsWith("/*-secure-")
    ? trimmed.slice("/*-secure-".length, trimmed.endsWith("*/") ? -2 : undefined)
    : trimmed;
  return JSON.parse(inner) as Record<string, unknown>;
}

/** Read weakSessionKey + userId from the logged-in web app's localStorage. */
export async function extractVuduAuth(page: Page): Promise<VuduAuth | null> {
  const auth = await page.evaluate(() => {
    let sessionKey: string | undefined;
    let userId: string | undefined;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const val = localStorage.getItem(key) || "";
      if (/weakSessionKey$/i.test(key) && val) sessionKey = val;
      if (/userID$/i.test(key) && val) userId = val;
      if (/userId$/i.test(key) && val) userId = val;
    }
    return { sessionKey, userId };
  });
  if (!auth.sessionKey || !auth.userId) return null;
  return { sessionKey: auth.sessionKey, userId: auth.userId };
}

export interface VuduContentItem {
  contentId: string;
  title: string;
  posterUrl?: string;
  quality?: string;
  releaseTime?: string;
  superType?: string;
}

interface FetchLibraryOpts {
  superType: "movies" | "tv";
  listType?: string;
  claimedAppId?: string;
}

/** Paginate the undocumented contentSearch API (100 items/page, moreBelow flag). */
export async function fetchVuduLibrary(
  request: APIRequestContext,
  auth: VuduAuth,
  opts: FetchLibraryOpts
): Promise<VuduContentItem[]> {
  const listType = opts.listType ?? "rentedOrOwned";
  const claimedAppId = opts.claimedAppId ?? "html5app";
  const out: VuduContentItem[] = [];
  let offset = 0;
  let pages = 0;

  while (pages < 200) {
  const params = new URLSearchParams();
  params.set("claimedAppId", claimedAppId);
  params.set("format", "application/json");
  params.set("_type", "contentSearch");
  params.set("count", "100");
  params.set("dimensionality", "any");
  params.append("followup", "ratingsSummaries");
  params.append("followup", "totalCount");
  params.set("listType", listType);
  params.set("sessionKey", auth.sessionKey);
  params.set("sortBy", "title");
  params.set("superType", opts.superType);
  params.set("userId", auth.userId);
  params.set("offset", String(offset));
    if (opts.superType === "movies") {
      params.append("type", "program");
      params.append("type", "bundle");
    } else {
      params.append("type", "season");
      params.append("type", "series");
    }

    const url = `${API_BASE}?${params.toString()}`;
    const res = await request.get(url, { timeout: 60_000 });
    if (!res.ok()) {
      throw new Error(`Vudu API HTTP ${res.status()} for ${opts.superType} offset ${offset}`);
    }

    const data = parseVuduJson(await res.text());
    const batch = (data.content as Record<string, unknown>[] | undefined) ?? [];
    for (const row of batch) {
      const contentId = vuduStr(row, "contentId");
      const title = vuduStr(row, "title");
      if (!contentId || !title) continue;
      out.push({
        contentId,
        title,
        posterUrl: normalizePoster(vuduStr(row, "posterUrl")),
        quality: normalizeQuality(
          vuduStr(row, "bestDashVideoQuality") || vuduStr(row, "bestVideoQuality")
        ),
        releaseTime: vuduStr(row, "releaseTime"),
        superType: vuduStr(row, "superType"),
      });
    }

    const moreBelow = vuduStr(data, "moreBelow");
    pages++;
    log.info(
      `${opts.superType} page ${pages}: +${batch.length} (total ${out.length}), moreBelow=${moreBelow}`
    );
    if (moreBelow !== "true") break;
    offset += 100;
  }

  return out;
}

function normalizePoster(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("http")) return url;
  return `https://images2.vudu.com/${url.replace(/^\//, "")}`;
}

function normalizeQuality(q: string | undefined): string | undefined {
  if (!q) return undefined;
  const u = q.toUpperCase();
  if (u.includes("UHD") || u.includes("4K")) return "4K UHD";
  if (u.includes("HDX")) return "HDX";
  if (u.includes("HD")) return "HD";
  if (u.includes("SD")) return "SD";
  return q;
}

export function vuduDetailUrl(title: string, contentId: string): string {
  const slug = encodeURIComponent(title.replace(/\s+/g, " ").trim());
  return `https://athome.fandango.com/content/browse/details/${slug}/${contentId}`;
}

export function releaseYear(releaseTime: string | undefined): number | undefined {
  if (!releaseTime) return undefined;
  const m = releaseTime.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : undefined;
}
