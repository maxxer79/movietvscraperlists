import { config } from "../config.js";
import { FandangoProvider } from "./fandango.js";
import { MoviesAnywhereProvider } from "./moviesanywhere.js";
import { StubProvider } from "./stubProvider.js";
import type { Provider } from "./types.js";

const all: Provider[] = [
  new FandangoProvider(),
  new MoviesAnywhereProvider(),
  new StubProvider(
    "appletv",
    "Apple TV",
    "https://tv.apple.com/login",
    "https://tv.apple.com/shop/movies",
    "Purchased movies library. Apple ID login; 2FA supported."
  ),
  new StubProvider(
    "googleplay",
    "Google Play / YouTube",
    "https://play.google.com/store/movies",
    "https://play.google.com/store/movies?category=OWNED",
    "Purchased movies on Google Play / YouTube."
  ),
  new StubProvider(
    "primevideo",
    "Prime Video",
    "https://www.amazon.com/ap/signin",
    "https://www.primevideo.com/",
    "Purchased/owned movies only — not Prime subscription catalog."
  ),
];

const byId = new Map(all.map((p) => [p.id, p]));

/** Providers enabled via ENABLED_PROVIDERS, in registry order. */
export function enabledProviders(): Provider[] {
  return all.filter((p) => config.enabledProviders.includes(p.id));
}

export function getProvider(id: string): Provider | undefined {
  const p = byId.get(id);
  if (!p || !config.enabledProviders.includes(p.id)) return undefined;
  return p;
}

export function allProviders(): Provider[] {
  return all;
}
