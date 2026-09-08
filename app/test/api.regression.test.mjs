import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../api.mjs";

// Derived from the captured incident: a report with a null timezone
// (e.g. created before timezone tracking existed) must not crash the
// request handler; it should fall back to a default timezone instead.
const state = {
  reports: [
    {
      id: "report-legacy",
      title: "June usage",
      timezone: null,
      createdAt: "2026-06-30T12:00:00.000Z",
    },
  ],
};

test("GET report with a null timezone falls back to a default instead of crashing", async () => {
  const response = await handleRequest(
    new Request("http://reporting.local/reports/report-legacy"),
    state,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, "report-legacy");
  assert.equal(body.title, "June usage");
  assert.equal(typeof body.timezone, "string");
  assert.ok(body.timezone.length > 0);
  assert.equal(typeof body.generatedAt, "string");
  assert.ok(body.generatedAt.length > 0);
});
