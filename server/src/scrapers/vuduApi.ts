import type { Page } from "playwright";
import { createLogger } from "../logger.js";
import { SessionExpiredError } from "./types.js";

const log = createLogger("vudu-api");
const API_BASE = "https://api.vudu.com/api2/";

export interface VuduAuth {
  sessionKey: string;
  userId: string;
  /** Optional alternate session key if weakSessionKey fails. */
  strongSessionKey?: string;
  accountId?: string;
}

/** Device-bound credentials used by the Fandango SPA to mint a fresh sessionKey. */
export interface VuduLightDevice {
  lightDeviceKey: string;
  lightDeviceId?: string;
  lightDeviceAccountId?: string;
  userId?: string;
  accountId?: string;
  userName?: string;
  email?: string;
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
  out: {
    sessionKey?: string;
    strongSessionKey?: string;
    userId?: string;
    accountId?: string;
  }
): void {
  if (!val || !val.trim()) return;

  const logical = decodeHoggleKey(key);
  // Values are sometimes URI-encoded.
  let value = val;
  try {
    if (/%[0-9A-Fa-f]{2}/.test(val)) value = decodeURIComponent(val);
  } catch {
    value = val;
  }

  if (/^weakSessionKey$/i.test(logical) && value) out.sessionKey = value;
  else if (/^strongSessionKey$/i.test(logical) && value) out.strongSessionKey = value;
  else if (
    !out.sessionKey &&
    /^sessionKey$/i.test(logical) &&
    !/csrf/i.test(logical) &&
    value.length > 8
  ) {
    out.sessionKey = value;
  }

  if (/^(userID|userId)$/i.test(logical) && value) out.userId = value;
  else if (/^accountId$/i.test(logical) && value) out.accountId = value;
  else if (!out.userId && /^user[_-]?id$/i.test(logical) && /^\d+$/.test(value)) out.userId = value;

  if ((!out.sessionKey || !out.userId) && value.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(value) as Record<string, unknown>;
      walkObjectForAuth(obj, out, 0);
    } catch {
      /* not JSON */
    }
  }
}

function walkObjectForAuth(
  obj: Record<string, unknown>,
  out: {
    sessionKey?: string;
    strongSessionKey?: string;
    userId?: string;
    accountId?: string;
  },
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

function finalizeAuth(out: {
  sessionKey?: string;
  strongSessionKey?: string;
  userId?: string;
  accountId?: string;
}): VuduAuth | null {
  const sessionKey = out.sessionKey || out.strongSessionKey;
  const userId = out.userId || out.accountId;
  if (!sessionKey || !userId) return null;
  return {
    sessionKey,
    userId,
    strongSessionKey: out.strongSessionKey,
    accountId: out.accountId,
  };
}

/** Read weakSessionKey + userId from a saved Playwright storageState JSON (no browser). */
export function extractVuduAuthFromStorageState(storageStateJson: string): VuduAuth | null {
  try {
    const state = JSON.parse(storageStateJson) as {
      origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
      cookies?: Array<{ name: string; value: string }>;
    };
    const out: {
      sessionKey?: string;
      strongSessionKey?: string;
      userId?: string;
      accountId?: string;
    } = {};
    for (const origin of state.origins ?? []) {
      for (const entry of origin.localStorage ?? []) {
        considerAuthEntry(entry.name, entry.value, out);
      }
    }
    for (const cookie of state.cookies ?? []) {
      considerAuthEntry(cookie.name, cookie.value, out);
    }
    const auth = finalizeAuth(out);
    if (auth) {
      log.info(
        `Extracted Vudu auth from storageState (userId ${auth.userId.slice(0, 6)}…, hasStrong=${Boolean(auth.strongSessionKey)})`
      );
    }
    return auth;
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
    const out: {
      sessionKey?: string;
      strongSessionKey?: string;
      userId?: string;
      accountId?: string;
    } = {};

    const decodeHoggle = (key: string): string => {
      if (!key.startsWith("hoggle")) return key;
      try {
        const b64 = decodeURIComponent(key.slice("hoggle".length));
        return atob(b64) || key;
      } catch {
        return key;
      }
    };

    const consider = (key: string, val: string) => {
      if (!val) return;
      const logical = decodeHoggle(key);
      let value = val;
      try {
        if (/%[0-9A-Fa-f]{2}/.test(val)) value = decodeURIComponent(val);
      } catch {
        value = val;
      }

      if (/^weakSessionKey$/i.test(logical)) out.sessionKey = value;
      else if (/^strongSessionKey$/i.test(logical)) out.strongSessionKey = value;
      else if (
        !out.sessionKey &&
        /^sessionKey$/i.test(logical) &&
        !/csrf/i.test(logical) &&
        value.length > 8
      ) {
        out.sessionKey = value;
      }
      if (/^(userID|userId)$/i.test(logical)) out.userId = value;
      else if (/^accountId$/i.test(logical)) out.accountId = value;
      else if (!out.userId && /^user[_-]?id$/i.test(logical) && /^\d+$/.test(value)) {
        out.userId = value;
      }

      if ((!out.sessionKey || !out.userId) && value.trim().startsWith("{")) {
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
          walk(JSON.parse(value) as Record<string, unknown>, 0);
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

function isVuduApiUrl(url: string): boolean {
  return /(?:^|\.)vudu\.com\/api/i.test(url) || /api(?:cache)?\.vudu\.com/i.test(url);
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

/** Pull auth from application/x-www-form-urlencoded or query-like POST bodies. */
export function extractVuduAuthFromBody(body: string | null | undefined): VuduAuth | null {
  if (!body || !body.trim()) return null;
  try {
    const params = new URLSearchParams(body.startsWith("{") ? "" : body);
    if (![...params.keys()].length && body.includes("=")) {
      // already tried URLSearchParams
    }
    const sessionKey =
      params.get("sessionKey") || params.get("weakSessionKey") || undefined;
    const userId =
      params.get("userId") || params.get("userID") || params.get("accountId") || undefined;
    const fromParams = finalizeAuth({
      sessionKey: sessionKey || undefined,
      userId: userId || undefined,
    });
    if (fromParams) return fromParams;

    if (body.trim().startsWith("{") || body.includes("/*-secure-")) {
      const data = body.includes("/*-secure-")
        ? parseVuduJson(body)
        : (JSON.parse(body) as Record<string, unknown>);
      return extractVuduAuthFromPayload(data);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Walk a Vudu API JSON payload for sessionKey / userId (handles nested sessionKey objects). */
export function extractVuduAuthFromPayload(data: Record<string, unknown>): VuduAuth | null {
  const out: {
    sessionKey?: string;
    strongSessionKey?: string;
    userId?: string;
    accountId?: string;
  } = {};

  const skRoot = data.sessionKey;
  if (Array.isArray(skRoot) && skRoot[0] && typeof skRoot[0] === "object") {
    const nested = skRoot[0] as Record<string, unknown>;
    const key = vuduStr(nested, "sessionKey") || vuduStr(nested, "weakSessionKey");
    const uid = vuduStr(nested, "userId") || vuduStr(nested, "userID");
    if (key) out.sessionKey = key;
    if (uid) out.userId = uid;
  }

  walkObjectForAuth(data, out, 0);
  const directKey = vuduStr(data, "sessionKey") || vuduStr(data, "weakSessionKey");
  const directUser = vuduStr(data, "userId") || vuduStr(data, "userID");
  if (directKey) out.sessionKey = out.sessionKey || directKey;
  if (directUser) out.userId = out.userId || directUser;

  return finalizeAuth(out);
}

function considerLightDeviceEntry(
  key: string,
  val: string,
  out: VuduLightDevice & { _seen?: boolean }
): void {
  if (!val || !val.trim()) return;
  const logical = decodeHoggleKey(key);
  let value = val;
  try {
    if (/%[0-9A-Fa-f]{2}/.test(val)) value = decodeURIComponent(val);
  } catch {
    value = val;
  }
  if (/^lightDeviceKey$/i.test(logical)) {
    out.lightDeviceKey = value;
    out._seen = true;
  } else if (/^lightDeviceId$/i.test(logical)) out.lightDeviceId = value;
  else if (/^lightDeviceAccountId$/i.test(logical)) out.lightDeviceAccountId = value;
  else if (/^(userID|userId)$/i.test(logical)) out.userId = value;
  else if (/^accountId$/i.test(logical)) out.accountId = value;
  else if (/^(userName|username)$/i.test(logical)) out.userName = value;
  else if (/^email$/i.test(logical)) out.email = value;
}

/** Read light-device credentials from Playwright storageState (no browser). */
export function extractLightDeviceFromStorageState(
  storageStateJson: string
): VuduLightDevice | null {
  try {
    const state = JSON.parse(storageStateJson) as {
      origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
    };
    const out: VuduLightDevice & { _seen?: boolean } = { lightDeviceKey: "" };
    for (const origin of state.origins ?? []) {
      for (const entry of origin.localStorage ?? []) {
        considerLightDeviceEntry(entry.name, entry.value, out);
      }
    }
    if (!out.lightDeviceKey) return null;
    return out;
  } catch {
    return null;
  }
}

/** Read light-device credentials from the live page. */
export async function extractLightDeviceFromPage(page: Page): Promise<VuduLightDevice | null> {
  const raw = await page.evaluate(() => {
    const out: Record<string, string> = {};
    const decodeHoggle = (key: string): string => {
      if (!key.startsWith("hoggle")) return key;
      try {
        return atob(decodeURIComponent(key.slice("hoggle".length))) || key;
      } catch {
        return key;
      }
    };
    const scan = (store: Storage) => {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key) continue;
        const logical = decodeHoggle(key);
        const val = store.getItem(key) || "";
        let value = val;
        try {
          if (/%[0-9A-Fa-f]{2}/.test(val)) value = decodeURIComponent(val);
        } catch {
          value = val;
        }
        if (
          /^(lightDeviceKey|lightDeviceId|lightDeviceAccountId|userId|userID|accountId|userName|username|email)$/i.test(
            logical
          )
        ) {
          out[logical] = value;
        }
      }
    };
    scan(localStorage);
    scan(sessionStorage);
    return out;
  });

  const lightDeviceKey = raw.lightDeviceKey;
  if (!lightDeviceKey) return null;
  return {
    lightDeviceKey,
    lightDeviceId: raw.lightDeviceId,
    lightDeviceAccountId: raw.lightDeviceAccountId,
    userId: raw.userId || raw.userID,
    accountId: raw.accountId,
    userName: raw.userName || raw.username,
    email: raw.email,
  };
}

/**
 * Mint a fresh weakSessionKey with username/password (classic Vudu API login).
 * This is the only reliable way we've found to obtain API credentials — lightDeviceKey
 * is rejected on sessionKeyRequest, and cookie login alone does not refresh API tokens.
 */
export async function mintVuduSessionWithPassword(
  userName: string,
  password: string,
  onAttempt?: (message: string) => void
): Promise<VuduAuth | null> {
  const attempts: Array<{ claimedAppId: string; label: string }> = [
    { claimedAppId: "myvudu", label: "myvudu + password" },
    { claimedAppId: "html5app", label: "html5app + password" },
  ];

  for (const attempt of attempts) {
    onAttempt?.(`Trying ${attempt.label}…`);
    try {
      const params = new URLSearchParams({
        claimedAppId: attempt.claimedAppId,
        format: "application/json",
        _type: "sessionKeyRequest",
        followup: "user",
        userName,
        password,
        weakSeconds: "25920000",
        sensorData: "sensorData",
      });
      const data = await vuduGet(params, `passwordLogin/${attempt.label}`);
      const auth = extractVuduAuthFromPayload(data);
      if (auth) {
        log.info(
          `Minted Vudu session via ${attempt.label} (userId ${auth.userId.slice(0, 6)}…)`
        );
        onAttempt?.(`Succeeded with ${attempt.label}`);
        return auth;
      }
      onAttempt?.(`${attempt.label}: response had no sessionKey`);
    } catch (err) {
      const msg = `${attempt.label}: ${(err as Error).message}`;
      log.warn(msg);
      onAttempt?.(msg);
    }
  }
  return null;
}

/**
 * @deprecated lightDeviceKey is rejected by sessionKeyRequest; kept only for diagnostics.
 * Prefer mintVuduSessionWithPassword at Connect time.
 */
export async function renewVuduSessionWithLightDevice(
  device: VuduLightDevice,
  onAttempt?: (message: string) => void,
  cookieHeader?: string
): Promise<VuduAuth | null> {
  onAttempt?.(
    "Light-device renewal is not supported by Vudu sessionKeyRequest — reconnect required"
  );
  void device;
  void cookieHeader;
  return null;
}

function buildLightDeviceRenewalAttempts(
  device: VuduLightDevice
): Array<{ label: string; method: "GET" | "POST"; params: Record<string, string> }> {
  const accountId = device.lightDeviceAccountId || device.accountId || device.userId;
  const attempts: Array<{
    label: string;
    method: "GET" | "POST";
    params: Record<string, string>;
  }> = [];

  // Vudu rejects lightDeviceId on sessionKeyRequest ("unexpected name 'lightDeviceId'").
  // Keep lightDeviceId only for the dedicated light-device request type.
  const push = (
    label: string,
    params: Record<string, string>,
    method: "GET" | "POST" = "GET"
  ) => {
    attempts.push({ label: `${label} [${method}]`, method, params });
  };

  for (const claimedAppId of ["html5app", "myvudu"] as const) {
    const base: Record<string, string> = {
      claimedAppId,
      format: "application/json",
      _type: "sessionKeyRequest",
      lightDeviceKey: device.lightDeviceKey,
      weakSeconds: "2592000",
      followup: "user",
    };

    // Most important: key-only (this is what failed earlier only because lightDeviceId was attached).
    push(`${claimedAppId}/sessionKeyRequest + lightDeviceKey`, { ...base });
    push(`${claimedAppId}/sessionKeyRequest + lightDeviceKey`, { ...base }, "POST");

    if (accountId) {
      push(`${claimedAppId}/sessionKeyRequest + accountId`, {
        ...base,
        accountId,
      });
      push(
        `${claimedAppId}/sessionKeyRequest + accountId`,
        { ...base, accountId },
        "POST"
      );
    }
    if (device.userId && device.userId !== accountId) {
      push(`${claimedAppId}/sessionKeyRequest + userId`, {
        ...base,
        userId: device.userId,
      });
    }
    if (device.userName || device.email) {
      push(`${claimedAppId}/sessionKeyRequest + userName`, {
        ...base,
        userName: device.userName || device.email || "",
      });
    }
  }

  // Dedicated light-device type — may accept lightDeviceId.
  if (device.lightDeviceId) {
    for (const claimedAppId of ["html5app", "myvudu"] as const) {
      const lightBase: Record<string, string> = {
        claimedAppId,
        format: "application/json",
        _type: "lightDeviceSessionKeyRequest",
        lightDeviceKey: device.lightDeviceKey,
        lightDeviceId: device.lightDeviceId,
        weakSeconds: "2592000",
        followup: "user",
      };
      push(`${claimedAppId}/lightDeviceSessionKeyRequest`, { ...lightBase });
      if (accountId) {
        push(`${claimedAppId}/lightDeviceSessionKeyRequest + accountId`, {
          ...lightBase,
          accountId,
          lightDeviceAccountId: accountId,
        });
      }
    }
  }

  return attempts;
}

/** Build a Cookie header from Playwright storageState JSON. */
export function cookieHeaderFromStorageState(storageStateJson: string): string | undefined {
  try {
    const state = JSON.parse(storageStateJson) as {
      cookies?: Array<{ name: string; value: string; domain?: string }>;
    };
    const cookies = (state.cookies ?? []).filter((c) =>
      /vudu\.com|fandango\.com/i.test(c.domain || "")
    );
    if (!cookies.length) return undefined;
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return undefined;
  }
}

/**
 * Renew using Playwright's request API (browser cookies, bypasses patched page fetch).
 */
export async function renewVuduSessionWithBrowserCookies(
  page: Page,
  device: VuduLightDevice,
  onAttempt?: (message: string) => void
): Promise<VuduAuth | null> {
  const attempts = buildLightDeviceRenewalAttempts(device);

  for (const attempt of attempts) {
    onAttempt?.(`Browser ${attempt.label}…`);
    try {
      const qs = new URLSearchParams(attempt.params).toString();
      const url = `${API_BASE}?${qs}`;
      const res =
        attempt.method === "POST"
          ? await page.request.post(API_BASE, {
              form: attempt.params,
              headers: {
                Accept: "application/json, text/javascript, */*",
                Origin: "https://athome.fandango.com",
                Referer: "https://athome.fandango.com/",
              },
            })
          : await page.request.get(url, {
              headers: {
                Accept: "application/json, text/javascript, */*",
                Origin: "https://athome.fandango.com",
                Referer: "https://athome.fandango.com/",
              },
            });

      const text = await res.text();
      if (!res.ok()) {
        const msg = `${attempt.label}: HTTP ${res.status()}`;
        log.warn(msg);
        onAttempt?.(msg);
        continue;
      }

      let data: Record<string, unknown>;
      try {
        data = parseVuduJson(text);
      } catch {
        const msg = `${attempt.label}: bad JSON (${text.slice(0, 80)})`;
        onAttempt?.(msg);
        continue;
      }

      const type = vuduStr(data, "_type");
      if (type === "error") {
        const code = vuduStr(data, "code") || "unknown";
        const sub = vuduStr(data, "subCode");
        const errText = vuduStr(data, "text") || code;
        const msg = `${attempt.label}: ${[code, sub, errText].filter(Boolean).join(" / ")}`;
        log.warn(msg);
        onAttempt?.(msg);
        continue;
      }

      const auth = extractVuduAuthFromPayload(data);
      if (auth) {
        log.info(
          `Browser-cookie renewed Vudu session via ${attempt.label} (userId ${auth.userId.slice(0, 6)}…)`
        );
        onAttempt?.(`Succeeded with ${attempt.label}`);
        return auth;
      }
      onAttempt?.(`${attempt.label}: response had no sessionKey`);
    } catch (err) {
      const msg = `${attempt.label}: ${(err as Error).message}`;
      log.warn(msg);
      onAttempt?.(msg);
    }
  }
  return null;
}

/** @deprecated Use renewVuduSessionWithBrowserCookies — page fetch is patched by Fandango. */
export async function renewVuduSessionInPage(
  page: Page,
  device: VuduLightDevice,
  onAttempt?: (message: string) => void
): Promise<VuduAuth | null> {
  return renewVuduSessionWithBrowserCookies(page, device, onAttempt);
}

/** Drop expired session keys so the SPA is forced to remint on next navigation. */
export async function clearStaleVuduSessionKeys(page: Page): Promise<void> {
  await page.evaluate(() => {
    const decodeHoggle = (key: string): string => {
      if (!key.startsWith("hoggle")) return key;
      try {
        return atob(decodeURIComponent(key.slice("hoggle".length))) || key;
      } catch {
        return key;
      }
    };
    const dropLogical =
      /^(weakSessionKey|strongSessionKey|weakSessionKeyExpiration|mtv\.vudu\.weakSessionKey)$/i;
    for (const store of [localStorage, sessionStorage]) {
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k) keys.push(k);
      }
      for (const key of keys) {
        if (dropLogical.test(decodeHoggle(key)) || dropLogical.test(key)) {
          store.removeItem(key);
        }
      }
    }
  });
}

/**
 * Listen for Vudu API traffic and capture sessionKey/userId from URLs, POST bodies,
 * and Vudu's secure-wrapped JSON responses (res.json() fails on that wrapper).
 */
export async function captureVuduAuthFromNetwork(
  page: Page,
  timeoutMs = 45_000
): Promise<VuduAuth | null> {
  return new Promise((resolve) => {
    let settled = false;
    let lastCandidate: VuduAuth | null = null;
    let vuduHits = 0;

    const finish = (auth: VuduAuth | null) => {
      if (settled) return;
      settled = true;
      page.off("request", onRequest);
      page.off("response", onResponse);
      clearTimeout(timer);
      if (!auth) {
        log.warn(`Network auth capture timed out after ${vuduHits} Vudu API hit(s)`);
      }
      resolve(auth);
    };

    const accept = (auth: VuduAuth | null, source: string, finishNow: boolean) => {
      if (!auth) return;
      lastCandidate = auth;
      log.info(
        `Seen Vudu auth from ${source} (userId ${auth.userId.slice(0, 6)}…)`
      );
      if (finishNow) finish(auth);
    };

    const onRequest = (req: {
      url: () => string;
      postData: () => string | null;
    }) => {
      const url = req.url();
      if (!isVuduApiUrl(url)) return;
      vuduHits++;
      // Request URLs often carry stale keys — keep as candidates only.
      accept(extractVuduAuthFromUrl(url), "request URL", false);
      accept(extractVuduAuthFromBody(req.postData()), "request body", false);
    };

    const onResponse = (res: {
      url: () => string;
      status: () => number;
      text: () => Promise<string>;
      request: () => { postData: () => string | null };
    }) => {
      void (async () => {
        if (settled) return;
        const url = res.url();
        if (!isVuduApiUrl(url)) return;
        vuduHits++;
        if (res.status() !== 200) return;

        let text = "";
        try {
          text = await res.text();
        } catch {
          return;
        }

        let data: Record<string, unknown> | null = null;
        try {
          data = parseVuduJson(text);
        } catch {
          try {
            data = JSON.parse(text) as Record<string, unknown>;
          } catch {
            data = null;
          }
        }

        if (data) {
          const code = vuduStr(data, "code");
          if (code === "authenticationExpired" || code === "accessDenied") {
            // Stale key on the wire — keep listening for a renewal response.
            return;
          }
          const fromBody = extractVuduAuthFromPayload(data);
          if (fromBody) {
            accept(fromBody, "response body", true);
            return;
          }
        }

        accept(extractVuduAuthFromUrl(url), "response URL", false);
      })();
    };

    page.on("request", onRequest);
    page.on("response", onResponse);

    const timer = setTimeout(() => {
      if (lastCandidate) {
        log.info(
          `Using last-seen Vudu auth from network (userId ${lastCandidate.userId.slice(0, 6)}…)`
        );
      }
      finish(lastCandidate);
    }, timeoutMs);
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

/** Patch a Playwright storageState JSON string with refreshed Vudu API credentials. */
export function injectVuduAuthIntoStorageState(
  storageStateJson: string,
  auth: VuduAuth
): string {
  const state = JSON.parse(storageStateJson) as {
    origins?: Array<{
      origin: string;
      localStorage?: Array<{ name: string; value: string }>;
    }>;
  };
  const origins = state.origins ?? [];
  let target = origins.find((o) => /fandango\.com|vudu\.com/i.test(o.origin));
  if (!target) {
    target = {
      origin: "https://athome.fandango.com",
      localStorage: [],
    };
    origins.push(target);
    state.origins = origins;
  }
  const ls = target.localStorage ?? [];
  const upsert = (name: string, value: string) => {
    const existing = ls.find((e) => e.name === name);
    if (existing) existing.value = value;
    else ls.push({ name, value });
  };
  upsert("mtv.vudu.weakSessionKey", auth.sessionKey);
  upsert("mtv.vudu.userId", auth.userId);
  upsert("weakSessionKey", auth.sessionKey);
  upsert("userId", auth.userId);
  target.localStorage = ls;
  return JSON.stringify(state);
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
  sessionKeyOverride?: string;
  onPage?: (info: { superType: string; page: number; batchSize: number; total: number }) => void;
}

function assertVuduOk(data: Record<string, unknown>, context: string): void {
  const type = vuduStr(data, "_type");
  if (type !== "error") return;

  const code = vuduStr(data, "code") || "unknown";
  const subCode = vuduStr(data, "subCode");
  const text = vuduStr(data, "text") || code;
  const detail = [code, subCode, text].filter(Boolean).join(" / ");
  if (code === "authenticationExpired" || code === "accessDenied") {
    throw new SessionExpiredError(
      "Fandango session expired. Disconnect, Connect again (complete any email code), then Sync."
    );
  }
  throw new Error(`Vudu API error (${context}): ${detail}`);
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
  context: string,
  opts?: { cookie?: string; method?: "GET" | "POST" }
): Promise<Record<string, unknown>> {
  const method = opts?.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json, text/javascript, */*",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Referer: "https://athome.fandango.com/",
    Origin: "https://athome.fandango.com",
  };
  if (opts?.cookie) headers.Cookie = opts.cookie;

  let res: Response;
  try {
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      res = await fetch(API_BASE, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers,
        body: params.toString(),
      });
    } else {
      res = await fetch(`${API_BASE}?${params.toString()}`, {
        signal: AbortSignal.timeout(60_000),
        headers,
      });
    }
  } catch (err) {
    throw new Error(`Vudu API network failure (${context}): ${(err as Error).message}`);
  }
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `Vudu API HTTP ${res.status} for ${context}: ${body.slice(0, 200).replace(/\s+/g, " ")}`
    );
  }
  let data: Record<string, unknown>;
  try {
    data = parseVuduJson(body);
  } catch (err) {
    throw new Error(
      `Vudu API bad JSON (${context}): ${(err as Error).message}; body=${body.slice(0, 120)}`
    );
  }
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
  const sessionKey = opts.sessionKeyOverride ?? auth.sessionKey;
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
    params.set("sessionKey", sessionKey);
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

    const data = await vuduGet(
      params,
      `${opts.superType}/${claimedAppId} offset ${offset}`
    );
    const batch = (data.content as Record<string, unknown>[] | undefined) ?? [];
    for (const row of batch) {
      const item = parseContentRow(row);
      if (item) out.push(item);
    }

    const moreBelow = vuduStr(data, "moreBelow");
    pages++;
    opts.onPage?.({
      superType: opts.superType,
      page: pages,
      batchSize: batch.length,
      total: out.length,
    });
    log.info(
      `${opts.superType} page ${pages}: +${batch.length} (total ${out.length}), moreBelow=${moreBelow}`
    );
    if (moreBelow !== "true") break;
    offset += 100;
  }

  return out;
}

/**
 * Try several claimedAppId / sessionKey combinations until one works.
 * Logs each failure so the UI sync log shows the real API error.
 */
export async function fetchVuduLibraryWithFallback(
  auth: VuduAuth,
  opts: Omit<FetchLibraryOpts, "claimedAppId" | "sessionKeyOverride">,
  onAttempt?: (message: string) => void
): Promise<VuduContentItem[]> {
  const attempts: Array<{ claimedAppId: string; sessionKey: string; label: string }> = [
    { claimedAppId: "html5app", sessionKey: auth.sessionKey, label: "html5app + weakSessionKey" },
    { claimedAppId: "myvudu", sessionKey: auth.sessionKey, label: "myvudu + weakSessionKey" },
    { claimedAppId: "vuduandroid", sessionKey: auth.sessionKey, label: "vuduandroid + weakSessionKey" },
  ];
  if (auth.strongSessionKey && auth.strongSessionKey !== auth.sessionKey) {
    attempts.push(
      {
        claimedAppId: "html5app",
        sessionKey: auth.strongSessionKey,
        label: "html5app + strongSessionKey",
      },
      {
        claimedAppId: "myvudu",
        sessionKey: auth.strongSessionKey,
        label: "myvudu + strongSessionKey",
      }
    );
  }

  let lastErr: Error | null = null;
  let sawExpired = false;
  for (const attempt of attempts) {
    try {
      onAttempt?.(`Trying ${attempt.label}…`);
      const rows = await fetchVuduLibrary(auth, {
        ...opts,
        claimedAppId: attempt.claimedAppId,
        sessionKeyOverride: attempt.sessionKey,
      });
      onAttempt?.(`Succeeded with ${attempt.label}`);
      return rows;
    } catch (err) {
      lastErr = err as Error;
      if (err instanceof SessionExpiredError) {
        sawExpired = true;
        onAttempt?.(`${attempt.label}: session rejected`);
        continue;
      }
      log.warn(`${attempt.label} failed: ${lastErr.message}`);
      onAttempt?.(`${attempt.label} failed: ${lastErr.message}`);
    }
  }
  if (sawExpired && (!lastErr || lastErr instanceof SessionExpiredError)) {
    throw new SessionExpiredError(
      "Fandango session expired. Disconnect, Connect again (complete any email code), then Sync."
    );
  }
  throw lastErr ?? new Error("All Vudu API auth variants failed");
}

/**
 * Quick probe: returns auth with the working sessionKey as primary, or null if
 * every variant is rejected as expired. Transient network errors also yield null
 * (caller should not clear the browser session for those alone — scrapeLibrary
 * only clears when login redirect / total capture failure).
 */
export async function validateVuduAuth(auth: VuduAuth): Promise<VuduAuth | null> {
  const probe = async (claimedAppId: string, sessionKey: string) => {
    const params = new URLSearchParams();
    params.set("claimedAppId", claimedAppId);
    params.set("format", "application/json");
    params.set("_type", "contentSearch");
    params.set("count", "1");
    params.set("dimensionality", "any");
    params.set("listType", "rentedOrOwned");
    params.set("sessionKey", sessionKey);
    params.set("sortBy", "title");
    params.set("superType", "movies");
    params.set("userId", auth.userId);
    params.set("offset", "0");
    params.append("type", "program");
    await vuduGet(params, `auth-probe/${claimedAppId}`);
  };

  const keys = [...new Set([auth.sessionKey, auth.strongSessionKey].filter(
    (k): k is string => Boolean(k)
  ))];
  for (const claimedAppId of ["html5app", "myvudu"] as const) {
    for (const sessionKey of keys) {
      try {
        await probe(claimedAppId, sessionKey);
        return {
          ...auth,
          sessionKey,
          strongSessionKey:
            auth.strongSessionKey && auth.strongSessionKey !== sessionKey
              ? auth.strongSessionKey
              : auth.sessionKey !== sessionKey
                ? auth.sessionKey
                : auth.strongSessionKey,
        };
      } catch (err) {
        if (err instanceof SessionExpiredError) continue;
        log.warn(`Auth probe ${claimedAppId} failed: ${(err as Error).message}`);
      }
    }
  }
  return null;
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
