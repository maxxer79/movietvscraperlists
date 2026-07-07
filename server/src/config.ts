import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv();

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const dataDir = resolve(process.env.DATA_DIR || "./data");

export const config = {
  port: parseInt(process.env.PORT || "8088", 10),
  dataDir,
  sessionSecret:
    process.env.SESSION_SECRET || "insecure-default-change-me-in-env-file",
  appPassword: process.env.APP_PASSWORD || "",
  headless: bool(process.env.HEADLESS, true),
  enabledProviders: (process.env.ENABLED_PROVIDERS ||
    "fandango,sony,moviesanywhere,universal")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  isProd: process.env.NODE_ENV === "production",
};

export type AppConfig = typeof config;
