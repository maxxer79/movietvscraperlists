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
import {
  captureVuduAuthFromNetwork,
  describePageStorage,
  extractLightDeviceFromPage,
  extractLightDeviceFromStorageState,
  extractVuduAuth,
  extractVuduAuthFromStorageState,
  fetchBundleContents,
  fetchVuduLibraryWithFallback,
  injectVuduAuthIntoLocalStorage,
  injectVuduAuthIntoStorageState,
  isBundleItem,
  releaseYear,
  renewVuduSessionWithLightDevice,
  validateVuduAuth,
  vuduDetailUrl,
  type VuduAuth,
} from "./vuduApi.js";
import { saveSession } from "../services/sessionStore.js";

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
  readonly notes =
    "Formerly Vudu. May send an email verification code on new devices. If sync says session expired, Disconnect and Connect again before Syncing.";

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

  async scrapeLibrary(
    context: BrowserContext,
    onProgress?: (message: string, itemsFound?: number) => void
  ): Promise<MediaItem[]> {
    const page = await context.newPage();
    try {
      onProgress?.("Opening Fandango in browser to refresh API credentials…", 0);

      // Listen BEFORE navigation so we catch the SPA's first library API calls
      // (those carry a live sessionKey even when localStorage still has stale ones).
      const networkAuthPromise = captureVuduAuthFromNetwork(page, 60_000);

      await page.goto("https://athome.fandango.com/content/browse/mymovies", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(2500);
      await dismissCookieBanner(page);

      if (/\/content\/account\/login/i.test(page.url())) {
        throw new SessionExpiredError(
          "Fandango session expired. Disconnect, Connect again (complete any email code), then Sync."
        );
      }

      // Prefer network-captured auth: storage may still hold expired keys.
      onProgress?.("Waiting for live Vudu API session from the page…", 0);
      await page.evaluate(() => window.scrollBy(0, 800)).catch(() => {});
      await page.waitForTimeout(2000);

      let auth = await networkAuthPromise;
      if (auth) {
        onProgress?.("Validating live API session…", 0);
        auth = await validateVuduAuth(auth);
        if (!auth) {
          onProgress?.("Network session still expired — checking page storage…", 0);
        }
      }
      if (!auth) {
        const stored = await extractVuduAuth(page);
        if (stored) {
          onProgress?.("Validating tokens found in page storage…", 0);
          auth = await validateVuduAuth(stored);
          if (!auth) {
            onProgress?.("Stored tokens still expired — trying TV page…", 0);
          }
        }
      }

      if (!auth) {
        onProgress?.("Trying TV library page for live API credentials…", 0);
        const tvAuthPromise = captureVuduAuthFromNetwork(page, 30_000);
        await page.goto("https://athome.fandango.com/content/browse/mytv", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(3000);
        if (/\/content\/account\/login/i.test(page.url())) {
          throw new SessionExpiredError(
            "Fandango session expired. Disconnect, Connect again (complete any email code), then Sync."
          );
        }
        const tvAuth = (await tvAuthPromise) || (await extractVuduAuth(page));
        auth = tvAuth ? await validateVuduAuth(tvAuth) : null;
      }

      // Cookie login can remain valid while sessionKeys are dead. The SPA stores a
      // lightDeviceKey that can mint a fresh weakSessionKey without a full reconnect.
      if (!auth) {
        onProgress?.("Renewing Vudu session with saved light-device credentials…", 0);
        const device = await extractLightDeviceFromPage(page);
        if (device?.lightDeviceKey) {
          const renewed = await renewVuduSessionWithLightDevice(device);
          auth = renewed ? await validateVuduAuth(renewed) : null;
          if (auth) {
            onProgress?.("Light-device renewal succeeded", 0);
          } else {
            onProgress?.("Light-device renewal did not yield a usable session", 0);
          }
        } else {
          onProgress?.("No lightDeviceKey found in page storage", 0);
        }
      }

      if (auth) {
        await injectVuduAuthIntoLocalStorage(page, auth);
        try {
          const storageState = JSON.stringify(await context.storageState());
          saveSession(this.id, storageState);
          onProgress?.("Saved refreshed API credentials for next sync", 0);
        } catch (err) {
          log.warn("Could not re-save session with Vudu credentials", err);
        }

        log.info(`Using Vudu API via browser (userId ${auth.userId.slice(0, 6)}…)`);
        onProgress?.("Using fast API sync (credentials refreshed)…", 0);
        return this.scrapeViaApi(auth, onProgress);
      }

      const storageDump = await describePageStorage(page);
      log.error(`Could not capture live Vudu auth. ${storageDump}`);
      onProgress?.(`Auth capture failed. ${storageDump}`, 0);
      throw new SessionExpiredError(
        "Could not refresh Fandango/Vudu API credentials. Disconnect, Connect again (complete any email code), then Sync."
      );
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Lightweight sync: read saved session credentials and call the Vudu API directly.
   * Returns null if credentials are missing OR expired so the caller can open a
   * browser to refresh them. Avoids launching Chromium on the happy path.
   */
  async scrapeFromStorageState(
    storageStateJson: string,
    onProgress?: (message: string, itemsFound?: number) => void
  ): Promise<MediaItem[] | null> {
    const auth = extractVuduAuthFromStorageState(storageStateJson);
    if (!auth) {
      onProgress?.("Could not read Vudu credentials from saved session");
      // Still try light-device renewal before forcing a browser open.
      const renewed = await this.tryLightDeviceRenewal(storageStateJson, onProgress);
      if (renewed) return this.scrapeViaApi(renewed, onProgress);
      return null;
    }
    log.info(`Light Vudu API sync (userId ${auth.userId.slice(0, 6)}…)`);
    onProgress?.("Using fast API sync (no browser)…", 0);
    try {
      return await this.scrapeViaApi(auth, onProgress);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        onProgress?.("Saved API tokens expired — trying light-device renewal…", 0);
        const renewed = await this.tryLightDeviceRenewal(storageStateJson, onProgress);
        if (renewed) {
          try {
            return await this.scrapeViaApi(renewed, onProgress);
          } catch (err2) {
            if (!(err2 instanceof SessionExpiredError)) throw err2;
          }
        }
        onProgress?.(
          "Saved API tokens expired — opening browser to refresh session…",
          0
        );
        log.warn("Light API sync hit expired session — falling back to browser refresh");
        return null;
      }
      throw err;
    }
  }

  private async tryLightDeviceRenewal(
    storageStateJson: string,
    onProgress?: (message: string, itemsFound?: number) => void
  ): Promise<VuduAuth | null> {
    const device = extractLightDeviceFromStorageState(storageStateJson);
    if (!device?.lightDeviceKey) {
      onProgress?.("No lightDeviceKey in saved session", 0);
      return null;
    }
    onProgress?.("Renewing Vudu session with light-device credentials…", 0);
    const renewed = await renewVuduSessionWithLightDevice(device);
    if (!renewed) {
      onProgress?.("Light-device renewal failed", 0);
      return null;
    }
    const ok = await validateVuduAuth(renewed);
    if (!ok) {
      onProgress?.("Renewed session still rejected by Vudu API", 0);
      return null;
    }
    onProgress?.("Light-device renewal succeeded — continuing API sync", 0);
    try {
      const patched = injectVuduAuthIntoStorageState(storageStateJson, ok);
      saveSession(this.id, patched);
    } catch (err) {
      log.warn("Could not re-save session after light-device renewal", err);
    }
    return ok;
  }

  /** Paginated api.vudu.com contentSearch — reliable for 1000+ titles. listType rentedOrOwned excludes wishlist. */
  private async scrapeViaApi(
    auth: VuduAuth,
    onProgress?: (message: string, itemsFound?: number) => void
  ): Promise<MediaItem[]> {
    const media: MediaItem[] = [];
    const seen = new Set<string>();

    for (const spec of [
      { superType: "movies" as const, type: "movie" as const },
      { superType: "tv" as const, type: "tv" as const },
    ]) {
      onProgress?.(`Fetching ${spec.type} from Vudu API…`, media.length);
      const rows = await fetchVuduLibraryWithFallback(
        auth,
        {
          superType: spec.superType,
          listType: "rentedOrOwned",
          onPage: (info) => {
            onProgress?.(
              `Fetching ${info.superType}: page ${info.page} (+${info.batchSize}, ${info.total} so far)`,
              media.length + info.total
            );
          },
        },
        (msg) => onProgress?.(msg, media.length)
      );

      for (const row of rows) {
        const key = `${spec.type}:${row.contentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const isBundle = isBundleItem(row);
        media.push({
          id: row.contentId,
          title: row.title,
          type: spec.type,
          year: releaseYear(row.releaseTime),
          quality: row.quality,
          posterUrl: row.posterUrl,
          url: vuduDetailUrl(row.title, row.contentId),
          meta: isBundle
            ? { contentKind: "bundle", isCollection: true }
            : row.contentKind
              ? { contentKind: row.contentKind }
              : undefined,
        });
      }
      onProgress?.(`Found ${rows.length} ${spec.type} titles (${media.length} total)`, media.length);
      log.info(`Fandango API ${spec.type}: ${rows.length} titles`);
    }

    await this.expandBundles(media, onProgress);
    onProgress?.(`Saving ${media.length} titles…`, media.length);
    log.info(`Scraped ${media.length} total items via Vudu API`);
    return media;
  }

  /** Look up individual titles inside bundle/collection purchases. */
  private async expandBundles(
    media: MediaItem[],
    onProgress?: (message: string, itemsFound?: number) => void
  ): Promise<void> {
    const bundles = media.filter((m) => m.meta?.isCollection || m.meta?.contentKind === "bundle");
    if (bundles.length === 0) return;

    log.info(`Expanding ${bundles.length} bundle/collection items…`);
    onProgress?.(`Expanding ${bundles.length} collections…`, media.length);
    let done = 0;
    const concurrency = 5;
    for (let i = 0; i < bundles.length; i += concurrency) {
      const chunk = bundles.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (bundle) => {
          try {
            const children = await fetchBundleContents(bundle.id);
            if (children.length === 0) return;
            bundle.meta = {
              ...bundle.meta,
              isCollection: true,
              contentKind: "bundle",
              collectionCount: children.length,
              collectionItems: children.map((c) => ({
                id: c.contentId,
                title: c.title,
                year: releaseYear(c.releaseTime),
                type: c.contentKind === "season" || c.contentKind === "series" ? "tv" : "movie",
              })),
            };
          } catch (err) {
            log.warn(`Could not expand bundle "${bundle.title}" (${bundle.id})`, err);
          } finally {
            done++;
            if (done % 10 === 0 || done === bundles.length) {
              onProgress?.(`Expanded ${done}/${bundles.length} collections…`, media.length);
            }
          }
        })
      );
    }
    log.info(`Finished expanding ${done} bundles`);
  }

  /** DOM fallback when API auth isn't available (virtualized grid — may miss titles). */
  private async scrapeViaDom(
    page: Page,
    onProgress?: (message: string, itemsFound?: number) => void
  ): Promise<MediaItem[]> {
    const seen = new Set<string>();
    const media: MediaItem[] = [];
    for (const source of this.sources) {
      onProgress?.(`Scrolling ${source.type} library page…`, media.length);
      await page.goto(source.url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await dismissCookieBanner(page);
      if (/\/content\/account\/login/i.test(page.url())) {
        throw new SessionExpiredError();
      }
      const raws = await this.collectWhileScrolling(page, source.type, (n) => {
        onProgress?.(`Scrolling ${source.type}: ${n} tiles so far…`, media.length + n);
      });
      await dumpDebug(page, this.id, source.type);
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
      }
      onProgress?.(`Finished ${source.type} scroll: ${raws.length} tiles`, media.length);
    }
    return media;
  }

  /**
   * Harvest every tile from a virtualized/infinite-scroll grid. Each pass reads
   * the currently-rendered tiles, merges them into a running map (keyed by
   * detail URL), then scrolls the real container forward. Stops when no new
   * tiles appear for several consecutive passes.
   */
  private async collectWhileScrolling(
    page: Page,
    sourceType: string,
    onCount?: (n: number) => void
  ): Promise<Array<Record<string, string | undefined>>> {
    const collected = new Map<string, Record<string, string | undefined>>();
    let stable = 0;
    for (let i = 0; i < 800 && stable < 10; i++) {
      const batch = await this.extractCards(page);
      let fresh = 0;
      for (const raw of batch) {
        const key = (raw.href || raw.title || "").toLowerCase();
        if (key && !collected.has(key)) {
          collected.set(key, raw);
          fresh++;
        }
      }

      await clickFirst(
        page,
        ['button:has-text("Load More")', 'button:has-text("Show More")'],
        250
      ).catch(() => false);

      // Scroll the last rendered tile into view; scrollIntoView walks up and
      // scrolls whatever ancestor is actually scrollable (window or inner div).
      await page.evaluate(() => {
        const tiles = document.querySelectorAll('a[href*="/content/browse/details/"]');
        const last = tiles[tiles.length - 1] as HTMLElement | undefined;
        if (last) last.scrollIntoView({ block: "end", behavior: "instant" as ScrollBehavior });
        window.scrollBy(0, Math.round(window.innerHeight * 0.9));
      });
      await page.waitForTimeout(650);

      if (fresh === 0) stable++;
      else stable = 0;
      if (i % 15 === 0) {
        log.info(`Fandango ${sourceType}: collected ${collected.size} tiles so far…`);
        onCount?.(collected.size);
      }
    }
    log.info(`Fandango ${sourceType}: finished with ${collected.size} tiles`);
    onCount?.(collected.size);
    return [...collected.values()];
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
