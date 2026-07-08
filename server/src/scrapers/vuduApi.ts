import type { Page } from "playwright";
import { createLogger } from "../logger.js";
import { SessionExpiredError } from "./types.js";

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


function considerAuthEntry(
  key: string,
  val: string,
  out: { sessionKey?: string; userId?: string }
): void {
  if (/weakSessionKey$/i.test(key) && val) out.sessionKey = val;
  if (/userID$/i.test(key) && val) out.userId = val;
  if (/userId$/i.test(key) && val) out.userId = val;

  if ((!out.sessionKey || !out.userId) && val.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(val) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") considerAuthEntry(k, v, out);
      }
    } catch {
      /* not JSON */
    }
  }
}

function finalizeAuth(out: { sessionKey?: string; userId?: string }): VuduAuth | null {
  if (!out.sessionKey || !out.userId) return null;
  return { sessionKey: out.sessionKey, userId: out.userId };
}

/** Read weakSessionKey + userId from a saved Playwright storageState JSON (no browser). */
export function extractVuduAuthFromStorageState(storageStateJson: string): VuduAuth | null {
  try {
    const state = JSON.parse(storageStateJson) as {
      origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
    };
    const out: { sessionKey?: string; userId?: string } = {};
    for (const origin of state.origins ?? []) {
      for (const entry of origin.localStorage ?? []) {
        considerAuthEntry(entry.name, entry.value, out);
      }
    }
    return finalizeAuth(out);
  } catch {
    return null;
  }
}

/** Read weakSessionKey + userId from the logged-in web app's localStorage. */
export async function extractVuduAuth(page: Page): Promise<VuduAuth | null> {
  const auth = await page.evaluate(() => {
    let sessionKey: string | undefined;
    let userId: string | undefined;

    const consider = (key: string, val: string) => {
      if (/weakSessionKey$/i.test(key) && val) sessionKey = val;
      if (/userID$/i.test(key) && val) userId = val;
      if (/userId$/i.test(key) && val) userId = val;
    };

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const val = localStorage.getItem(key) || "";
      consider(key, val);

      if ((!sessionKey || !userId) && val.trim().startsWith("{")) {
        try {
          const obj = JSON.parse(val) as Record<string, unknown>;
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === "string") consider(k, v);
          }
        } catch {
          /* not JSON */
        }
      }
    }
    return { sessionKey, userId };
  });

  return finalizeAuth(auth);
}

export interface VuduContentItem {
  contentId: string;
  title: string;
  posterUrl?: string;
  quality?: string;
  releaseTime?: string;
  superType?: string;
  /** program | bundle | season | series */
  contentKind?: string;
  isContainer?: boolean;
}

interface FetchLibraryOpts {
  superType: "movies" | "tv";
  listType?: string;
  claimedAppId?: string;
}

function assertVuduOk(data: Record<string, unknown>, context: string): void {
  const type = vuduStr(data, "_type");
  if (type !== "error") return;

  const code = vuduStr(data, "code") || "unknown";
  const text = vuduStr(data, "text") || code;
  if (code === "authenticationExpired" || code === "accessDenied") {
    throw new SessionExpiredError(
      "Fandango session expired. Please disconnect and log in again."
    );
  }
  throw new Error(`Vudu API error (${context}): ${text}`);
}

function parseContentRow(row: Record<string, unknown>): VuduContentItem | null {
  const contentId = vuduStr(row, "contentId");
  const title = vuduStr(row, "title");
  if (!contentId || !title) return null;
  return {
    contentId,
    title,
    posterUrl: normalizePoster(vuduStr(row, "posterUrl")),
    quality: normalizeQuality(
      vuduStr(row, "bestDashVideoQuality") || vuduStr(row, "bestVideoQuality")
    ),
    releaseTime: vuduStr(row, "releaseTime"),
    superType: vuduStr(row, "superType"),
    contentKind: vuduStr(row, "type"),
    isContainer: vuduStr(row, "isContainer") === "true",
  };
}

async function vuduGet(
  params: URLSearchParams,
  context: string
): Promise<Record<string, unknown>> {
  const url = `${API_BASE}?${params.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`Vudu API HTTP ${res.status} for ${context}`);
  }
  const data = parseVuduJson(await res.text());
  assertVuduOk(data, context);
  return data;
}

/** Paginate the undocumented contentSearch API (100 items/page, moreBelow flag). */
export async function fetchVuduLibrary(
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

    const data = await vuduGet(params, `${opts.superType} offset ${offset}`);
    const batch = (data.content as Record<string, unknown>[] | undefined) ?? [];
    for (const row of batch) {
      const item = parseContentRow(row);
      if (item) out.push(item);
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

/** Individual movies/shows inside a bundle/collection (containerId lookup). */
export async function fetchBundleContents(containerId: string): Promise<VuduContentItem[]> {
  const out: VuduContentItem[] = [];
  let offset = 0;
  let pages = 0;

  while (pages < 20) {
    const params = new URLSearchParams();
    params.set("claimedAppId", "html5app");
    params.set("format", "application/json");
    params.set("_type", "contentSearch");
    params.set("containerId", containerId);
    params.set("count", "100");
    params.set("offset", String(offset));

    const data = await vuduGet(params, `bundle ${containerId} offset ${offset}`);
    const batch = (data.content as Record<string, unknown>[] | undefined) ?? [];
    for (const row of batch) {
      const item = parseContentRow(row);
      if (item) out.push(item);
    }

    const moreBelow = vuduStr(data, "moreBelow");
    pages++;
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

export function isBundleItem(item: VuduContentItem): boolean {
  return (
    item.contentKind === "bundle" ||
    item.isContainer === true ||
    /\(\s*Bundle\s*\)/i.test(item.title)
  );
}
