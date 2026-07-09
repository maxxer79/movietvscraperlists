import type { BrowserContext, Page, Response } from "playwright";
import {
  SessionExpiredError,
  type LoginCredentials,
  type LoginStep,
  type MediaItem,
  type Provider,
} from "./types.js";
import {
  CODE_INPUT_SELECTORS,
  autoScroll,
  clickFirst,
  dismissCookieBanner,
  dumpDebug,
  fillFirst,
  firstVisible,
  looksLikeCodePrompt,
  parseQuality,
  parseYear,
} from "./helpers.js";
import { createLogger } from "../logger.js";

const log = createLogger("appletv");

/**
 * Apple TV — purchased movies library.
 *
 * Login uses Apple ID (often via account.apple.com / tv.apple.com).
 * Library destination is tuned on first sync; we try purchased/movies URLs
 * and capture JSON while scrolling. Movies only.
 *
 * Search for "TUNE:" after first Connect/Sync with a real account.
 */
export class AppleTvProvider implements Provider {
  readonly id = "appletv";
  readonly name = "Apple TV";
  readonly implemented = true;
  readonly loginUrl = "https://tv.apple.com/login";
  readonly libraryUrl = "https://tv.apple.com/shop/movies";
  readonly notes =
    "Purchased movies library. Apple ID login; 2FA supported. First sync may need selector tuning (see data/debug/).";

  /** Candidate purchased-library URLs — first that stays authenticated wins. */
  private readonly libraryCandidates = [
    "https://tv.apple.com/account/purchases",
    "https://tv.apple.com/us/purchases",
    "https://tv.apple.com/shop/movies",
    "https://tv.apple.com/",
  ];

  async startLogin(page: Page, creds: LoginCredentials): Promise<LoginStep> {
    await page.goto(this.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2000);
    await dismissCookieBanner(page);

    // TUNE: Apple often embeds sign-in in an iframe or redirects to appleid.apple.com.
    const frames = page.frames();
    let filledEmail = await fillFirst(
      page,
      [
        'input#account_name_text_field',
        'input[id*="account" i]',
        'input[type="email"]',
        'input[name="accountName"]',
        'input[autocomplete="username"]',
        'input[type="text"]',
      ],
      creds.username,
      5000
    );

    if (!filledEmail) {
      for (const frame of frames) {
        try {
          const el = frame.locator('input#account_name_text_field, input[type="email"], input[name="accountName"]').first();
          if (await el.isVisible({ timeout: 1500 })) {
            await el.fill(creds.username);
            filledEmail = true;
            break;
          }
        } catch {
          /* next frame */
        }
      }
    }

    if (!filledEmail) {
      await dumpDebug(page, this.id, "no-email-field");
      return {
        status: "error",
        message:
          "Could not find the Apple ID field. Apple may have changed the sign-in page — check data/debug/.",
      };
    }

    // TUNE: Apple often uses a two-step flow (email → Continue → password).
    await clickFirst(page, [
      'button#sign-in',
      'button:has-text("Continue")',
      'button[type="submit"]',
      '#continue-password',
    ]);
    await page.waitForTimeout(1500);

    let filledPass = await fillFirst(
      page,
      [
        'input#password_text_field',
        'input[type="password"]',
        'input[name="password"]',
        'input[autocomplete="current-password"]',
      ],
      creds.password,
      5000
    );

    if (!filledPass) {
      for (const frame of page.frames()) {
        try {
          const el = frame.locator('input#password_text_field, input[type="password"]').first();
          if (await el.isVisible({ timeout: 1500 })) {
            await el.fill(creds.password);
            filledPass = true;
            break;
          }
        } catch {
          /* next */
        }
      }
    }

    if (!filledPass) {
      await dumpDebug(page, this.id, "no-password-field");
      return {
        status: "error",
        message: "Could not find the Apple ID password field. A debug screenshot was saved.",
      };
    }

    await clickFirst(page, [
      'button#sign-in',
      'button:has-text("Sign In")',
      'button:has-text("Continue")',
      'button[type="submit"]',
    ]);
    await page.waitForTimeout(3500);
    return this.evaluatePostAuth(page);
  }

  async submitInput(page: Page, _field: string, value: string): Promise<LoginStep> {
    // Apple 2FA often uses multiple single-digit inputs.
    const digits = value.replace(/\D/g, "");
    const boxes = page.locator('input[maxlength="1"], input[autocomplete="one-time-code"]');
    const boxCount = await boxes.count().catch(() => 0);
    if (boxCount >= 4 && digits.length >= 4) {
      for (let i = 0; i < Math.min(boxCount, digits.length); i++) {
        await boxes.nth(i).fill(digits[i]!);
      }
    } else {
      const filled = await fillFirst(page, CODE_INPUT_SELECTORS, value, 5000);
      if (!filled) {
        // Try frames
        let ok = false;
        for (const frame of page.frames()) {
          try {
            const el = frame.locator(CODE_INPUT_SELECTORS.join(", ")).first();
            if (await el.isVisible({ timeout: 1000 })) {
              await el.fill(value);
              ok = true;
              break;
            }
          } catch {
            /* next */
          }
        }
        if (!ok) {
          await dumpDebug(page, this.id, "no-code-field");
          return { status: "error", message: "Could not find the Apple verification code field." };
        }
      }
    }

    await clickFirst(page, [
      'button[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Verify")',
      'button:has-text("Trust")',
    ]);
    await page.waitForTimeout(3000);
    return this.evaluatePostAuth(page);
  }

  private async evaluatePostAuth(page: Page): Promise<LoginStep> {
    if (await this.isLoggedIn(page)) return { status: "success" };
    if (await looksLikeCodePrompt(page)) {
      return {
        status: "need_input",
        field: "code",
        prompt: "Enter the Apple ID verification code from your trusted device or SMS.",
      };
    }
    await dumpDebug(page, this.id, "post-auth-unknown");
    return {
      status: "error",
      message: "Apple sign-in did not complete. A debug screenshot was saved.",
    };
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (/idmsa\.apple\.com|appleid\.apple\.com.*signin|\/login/i.test(url) &&
        (await firstVisible(page, ['input[type="password"]', "#password_text_field"], 800))) {
      return false;
    }
    const sel = await firstVisible(
      page,
      [
        'a[href*="purchases" i]',
        'a[href*="account" i]',
        'button:has-text("Sign Out")',
        '[data-testid*="account" i]',
        'text=/purchased/i',
      ],
      3000
    );
    return sel !== null || (/tv\.apple\.com/i.test(url) && !/signin|login/i.test(url));
  }

  async scrapeLibrary(
    context: BrowserContext,
    onProgress?: (message: string, itemsFound?: number) => void
  ): Promise<MediaItem[]> {
    const page = await context.newPage();
    const captured: unknown[] = [];
    const onResponse = async (response: Response) => {
      try {
        const u = response.url();
        if (!/apple\.com/i.test(u)) return;
        if (!/purchase|library|uts|amp-api|movies/i.test(u)) return;
        if (response.status() < 200 || response.status() >= 300) return;
        const ct = (response.headers()["content-type"] || "").toLowerCase();
        if (!ct.includes("json")) return;
        const json = await response.json().catch(() => null);
        if (json) captured.push(json);
      } catch {
        /* ignore */
      }
    };
    page.on("response", onResponse);

    try {
      onProgress?.("Opening Apple TV…", 0);
      let opened = false;
      for (const url of this.libraryCandidates) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(1500);
        await dismissCookieBanner(page);
        if (/signin|login|idmsa/i.test(page.url())) {
          continue;
        }
        if (await this.isLoggedIn(page)) {
          opened = true;
          onProgress?.(`Opened ${url}`, 0);
          break;
        }
      }
      if (!opened) {
        throw new SessionExpiredError(
          "Apple TV session expired. Disconnect, Connect again (complete 2FA), then Sync."
        );
      }

      await autoScroll(page, 60);
      await page.waitForTimeout(1000);

      let items = extractMoviesFromJson(captured, "appletv");
      if (items.length === 0) {
        onProgress?.("API capture empty — scraping DOM…", 0);
        items = await scrapeMovieDom(page, "appletv", onProgress);
      }
      if (items.length === 0) await dumpDebug(page, this.id, "empty-library");
      onProgress?.(`Found ${items.length} movies`, items.length);
      log.info(`Apple TV scrape: ${items.length} titles`);
      return items;
    } finally {
      page.off("response", onResponse);
      await page.close().catch(() => {});
    }
  }
}

/** Shared JSON walker for retailer scrapers — movies only. */
export function extractMoviesFromJson(blobs: unknown[], providerTag: string): MediaItem[] {
  const found: MediaItem[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown, depth: number) => {
    if (depth > 14 || node == null) return;
    if (Array.isArray(node)) {
      for (const c of node) visit(c, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const title =
      str(obj, "title") ||
      str(obj, "name") ||
      str(obj, "displayTitle") ||
      str(obj, "movieTitle");
    if (!title || title.length < 2) {
      for (const v of Object.values(obj)) visit(v, depth + 1);
      return;
    }
    const kind = str(obj, "type") || str(obj, "contentType") || str(obj, "mediaType") || "";
    if (/tv|season|series|episode|show/i.test(kind)) {
      for (const v of Object.values(obj)) visit(v, depth + 1);
      return;
    }
    if (/season\s+\d|episode\s+\d/i.test(title)) {
      for (const v of Object.values(obj)) visit(v, depth + 1);
      return;
    }
    const hasMediaHint =
      "poster" in obj ||
      "posterUrl" in obj ||
      "artwork" in obj ||
      "images" in obj ||
      "imdbId" in obj ||
      "releaseYear" in obj ||
      "year" in obj ||
      typeof obj.id === "string" ||
      typeof obj.id === "number";
    if (!hasMediaHint) {
      for (const v of Object.values(obj)) visit(v, depth + 1);
      return;
    }

    const id = str(obj, "id") || str(obj, "contentId") || str(obj, "adamId") || `${providerTag}:${title.toLowerCase()}`;
    if (seen.has(id)) {
      for (const v of Object.values(obj)) visit(v, depth + 1);
      return;
    }
    seen.add(id);
    const imdbId = str(obj, "imdbId") || str(obj, "imdb");
    const tmdbId = str(obj, "tmdbId") || str(obj, "tmdb");
    const meta: Record<string, string | number | boolean | null> = {};
    if (imdbId) meta.imdbId = imdbId.startsWith("tt") ? imdbId : `tt${imdbId}`;
    if (tmdbId) meta.tmdbId = tmdbId;
    found.push({
      id,
      title,
      type: "movie",
      year: num(obj, "year") ?? num(obj, "releaseYear") ?? parseYear(str(obj, "releaseDate")),
      quality: parseQuality(str(obj, "quality") || str(obj, "resolution")),
      posterUrl: posterFrom(obj),
      meta: Object.keys(meta).length ? meta : undefined,
    });
    for (const v of Object.values(obj)) visit(v, depth + 1);
  };

  for (const b of blobs) visit(b, 0);
  return found;
}

export async function scrapeMovieDom(
  page: Page,
  providerTag: string,
  onProgress?: (message: string, itemsFound?: number) => void
): Promise<MediaItem[]> {
  const collected = new Map<string, MediaItem>();
  let stable = 0;
  for (let i = 0; i < 150 && stable < 8; i++) {
    const batch = await page.evaluate(() => {
      const out: Array<{ title: string; href?: string; poster?: string; text?: string }> = [];
      const anchors = Array.from(
        document.querySelectorAll<HTMLAnchorElement>(
          'a[href*="/movie"], a[href*="/movies/"], a[href*="itunes.apple.com"], [class*="lockup"] a, [class*="shelf"] a'
        )
      );
      for (const a of anchors) {
        const img = a.querySelector("img");
        const title =
          (a.getAttribute("aria-label") || img?.getAttribute("alt") || a.textContent || "")
            .trim()
            .split("\n")[0]
            ?.trim() || "";
        if (title.length < 2) continue;
        out.push({
          title,
          href: a.href || undefined,
          poster: img?.src || undefined,
          text: a.textContent || undefined,
        });
      }
      return out;
    });
    let fresh = 0;
    for (const raw of batch) {
      if (/season|episode|series|tv show|trailer/i.test(raw.title)) continue;
      const id =
        raw.href?.match(/\/(?:movie|umc\.cmc\.[^/?#]+|id)\/?([^/?#]+)/i)?.[1] ||
        `${providerTag}-dom:${raw.title.toLowerCase()}`;
      if (collected.has(id)) continue;
      collected.set(id, {
        id,
        title: raw.title.replace(/\s+/g, " ").trim(),
        type: "movie",
        year: parseYear(raw.text) ?? parseYear(raw.title),
        quality: parseQuality(raw.text),
        posterUrl: raw.poster,
        url: raw.href,
      });
      fresh++;
    }
    onProgress?.(`Scrolling: ${collected.size} titles…`, collected.size);
    if (fresh === 0) stable++;
    else stable = 0;
    await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
    await page.waitForTimeout(700);
  }
  return [...collected.values()];
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

function num(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d{4}$/.test(v)) return parseInt(v, 10);
  return undefined;
}

function posterFrom(obj: Record<string, unknown>): string | undefined {
  for (const k of ["posterUrl", "poster", "artworkUrl", "imageUrl", "thumbnailUrl"]) {
    const v = obj[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  return undefined;
}
