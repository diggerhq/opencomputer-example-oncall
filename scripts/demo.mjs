import { readFile, mkdir, writeFile } from "node:fs/promises";
import { captureIncident } from "../app/incidents.mjs";
import { captureSentryIncident } from "./sentry.mjs";
import { root, sentryConfig, opencomputerConfig, serviceArgument, sourceCommit } from "./config.mjs";
import { followSession } from "./session.mjs";

try {
  const service = serviceArgument();
  const follow = process.argv.includes("--follow");
  const commit = await sourceCommit();
  const sentry = sentryConfig();
  const oc = await opencomputerConfig();
  const webhook = JSON.parse(await readFile(new URL(".opencomputer/webhook.json", root), "utf8"));
  if (webhook.projectId !== oc.projectId || webhook.environment !== "development" || webhook.agentId !== "oncall" ||
      new URL(webhook.url).origin !== oc.origin || !new URL(webhook.url).pathname.startsWith("/api/agent-webhooks/") || !webhook.token) {
    throw new Error("Run npm run setup to configure this project's Development webhook");
  }
  const incident = { ...await captureIncident(service), commit };
  console.log(`Laptop: ${service}: ${incident.error.name}: ${incident.error.message}`);
  console.log("Laptop: recording the exception and captured state in Sentry…");
  const { eventId, issueUrl } = await captureSentryIncident(incident, sentry);
  console.log(`Sentry: ${issueUrl}`);
  const body = {
    text: service === "api" ? "A customer's report request is failing. Investigate, verify a correction, and open a pull request."
      : "Reports have stopped completing. Investigate, verify a correction, and open a pull request.",
    payload: { service, organization: sentry.organization, project: sentry.project, eventId, release: incident.release, commit },
  };
  await mkdir(new URL(".oncall/", root), { recursive: true });
  // Preserve the delivery for an exact retry without generating another incident.
  await writeFile(new URL(`.oncall/${eventId}-delivery.json`, root), JSON.stringify(body) + "\n", { mode: 0o600 });
  console.log("Laptop → OpenComputer: dispatching the incident…");
  const response = await fetch(webhook.url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${webhook.token}`, "Content-Type": "application/json", "Idempotency-Key": `sentry:${eventId}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenComputer webhook returned HTTP ${response.status}`);
  const admitted = await response.json();
  const sessionId = admitted.request?.sessionId ?? admitted.sessionId;
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("Webhook did not return a session ID");
  const sessionUrl = admitted.sessionUrl ?? admitted.request?.sessionUrl ??
    `${oc.origin}/projects/${encodeURIComponent(oc.projectId)}/sessions/${sessionId}?agent=oncall&environment=development`;
  await writeFile(new URL(`.oncall/${service}-latest.json`, root), JSON.stringify({
    service, sessionId, sessionUrl, eventId, issueUrl, release: incident.release, commit,
    deploymentId: admitted.request?.deploymentId,
  }) + "\n", { mode: 0o600 });
  console.log(`\nOpenComputer accepted session ${sessionId}.`);
  console.log("The agent now runs in its cloud workspace. The laptop's work is finished.");
  console.log(`OpenComputer session: ${sessionUrl}`);
  console.log("Open Events to inspect the agent's commands and results.");
  if (follow) {
    console.log("\nFollowing OpenComputer events; closing this terminal does not stop the cloud session.");
    await followSession(sessionId, oc);
  } else {
    console.log(`Optional terminal view: npm run follow -- ${service}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
