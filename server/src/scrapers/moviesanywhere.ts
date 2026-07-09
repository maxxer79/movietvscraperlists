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

const log = createLogger("moviesanywhere");

/**
 * Movies Anywhere — movies-only purchased library.
 *
 * Login: moviesanywhere.com/login (email/password; 2FA supported).
 * Library: moviesanywhere.com/my-movies (MA does not import TV).
 *
 * Prefer capturing gateway.moviesanywhere.com GraphQL / API JSON while the
 * library page loads; fall back to DOM card scrape + scroll.
 * Search for "TUNE:" for selectors that may need adjustment after first sync.
 */
export class MoviesAnywhereProvider implements Provider {
  readonly id = "moviesanywhere";
  readonly name = "Movies Anywhere";
  readonly implemented = true;
  readonly loginUrl = "https://moviesanywhere.com/login";
  readonly libraryUrl = "https://moviesanywhere.com/my-movies";
  readonly notes =
    "Movies only. Use your Movies Anywhere login (Fandango link is on MA's side).";

  async startLogin(page: Page, creds: LoginCredentials): Promise<LoginStep> {
    await page.goto(this.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
    await dismissCookieBanner(page);

    // TUNE: MA may show "Continue with Email" before the form.
    await clickFirst(
      page,
      [
        'button:has-text("Continue with Email")',
        'a:has-text("Continue with Email")',
        'button:has-text("Sign in with Email")',
        'button:has-text("Email")',
      ],
      3000
    ).catch(() => false);
    await page.waitForTimeout(800);

    const emailOk = await fillFirst(
      page,
      [
        'input[type="email"]',
        'input[name="email"]',
        'input[id*="email" i]',
        'input[autocomplete="username"]',
        'input[autocomplete="email"]',
        'input[placeholder*="email" i]',
      ],
      creds.username
    );
    if (!emailOk) {
      await dumpDebug(page, this.id, "no-email-field");
      return {
        status: "error",
        message:
          "Could not find the email field on Movies Anywhere sign-in. A debug screenshot was saved.",
      };
    }

    const passOk = await fillFirst(
      page,
      [
        'input[type="password"]',
        'input[name="password"]',
        'input[id*="password" i]',
        'input[autocomplete="current-password"]',
      ],
      creds.password
    );
    if (!passOk) {
      await dumpDebug(page, this.id, "no-password-field");
      return {
        status: "error",
        message: "Could not find the password field. A debug screenshot was saved.",
      };
    }

    // TUNE: submit button labels vary.
    await clickFirst(page, [
      'button[type="submit"]',
      'button:has-text("Sign In")',
      'button:has-text("Sign in")',
      'button:has-text("Log In")',
      'button:has-text("Log in")',
      'button:has-text("Continue")',
      'input[type="submit"]',
    ]);

    await page.waitForTimeout(3000);
    return this.evaluatePostAuth(page);
  }

  async submitInput(page: Page, _field: string, value: string): Promise<LoginStep> {
    const filled = await fillFirst(page, CODE_INPUT_SELECTORS, value, 5000);
    if (!filled) {
      await dumpDebug(page, this.id, "no-code-field");
      return { status: "error", message: "Could not find the code entry field." };
    }
    await clickFirst(page, [
      'button[type="submit"]',
      'button:has-text("Verify")',
      'button:has-text("Submit")',
      'button:has-text("Continue")',
      'button:has-text("Confirm")',
    ]);
    await page.waitForTimeout(2500);
    return this.evaluatePostAuth(page);
  }

  private async evaluatePostAuth(page: Page): Promise<LoginStep> {
    if (await this.isLoggedIn(page)) return { status: "success" };

    if (await looksLikeCodePrompt(page)) {
      return {
        status: "need_input",
        field: "code",
        prompt:
          "Movies Anywhere sent a verification code (check your email/phone). Enter it to continue.",
      };
    }

    const errSel = await firstVisible(
      page,
      ['[role="alert"]', ".error", ".error-message", '[class*="error" i]', '[data-testid*="error" i]'],
      1500
    );
    if (errSel) {
      const msg = (await page.locator(errSel).first().innerText().catch(() => "")).trim();
      if (msg) return { status: "error", message: msg };
    }

    await dumpDebug(page, this.id, "post-auth-unknown");
    return {
      status: "error",
      message:
        "Login did not complete and no code prompt was detected. A debug screenshot was saved.",
    };
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (/\/login/i.test(url) && !/my-movies/i.test(url)) return false;
    if ((await firstVisible(page, ['input[type="password"]'], 800)) !== null) {
      // Password field visible usually means still on auth.
      if (/\/login|\/signin|\/auth/i.test(url)) return false;
    }

    const sel = await firstVisible(
      page,
      [
        'a[href*="my-movies" i]',
        'a[href*="/account" i]',
        'a[href*="sign-out" i]',
        'a[href*="logout" i]',
        'button:has-text("Sign Out")',
        'button:has-text("Log Out")',
        '[data-testid*="profile" i]',
        'text=/my movies/i',
      ],
      3000
    );
    return sel !== null || /\/my-movies/i.test(url);
  }

  async scrapeLibrary(
    context: BrowserContext,
    onProgress?: (message: string, itemsFound?: number) => void
  ): Promise<MediaItem[]> {
    const page = await context.newPage();
    const captured: unknown[] = [];

    const onResponse = async (response: Response) => {
      try {
        const url = response.url();
        if (!/moviesanywhere\.com/i.test(url)) return;
        if (!/graphql|gateway|api|library|collection|my-?movies|entitlement/i.test(url)) return;
        if (response.status() < 200 || response.status() >= 300) return;
        const ct = (response.headers()["content-type"] || "").toLowerCase();
        if (!ct.includes("json") && !/graphql/i.test(url)) return;
        const json = await response.json().catch(() => null);
        if (json) captured.push(json);
      } catch {
        /* ignore non-JSON */
      }
    };

    page.on("response", onResponse);

    try {
      onProgress?.("Opening Movies Anywhere library…", 0);
      await page.goto(this.libraryUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(2000);
      await dismissCookieBanner(page);

      if (/\/login/i.test(page.url()) || !(await this.isLoggedIn(page))) {
        throw new SessionExpiredError(
          "Movies Anywhere session expired. Disconnect, Connect again, then Sync."
        );
      }

      onProgress?.("Loading library (listening for API responses)…", 0);
      await autoScroll(page, 80);
      await page.waitForTimeout(1500);

      let items = this.itemsFromCapturedJson(captured);
      if (items.length > 0) {
        onProgress?.(`Found ${items.length} movies via API capture`, items.length);
        log.info(`Movies Anywhere API capture: ${items.length} titles`);
        return items;
      }

      onProgress?.("API capture empty — scraping library page DOM…", 0);
      items = await this.scrapeViaDom(page, onProgress);
      if (items.length === 0) {
        await dumpDebug(page, this.id, "empty-library");
        log.warn("Movies Anywhere scrape returned 0 titles — debug dump saved");
      } else {
        log.info(`Movies Anywhere DOM scrape: ${items.length} titles`);
      }
      return items;
    } finally {
      page.off("response", onResponse);
      await page.close().catch(() => {});
    }
  }

  /** Walk captured JSON blobs and pull movie-like title objects. */
  private itemsFromCapturedJson(blobs: unknown[]): MediaItem[] {
    const found: MediaItem[] = [];
    const seen = new Set<string>();

    const visit = (node: unknown, depth: number) => {
      if (depth > 14 || node == null) return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child, depth + 1);
        return;
      }
      if (typeof node !== "object") return;
      const obj = node as Record<string, unknown>;

      const title = pickString(obj, ["title", "name", "movieTitle", "displayTitle"]);
      const looksLikeTitle =
        title &&
        title.length > 1 &&
        (hasAnyKey(obj, [
          "poster",
          "posterUrl",
          "posterImage",
          "image",
          "images",
          "artwork",
          "slug",
          "eidr",
          "imdbId",
          "imdb",
          "tmdbId",
          "tmdb",
          "releaseYear",
          "year",
          "theatricalReleaseDate",
        ]) ||
          typeof obj.id === "string" ||
          typeof obj.id === "number");

      if (looksLikeTitle && title && !looksLikeTv(obj, title)) {
        const id =
          pickString(obj, ["id", "titleId", "movieId", "uuid", "slug"]) ||
          `ma:${title.toLowerCase()}`;
        const key = id.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          const year =
            pickNumber(obj, ["year", "releaseYear"]) ??
            parseYear(pickString(obj, ["theatricalReleaseDate", "releaseDate", "title"]));
          const poster = extractPoster(obj);
          const imdbId = pickString(obj, ["imdbId", "imdb", "imdb_id"]);
          const tmdbId = pickString(obj, ["tmdbId", "tmdb", "tmdb_id"]);
          const eidr = pickString(obj, ["eidr", "eidrId"]);
          const slug = pickString(obj, ["slug"]);
          const quality = parseQuality(
            pickString(obj, ["quality", "resolution", "format", "highestQuality"])
          );
          const meta: Record<string, string | number | boolean | null> = {
            moviesAnywhereId: id,
          };
          if (imdbId) meta.imdbId = normalizeImdb(imdbId);
          if (tmdbId) meta.tmdbId = tmdbId;
          if (eidr) meta.eidr = eidr;
          if (slug) meta.slug = slug;

          found.push({
            id: String(id),
            title,
            type: "movie",
            year,
            quality,
            posterUrl: poster,
            url: slug
              ? `https://moviesanywhere.com/movie/${slug}`
              : `https://moviesanywhere.com/my-movies`,
            meta,
          });
        }
      }

      for (const v of Object.values(obj)) visit(v, depth + 1);
    };

    for (const blob of blobs) visit(blob, 0);
    return found;
  }

  private async scrapeViaDom(
    page: Page,
    onProgress?: (message: string, itemsFound?: number) => void
  ): Promise<MediaItem[]> {
    const collected = new Map<string, MediaItem>();
    let stable = 0;

    for (let i = 0; i < 200 && stable < 8; i++) {
      const batch = await page.evaluate(() => {
        const out: Array<{
          title: string;
          href?: string;
          poster?: string;
          text?: string;
        }> = [];
        // TUNE: card selectors for my-movies grid.
        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>(
            'a[href*="/movie/"], a[href*="/title/"], [data-testid*="movie" i] a, .movie-card a, [class*="MovieCard" i] a, [class*="poster" i] a'
          )
        );
        for (const a of anchors) {
          const href = a.href || a.getAttribute("href") || "";
          const img = a.querySelector("img");
          const title =
            a.getAttribute("aria-label") ||
            img?.getAttribute("alt") ||
            a.querySelector("h2,h3,h4,[class*='title' i]")?.textContent ||
            "";
          const t = title.trim();
          if (!t || t.length < 2) continue;
          out.push({
            title: t,
            href: href || undefined,
            poster: img?.src || img?.getAttribute("data-src") || undefined,
            text: a.textContent || undefined,
          });
        }
        // Also harvest img alt posters without links.
        if (out.length === 0) {
          for (const img of Array.from(document.querySelectorAll("img[alt]"))) {
            const alt = (img.getAttribute("alt") || "").trim();
            if (alt.length < 2 || /logo|avatar|icon|banner/i.test(alt)) continue;
            out.push({
              title: alt,
              poster: (img as HTMLImageElement).src || undefined,
            });
          }
        }
        return out;
      });

      let fresh = 0;
      for (const raw of batch) {
        const title = raw.title.replace(/\s+/g, " ").trim();
        if (!title) continue;
        if (/season|episode|series|tv show/i.test(title)) continue;
        const id =
          raw.href?.match(/\/(?:movie|title)\/([^/?#]+)/i)?.[1] ||
          `ma-dom:${title.toLowerCase()}`;
        if (collected.has(id)) continue;
        collected.set(id, {
          id,
          title,
          type: "movie",
          year: parseYear(raw.text) ?? parseYear(title),
          quality: parseQuality(raw.text),
          posterUrl: raw.poster,
          url: raw.href?.startsWith("http")
            ? raw.href
            : raw.href
              ? `https://moviesanywhere.com${raw.href}`
              : undefined,
          meta: { moviesAnywhereId: id },
        });
        fresh++;
      }

      onProgress?.(`Scrolling My Movies: ${collected.size} titles…`, collected.size);
      if (fresh === 0) stable++;
      else stable = 0;

      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
      await page.waitForTimeout(700);
    }

    return [...collected.values()];
  }
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^\d{4}$/.test(v)) return parseInt(v, 10);
  }
  return undefined;
}

function hasAnyKey(obj: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => k in obj && obj[k] != null);
}

function looksLikeTv(obj: Record<string, unknown>, title: string): boolean {
  const kind = pickString(obj, ["type", "contentType", "mediaType", "kind", "category"]);
  if (kind && /tv|season|series|episode/i.test(kind)) return true;
  if (/season\s+\d|episode\s+\d/i.test(title)) return true;
  return false;
}

function normalizeImdb(id: string): string {
  const t = id.trim();
  if (/^tt\d+$/i.test(t)) return t.toLowerCase();
  if (/^\d+$/.test(t)) return `tt${t}`;
  return t;
}

function extractPoster(obj: Record<string, unknown>): string | undefined {
  const direct = pickString(obj, ["posterUrl", "poster", "imageUrl", "artworkUrl", "thumbnailUrl"]);
  if (direct && /^https?:\/\//i.test(direct)) return direct;

  for (const key of ["images", "artwork", "posters", "image"]) {
    const v = obj[key];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
        if (item && typeof item === "object") {
          const u = pickString(item as Record<string, unknown>, ["url", "src", "href", "path"]);
          if (u && /^https?:\/\//i.test(u)) return u;
        }
      }
    }
    if (v && typeof v === "object") {
      const u = pickString(v as Record<string, unknown>, ["url", "src", "poster", "thumbnail"]);
      if (u && /^https?:\/\//i.test(u)) return u;
    }
  }
  return undefined;
}
