import type { BrowserContext, Page } from "playwright";

/** A single movie or TV show in a user's library. */
export interface MediaItem {
  /** Stable id within a provider when available (else derived from title). */
  id: string;
  title: string;
  type: "movie" | "tv" | "unknown";
  year?: number;
  /** Highest available quality string, e.g. "4K UHD", "HDX", "HD", "SD". */
  quality?: string;
  posterUrl?: string;
  /** Deep link to the item on the provider, if discoverable. */
  url?: string;
  /** Free-form extras (season count, studio, etc.). */
  meta?: Record<string, string | number | boolean | null>;
}

/** Result of a single step in the interactive login flow. */
export type LoginStep =
  | { status: "success" }
  | {
      status: "need_input";
      /** Which input is required next (e.g. "code", "password", "answer"). */
      field: string;
      /** Human-readable prompt to show the user. */
      prompt: string;
    }
  | { status: "error"; message: string };

export interface LoginCredentials {
  username: string;
  password: string;
}

/**
 * A provider knows how to log a user into one streaming/purchase service and
 * read their purchased library. The generic LoginController drives the browser
 * lifecycle; providers only implement service-specific logic and selectors.
 */
export interface Provider {
  readonly id: string;
  readonly name: string;
  /** Whether this provider is fully implemented (vs. a stub placeholder). */
  readonly implemented: boolean;
  readonly loginUrl: string;
  readonly libraryUrl: string;
  /** Short note shown in the UI (e.g. login quirks). */
  readonly notes?: string;

  /**
   * Begin login: navigate + submit credentials. Return the next step.
   * The page stays alive so subsequent steps (2FA) can continue on it.
   */
  startLogin(page: Page, creds: LoginCredentials): Promise<LoginStep>;

  /** Provide a requested input (usually a 2FA code) and advance the flow. */
  submitInput(page: Page, field: string, value: string): Promise<LoginStep>;

  /** True if the given page/context currently has a valid, logged-in session. */
  isLoggedIn(page: Page): Promise<boolean>;

  /** Read the full purchased library using an authenticated context. */
  scrapeLibrary(context: BrowserContext): Promise<MediaItem[]>;
}

/** Thrown by scrapeLibrary when the saved session is no longer valid. */
export class SessionExpiredError extends Error {
  constructor(message = "Session expired. Please log in again.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}
