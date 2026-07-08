import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";

const MAX_JOB_LOG_LINES = 120;
const syncLogFile = () => join(paths.logs, "sync.log");

function ensureLogDir() {
  if (!existsSync(paths.logs)) mkdirSync(paths.logs, { recursive: true });
}

/** Append a timestamped line to the persistent sync log on disk. */
export function appendSyncLog(providerId: string, jobId: string, line: string): void {
  ensureLogDir();
  const ts = new Date().toISOString();
  appendFileSync(syncLogFile(), `[${ts}] [${providerId}] [${jobId.slice(0, 8)}] ${line}\n`, "utf8");
}

export function appendJobLog(
  job: { providerId: string; id: string; logLines?: string[] },
  line: string
): void {
  if (!job.logLines) job.logLines = [];
  const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
  job.logLines.push(stamped);
  if (job.logLines.length > MAX_JOB_LOG_LINES) {
    job.logLines.splice(0, job.logLines.length - MAX_JOB_LOG_LINES);
  }
  appendSyncLog(job.providerId, job.id, line);
}
