import { bearer, defineConnection, defineTool, useSecret } from "@opencomputer/agent";
import { loadIncident } from "../lib/incident.js";
import { requireCheckout } from "../lib/checkout.js";
import { verifyWorkspace } from "../lib/verification.js";
import { publishFix, type Request } from "../lib/github-api.js";

export const github = defineConnection({
  id: "github",
  origin: "https://api.github.com",
  methods: ["GET", "POST"],
  pathPrefix: "/repos/diggerhq/opencomputer-example-oncall/",
  headers: {
    Authorization: bearer(useSecret("GITHUB_TOKEN")),
    Accept: "application/vnd.github+json",
    "User-Agent": "opencomputer-example-oncall",
  },
});

export const openFixPullRequest = defineTool({
  name: "open_fix_pull_request",
  description: "Verify the actual cloud checkout, then publish its service fix and new regression test as a GitHub PR. Independently runs identical application tests with the new test against original and fixed source; requires failure before and success after. Reads files from disk; accepts no model-supplied file contents or test logs. Only app/{service}.mjs and app/test/{service}.regression.test.mjs may change. Returns the PR URL, diff, and captured test results.",
  input: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short PR title describing the behavior fixed, at most 120 characters." },
      explanation: { type: "string", description: "Concise cause and correction, for the PR reviewer." },
    },
    required: ["title", "explanation"],
    additionalProperties: false,
  },
  async run({ input, signal }) {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 120 || /[\r\n]/.test(input.title) ||
        typeof input.explanation !== "string" || !input.explanation.trim() || input.explanation.length > 4000) {
      throw new Error("Provide a concise explanation of the cause and correction.");
    }
    const incident = await loadIncident();
    await requireCheckout(incident, process.cwd(), signal);
    const verification = await verifyWorkspace({ service: incident.service, commit: incident.commit, signal });
    const request: Request = async (method, path, body) => {
      const response = await github.fetch(path, {
        method, signal, headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let json: unknown;
      try { json = await response.json(); } catch { json = undefined; }
      return { status: response.status, json, text: "" };
    };
    const publication = await publishFix(request, {
      service: incident.service, commit: incident.commit, eventId: incident.eventId,
      issueUrl: incident.issueUrl ?? `https://sentry.io/organizations/${incident.organization}/issues/?query=${incident.eventId}`,
      title: input.title, explanation: input.explanation, files: verification.files,
      before: verification.before, after: verification.after,
    });
    return { publication, diff: verification.diff, before: verification.before, after: verification.after };
  },
});
