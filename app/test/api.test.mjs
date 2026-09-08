import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../api.mjs";

const state = {
  reports: [{
    id: "report-monthly",
    title: "Monthly usage",
    timezone: " America/New_York ",
    createdAt: "2026-07-01T01:30:00.000Z",
  }],
};

test("GET returns a report with its timestamp in the configured timezone", async () => {
  const response = await handleRequest(new Request("http://reporting.local/reports/report-monthly"), state);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: "report-monthly",
    title: "Monthly usage",
    timezone: "America/New_York",
    generatedAt: "30 Jun 2026, 21:30",
  });
});

test("unknown reports and unmatched routes return 404", async () => {
  for (const pathname of ["/reports/missing", "/unrelated"]) {
    const response = await handleRequest(new Request(`http://reporting.local${pathname}`), state);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Report not found" });
  }
});

test("report writes are rejected", async () => {
  const response = await handleRequest(new Request("http://reporting.local/reports/report-monthly", { method: "POST" }), state);
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: "Method not allowed" });
});
