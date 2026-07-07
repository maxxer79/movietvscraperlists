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
 * NOTE: These selectors are best-effort. Fandango's SPA changes over time, and
 * the exact login/library markup can't be verified without a live account. On
 * the first real login/scrape the provider dumps DOM + screenshots to
 * data/debug so the selectors below can be tuned quickly. Search the code for
 * "TUNE:" to find the spots most likely to need adjustment.
 */
export class FandangoProvider implements Provider {
  readonly id = "fandango";
  readonly name = "Fandango at Home";
  readonly implemented = true;
  readonly loginUrl = "https://www.fandangoathome.com/signin";
  readonly libraryUrl = "https://www.fandangoathome.com/my-movies";
  readonly notes = "Formerly Vudu. May send an email verification code on new devices.";

  async startLogin(page: Page, creds: LoginCredentials): Promise<LoginStep> {
    await page.goto(this.loginUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    // TUNE: email field
    const emailOk = await fillFirst(
      page,
      [
        'input[type="email"]',
        'input[name="email" i]',
        'input[id*="email" i]',
        'input[name="username" i]',
        'input[autocomplete="username"]',
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

    // Some flows require pressing "Continue" before the password appears.
    await clickFirst(
      page,
      ['button:has-text("Continue")', 'button:has-text("Next")'],
      2500
    ).catch(() => false);
    await page.waitForTimeout(800);

    // TUNE: password field
    const passOk = await fillFirst(
      page,
      [
        'input[type="password"]',
        'input[name="password" i]',
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

    // TUNE: submit button
    await clickFirst(page, [
      'button[type="submit"]',
      'button:has-text("Sign In")',
      'button:has-text("Sign in")',
      'button:has-text("Log In")',
      'input[type="submit"]',
    ]);

    await page.waitForTimeout(2500);
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
    // TUNE: signed-in indicators (account menu / avatar / "My Movies" link)
    const sel = await firstVisible(
      page,
      [
        'a[href*="my-movies" i]',
        'a[href*="account" i]',
        '[data-testid*="account" i]',
        'button:has-text("Account")',
        'text=/my movies/i',
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

      if (/signin|login/i.test(page.url()) || !(await this.isLoggedIn(page))) {
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
