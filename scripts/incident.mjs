import { captureIncident } from "../app/incidents.mjs";
import { replayApi, replayWorker } from "../app/replay.mjs";
import { serviceArgument } from "./config.mjs";

try {
  const incident = await captureIncident(serviceArgument());
  const result = incident.service === "api"
    ? await replayApi(incident.snapshot) : replayWorker(incident.snapshot);
  console.log(`${incident.service}: ${incident.error.name}: ${incident.error.message}`);
  if (incident.service === "api") {
    console.log(`${result.request.method} ${result.request.path} → ${result.response.status}`);
    const healthy = structuredClone(incident.snapshot);
    healthy.request.path = "/reports/report-current";
    const control = await replayApi(healthy);
    console.log(`${control.request.method} ${control.request.path} → ${control.response.status}`);
  } else {
    for (const attempt of result.attempts) console.log(`attempt ${attempt.step}: ${attempt.jobId} → ${attempt.outcome}`);
    for (const job of result.jobs) console.log(`${job.id}: ${job.status}, ${job.attempts} attempts`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
