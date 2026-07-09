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

/**
 * After a successful browser login, mint a fresh Vudu API sessionKey via
 * password sessionKeyRequest. Page/localStorage tokens are often already dead —
 * never persist them unless they pass API validation.
 */
async function captureProviderAuth(login: ActiveLogin): Promise<AuthCaptureResult> {
  if (login.provider.id !== "fandango") return { auth: null };
  const attempts: string[] = [];
  try {
    const page = login.page;

    if (!login.creds?.username || !login.creds?.password) {
      return {
        auth: null,
        detail: "Password was not available to mint a Vudu API sessionKey.",
      };
    }

    const minted = await mintVuduSessionWithPassword(
      login.creds.username,
      login.creds.password,
      (msg) => attempts.push(msg)
    );
    if (minted) {
      const ok = await validateVuduAuth(minted);
      if (ok) {
        await injectVuduAuthIntoLocalStorage(page, ok).catch((err) => {
          log.warn("Could not inject minted auth into page localStorage", err);
        });
        log.info(
          `Minted Vudu API credentials for ${login.provider.id} (userId ${ok.userId.slice(0, 6)}…)`
        );
        return { auth: ok };
      }
      attempts.push("Password mint returned a sessionKey that failed API validation");
      log.warn("Password-minted Vudu session failed validation");
    } else {
      log.warn("Password sessionKeyRequest failed");
    }

    // Last resort: only keep page/network tokens if they actually work against the API.
    const networkAuthPromise = captureVuduAuthFromNetwork(page, 20_000);
    await page.goto("https://athome.fandango.com/content/browse/mymovies", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2000);
    await dismissCookieBanner(page);

    let auth = await extractVuduAuth(page);
    if (!auth) {
      auth = (await extractVuduAuth(page)) || (await networkAuthPromise);
    }
    if (auth) {
      const ok = await validateVuduAuth(auth);
      if (ok) {
        await injectVuduAuthIntoLocalStorage(page, ok).catch(() => {});
        log.info(
          `Captured validated Vudu API credentials for ${login.provider.id} (userId ${ok.userId.slice(0, 6)}…)`
        );
        return { auth: ok };
      }
      attempts.push("Page/localStorage tokens were present but rejected by the API");
      log.warn("Page-captured Vudu tokens failed validation — not saving them");
    } else {
      attempts.push("No sessionKey found in page storage or network traffic");
    }

    return {
      auth: null,
      detail: attempts.slice(-4).join(" · ") || "Could not mint a usable Vudu API sessionKey",
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
