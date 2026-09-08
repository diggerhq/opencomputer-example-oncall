import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { captureIncident } from "../app/incidents.mjs";
import { captureSentryIncident } from "./sentry.mjs";
import { root, sentryConfig, opencomputerConfig, serviceArgument, sourceCommit } from "./config.mjs";
import { followSession } from "./session.mjs";

/**
 * Wait for Sentry's alert to reach the deployed agent. The webhook's request
 * ledger is the only place that shows it: a request created after the
 * incident whose session id has been announced.
 */
async function awaitDelivery(oc, webhook, since, { timeoutMs = 180_000, intervalMs = 5_000 } = {}) {
  const url = `${oc.origin}/api/managed-agents/projects/${encodeURIComponent(webhook.projectId)}/webhooks/${encodeURIComponent(webhook.id)}/requests?environment=development`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(url, { headers: { "x-api-key": oc.apiKey }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    if (response?.ok) {
      const { requests = [] } = await response.json();
      const delivered = requests
        .filter((request) => request.createdAt >= since && typeof request.sessionId === "string")
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      if (delivered) return delivered;
    }
    await sleep(intervalMs);
  }
  return undefined;
}

try {
  const service = serviceArgument();
  const follow = process.argv.includes("--follow");
  const commit = await sourceCommit();
  const sentry = sentryConfig();
  const oc = await opencomputerConfig();
  const webhook = JSON.parse(await readFile(new URL(".opencomputer/webhook.json", root), "utf8"));
  if (webhook.projectId !== oc.projectId || webhook.environment !== "development" || webhook.agentId !== "oncall" || !webhook.id) {
    throw new Error("Run npm run setup to configure this project's Development webhook");
  }
  const since = new Date().toISOString();
  const incident = { ...await captureIncident(service), commit };
  console.log(`Laptop: ${service}: ${incident.error.name}: ${incident.error.message}`);
  console.log("Laptop: recording the exception and captured state in Sentry…");
  const { eventId, issueUrl } = await captureSentryIncident(incident, sentry);
  console.log(`Sentry: ${issueUrl}`);
  console.log("Sentry → OpenComputer: waiting for the issue alert to reach the deployed agent…");
  const delivered = await awaitDelivery(oc, webhook, since);
  if (!delivered) {
    throw new Error(
      "No delivery reached the agent within three minutes. Check the Sentry alert rule and the integration's webhook URL (see README, Setup), " +
      "then look at the webhook's request ledger in the dashboard.",
    );
  }
  const sessionId = delivered.sessionId;
  const sessionUrl = `${oc.origin}/projects/${encodeURIComponent(oc.projectId)}/sessions/${sessionId}?agent=oncall&environment=development`;
  await mkdir(new URL(".oncall/", root), { recursive: true });
  await writeFile(new URL(`.oncall/${service}-latest.json`, root), JSON.stringify({
    service, sessionId, sessionUrl, eventId, issueUrl, release: incident.release, commit,
    requestId: delivered.id, deploymentId: delivered.deploymentId,
  }) + "\n", { mode: 0o600 });
  console.log(`\nSentry delivered the alert; OpenComputer accepted session ${sessionId}.`);
  console.log("The agent now runs in its cloud workspace. The laptop's work is finished.");
  console.log(`OpenComputer session: ${sessionUrl}`);
  if (follow) {
    console.log("\nFollowing OpenComputer events; closing this terminal does not stop the cloud session.");
    await followSession(sessionId, oc);
  } else {
    console.log(`Watch the agent: npx opencomputer session attach ${sessionId}`);
    console.log(`Inspect recorded tool results: npx opencomputer sessions tail ${sessionId} --json`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
