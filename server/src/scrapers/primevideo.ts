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

const log = createLogger("primevideo");

/**
 * Prime Video — purchased/owned movies only (not Prime subscription catalog).
 *
 * Login: Amazon account. Prefer "Your Video Library" / Purchases destinations.
 * Search "TUNE:" after first Connect/Sync.
 */
export class PrimeVideoProvider implements Provider {
  readonly id = "primevideo";
  readonly name = "Prime Video";
  readonly implemented = true;
  readonly loginUrl = "https://www.amazon.com/ap/signin";
  readonly libraryUrl = "https://www.primevideo.com/";
  readonly notes =
    "Purchased/owned movies only — not Prime subscription catalog. Amazon login; 2FA supported.";

  private readonly libraryCandidates = [
    "https://www.amazon.com/gp/video/library?ref_=atv_hom_library",
    "https://www.primevideo.com/region/na/library",
    "https://www.primevideo.com/library",
    "https://www.primevideo.com/",
  ];

  async startLogin(page: Page, creds: LoginCredentials): Promise<LoginStep> {
    // Prefer Prime Video sign-in which redirects to Amazon auth.
    await page.goto(
      "https://www.primevideo.com/auth-redirect/ref=atv_nb_sign_in?returnUrl=%2F",
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await page.waitForTimeout(1500);
    if (!/ap\/signin|amazon\.com.*signin/i.test(page.url())) {
      await page.goto(this.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(1500);
    }
    await dismissCookieBanner(page);

    const emailOk = await fillFirst(
      page,
      [
        'input#ap_email',
        'input[name="email"]',
        'input[type="email"]',
        'input#ap_email_login',
      ],
      creds.username
    );
    if (!emailOk) {
      await dumpDebug(page, this.id, "no-email-field");
      return {
        status: "error",
        message: "Could not find the Amazon email field. A debug screenshot was saved.",
      };
    }

    // Amazon sometimes has Continue before password.
    await clickFirst(page, [
      'input#continue',
      'button:has-text("Continue")',
      'input[type="submit"]',
    ]);
    await page.waitForTimeout(1200);

    const passOk = await fillFirst(
      page,
      ['input#ap_password', 'input[name="password"]', 'input[type="password"]'],
      creds.password,
      8000
    );
    if (!passOk) {
      await dumpDebug(page, this.id, "no-password-field");
      return {
        status: "error",
        message: "Could not find the Amazon password field. A debug screenshot was saved.",
      };
    }

    await clickFirst(page, [
      'input#signInSubmit',
      'button#signInSubmit',
      'input[type="submit"]',
      'button:has-text("Sign in")',
    ]);
    await page.waitForTimeout(3500);
    return this.evaluatePostAuth(page);
  }

  async submitInput(page: Page, _field: string, value: string): Promise<LoginStep> {
    const filled = await fillFirst(
      page,
      [
        ...CODE_INPUT_SELECTORS,
        'input#auth-mfa-otpcode',
        'input[name="otpCode"]',
        'input[name="code"]',
      ],
      value,
      5000
    );
    if (!filled) {
      await dumpDebug(page, this.id, "no-code-field");
      return { status: "error", message: "Could not find the Amazon OTP / code field." };
    }
    await clickFirst(page, [
      'input#auth-signin-button',
      'button:has-text("Sign in")',
      'button:has-text("Submit")',
      'input[type="submit"]',
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
        prompt: "Enter the Amazon / Prime Video verification code (SMS or authenticator).",
      };
    }
    const errSel = await firstVisible(
      page,
      ['#auth-error-message-box', '[class*="error" i]', '[role="alert"]'],
      1500
    );
    if (errSel) {
      const msg = (await page.locator(errSel).first().innerText().catch(() => "")).trim();
      if (msg) return { status: "error", message: msg };
    }
    await dumpDebug(page, this.id, "post-auth-unknown");
    return {
      status: "error",
      message: "Amazon sign-in did not complete. A debug screenshot was saved.",
    };
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (/\/ap\/signin|\/ap\/mfa/i.test(url)) return false;
    if (await firstVisible(page, ["#ap_password", "#ap_email"], 600)) return false;
    const sel = await firstVisible(
      page,
      [
        'a[href*="/gp/video/library" i]',
        'a[href*="library" i]',
        'a[href*="signout" i]',
        'text=/your video library/i',
        'text=/purchases/i',
      ],
      3000
    );
    return sel !== null || /primevideo\.com|amazon\.com\/gp\/video/i.test(url);
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
        if (!/amazon\.|primevideo\./i.test(u)) return;
        if (!/library|purchase|entitlement|cdp|atv|dv-customer/i.test(u)) return;
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
      onProgress?.("Opening Prime Video purchased library…", 0);
      let opened = false;
      for (const url of this.libraryCandidates) {
        // Skip subscription-filter URL for actual scrape — keep as last resort nav only
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(2000);
        await dismissCookieBanner(page);
        if (/\/ap\/signin/i.test(page.url())) continue;
        if (await this.isLoggedIn(page)) {
          opened = true;
          onProgress?.(`Opened library candidate`, 0);
          break;
        }
      }
      if (!opened) {
        throw new SessionExpiredError(
          "Prime Video session expired. Disconnect, Connect again, then Sync."
        );
      }

      // Prefer navigating to purchases / owned if a link is visible.
      // TUNE: link text for purchased library.
      await clickFirst(
        page,
        [
          'a:has-text("Your Video Library")',
          'a:has-text("Purchases")',
          'a:has-text("Movies")',
          'a[href*="library" i]',
        ],
        3000
      ).catch(() => false);
      await page.waitForTimeout(1500);

      // Try to filter to Movies / Purchases if UI exposes it.
      await clickFirst(
        page,
        [
          'button:has-text("Movies")',
          'a:has-text("Movies")',
          '[aria-label*="Movies" i]',
          'button:has-text("Purchases")',
        ],
        2500
      ).catch(() => false);
      await page.waitForTimeout(1000);

      await autoScroll(page, 80);
      let items = extractMoviesFromJson(captured, "primevideo");
      if (items.length === 0) {
        onProgress?.("API capture empty — scraping DOM…", 0);
        items = await scrapeMovieDom(page, "primevideo", onProgress);
      }

      // Drop obvious non-owned / rental-only labels when present in title text.
      items = items
        .filter((i) => !/\brent(al)?\b/i.test(i.title))
        .map((i) => ({ ...i, type: "movie" as const }));

      if (items.length === 0) await dumpDebug(page, this.id, "empty-library");
      onProgress?.(`Found ${items.length} movies`, items.length);
      log.info(`Prime Video scrape: ${items.length} titles`);
      return items;
    } finally {
      page.off("response", onResponse);
      await page.close().catch(() => {});
    }
  }
}
