import { bearer, defineConnection, defineTool, useSecret } from "@opencomputer/agent";
import { clearIncident, normalizeSentryEvent, parseLocator, saveIncident } from "../lib/incident.js";
import { repository } from "../lib/target.js";

export const sentry = defineConnection({
  id: "sentry",
  origin: "https://sentry.io",
  methods: ["GET"],
  pathPrefix: "/api/0/projects/",
  headers: { Authorization: bearer(useSecret("SENTRY_AUTH_TOKEN")) },
});

export const readSentryEvent = defineTool({
  name: "read_sentry_event",
  description: "Read the exact Sentry event in the incident locator. Validate its event ID, service, release, Git commit and captured state, then save .oncall/incident.json. Returns the public repository and pinned commit to clone in this cloud session. A failed read stops investigation.",
  input: {
    type: "object",
    properties: {
      service: { type: "string", enum: ["api", "worker"] },
      organization: { type: "string" },
      project: { type: "string" },
      eventId: { type: "string" },
      release: { type: "string" },
      commit: { type: "string" },
    },
    required: ["service", "organization", "project", "eventId", "release", "commit"],
    additionalProperties: false,
  },
  async run({ input, signal }) {
    await clearIncident();
    const locator = parseLocator(input);
    const response = await sentry.fetch(`/api/0/projects/${locator.organization}/${locator.project}/events/${locator.eventId}/`, { method: "GET", signal });
    if (!response.ok) throw new Error(`Sentry event read failed with HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 1_048_576) throw new Error("Sentry event exceeds the 1 MiB diagnostic limit");
    const event = JSON.parse(text);
    const incident = normalizeSentryEvent(locator, event);
    await saveIncident(incident);
    const exceptions = Array.isArray(event.entries)
      ? event.entries.filter((entry: { type?: string }) => entry.type === "exception").flatMap((entry: { data?: { values?: unknown[] } }) => entry.data?.values ?? [])
      : [];
    const breadcrumbs = Array.isArray(event.entries)
      ? event.entries.filter((entry: { type?: string }) => entry.type === "breadcrumbs").flatMap((entry: { data?: { values?: unknown[] } }) => entry.data?.values ?? [])
      : [];
    return {
      service: incident.service,
      release: incident.release,
      eventId: incident.eventId,
      commit: incident.commit,
      issueUrl: incident.issueUrl ?? "",
      title: String(event.title ?? event.message ?? "").slice(0, 1000),
      exceptions: JSON.stringify(exceptions).slice(0, 8000),
      breadcrumbs: JSON.stringify(breadcrumbs.slice(-20)).slice(0, 4000),
      capturedState: ".oncall/incident.json",
      repository: `https://github.com/${repository}.git`,
      source: "repository/app/",
      note: "Clone the repository and check out the pinned commit. Diagnostic tools execute that checkout against captured event-time state.",
    };
  },
});
