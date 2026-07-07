import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { paths } from "../services/paths.js";
import { createLogger } from "../logger.js";

const log = createLogger("scrape");

/** Try each selector; return the first one that becomes visible within timeout. */
export async function firstVisible(
  page: Page,
  selectors: string[],
  timeoutMs = 8000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      try {
        if (await el.isVisible()) return sel;
      } catch {
        /* ignore invalid/detached */
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

/** Fill the first matching selector. Returns true if a field was filled. */
export async function fillFirst(
  page: Page,
  selectors: string[],
  value: string,
  timeoutMs = 8000
): Promise<boolean> {
  const sel = await firstVisible(page, selectors, timeoutMs);
  if (!sel) return false;
  await page.locator(sel).first().fill(value);
  return true;
}

/** Click the first matching selector. Returns true if something was clicked. */
export async function clickFirst(
  page: Page,
  selectors: string[],
  timeoutMs = 8000
): Promise<boolean> {
  const sel = await firstVisible(page, selectors, timeoutMs);
  if (!sel) return false;
  await page.locator(sel).first().click();
  return true;
}

/** Detect a page that is asking for a 2FA / verification code. */
export async function looksLikeCodePrompt(page: Page): Promise<boolean> {
  const body = (await page.content()).toLowerCase();
  return (
    /verification code|security code|one[- ]time|enter the code|2-step|two[- ]factor|we sent you a code|check your email/.test(
      body
    ) || (await firstVisible(page, CODE_INPUT_SELECTORS, 1500)) !== null
  );
}

export const CODE_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[name*="otp" i]',
  'input[placeholder*="code" i]',
];

/** Scroll to the bottom repeatedly to trigger lazy-loaded library items. */
export async function autoScroll(page: Page, maxSteps = 60): Promise<void> {
  let previousHeight = 0;
  for (let i = 0; i < maxSteps; i++) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    if (height === previousHeight) break;
    previousHeight = height;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
  }
}

/** Save the current DOM to the debug folder for offline selector tuning. */
export async function dumpDebug(page: Page, providerId: string, tag: string) {
  try {
    const html = await page.content();
    writeFileSync(join(paths.debug, `${providerId}-${tag}-${Date.now()}.html`), html);
    await page.screenshot({
      path: join(paths.debug, `${providerId}-${tag}-${Date.now()}.png`),
      fullPage: true,
    });
    log.info(`Dumped debug DOM+screenshot for ${providerId} (${tag})`);
  } catch (err) {
    log.warn(`Failed to dump debug for ${providerId}`, err);
  }
}

/** Parse a quality label from arbitrary text. */
export function parseQuality(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.toUpperCase();
  if (t.includes("4K") || t.includes("UHD")) return "4K UHD";
  if (t.includes("HDX")) return "HDX";
  if (/\bHD\b/.test(t)) return "HD";
  if (/\bSD\b/.test(t)) return "SD";
  return undefined;
}

/** Extract a 4-digit year from text if present. */
export function parseYear(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : undefined;
}
