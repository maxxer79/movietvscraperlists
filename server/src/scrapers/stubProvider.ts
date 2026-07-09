import type { BrowserContext, Page } from "playwright";
import type {
  LoginCredentials,
  LoginStep,
  MediaItem,
  Provider,
} from "./types.js";

/**
 * A not-yet-implemented provider. It appears in the UI (so you can see the
 * roadmap) but clearly reports that scraping isn't wired up yet. Replace each
 * of these with a real implementation modeled on FandangoProvider.
 */
export class StubProvider implements Provider {
  readonly implemented = false;
  constructor(
    readonly id: string,
    readonly name: string,
    readonly loginUrl: string,
    readonly libraryUrl: string,
    readonly notes?: string
  ) {}

  private notReady(): LoginStep {
    return {
      status: "error",
      message: `${this.name} isn't implemented yet. It's next on the roadmap.`,
    };
  }

  async startLogin(_page: Page, _creds: LoginCredentials): Promise<LoginStep> {
    return this.notReady();
  }
  async submitInput(_page: Page, _field: string, _value: string): Promise<LoginStep> {
    return this.notReady();
  }
  async isLoggedIn(_page: Page): Promise<boolean> {
    return false;
  }
  async scrapeLibrary(
    _context: BrowserContext,
    _onProgress?: (message: string, itemsFound?: number) => void
  ): Promise<MediaItem[]> {
    throw new Error(`${this.name} scraper isn't implemented yet.`);
  }
}
