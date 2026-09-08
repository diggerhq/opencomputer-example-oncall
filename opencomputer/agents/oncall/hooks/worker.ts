import { useTool } from "@opencomputer/agent";
import { inspectQueue, replayWorker } from "../tools/worker.js";

export function useWorkerDiagnostics() {
  useTool(inspectQueue);
  useTool(replayWorker);
  return "Worker diagnostics: inspect_queue reads the captured jobs and their state. replay_worker executes bounded queue processing against repository/app/worker.mjs. Inspect the attempts and final job states before and after your correction; account for both the failing job and healthy jobs. Diagnose the worker; do not change the API.";
}
