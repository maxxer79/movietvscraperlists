import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProvider } from "../scrapers/registry.js";
import { SessionExpiredError } from "../scrapers/types.js";
import { newContext } from "./browser.js";
import { saveLibrary, type LibrarySnapshot } from "./libraryStore.js";
import { clearSession, loadSession } from "./sessionStore.js";
import { paths } from "./paths.js";
import { createLogger } from "../logger.js";

const log = createLogger("scrape-jobs");
const jobsDir = () => join(paths.data, "scrape-jobs");
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

export interface ScrapeJob {
  id: string;
  providerId: string;
  status: "running" | "done" | "error";
  message: string;
  count?: number;
  startedAt: string;
  finishedAt?: string;
  snapshot?: LibrarySnapshot;
  error?: string;
  sessionExpired?: boolean;
}

const jobs = new Map<string, ScrapeJob>();
const activeByProvider = new Map<string, string>();

function jobFile(jobId: string) {
  return join(jobsDir(), `${jobId}.json`);
}

function persistJob(job: ScrapeJob): void {
  writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2), "utf8");
}

function loadJobFromDisk(jobId: string): ScrapeJob | null {
  const f = jobFile(jobId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as ScrapeJob;
  } catch {
    return null;
  }
}

function rememberJob(job: ScrapeJob): void {
  jobs.set(job.id, job);
  persistJob(job);
}

function cleanupOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status === "running") continue;
    const finished = job.finishedAt ? Date.parse(job.finishedAt) : Date.parse(job.startedAt);
    if (finished < cutoff) {
      jobs.delete(id);
      try {
        rmSync(jobFile(id));
      } catch {
        /* ignore */
      }
    }
  }

  if (!existsSync(jobsDir())) return;
  for (const name of readdirSync(jobsDir())) {
    if (!name.endsWith(".json")) continue;
    const f = join(jobsDir(), name);
    try {
      const job = JSON.parse(readFileSync(f, "utf8")) as ScrapeJob;
      if (job.status === "running") continue;
      const finished = job.finishedAt ? Date.parse(job.finishedAt) : Date.parse(job.startedAt);
      if (finished < cutoff) rmSync(f);
    } catch {
      /* ignore bad files */
    }
  }
}

/** Warm the in-memory cache from disk on first lookup after a restart. */
function hydrateJob(jobId: string): ScrapeJob | null {
  const cached = jobs.get(jobId);
  if (cached) return cached;
  const disk = loadJobFromDisk(jobId);
  if (disk) jobs.set(disk.id, disk);
  return disk;
}

export function getScrapeJob(jobId: string): ScrapeJob | null {
  return hydrateJob(jobId);
}

export function getActiveScrapeJob(providerId: string): ScrapeJob | null {
  const jobId = activeByProvider.get(providerId);
  if (jobId) {
    const job = hydrateJob(jobId);
    if (job?.status === "running") return job;
  }

  if (!existsSync(jobsDir())) return null;
  let latest: ScrapeJob | null = null;
  for (const name of readdirSync(jobsDir())) {
    if (!name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(join(jobsDir(), name), "utf8")) as ScrapeJob;
      if (job.providerId !== providerId || job.status !== "running") continue;
      if (!latest || job.startedAt > latest.startedAt) latest = job;
    } catch {
      /* ignore */
    }
  }
  if (latest) jobs.set(latest.id, latest);
  return latest;
}

/** Most recent job for a provider (running or recently finished). */
export function getLatestScrapeJob(providerId: string): ScrapeJob | null {
  let latest: ScrapeJob | null = null;

  for (const job of jobs.values()) {
    if (job.providerId !== providerId) continue;
    if (!latest || job.startedAt > latest.startedAt) latest = job;
  }

  if (!existsSync(jobsDir())) return latest;
  for (const name of readdirSync(jobsDir())) {
    if (!name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(join(jobsDir(), name), "utf8")) as ScrapeJob;
      if (job.providerId !== providerId) continue;
      if (!latest || job.startedAt > latest.startedAt) latest = job;
    } catch {
      /* ignore */
    }
  }
  if (latest) jobs.set(latest.id, latest);
  return latest;
}

export function resolveScrapeJob(providerId: string, jobId?: string): ScrapeJob | null {
  if (jobId) {
    const direct = getScrapeJob(jobId);
    if (direct && direct.providerId === providerId) return direct;
  }
  return getActiveScrapeJob(providerId) ?? getLatestScrapeJob(providerId);
}

export function startScrapeJob(providerId: string): ScrapeJob {
  cleanupOldJobs();

  const existingId = activeByProvider.get(providerId);
  if (existingId) {
    const existing = hydrateJob(existingId);
    if (existing?.status === "running") return existing;
  }

  const provider = getProvider(providerId);
  if (!provider) throw new Error("Unknown provider");
  if (!provider.implemented) throw new Error(`${provider.name} is not implemented yet.`);

  const state = loadSession(providerId);
  if (!state) throw new Error("Not connected. Please log in to this provider first.");

  const job: ScrapeJob = {
    id: randomUUID(),
    providerId,
    status: "running",
    message: "Starting library sync…",
    startedAt: new Date().toISOString(),
  };
  rememberJob(job);
  activeByProvider.set(providerId, job.id);

  void runScrapeJob(job, provider, state).catch((err) => {
    log.error(`Unhandled scrape job failure for ${providerId}`, err);
  });

  return job;
}

function updateJob(job: ScrapeJob, patch: Partial<ScrapeJob>): void {
  Object.assign(job, patch);
  rememberJob(job);
}

async function runScrapeJob(
  job: ScrapeJob,
  provider: NonNullable<ReturnType<typeof getProvider>>,
  storageState: string
): Promise<void> {
  const context = await newContext(storageState);
  try {
    updateJob(job, {
      message: "Fetching your library — large collections may take a few minutes…",
    });
    const items = await provider.scrapeLibrary(context);
    const snapshot = saveLibrary(provider.id, items);
    updateJob(job, {
      status: "done",
      count: snapshot.count,
      snapshot,
      message: `Synced ${snapshot.count} titles`,
      finishedAt: new Date().toISOString(),
    });
    log.info(`${provider.id} scrape job ${job.id} finished: ${snapshot.count} items`);
  } catch (err) {
    const finishedAt = new Date().toISOString();
    if (err instanceof SessionExpiredError) {
      clearSession(provider.id);
      updateJob(job, {
        status: "error",
        sessionExpired: true,
        error: err.message,
        message: err.message,
        finishedAt,
      });
    } else {
      const message = (err as Error).message;
      updateJob(job, {
        status: "error",
        error: message,
        message,
        finishedAt,
      });
    }
    log.error(`${provider.id} scrape job ${job.id} failed`, err);
  } finally {
    activeByProvider.delete(provider.id);
    await context.close().catch(() => {});
  }
}
