import { readFile, mkdir, writeFile } from "node:fs/promises";
import { captureIncident } from "../app/incidents.mjs";
import { captureSentryIncident } from "./sentry.mjs";
import { root, sentryConfig, opencomputerConfig, serviceArgument } from "./config.mjs";
import { followSession } from "./session.mjs";

try {
  const service = serviceArgument();
  const sentry = sentryConfig();
  const oc = await opencomputerConfig();
  const webhook = JSON.parse(await readFile(new URL(".opencomputer/webhook.json", root), "utf8"));
  if (webhook.projectId !== oc.projectId || webhook.environment !== "development" || webhook.agentId !== "oncall" ||
      new URL(webhook.url).origin !== oc.origin || !new URL(webhook.url).pathname.startsWith("/api/agent-webhooks/") || !webhook.token) {
    throw new Error("Run npm run setup to configure this project's Development webhook");
  }
  const incident = await captureIncident(service);
  console.log(`${service}: ${incident.error.name}: ${incident.error.message}`);
  console.log("Recording in Sentry…");
  const { eventId, issueUrl } = await captureSentryIncident(incident, sentry);
  console.log(`Sentry: ${issueUrl}`);
  const body = {
    text: service === "api" ? "A customer's report request is failing. Investigate and verify a local correction."
      : "Reports have stopped completing. Investigate and verify a local correction.",
    payload: { service, organization: sentry.organization, project: sentry.project, eventId, release: incident.release },
  };
  await mkdir(new URL(".oncall/", root), { recursive: true });
  // Preserve the delivery for an exact retry without generating another incident.
  await writeFile(new URL(`.oncall/${eventId}-delivery.json`, root), JSON.stringify(body) + "\n", { mode: 0o600 });
  const response = await fetch(webhook.url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${webhook.token}`, "Content-Type": "application/json", "Idempotency-Key": `sentry:${eventId}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenComputer webhook returned HTTP ${response.status}`);
  const admitted = await response.json();
  const sessionId = admitted.request?.sessionId ?? admitted.sessionId;
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("Webhook did not return a session ID");
  console.log(`Session: ${sessionId}`);
  const sessionUrl = admitted.sessionUrl ?? admitted.request?.sessionUrl;
  if (sessionUrl) console.log(sessionUrl);
  await writeFile(new URL(`.oncall/${service}-latest.json`, root), JSON.stringify({
    sessionId, sessionUrl, eventId, issueUrl, release: incident.release, deploymentId: admitted.request?.deploymentId,
  }) + "\n", { mode: 0o600 });
  await followSession(sessionId, oc);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
