import type { BrowserContext, Page } from "playwright";
import {
  SessionExpiredError,
  type LoginCredentials,
  type LoginStep,
  type MediaItem,
  type Provider,
} from "./types.js";
import {
  CODE_INPUT_SELECTORS,
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

const log = createLogger("fandango");

/**
 * Fandango at Home (formerly Vudu).
 *
 * Verified against the live site (athome.fandango.com):
 *   - Login page has #email + #password on one page, submit button "Sign In".
 *   - A OneTrust cookie banner overlays the page and must be dismissed first.
 *   - The purchased library lives at /content/browse/mylibrary.
 *
 * The library card markup requires a logged-in session to inspect, so the card
 * extraction below is defensive and dumps DOM + screenshots to data/debug on
 * the first real sync. Search for "TUNE:" for spots that may need adjustment.
 */
export class FandangoProvider implements Provider {
  readonly id = "fandango";
  readonly name = "Fandango at Home";
  readonly implemented = true;
  readonly loginUrl =
    "https://athome.fandango.com/content/account/login?type=vudu_auth";
  readonly libraryUrl = "https://athome.fandango.com/content/browse/mymovies";
  readonly notes = "Formerly Vudu. May send an email verification code on new devices.";

  // Your purchased library lives on two dedicated pages. We scrape ONLY these,
  // so wishlist and other lists are ignored.
  private readonly sources: Array<{ url: string; type: "movie" | "tv" }> = [
    { url: "https://athome.fandango.com/content/browse/mymovies", type: "movie" },
    { url: "https://athome.fandango.com/content/browse/mytv", type: "tv" },
  ];

  async startLogin(page: Page, creds: LoginCredentials): Promise<LoginStep> {
    await page.goto(this.loginUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await dismissCookieBanner(page);

    const emailOk = await fillFirst(
      page,
      [
        "#email",
        'input[name="email"]',
        'input[aria-label="Enter email"]',
        'input[type="email"]',
      ],
      creds.username
    );
    if (!emailOk) {
      await dumpDebug(page, this.id, "no-email-field");
      return {
        status: "error",
        message:
          "Could not find the email field on the sign-in page. A debug screenshot was saved.",
      };
    }

    const passOk = await fillFirst(
      page,
      [
        "#password",
        'input[name="password"]',
        'input[aria-label="Enter password"]',
        'input[type="password"]',
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

    // TUNE: submit button. "Sign In" is the primary action on this page.
    await clickFirst(page, [
      'button:has-text("Sign In")',
      'button:has-text("Sign in")',
      'button[type="submit"]',
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
    ]);
    await page.waitForTimeout(2500);
    return this.evaluatePostAuth(page);
  }

  /** Decide whether we're logged in, need a code, or errored. */
  private async evaluatePostAuth(page: Page): Promise<LoginStep> {
    if (await this.isLoggedIn(page)) return { status: "success" };

    if (await looksLikeCodePrompt(page)) {
      return {
        status: "need_input",
        field: "code",
        prompt:
          "Fandango sent a verification code (check your email/phone). Enter it to continue.",
      };
    }

    // Look for a visible error message.
    const errSel = await firstVisible(
      page,
      ['[role="alert"]', ".error", ".error-message", '[class*="error" i]'],
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
        "Login did not complete and no code prompt was detected. A debug screenshot was saved to help fix this.",
    };
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    // If we're still on the login page, we're not signed in.
    if (/\/content\/account\/login/i.test(page.url())) return false;
    // A visible email/password form also means "not signed in".
    if ((await firstVisible(page, ["#email", "#password"], 800)) !== null) return false;

    const sel = await firstVisible(
      page,
      [
        'a[href*="mylibrary" i]',
        'a[href*="account/myinfo" i]',
        'a[href*="account" i]',
        'text=/my library/i',
      ],
      3000
    );
    return sel !== null;
  }

  async scrapeLibrary(context: BrowserContext): Promise<MediaItem[]> {
    const page = await context.newPage();
    const seen = new Set<string>();
    const media: MediaItem[] = [];
    try {
      for (const source of this.sources) {
        await page.goto(source.url, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2500);
        await dismissCookieBanner(page);

        if (/\/content\/account\/login/i.test(page.url())) {
          throw new SessionExpiredError();
        }

        // The library uses infinite scroll; load everything before parsing.
        await this.loadAll(page);
        await dumpDebug(page, this.id, source.type);

        const raws = await this.extractCards(page);
        let added = 0;
        for (const raw of raws) {
          const title = (raw.title || "").trim();
          if (!title) continue;
          const key = `${source.type}:${(raw.href || title).toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          media.push({
            id: raw.href || `${source.type}:${title}`,
            title,
            type: source.type,
            year: parseYear(title),
            quality: parseQuality(raw.qualityText),
            posterUrl: raw.poster,
            url: raw.href,
          });
          added++;
        }
        log.info(`Fandango ${source.type}: parsed ${added} titles from ${source.url}`);
        if (added === 0) {
          log.warn(
            `No ${source.type} titles parsed. See data/debug/fandango-${source.type}-*.html to tune selectors.`
          );
        }
      }

      log.info(`Scraped ${media.length} total items from Fandango at Home`);
      return media;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Repeatedly scroll + click any "load more" control until the list stops growing. */
  private async loadAll(page: Page): Promise<void> {
    let stable = 0;
    let lastCount = -1;
    for (let i = 0; i < 200 && stable < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await clickFirst(
        page,
        ['button:has-text("Load More")', 'button:has-text("Show More")'],
        400
      ).catch(() => false);
      await page.waitForTimeout(700);
      const count = await page.evaluate(
        () =>
          document.querySelectorAll('a[href*="/content/browse/details/"]').length
      );
      if (count === lastCount) stable++;
      else stable = 0;
      lastCount = count;
    }
  }

  /** TUNE: extract title/poster/link/quality from library tiles. */
  private extractCards(page: Page) {
    return page.evaluate(() => {
      const out: Array<Record<string, string | undefined>> = [];
      // Fandango library tiles are anchors to /content/browse/details/<Title>/<id>
      // wrapping an <img alt="Title">.
      let cards: Element[] = Array.from(
        document.querySelectorAll('a[href*="/content/browse/details/"]')
      );
      // Fallback: any poster image with alt text.
      if (cards.length === 0) {
        cards = Array.from(document.querySelectorAll("img[alt]")).filter(
          (img) => (img as HTMLImageElement).alt.trim().length > 0
        );
      }
      for (const card of cards) {
        const img = card.matches("img") ? (card as HTMLImageElement) : card.querySelector("img");
        const anchor = (card.matches("a") ? card : card.closest("a")) as HTMLAnchorElement | null;
        // Derive a title from the URL slug as a last resort:
        // /content/browse/details/The%20Matrix/12345 -> "The Matrix"
        let urlTitle: string | undefined;
        const href0 = anchor?.getAttribute("href") || "";
        const m = href0.match(/\/details\/([^/]+)\/[^/]+\/?$/);
        if (m) {
          try {
            urlTitle = decodeURIComponent(m[1]).replace(/[-_]+/g, " ").trim();
          } catch {
            urlTitle = m[1].replace(/[-_]+/g, " ").trim();
          }
        }
        const title =
          img?.getAttribute("alt") ||
          (card.querySelector('[class*="title" i]') as HTMLElement)?.innerText ||
          card.getAttribute("aria-label") ||
          anchor?.getAttribute("aria-label") ||
          urlTitle ||
          undefined;
        const poster =
          img?.getAttribute("src") || img?.getAttribute("data-src") || undefined;
        const href = anchor?.href || undefined;
        const container = anchor || card;
        const qualityText =
          (container.querySelector('[class*="quality" i]') as HTMLElement)?.innerText ||
          (container.querySelector('[class*="badge" i]') as HTMLElement)?.innerText ||
          (container.textContent?.match(/\b(4K|UHD|HDX|HD|SD)\b/)?.[0] ?? undefined);
        if (title && title.trim()) {
          out.push({ title: title.trim(), poster, href, qualityText });
        }
      }
      return out;
    });
  }
}
