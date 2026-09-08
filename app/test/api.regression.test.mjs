import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../api.mjs";

// Derived from the captured incident: report-legacy has timezone: null,
// while report-current has a normal timezone string. GET /reports/report-legacy
// previously threw TypeError: Cannot read properties of null (reading 'trim').
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

test("GET report with a missing timezone falls back instead of throwing", async () => {
  const response = await handleRequest(new Request("http://reporting.local/reports/report-legacy"), state);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, "report-legacy");
  assert.equal(body.title, "June usage");
  assert.equal(typeof body.timezone, "string");
  assert.ok(body.timezone.length > 0);
  assert.equal(typeof body.generatedAt, "string");
  assert.ok(body.generatedAt.length > 0);
});

test("GET report with a normal timezone still trims and formats correctly", async () => {
  const response = await handleRequest(new Request("http://reporting.local/reports/report-current"), state);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: "report-current",
    title: "August usage",
    timezone: "Europe/London",
    generatedAt: "31 Aug 2026, 13:00",
  });
});
