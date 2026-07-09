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
  injectVuduAuthIntoStorageState,
  mintVuduSessionWithPassword,
  validateVuduAuth,
  type VuduAuth,
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
  /**
   * Live capture of api.vudu.com traffic during Sign-In / code verify.
   * Classic password sessionKeyRequest often returns empty now; the SPA still
   * mints a usable key on the wire during browser login.
   */
  networkAuthPromise?: Promise<VuduAuth | null>;
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

interface AuthCaptureResult {
  auth: VuduAuth | null;
  /** Human-readable reason when auth is null (shown in Connect error). */
  detail?: string;
}

async function acceptValidatedAuth(
  page: Page,
  providerId: string,
  auth: VuduAuth,
  source: string
): Promise<VuduAuth | null> {
  const ok = await validateVuduAuth(auth);
  if (!ok) {
    log.warn(`${source} sessionKey failed API validation`);
    return null;
  }
  await injectVuduAuthIntoLocalStorage(page, ok).catch((err) => {
    log.warn("Could not inject auth into page localStorage", err);
  });
  log.info(
    `Got Vudu API credentials via ${source} for ${providerId} (userId ${ok.userId.slice(0, 6)}…)`
  );
  return ok;
}

/**
 * After a successful browser login, obtain a usable Vudu API sessionKey.
 * Prefer keys captured live from Sign-In network traffic; fall back to password
 * mint and validated page storage. Never persist rejected tokens.
 */
async function captureProviderAuth(login: ActiveLogin): Promise<AuthCaptureResult> {
  if (login.provider.id !== "fandango") return { auth: null };
  const attempts: string[] = [];
  try {
    const page = login.page;

    // 1) Auth minted by the SPA during Sign-In / email-code (best path).
    if (login.networkAuthPromise) {
      attempts.push("Checking Sign-In network capture…");
      const fromLogin = await login.networkAuthPromise;
      if (fromLogin) {
        const ok = await acceptValidatedAuth(page, login.provider.id, fromLogin, "Sign-In network");
        if (ok) return { auth: ok };
        attempts.push("Sign-In network key failed API validation");
      } else {
        attempts.push("No sessionKey seen on the wire during Sign-In");
      }
    }

    // 2) Classic password sessionKeyRequest (often empty under Fandango SSO).
    if (login.creds?.username && login.creds?.password) {
      const minted = await mintVuduSessionWithPassword(
        login.creds.username,
        login.creds.password,
        (msg) => attempts.push(msg)
      );
      if (minted) {
        const ok = await acceptValidatedAuth(page, login.provider.id, minted, "password mint");
        if (ok) return { auth: ok };
        attempts.push("Password mint returned a sessionKey that failed API validation");
      } else {
        log.warn("Password sessionKeyRequest failed");
      }
    } else {
      attempts.push("Password was not available for API mint");
    }

    // 3) Brief post-login listen + page storage (only if API-validated).
    const networkAuthPromise = captureVuduAuthFromNetwork(page, 25_000);
    await page.goto("https://athome.fandango.com/content/browse/mymovies", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2500);
    await dismissCookieBanner(page);
    await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});

    const fromNetwork = await networkAuthPromise;
    if (fromNetwork) {
      const ok = await acceptValidatedAuth(page, login.provider.id, fromNetwork, "library network");
      if (ok) return { auth: ok };
      attempts.push("Library-page network key failed API validation");
    }

    const fromPage = await extractVuduAuth(page);
    if (fromPage) {
      const ok = await acceptValidatedAuth(page, login.provider.id, fromPage, "page storage");
      if (ok) return { auth: ok };
      attempts.push("Page/localStorage tokens were present but rejected by the API");
    } else {
      attempts.push("No sessionKey found in page storage");
    }

    return {
      auth: null,
      detail: attempts.slice(-5).join(" · ") || "Could not mint a usable Vudu API sessionKey",
    };
  } catch (err) {
    log.warn(`Could not capture Vudu auth after login for ${login.provider.id}`, err);
    return {
      auth: null,
      detail: (err as Error).message || "Unexpected error while minting API session",
    };
  } finally {
    // Do not keep the password around after finalize.
    login.creds = undefined;
    login.networkAuthPromise = undefined;
  }
}

async function finalize(login: ActiveLogin): Promise<LoginStep> {
  const { auth, detail } = await captureProviderAuth(login);
  let storageState = JSON.stringify(await login.context.storageState());

  if (login.provider.id === "fandango") {
    if (!auth) {
      await login.context.close().catch(() => {});
      active.delete(login.loginId);
      return {
        status: "error",
        message:
          "Signed into Fandango, but could not mint a usable Vudu API sessionKey. " +
          "Sync needs this key. Try Connect again with the same email/password" +
          (detail ? ` (${detail})` : "."),
      };
    }
    // Patch storageState directly so Sync does not depend on page-origin localStorage.
    storageState = injectVuduAuthIntoStorageState(storageState, auth);
  }

  saveSession(login.provider.id, storageState);
  await login.context.close().catch(() => {});
  active.delete(login.loginId);
  return { status: "success" };
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
    // Listen for a live sessionKey while the SPA signs in (password mint often fails).
    if (provider.id === "fandango") {
      login.networkAuthPromise = captureVuduAuthFromNetwork(page, 120_000);
    }
    const step = await provider.startLogin(page, creds);
    if (step.status === "error") {
      await saveScreenshot(page, provider.id, "login-error");
      await context.close().catch(() => {});
      return { loginId, step };
    }
    if (step.status === "success") {
      return { loginId, step: await finalize(login) };
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
    // Code verify also mints API keys — refresh the network listener.
    if (login.provider.id === "fandango") {
      login.networkAuthPromise = captureVuduAuthFromNetwork(login.page, 90_000);
    }
    const step = await login.provider.submitInput(login.page, field, value);
    if (step.status === "success") {
      return await finalize(login);
    }
    if (step.status === "error") {
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
