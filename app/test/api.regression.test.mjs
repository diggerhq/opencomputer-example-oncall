import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../api.mjs";

// Derived from the Sentry incident: report-legacy has timezone: null,
// which crashed handleRequest with
// "TypeError: Cannot read properties of null (reading 'trim')".
const state = {
  reports: [{
    id: "report-legacy",
    title: "June usage",
    timezone: null,
    createdAt: "2026-06-30T12:00:00.000Z",
  }],
};

test("GET on a legacy report with no timezone defaults to UTC instead of crashing", async () => {
  const response = await handleRequest(new Request("http://reporting.local/reports/report-legacy"), state);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: "report-legacy",
    title: "June usage",
    timezone: "UTC",
    generatedAt: "30 Jun 2026, 12:00",
  });
});
