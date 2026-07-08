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
  readonly libraryUrl = "https://athome.fandango.com/content/browse/mylibrary";
  readonly notes = "Formerly Vudu. May send an email verification code on new devices.";

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
    try {
      await page.goto(this.libraryUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await dismissCookieBanner(page);

      if (/\/content\/account\/login/i.test(page.url())) {
        throw new SessionExpiredError();
      }

      await autoScroll(page);
      await dumpDebug(page, this.id, "library");

      // TUNE: the card container + inner fields.
      const items = await page.evaluate(() => {
        const results: Array<Record<string, string | undefined>> = [];
        const cardSelectors = [
          '[data-testid*="poster" i]',
          '[class*="poster" i]',
          '[class*="movie-card" i]',
          '[class*="content-card" i]',
          'a[href*="/content/movies/"]',
        ];
        let cards: Element[] = [];
        for (const cs of cardSelectors) {
          const found = Array.from(document.querySelectorAll(cs));
          if (found.length > cards.length) cards = found;
        }
        for (const card of cards) {
          const img = card.querySelector("img");
          const title =
            img?.getAttribute("alt") ||
            (card.querySelector('[class*="title" i]') as HTMLElement)?.innerText ||
            (card as HTMLElement).getAttribute("aria-label") ||
            undefined;
          const poster =
            img?.getAttribute("src") || img?.getAttribute("data-src") || undefined;
          const href =
            (card as HTMLAnchorElement).href ||
            (card.querySelector("a") as HTMLAnchorElement)?.href ||
            undefined;
          const qualityText =
            (card.querySelector('[class*="quality" i]') as HTMLElement)?.innerText ||
            (card.querySelector('[class*="badge" i]') as HTMLElement)?.innerText ||
            undefined;
          if (title) {
            results.push({ title: title.trim(), poster, href, qualityText });
          }
        }
        return results;
      });

      const seen = new Set<string>();
      const media: MediaItem[] = [];
      for (const raw of items) {
        const title = (raw.title || "").trim();
        if (!title || seen.has(title.toLowerCase())) continue;
        seen.add(title.toLowerCase());
        media.push({
          id: raw.href || title,
          title,
          type: "unknown",
          year: parseYear(title),
          quality: parseQuality(raw.qualityText),
          posterUrl: raw.poster,
          url: raw.href,
        });
      }

      log.info(`Scraped ${media.length} items from Fandango at Home`);
      if (media.length === 0) {
        log.warn(
          "No items parsed. Check data/debug for the library DOM dump to tune selectors."
        );
      }
      return media;
    } finally {
      await page.close().catch(() => {});
    }
  }
}
