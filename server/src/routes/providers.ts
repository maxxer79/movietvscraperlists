import { Router } from "express";
import { z } from "zod";
import { enabledProviders, getProvider } from "../scrapers/registry.js";
import { hasSession, clearSession } from "../services/sessionStore.js";
import { loadLibrary } from "../services/libraryStore.js";
import { startLogin, submitInput, cancelLogin } from "../scrapers/loginController.js";
import {
  resolveScrapeJob,
  startScrapeJob,
} from "../services/scrapeJobs.js";
import { createLogger } from "../logger.js";

const log = createLogger("api");
export const providersRouter = Router();

// List providers + their status (connected? last scrape? counts?)
providersRouter.get("/", (_req, res) => {
  const list = enabledProviders().map((p) => {
    const lib = loadLibrary(p.id);
    return {
      id: p.id,
      name: p.name,
      implemented: p.implemented,
      notes: p.notes,
      connected: hasSession(p.id),
      lastScrapedAt: lib?.scrapedAt ?? null,
      itemCount: lib?.count ?? 0,
    };
  });
  res.json({ providers: list });
});

const loginStartSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

providersRouter.post("/:id/login/start", async (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: "Unknown provider" });
  if (!provider.implemented)
    return res.status(400).json({ error: `${provider.name} is not implemented yet.` });

  const parsed = loginStartSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "username and password are required" });

  try {
    const result = await startLogin(provider, parsed.data);
    res.json(result);
  } catch (err) {
    log.error("login/start failed", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

const loginCodeSchema = z.object({
  loginId: z.string().min(1),
  field: z.string().default("code"),
  value: z.string().min(1),
});

providersRouter.post("/:id/login/submit", async (req, res) => {
  const parsed = loginCodeSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "loginId and value are required" });
  try {
    const step = await submitInput(
      parsed.data.loginId,
      parsed.data.field,
      parsed.data.value
    );
    res.json({ step });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

providersRouter.post("/:id/login/cancel", async (req, res) => {
  const loginId = z.string().safeParse(req.body?.loginId);
  if (loginId.success) await cancelLogin(loginId.data);
  res.json({ ok: true });
});

providersRouter.post("/:id/disconnect", (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: "Unknown provider" });
  clearSession(provider.id);
  res.json({ ok: true });
});

// Trigger a scrape using the saved session (runs in background for large libraries).
providersRouter.post("/:id/scrape", async (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: "Unknown provider" });
  if (!provider.implemented)
    return res.status(400).json({ error: `${provider.name} is not implemented yet.` });

  try {
    const job = startScrapeJob(provider.id);
    res.status(202).json({
      ok: true,
      jobId: job.id,
      status: job.status,
      message: job.message,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("Not connected")) {
      return res.status(401).json({ error: message });
    }
    log.error(`scrape start failed for ${provider.id}`, err);
    res.status(500).json({ error: message });
  }
});

// Poll scrape progress (avoids browser/proxy timeouts on large libraries).
providersRouter.get("/:id/scrape/status", (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: "Unknown provider" });

  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : undefined;
  const job = resolveScrapeJob(provider.id, jobId);
  if (!job) {
    return res.status(404).json({ error: "No scrape job found." });
  }

  res.json({
    jobId: job.id,
    status: job.status,
    message: job.message,
    count: job.count ?? null,
    itemsFound: job.itemsFound ?? null,
    logLines: job.logLines ?? [],
    snapshot: job.status === "done" ? job.snapshot : undefined,
    error: job.error,
    sessionExpired: job.sessionExpired ?? false,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
  });
});

// Get the stored library for a provider.
providersRouter.get("/:id/library", (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: "Unknown provider" });
  const lib = loadLibrary(provider.id);
  res.json(lib ?? { providerId: provider.id, count: 0, items: [], scrapedAt: null });
});
