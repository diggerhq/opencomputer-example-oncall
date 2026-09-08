import { isDeepStrictEqual } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const EVENT_ID = /^[a-f0-9]{32}$/;
const SLUG = /^[a-zA-Z0-9_-]+$/;
const MAX_CONTEXT_BYTES = 64 * 1024;

function incidentContext(incident) {
  if (!incident || !["api", "worker"].includes(incident.service) ||
      typeof incident.release !== "string" || !incident.release || incident.release.length > 200 ||
      !/^[a-f0-9]{40}$/.test(incident.commit ?? "") ||
      !(incident.error instanceof Error)) {
    throw new Error("Expected a captured api or worker Error with a release, full Git commit, and snapshot.");
  }
  const context = { service: incident.service, release: incident.release, commit: incident.commit, snapshot: incident.snapshot };
  let json;
  try {
    json = JSON.stringify(context);
    if (!isDeepStrictEqual(JSON.parse(json), context)) throw new Error();
  } catch {
    throw new Error("The incident snapshot must contain only JSON values.");
  }
  if (Buffer.byteLength(json) > MAX_CONTEXT_BYTES) {
    throw new Error("The incident context exceeds 64 KiB.");
  }
  if (!context.snapshot || typeof context.snapshot !== "object" || Array.isArray(context.snapshot)) {
    throw new Error("The incident snapshot must be an object.");
  }
  return JSON.parse(json);
}

function validateConfig(config) {
  if (!config || typeof config.dsn !== "string" || !config.dsn ||
      typeof config.token !== "string" || !config.token ||
      !SLUG.test(config.organization ?? "") || !SLUG.test(config.project ?? "")) {
    throw new Error("Configure SENTRY_DSN, SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT.");
  }
  try {
    const dsn = new URL(config.dsn);
    if (dsn.protocol !== "https:" || !dsn.username || !/^\/\d+$/.test(dsn.pathname)) throw new Error();
  } catch {
    throw new Error("SENTRY_DSN must be a valid HTTPS Sentry DSN.");
  }
}

function verifyEvent(event, eventId, expected) {
  const returnedId = event?.eventID ?? event?.eventId ?? event?.id;
  const release = typeof event?.release === "string" ? event.release : event?.release?.version;
  const oncall = event?.contexts?.oncall;
  if (returnedId !== eventId || release !== expected.release ||
      oncall?.service !== expected.service || oncall?.release !== expected.release ||
      oncall?.commit !== expected.commit ||
      !isDeepStrictEqual(oncall?.snapshot, expected.snapshot)) {
    throw new Error("Sentry did not preserve the exact incident ID, release and snapshot; the incident was not dispatched.");
  }
}

/** Capture the actual fixture Error, then wait until the agent can read its exact replay context. */
export async function captureSentryIncident(incident, config, options = {}) {
  validateConfig(config);
  const context = incidentContext(incident);
  const sdk = options.sentry ?? await import("@sentry/node");
  const fetcher = options.fetch ?? globalThis.fetch;
  const delay = options.sleep ?? sleep;
  const flushTimeoutMs = options.flushTimeoutMs ?? 5_000;
  const pollingTimeoutMs = options.pollingTimeoutMs ?? 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const maxAttempts = options.maxAttempts ?? 30;

  // A private client avoids instrumenting the CLI's HTTP requests, process errors or environment.
  const client = new sdk.NodeClient({
    dsn: config.dsn,
    transport: sdk.makeNodeTransport,
    stackParser: sdk.defaultStackParser,
    defaultIntegrations: false,
    integrations: [],
    debug: false,
    enableLogs: false,
    enableMetrics: false,
    sendDefaultPii: false,
    sendClientReports: false,
    autoSessionTracking: false,
    sampleRate: 1,
    release: context.release,
    environment: "development",
    serverName: "oncall-example",
    normalizeDepth: 20,
    normalizeMaxBreadth: 1_000,
    maxBreadcrumbs: 20,
  });
  const scope = new sdk.Scope();
  scope.setClient(client);
  scope.setTag("service", context.service);
  scope.setContext("oncall", context);
  // Demo grouping: every run is its own Sentry issue, so an alert rule on
  // "a new issue is created" fires for each run instead of once per
  // grouped error. A real application would keep Sentry's default grouping.
  scope.setFingerprint(["oncall", context.service, crypto.randomUUID()]);
  for (const crumb of (incident.breadcrumbs ?? []).slice(-20)) scope.addBreadcrumb(crumb);

  let eventId;
  try {
    eventId = scope.captureException(incident.error);
    if (!EVENT_ID.test(eventId ?? "")) throw new Error();
    if (!await client.flush(flushTimeoutMs)) throw new Error();
  } catch {
    throw new Error("Sentry could not flush the captured incident. Check the DSN and network connection.");
  } finally {
    // close() also disposes the SDK transport after the one explicitly captured event.
    await client.close(flushTimeoutMs).catch(() => {});
  }

  const url = `https://sentry.io/api/0/projects/${config.organization}/${config.project}/events/${eventId}/`;
  const deadline = Date.now() + pollingTimeoutMs;
  for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt++) {
    let response;
    try {
      response = await fetcher(url, {
        headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now()))),
      });
    } catch {
      // Ingestion and transient network failures may delay the read. Never echo provider errors or headers.
    }
    if (response?.ok) {
      let event;
      try { event = await response.json(); } catch {
        throw new Error("Sentry returned an unreadable event; the incident was not dispatched.");
      }
      verifyEvent(event, eventId, context);
      const groupId = String(event.groupID ?? "");
      const issueUrl = /^\d+$/.test(groupId)
        ? `https://sentry.io/organizations/${config.organization}/issues/${groupId}/`
        : `https://sentry.io/organizations/${config.organization}/issues/?query=${encodeURIComponent(eventId)}`;
      return { eventId, issueUrl };
    }
    if (response?.status === 401 || response?.status === 403) {
      throw new Error(`Sentry event lookup was denied (HTTP ${response.status}). Check the token's project:read permission and project access.`);
    }
    if (response && response.status !== 404 && response.status !== 429 && response.status < 500) {
      throw new Error(`Sentry event lookup failed (HTTP ${response.status}).`);
    }
    if (attempt + 1 < maxAttempts && Date.now() < deadline) {
      await delay(Math.max(0, Math.min(pollIntervalMs, deadline - Date.now())));
    }
  }
  throw new Error("The captured Sentry event did not become readable before the polling limit; the incident was not dispatched.");
}
