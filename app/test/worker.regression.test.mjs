import assert from "node:assert/strict";
import test from "node:test";
import { runWorkerBatch } from "../worker.mjs";

// Derived from the captured incident snapshot (job-101 has rows: null while
// job-102 and job-103 are healthy pending jobs behind it in creation order).
function snapshot() {
  return {
    maxSteps: 4,
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

test("a permanently invalid job fails once and does not starve healthy jobs behind it", () => {
  const state = snapshot();
  const result = runWorkerBatch(state, { maxSteps: state.maxSteps });

  // job-101 is retried exactly once (it's a permanent failure, not transient),
  // then the batch moves on to process the healthy jobs behind it.
  assert.deepEqual(
    result.attempts.map(({ jobId, outcome }) => ({ jobId, outcome })),
    [
      { jobId: "job-101", outcome: "failed" },
      { jobId: "job-102", outcome: "completed" },
      { jobId: "job-103", outcome: "completed" },
    ],
  );

  const jobs = state.jobs.map(({ id, status, attempts }) => ({ id, status, attempts }));
  assert.deepEqual(jobs, [
    { id: "job-101", status: "failed", attempts: 1 },
    { id: "job-102", status: "completed", attempts: 1 },
    { id: "job-103", status: "completed", attempts: 1 },
  ]);

  assert.deepEqual(Object.keys(result.outputs), ["job-102", "job-103"]);
  assert.equal(result.errors.length, 1);
  assert.equal(state.jobs[0].lastError, "Report job rows must be an array");
});
