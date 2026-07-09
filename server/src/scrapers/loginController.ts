import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { newContext } from "../services/browser.js";
import { saveSession } from "../services/sessionStore.js";
import { createLogger } from "../logger.js";
import { paths } from "../services/paths.js";
import { join } from "node:path";
import type { LoginCredentials, LoginStep, Provider } from "./types.js";
import {
  extractVuduAuth,
  injectVuduAuthIntoLocalStorage,
} from "./vuduApi.js";
import { dismissCookieBanner } from "./helpers.js";

const log = createLogger("login");

interface ActiveLogin {
  loginId: string;
  provider: Provider;
  context: BrowserContext;
  page: Page;
  createdAt: number;
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
 * After a successful login, visit the library so Vudu writes session tokens,
 * then copy them into localStorage so Playwright storageState persists them
 * for fast API syncs (sessionStorage alone is not saved by Playwright).
 */
async function captureProviderAuth(login: ActiveLogin): Promise<void> {
  if (login.provider.id !== "fandango") return;
  try {
    const page = login.page;
    await page.goto("https://athome.fandango.com/content/browse/mymovies", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3000);
    await dismissCookieBanner(page);

    let auth = await extractVuduAuth(page);
    if (!auth) {
      // Give the SPA a bit more time to hydrate tokens.
      await page.waitForTimeout(4000);
      auth = await extractVuduAuth(page);
    }
    if (auth) {
      await injectVuduAuthIntoLocalStorage(page, auth);
      log.info(
        `Captured Vudu API credentials for ${login.provider.id} (userId ${auth.userId.slice(0, 6)}…)`
      );
    } else {
      log.warn(
        `Logged into ${login.provider.id} but could not find Vudu API credentials — sync may use slow browser path`
      );
    }
  } catch (err) {
    log.warn(`Could not capture Vudu auth after login for ${login.provider.id}`, err);
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
