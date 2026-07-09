import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { newContext } from "../services/browser.js";
import { saveSession } from "../services/sessionStore.js";
import { createLogger } from "../logger.js";
import { paths } from "../services/paths.js";
import { join } from "node:path";
import type { LoginCredentials, LoginStep, Provider } from "./types.js";
import {
  captureVuduAuthFromNetwork,
  extractVuduAuth,
  injectVuduAuthIntoLocalStorage,
  mintVuduSessionWithPassword,
  validateVuduAuth,
} from "./vuduApi.js";
import { dismissCookieBanner } from "./helpers.js";

const log = createLogger("login");

interface ActiveLogin {
  loginId: string;
  provider: Provider;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  /** Kept only for the duration of this login so we can mint a Vudu API sessionKey. */
  creds?: LoginCredentials;
}

const active = new Map<string, ActiveLogin>();
const TTL_MS = 10 * 60 * 1000; // abandon in-progress logins after 10 minutes

function sweep() {
  const now = Date.now();
  for (const [id, login] of active) {
    if (now - login.createdAt > TTL_MS) {
      log.warn(`Abandoning stale login ${id} for ${login.provider.id}`);
      void login.context.close().catch(() => {});
      active.delete(id);
    }
  }
}
setInterval(sweep, 60 * 1000).unref?.();

async function saveScreenshot(page: Page, providerId: string, tag: string) {
  try {
    const f = join(paths.debug, `${providerId}-${tag}-${Date.now()}.png`);
    await page.screenshot({ path: f, fullPage: true });
    log.debug(`Saved debug screenshot ${f}`);
  } catch {
    /* screenshots are best-effort */
  }
}

/**
 * After a successful browser login, mint a fresh Vudu API sessionKey via
 * password sessionKeyRequest (the only reliable method), then persist it into
 * localStorage so Playwright storageState keeps it for fast syncs.
 */
async function captureProviderAuth(login: ActiveLogin): Promise<void> {
  if (login.provider.id !== "fandango") return;
  try {
    const page = login.page;

    // Prefer password mint — cookie/localStorage tokens are often already stale
    // or never written for API use.
    if (login.creds?.username && login.creds?.password) {
      const minted = await mintVuduSessionWithPassword(
        login.creds.username,
        login.creds.password
      );
      if (minted) {
        const ok = await validateVuduAuth(minted);
        if (ok) {
          await injectVuduAuthIntoLocalStorage(page, ok);
          log.info(
            `Minted Vudu API credentials for ${login.provider.id} (userId ${ok.userId.slice(0, 6)}…)`
          );
          return;
        }
        log.warn("Password-minted Vudu session failed validation — trying page capture");
      } else {
        log.warn("Password sessionKeyRequest failed — trying page/network capture");
      }
    }

    const networkAuthPromise = captureVuduAuthFromNetwork(page, 45_000);
    await page.goto("https://athome.fandango.com/content/browse/mymovies", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3000);
    await dismissCookieBanner(page);

    let auth = await extractVuduAuth(page);
    if (!auth) {
      await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
      await page.waitForTimeout(2000);
      auth = (await extractVuduAuth(page)) || (await networkAuthPromise);
    }
    if (auth) {
      const ok = (await validateVuduAuth(auth)) || auth;
      await injectVuduAuthIntoLocalStorage(page, ok);
      log.info(
        `Captured Vudu API credentials for ${login.provider.id} (userId ${ok.userId.slice(0, 6)}…)`
      );
    } else {
      log.warn(
        `Logged into ${login.provider.id} but could not obtain Vudu API credentials — Sync will ask you to reconnect`
      );
    }
  } catch (err) {
    log.warn(`Could not capture Vudu auth after login for ${login.provider.id}`, err);
  } finally {
    // Do not keep the password around after finalize.
    login.creds = undefined;
  }
}

async function finalize(login: ActiveLogin): Promise<void> {
  await captureProviderAuth(login);
  const storageState = JSON.stringify(await login.context.storageState());
  saveSession(login.provider.id, storageState);
  await login.context.close().catch(() => {});
  active.delete(login.loginId);
}

export interface LoginResponse {
  loginId: string;
  step: LoginStep;
}

export async function startLogin(
  provider: Provider,
  creds: LoginCredentials
): Promise<LoginResponse> {
  sweep();
  const context = await newContext();
  const page = await context.newPage();
  const loginId = randomUUID();
  const login: ActiveLogin = {
    loginId,
    provider,
    context,
    page,
    createdAt: Date.now(),
    creds,
  };

  try {
    const step = await provider.startLogin(page, creds);
    if (step.status === "error") {
      await saveScreenshot(page, provider.id, "login-error");
      await context.close().catch(() => {});
      return { loginId, step };
    }
    if (step.status === "success") {
      await finalize(login);
      return { loginId, step };
    }
    // need_input: keep the session alive for the next call
    active.set(loginId, login);
    return { loginId, step };
  } catch (err) {
    log.error(`startLogin failed for ${provider.id}`, err);
    await saveScreenshot(page, provider.id, "login-exception");
    await context.close().catch(() => {});
    return {
      loginId,
      step: { status: "error", message: (err as Error).message },
    };
  }
}

export async function submitInput(
  loginId: string,
  field: string,
  value: string
): Promise<LoginStep> {
  const login = active.get(loginId);
  if (!login) {
    return {
      status: "error",
      message: "Login session expired or not found. Please start again.",
    };
  }
  try {
    const step = await login.provider.submitInput(login.page, field, value);
    if (step.status === "success") {
      await finalize(login);
    } else if (step.status === "error") {
      await saveScreenshot(login.page, login.provider.id, "code-error");
    }
    return step;
  } catch (err) {
    log.error(`submitInput failed for ${login.provider.id}`, err);
    await saveScreenshot(login.page, login.provider.id, "code-exception");
    return { status: "error", message: (err as Error).message };
  }
}

export async function cancelLogin(loginId: string): Promise<void> {
  const login = active.get(loginId);
  if (login) {
    await login.context.close().catch(() => {});
    active.delete(loginId);
  }
}
