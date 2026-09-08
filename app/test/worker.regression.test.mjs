import assert from "node:assert/strict";
import test from "node:test";
import { runWorkerBatch } from "../worker.mjs";

// Derived from Sentry incident 6f1192b4206f4cf5ace82c733d24537f: job-101 has
// malformed rows (null) and sorts first by createdAt. Two healthy jobs,
// job-102 and job-103, are queued right behind it.
function snapshot() {
  return {
    jobs: [
      {
        id: "job-101",
        createdAt: "2026-09-08T09:00:00.000Z",
        status: "pending",
        attempts: 0,
        reportId: "report-101",
        rows: null,
      },
      {
        id: "job-102",
        createdAt: "2026-09-08T09:01:00.000Z",
        status: "pending",
        attempts: 0,
        reportId: "report-102",
        rows: [{ account: "Example North", total: 120 }],
      },
      {
        id: "job-103",
        createdAt: "2026-09-08T09:02:00.000Z",
        status: "pending",
        attempts: 0,
        reportId: "report-103",
        rows: [{ account: "Example South", total: 75 }],
      },
    ],
  };
}

test("a permanently malformed job does not starve healthy jobs behind it", () => {
  const state = snapshot();
  const result = runWorkerBatch(state, { maxSteps: 4 });

  // The bad job fails once, is marked failed (not retried forever), and the
  // two healthy jobs behind it are attempted and completed within the batch.
  assert.deepEqual(result.attempts.map(({ jobId, outcome }) => ({ jobId, outcome })), [
    { jobId: "job-101", outcome: "failed" },
    { jobId: "job-102", outcome: "completed" },
    { jobId: "job-103", outcome: "completed" },
  ]);

  assert.deepEqual(state.jobs.map(({ id, status, attempts }) => ({ id, status, attempts })), [
    { id: "job-101", status: "failed", attempts: 1 },
    { id: "job-102", status: "completed", attempts: 1 },
    { id: "job-103", status: "completed", attempts: 1 },
  ]);

  assert.equal(state.jobs[0].lastError, "Report job rows must be an array");
  assert.equal(result.outputs["job-102"], "account,total\nExample North,120\n");
  assert.equal(result.outputs["job-103"], "account,total\nExample South,75\n");
  assert.equal(result.errors.length, 1);
});
