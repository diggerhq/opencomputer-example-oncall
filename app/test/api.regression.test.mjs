import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../api.mjs";

// Derived from the captured incident snapshot (report-legacy has no
// timezone). GET /reports/report-legacy crashed with
// "Cannot read properties of null (reading 'trim')" because api.mjs called
// report.timezone.trim() without checking for null.
const state = {
  reports: [
    {
      id: "report-legacy",
      title: "June usage",
      timezone: null,
      createdAt: "2026-06-30T12:00:00.000Z",
    },
    {
      id: "report-current",
      title: "August usage",
      timezone: "Europe/London",
      createdAt: "2026-08-31T12:00:00.000Z",
    },
  ],
};

test("GET falls back to UTC for a legacy report with no timezone", async () => {
  const response = await handleRequest(new Request("http://reporting.local/reports/report-legacy"), state);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: "report-legacy",
    title: "June usage",
    timezone: "UTC",
    generatedAt: "30 Jun 2026, 12:00",
  });
});

test("GET still honors an explicit timezone for a healthy report", async () => {
  const response = await handleRequest(new Request("http://reporting.local/reports/report-current"), state);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: "report-current",
    title: "August usage",
    timezone: "Europe/London",
    generatedAt: "31 Aug 2026, 13:00",
  });
});
