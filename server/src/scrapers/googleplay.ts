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
import { extractMoviesFromJson, scrapeMovieDom } from "./appletv.js";

const log = createLogger("googleplay");

/**
 * Google Play / YouTube — purchased movies library.
 *
 * Login: Google account (accounts.google.com). Library: Play movies owned list.
 * Movies only. Search "TUNE:" after first Connect/Sync.
 */
export class GooglePlayProvider implements Provider {
  readonly id = "googleplay";
  readonly name = "Google Play / YouTube";
  readonly implemented = true;
  readonly loginUrl = "https://accounts.google.com/ServiceLogin?service=googleplay";
  readonly libraryUrl = "https://play.google.com/store/movies?category=OWNED";
  readonly notes =
    "Purchased movies on Google Play / YouTube. Google login; 2FA supported.";

  private readonly libraryCandidates = [
    "https://play.google.com/store/movies?category=OWNED",
    "https://play.google.com/movies/owned",
    "https://play.google.com/store/mymovies",
    "https://www.youtube.com/feed/library/movies",
  ];

  async startLogin(page: Page, creds: LoginCredentials): Promise<LoginStep> {
    await page.goto(this.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
    await dismissCookieBanner(page);

    const emailOk = await fillFirst(
      page,
      [
        'input[type="email"]',
        'input[name="identifier"]',
        '#identifierId',
        'input[autocomplete="username"]',
      ],
      creds.username
    );
    if (!emailOk) {
      await dumpDebug(page, this.id, "no-email-field");
      return {
        status: "error",
        message: "Could not find the Google email field. A debug screenshot was saved.",
      };
    }

    await clickFirst(page, [
      '#identifierNext',
      'button:has-text("Next")',
      'button[type="submit"]',
    ]);
    await page.waitForTimeout(2000);

    const passOk = await fillFirst(
      page,
      [
        'input[type="password"]',
        'input[name="Passwd"]',
        'input[name="password"]',
        'input[autocomplete="current-password"]',
      ],
      creds.password,
      8000
    );
    if (!passOk) {
      await dumpDebug(page, this.id, "no-password-field");
      return {
        status: "error",
        message: "Could not find the Google password field. A debug screenshot was saved.",
      };
    }

    await clickFirst(page, [
      '#passwordNext',
      'button:has-text("Next")',
      'button[type="submit"]',
    ]);
    await page.waitForTimeout(3500);
    return this.evaluatePostAuth(page);
  }

  async submitInput(page: Page, _field: string, value: string): Promise<LoginStep> {
    const filled = await fillFirst(
      page,
      [
        ...CODE_INPUT_SELECTORS,
        'input[name="totpPin"]',
        'input[id*="totp" i]',
        'input[type="tel"]',
      ],
      value,
      5000
    );
    if (!filled) {
      await dumpDebug(page, this.id, "no-code-field");
      return { status: "error", message: "Could not find the Google verification code field." };
    }
    await clickFirst(page, [
      'button:has-text("Next")',
      'button:has-text("Verify")',
      'button[type="submit"]',
      '#totpNext',
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
        prompt: "Enter the Google verification code (Authenticator / SMS / prompt).",
      };
    }
    // Challenge pages (phone confirm, etc.)
    const challenge = await firstVisible(
      page,
      ['text=/verify it.?s you/i', 'text=/2-step/i', 'text=/confirm it.?s you/i'],
      1500
    );
    if (challenge) {
      return {
        status: "need_input",
        field: "code",
        prompt: "Google needs a verification code. Enter it to continue.",
      };
    }
    await dumpDebug(page, this.id, "post-auth-unknown");
    return {
      status: "error",
      message: "Google sign-in did not complete. A debug screenshot was saved.",
    };
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (/accounts\.google\.com\/.*(signin|challenge|v3\/signin)/i.test(url)) {
      if (await firstVisible(page, ['input[type="password"]', 'input[type="email"]'], 800)) {
        return false;
      }
    }
    const sel = await firstVisible(
      page,
      [
        'a[href*="SignOutOptions" i]',
        'img[aria-label*="Account" i]',
        'a[aria-label*="Google Account" i]',
        'text=/library/i',
      ],
      3000
    );
    return sel !== null || /play\.google\.com|youtube\.com/i.test(url);
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
        if (!/google\.com|youtube\.com/i.test(u)) return;
        if (!/batchexecute|library|_\/Play|movies|owned|entitlement/i.test(u)) return;
        if (response.status() < 200 || response.status() >= 300) return;
        const ct = (response.headers()["content-type"] || "").toLowerCase();
        if (ct.includes("json") || ct.includes("javascript") || ct.includes("text/plain")) {
          const text = await response.text().catch(() => "");
          if (!text || text.length < 20) return;
          try {
            captured.push(JSON.parse(text));
          } catch {
            // batchexecute often isn't pure JSON — skip
          }
        }
      } catch {
        /* ignore */
      }
    };
    page.on("response", onResponse);

    try {
      onProgress?.("Opening Google Play movies library…", 0);
      let opened = false;
      for (const url of this.libraryCandidates) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(2000);
        await dismissCookieBanner(page);
        if (/accounts\.google\.com/i.test(page.url())) continue;
        if (await this.isLoggedIn(page)) {
          opened = true;
          break;
        }
      }
      if (!opened) {
        throw new SessionExpiredError(
          "Google Play session expired. Disconnect, Connect again, then Sync."
        );
      }

      await autoScroll(page, 70);
      let items = extractMoviesFromJson(captured, "googleplay");
      if (items.length === 0) {
        onProgress?.("API capture empty — scraping DOM…", 0);
        items = await scrapeMovieDom(page, "googleplay", onProgress);
        // Extra Google Play-specific cards
        if (items.length === 0) {
          items = await this.scrapePlayCards(page, onProgress);
        }
      }
      // Force movie type
      items = items.map((i) => ({ ...i, type: "movie" as const }));
      if (items.length === 0) await dumpDebug(page, this.id, "empty-library");
      onProgress?.(`Found ${items.length} movies`, items.length);
      log.info(`Google Play scrape: ${items.length} titles`);
      return items;
    } finally {
      page.off("response", onResponse);
      await page.close().catch(() => {});
    }
  }

  private async scrapePlayCards(
    page: Page,
    onProgress?: (message: string, itemsFound?: number) => void
  ): Promise<MediaItem[]> {
    const collected = new Map<string, MediaItem>();
    let stable = 0;
    for (let i = 0; i < 120 && stable < 8; i++) {
      const batch = await page.evaluate(() => {
        const out: Array<{ title: string; href?: string; poster?: string }> = [];
        for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='details'], a[href*='/movie/'], a[href*='id=']"))) {
          const img = a.querySelector("img");
          const title = (img?.getAttribute("alt") || a.getAttribute("aria-label") || "").trim();
          if (title.length < 2) continue;
          out.push({ title, href: a.href, poster: img?.src });
        }
        return out;
      });
      let fresh = 0;
      for (const raw of batch) {
        if (/season|episode|tv/i.test(raw.title)) continue;
        const id = raw.href?.match(/[?&]id=([^&]+)/)?.[1] || `gp:${raw.title.toLowerCase()}`;
        if (collected.has(id)) continue;
        collected.set(id, {
          id,
          title: raw.title,
          type: "movie",
          year: parseYear(raw.title),
          quality: parseQuality(raw.title),
          posterUrl: raw.poster,
          url: raw.href,
        });
        fresh++;
      }
      onProgress?.(`Play cards: ${collected.size}…`, collected.size);
      if (fresh === 0) stable++;
      else stable = 0;
      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
      await page.waitForTimeout(700);
    }
    return [...collected.values()];
  }
}
