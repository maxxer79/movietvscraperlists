import { config } from "../config.js";
import { AppleTvProvider } from "./appletv.js";
import { FandangoProvider } from "./fandango.js";
import { GooglePlayProvider } from "./googleplay.js";
import { MoviesAnywhereProvider } from "./moviesanywhere.js";
import { PrimeVideoProvider } from "./primevideo.js";
import type { Provider } from "./types.js";

const all: Provider[] = [
  new FandangoProvider(),
  new MoviesAnywhereProvider(),
  new AppleTvProvider(),
  new GooglePlayProvider(),
  new PrimeVideoProvider(),
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
