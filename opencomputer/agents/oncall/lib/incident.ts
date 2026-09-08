import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type Service = "api" | "worker";
export type Locator = { service: Service; organization: string; project: string; eventId: string; release: string };
export type Report = { id: string; title: string; timezone: string | null; createdAt: string };
export type ApiSnapshot = { version: 1; request: { method: "GET"; path: string }; reports: Report[] };
export type Job = { id: string; createdAt: string; status: string; attempts: number; reportId: string; rows: { account: string; total: number }[] | null };
export type WorkerSnapshot = { version: 1; jobs: Job[]; maxSteps: number };
export type Incident = Locator & { snapshot: ApiSnapshot | WorkerSnapshot };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error(`${label} must be a nonempty string of at most ${max} characters`);
  return value;
}

function integer(value: unknown, label: string, max: number): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error(`${label} is out of bounds`);
  return Number(value);
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array of at most ${max} entries`);
  return value;
}

export function parseLocator(value: unknown): Locator {
  const input = object(value, "incident locator");
  if (input.service !== "api" && input.service !== "worker") throw new Error("service must be api or worker");
  const organization = string(input.organization, "organization", 100);
  const project = string(input.project, "project", 100);
  if (![organization, project].every(slug => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug))) throw new Error("organization and project must be Sentry slugs");
  const eventId = string(input.eventId, "eventId", 32);
  if (!/^[a-fA-F0-9]{32}$/.test(eventId)) throw new Error("eventId must be 32 hexadecimal characters");
  return { service: input.service, organization, project, eventId: eventId.toLowerCase(), release: string(input.release, "release", 200) };
}

export function normalizeSnapshot(service: Service, value: unknown): ApiSnapshot | WorkerSnapshot {
  const snapshot = object(value, "snapshot");
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 65_536) throw new Error("Captured diagnostic state exceeds 64 KiB");
  if (snapshot.version !== 1) throw new Error("Unsupported diagnostic snapshot version");
  if (service === "api") {
    const request = object(snapshot.request, "request");
    if (request.method !== "GET") throw new Error("Captured request must use GET");
    const requestPath = string(request.path, "request.path", 200);
    if (!/^\/reports\/[a-zA-Z0-9_-]+$/.test(requestPath)) throw new Error("Captured request must target one report");
    const reports = array(snapshot.reports, "reports", 10).map((value) => {
      const report = object(value, "report");
      return {
        id: string(report.id, "report.id", 160),
        title: string(report.title, "report.title"),
        timezone: report.timezone === null ? null : string(report.timezone, "report.timezone", 100),
        createdAt: string(report.createdAt, "report.createdAt", 64),
      };
    });
    return { version: 1, request: { method: "GET", path: requestPath }, reports };
  }
  const jobs = array(snapshot.jobs, "jobs", 10).map((value) => {
    const job = object(value, "job");
    const rows = job.rows === null ? null : array(job.rows, "job.rows", 100).map(value => {
      const row = object(value, "row");
      if (typeof row.total !== "number" || !Number.isFinite(row.total)) throw new Error("row.total must be finite");
      return { account: string(row.account, "row.account", 160), total: row.total };
    });
    return {
      id: string(job.id, "job.id", 160),
      createdAt: string(job.createdAt, "job.createdAt", 64),
      status: string(job.status, "job.status", 32),
      attempts: integer(job.attempts, "job.attempts", 1000),
      reportId: string(job.reportId, "job.reportId", 160),
      rows,
    };
  });
  const maxSteps = integer(snapshot.maxSteps, "maxSteps", 8);
  if (maxSteps < 1) throw new Error("maxSteps must be positive");
  return { version: 1, jobs, maxSteps };
}

export function normalizeSentryEvent(locator: Locator, value: unknown): Incident {
  const event = object(value, "Sentry event");
  const context = object(object(event.contexts, "event.contexts").oncall, "event.contexts.oncall");
  const eventRelease = typeof event.release === "string" ? event.release : object(event.release, "event.release").version;
  if (eventRelease !== locator.release || context.release !== locator.release) throw new Error("Sentry event release does not match the incident locator");
  if (context.service !== locator.service) throw new Error("Sentry event service does not match the incident locator");
  const eventId = event.eventID ?? event.event_id ?? event.id;
  if (typeof eventId !== "string" || eventId.toLowerCase() !== locator.eventId) throw new Error("Sentry returned a different event ID");
  return { ...locator, snapshot: normalizeSnapshot(locator.service, context.snapshot) };
}

export async function requireSourceRelease(release: string, cwd = process.cwd()) {
  const metadata = object(JSON.parse(await readFile(path.join(cwd, "app/release.json"), "utf8")), "source release");
  if (metadata.release !== release) throw new Error("The Sentry release does not match the bundled application source");
}

export async function saveIncident(incident: Incident, cwd = process.cwd()) {
  await mkdir(path.join(cwd, ".oncall"), { recursive: true });
  await writeFile(path.join(cwd, ".oncall/incident.json"), `${JSON.stringify(incident, null, 2)}\n`, { mode: 0o600 });
}

export async function clearIncident(cwd = process.cwd()) {
  await rm(path.join(cwd, ".oncall/incident.json"), { force: true });
}

export async function loadIncident(service: Service, cwd = process.cwd()): Promise<Incident> {
  const stored = object(JSON.parse(await readFile(path.join(cwd, ".oncall/incident.json"), "utf8")), "saved incident");
  const locator = parseLocator(stored);
  if (locator.service !== service) throw new Error(`The captured incident is not for the ${service} service`);
  return { ...locator, snapshot: normalizeSnapshot(service, stored.snapshot) };
}
