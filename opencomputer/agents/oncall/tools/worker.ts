import { defineTool } from "@opencomputer/agent";
import { loadIncident, type WorkerSnapshot } from "../lib/incident.js";
import { replay } from "../lib/replay.js";

export const inspectQueue = defineTool({
  name: "inspect_queue",
  description: "Read the jobs captured with this worker incident: order, status, attempts, and input rows. This is the event-time queue snapshot, not a live queue query.",
  input: { type: "object", properties: {}, additionalProperties: false },
  async run() {
    const snapshot = (await loadIncident("worker")).snapshot as WorkerSnapshot;
    return { captured: true, maxSteps: snapshot.maxSteps, jobs: snapshot.jobs };
  },
});

export const replayWorker = defineTool({
  name: "replay_worker",
  description: "Process the captured queue for its bounded number of steps using the current local worker source in a fresh Node process. Returns actual attempts and final queue state; compare failing and healthy jobs before and after a correction.",
  input: { type: "object", properties: {}, additionalProperties: false },
  async run({ signal }) {
    const snapshot = (await loadIncident("worker")).snapshot as WorkerSnapshot;
    return replay("worker", snapshot, process.cwd(), signal);
  },
});
