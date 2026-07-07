import { config } from "../config.js";
import { FandangoProvider } from "./fandango.js";
import { StubProvider } from "./stubProvider.js";
import type { Provider } from "./types.js";

const all: Provider[] = [
  new FandangoProvider(),
  new StubProvider(
    "sony",
    "Sony Pictures Core",
    "https://www.sonypicturescore.com/",
    "https://www.sonypicturescore.com/library",
    "Formerly Bravia Core. Redeem/library lives behind the Sony account login."
  ),
  new StubProvider(
    "moviesanywhere",
    "Movies Anywhere",
    "https://moviesanywhere.com/login",
    "https://moviesanywhere.com/my-movies",
    "Aggregates titles from connected retailers. Uses Movies Anywhere account login."
  ),
  new StubProvider(
    "universal",
    "Universal Pictures",
    "https://www.universalpictures.com/",
    "https://www.universalpictures.com/",
    "Universal Pictures Store / MyUniversal library."
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
