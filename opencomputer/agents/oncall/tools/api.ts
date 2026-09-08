import { defineTool, type DataValue } from "@opencomputer/agent";
import { loadIncident, type ApiSnapshot } from "../lib/incident.js";
import { replay } from "../lib/replay.js";

export const inspectRecord = defineTool({
  name: "inspect_record",
  description: "Read the report records captured with this API incident. With a reportId, return that record; without one, return the captured request and available records. This is an event-time snapshot, not a live database read.",
  input: { type: "object", properties: { reportId: { type: "string" } }, additionalProperties: false },
  async run({ input }): Promise<DataValue> {
    const snapshot = (await loadIncident("api")).snapshot as ApiSnapshot;
    if (input.reportId !== undefined) {
      const report = snapshot.reports.find(report => report.id === input.reportId);
      if (!report) throw new Error("The requested report is not present in the captured state");
      return { captured: true, report };
    }
    return { captured: true, request: snapshot.request, reports: snapshot.reports };
  },
});

export const replayRequest = defineTool({
  name: "replay_request",
  description: "Run the captured request against the current local application source in a fresh Node process. Optionally choose another captured reportId to check healthy behavior. Returns actual response or exception evidence; an application error is evidence, not a tool failure.",
  input: { type: "object", properties: { reportId: { type: "string" } }, additionalProperties: false },
  async run({ input, signal }) {
    const snapshot = (await loadIncident("api")).snapshot as ApiSnapshot;
    if (input.reportId !== undefined) {
      const report = snapshot.reports.find(report => report.id === input.reportId);
      if (!report || !/^[a-zA-Z0-9_-]+$/.test(report.id)) throw new Error("Choose a reportId present in the captured state");
      snapshot.request.path = `/reports/${report.id}`;
    }
    return replay("api", snapshot, process.cwd(), signal);
  },
});
