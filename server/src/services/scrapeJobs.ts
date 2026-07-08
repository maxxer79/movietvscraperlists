import { randomUUID } from "node:crypto";
import { getProvider } from "../scrapers/registry.js";
import { SessionExpiredError } from "../scrapers/types.js";
import { newContext } from "./browser.js";
import { saveLibrary, type LibrarySnapshot } from "./libraryStore.js";
import { clearSession, loadSession } from "./sessionStore.js";
import { createLogger } from "../logger.js";

const log = createLogger("scrape-jobs");

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

function cleanupOldJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.status === "running") continue;
    const finished = job.finishedAt ? Date.parse(job.finishedAt) : Date.parse(job.startedAt);
    if (finished < cutoff) jobs.delete(id);
  }
}

export function getScrapeJob(jobId: string): ScrapeJob | null {
  return jobs.get(jobId) ?? null;
}

export function getActiveScrapeJob(providerId: string): ScrapeJob | null {
  const jobId = activeByProvider.get(providerId);
  if (!jobId) return null;
  const job = jobs.get(jobId);
  if (!job || job.status !== "running") return null;
  return job;
}

export function startScrapeJob(providerId: string): ScrapeJob {
  cleanupOldJobs();

  const existingId = activeByProvider.get(providerId);
  if (existingId) {
    const existing = jobs.get(existingId);
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
  jobs.set(job.id, job);
  activeByProvider.set(providerId, job.id);

  void runScrapeJob(job, provider, state).catch((err) => {
    log.error(`Unhandled scrape job failure for ${providerId}`, err);
  });

  return job;
}

async function runScrapeJob(
  job: ScrapeJob,
  provider: NonNullable<ReturnType<typeof getProvider>>,
  storageState: string
): Promise<void> {
  const context = await newContext(storageState);
  try {
    job.message = "Fetching your library — large collections may take a few minutes…";
    const items = await provider.scrapeLibrary(context);
    const snapshot = saveLibrary(provider.id, items);
    job.status = "done";
    job.count = snapshot.count;
    job.snapshot = snapshot;
    job.message = `Synced ${snapshot.count} titles`;
    job.finishedAt = new Date().toISOString();
    log.info(`${provider.id} scrape job ${job.id} finished: ${snapshot.count} items`);
  } catch (err) {
    job.status = "error";
    job.finishedAt = new Date().toISOString();
    if (err instanceof SessionExpiredError) {
      clearSession(provider.id);
      job.sessionExpired = true;
      job.error = err.message;
      job.message = err.message;
    } else {
      job.error = (err as Error).message;
      job.message = job.error;
    }
    log.error(`${provider.id} scrape job ${job.id} failed`, err);
  } finally {
    activeByProvider.delete(provider.id);
    await context.close().catch(() => {});
  }
}
