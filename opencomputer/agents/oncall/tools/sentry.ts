import { bearer, defineConnection, defineTool, useSecret } from "@opencomputer/agent";
import { clearIncident, normalizeSentryEvent, parseLocator, requireSourceRelease, saveIncident } from "../lib/incident.js";

export const sentry = defineConnection({
  id: "sentry",
  origin: "https://sentry.io",
  methods: ["GET"],
  pathPrefix: "/api/0/projects/",
  headers: { Authorization: bearer(useSecret("SENTRY_AUTH_TOKEN")) },
});

export const readSentryEvent = defineTool({
  name: "read_sentry_event",
  description: "Read the exact Sentry event in the incident locator. Validate its captured diagnostic state and release against the bundled source, then save .oncall/incident.json for local inspection and replay. A read or validation failure stops investigation; do not replace it with sample data.",
  input: {
    type: "object",
    properties: {
      service: { type: "string", enum: ["api", "worker"] },
      organization: { type: "string" },
      project: { type: "string" },
      eventId: { type: "string" },
      release: { type: "string" },
    },
    required: ["service", "organization", "project", "eventId", "release"],
    additionalProperties: false,
  },
  async run({ input, signal }) {
    await clearIncident();
    const locator = parseLocator(input);
    await requireSourceRelease(locator.release);
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
      title: String(event.title ?? event.message ?? "").slice(0, 1000),
      exceptions: JSON.stringify(exceptions).slice(0, 8000),
      breadcrumbs: JSON.stringify(breadcrumbs.slice(-20)).slice(0, 4000),
      capturedState: ".oncall/incident.json",
      source: "app/",
      note: "The diagnostic tools inspect and replay captured event-time state, not live infrastructure.",
    };
  },
});
