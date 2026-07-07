import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encrypt, decrypt } from "./crypto.js";
import { paths } from "./paths.js";
import { createLogger } from "../logger.js";

const log = createLogger("sessions");

function file(providerId: string) {
  return join(paths.sessions, `${providerId}.session.enc`);
}

/** Persist a Playwright storageState (as JSON string) for a provider, encrypted. */
export function saveSession(providerId: string, storageStateJson: string): void {
  writeFileSync(file(providerId), encrypt(storageStateJson), "utf8");
  log.info(`Saved session for ${providerId}`);
}

/** Load a saved storageState JSON string, or null if none/invalid. */
export function loadSession(providerId: string): string | null {
  const f = file(providerId);
  if (!existsSync(f)) return null;
  try {
    return decrypt(readFileSync(f, "utf8"));
  } catch (err) {
    log.warn(`Could not decrypt session for ${providerId} (secret changed?)`, err);
    return null;
  }
}

export function hasSession(providerId: string): boolean {
  return existsSync(file(providerId));
}

export function clearSession(providerId: string): void {
  const f = file(providerId);
  if (existsSync(f)) rmSync(f);
  log.info(`Cleared session for ${providerId}`);
}
