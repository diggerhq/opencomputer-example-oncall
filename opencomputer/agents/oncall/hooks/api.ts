import { useTool } from "@opencomputer/agent";
import { inspectRecord, replayRequest } from "../tools/api.js";

export function useApiDiagnostics() {
  useTool(inspectRecord);
  useTool(replayRequest);
  return "API diagnostics: inspect_record reads report records from the captured incident. replay_request executes the captured GET request against repository/app/api.mjs; passing a reportId checks another captured record. Compare the failing request with a healthy report, then repeat both checks after your correction. Diagnose the API; do not change the worker.";
}
