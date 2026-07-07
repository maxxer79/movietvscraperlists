import { chromium, type Browser, type BrowserContext } from "playwright";
import { config } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("browser");

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    log.info(`Launching Chromium (headless=${config.headless})`);
    browserPromise = chromium.launch({
      headless: config.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  }
  return browserPromise;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Create a fresh context, optionally seeded with a saved storageState JSON. */
export async function newContext(storageStateJson?: string): Promise<BrowserContext> {
  const browser = await getBrowser();
  return browser.newContext({
    userAgent: DEFAULT_UA,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    storageState: storageStateJson ? JSON.parse(storageStateJson) : undefined,
  });
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}
