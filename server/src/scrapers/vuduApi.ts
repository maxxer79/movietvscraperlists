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


function decodeHoggleKey(key: string): string {
  if (!key.startsWith("hoggle")) return key;
  try {
    const b64 = decodeURIComponent(key.slice("hoggle".length));
    return Buffer.from(b64, "base64").toString("utf8") || key;
  } catch {
    return key;
  }
}

function considerAuthEntry(
  key: string,
  val: string,
  out: { sessionKey?: string; userId?: string }
): void {
  if (!val || !val.trim()) return;

  const logical = decodeHoggleKey(key);

  // Prefer weakSessionKey; also accept sessionKey / weakSession variants.
  if (/weakSessionKey$/i.test(logical) && val) out.sessionKey = val;
  else if (
    !out.sessionKey &&
    /^(strong)?[Ss]essionKey$/i.test(logical) &&
    !/csrf/i.test(logical) &&
    val.length > 8
  ) {
    out.sessionKey = val;
  }

  if (/^(userID|userId|accountId)$/i.test(logical) && val) out.userId = val;
  else if (!out.userId && /^user[_-]?id$/i.test(logical) && /^\d+$/.test(val)) out.userId = val;

  if ((!out.sessionKey || !out.userId) && val.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(val) as Record<string, unknown>;
      walkObjectForAuth(obj, out, 0);
    } catch {
      /* not JSON */
    }
  }
}

function walkObjectForAuth(
  obj: Record<string, unknown>,
  out: { sessionKey?: string; userId?: string },
  depth: number
): void {
  if (depth > 4) return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") considerAuthEntry(k, v, out);
    else if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
      considerAuthEntry(k, v[0], out);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      walkObjectForAuth(v as Record<string, unknown>, out, depth + 1);
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
      cookies?: Array<{ name: string; value: string }>;
    };
    const out: { sessionKey?: string; userId?: string } = {};
    for (const origin of state.origins ?? []) {
      for (const entry of origin.localStorage ?? []) {
        considerAuthEntry(entry.name, entry.value, out);
      }
    }
    // Some builds stash tokens in cookies too.
    for (const cookie of state.cookies ?? []) {
      considerAuthEntry(cookie.name, cookie.value, out);
    }
    return finalizeAuth(out);
  } catch {
    return null;
  }
}

/**
 * Read sessionKey + userId from the live page.
 * Checks localStorage AND sessionStorage (Playwright storageState only persists localStorage).
 */
export async function extractVuduAuth(page: Page): Promise<VuduAuth | null> {
  const auth = await page.evaluate(() => {
    const out: { sessionKey?: string; userId?: string } = {};

    const decodeHoggle = (key: string): string => {
      if (!key.startsWith("hoggle")) return key;
      try {
        const b64 = decodeURIComponent(key.slice("hoggle".length));
        // atob is available in the browser context
        return atob(b64) || key;
      } catch {
        return key;
      }
    };

    const consider = (key: string, val: string) => {
      if (!val) return;
      const logical = decodeHoggle(key);

      if (/weakSessionKey$/i.test(logical)) out.sessionKey = val;
      else if (
        !out.sessionKey &&
        /^(strong)?[Ss]essionKey$/i.test(logical) &&
        !/csrf/i.test(logical) &&
        val.length > 8
      ) {
        out.sessionKey = val;
      }
      if (/^(userID|userId|accountId)$/i.test(logical)) out.userId = val;
      else if (!out.userId && /^user[_-]?id$/i.test(logical) && /^\d+$/.test(val)) out.userId = val;

      if ((!out.sessionKey || !out.userId) && val.trim().startsWith("{")) {
        try {
          const walk = (obj: Record<string, unknown>, depth: number) => {
            if (depth > 4) return;
            for (const [k, v] of Object.entries(obj)) {
              if (typeof v === "string") consider(k, v);
              else if (Array.isArray(v) && typeof v[0] === "string") consider(k, v[0]);
              else if (v && typeof v === "object" && !Array.isArray(v)) {
                walk(v as Record<string, unknown>, depth + 1);
              }
            }
          };
          walk(JSON.parse(val) as Record<string, unknown>, 0);
        } catch {
          /* ignore */
        }
      }
    };

    const scan = (store: Storage) => {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key) continue;
        consider(key, store.getItem(key) || "");
      }
    };

    scan(localStorage);
    scan(sessionStorage);
    return {
      ...out,
      localKeys: Object.keys(localStorage),
      sessionKeys: Object.keys(sessionStorage),
    };
  });

  const result = finalizeAuth(auth);
  if (!result) {
    log.warn(
      `No Vudu auth in page storage (local=${auth.localKeys?.length ?? 0}, session=${auth.sessionKeys?.length ?? 0}) keys local=[${(auth.localKeys || []).slice(0, 30).join(",")}] session=[${(auth.sessionKeys || []).slice(0, 30).join(",")}]`
    );
  } else {
    log.info(`Extracted Vudu auth from page storage (userId ${result.userId.slice(0, 6)}…)`);
  }
  return result;
}

/** Pull sessionKey + userId out of a Vudu API URL (query string). */
export function extractVuduAuthFromUrl(url: string): VuduAuth | null {
  try {
    const u = new URL(url);
    const sessionKey =
      u.searchParams.get("sessionKey") ||
      u.searchParams.get("weakSessionKey") ||
      undefined;
    const userId =
      u.searchParams.get("userId") ||
      u.searchParams.get("userID") ||
      u.searchParams.get("accountId") ||
      undefined;
    return finalizeAuth({ sessionKey: sessionKey || undefined, userId: userId || undefined });
  } catch {
    return null;
  }
}

/**
 * Listen for api.vudu.com traffic and capture sessionKey/userId from request URLs.
 * The modern Fandango SPA often keeps tokens in memory / IndexedDB, but still
 * sends them on every library API call.
 */
export async function captureVuduAuthFromNetwork(
  page: Page,
  timeoutMs = 45_000
): Promise<VuduAuth | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (auth: VuduAuth | null) => {
      if (settled) return;
      settled = true;
      page.off("request", onRequest);
      page.off("response", onResponse);
      clearTimeout(timer);
      resolve(auth);
    };

    const considerUrl = (url: string) => {
      if (!/api\.vudu\.com/i.test(url)) return;
      const auth = extractVuduAuthFromUrl(url);
      if (auth) {
        log.info(`Captured Vudu auth from network request (userId ${auth.userId.slice(0, 6)}…)`);
        finish(auth);
      }
    };

    const onRequest = (req: { url: () => string }) => considerUrl(req.url());
    const onResponse = (res: { url: () => string }) => considerUrl(res.url());

    page.on("request", onRequest);
    page.on("response", onResponse);

    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** Best-effort dump of storage key names for debugging auth capture failures. */
export async function describePageStorage(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const decode = (key: string): string => {
        if (!key.startsWith("hoggle")) return key;
        try {
          return atob(decodeURIComponent(key.slice("hoggle".length))) || key;
        } catch {
          return key;
        }
      };
      const local = Object.keys(localStorage).map(decode);
      const session = Object.keys(sessionStorage).map(decode);
      return `localStorage(${local.length}): ${local.slice(0, 40).join(", ") || "(empty)"}; sessionStorage(${session.length}): ${session.slice(0, 40).join(", ") || "(empty)"}`;
    });
  } catch {
    return "could not read page storage";
  }
}

/** Copy auth into localStorage so Playwright storageState will persist it for next sync. */
export async function injectVuduAuthIntoLocalStorage(page: Page, auth: VuduAuth): Promise<void> {
  await page.evaluate((a) => {
    localStorage.setItem("mtv.vudu.weakSessionKey", a.sessionKey);
    localStorage.setItem("mtv.vudu.userId", a.userId);
  }, auth);
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
  onPage?: (info: { superType: string; page: number; batchSize: number; total: number }) => void;
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
    opts.onPage?.({ superType: opts.superType, page: pages, batchSize: batch.length, total: out.length });
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
