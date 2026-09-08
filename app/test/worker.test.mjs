import assert from "node:assert/strict";
import test from "node:test";
import { runWorkerBatch } from "../worker.mjs";

function job(id, createdAt, rows = [{ account: "Example", total: 10 }]) {
  return { id, createdAt, status: "pending", attempts: 0, reportId: `report-${id}`, rows };
}

test("a bounded batch processes healthy jobs in creation order", () => {
  const state = { jobs: [
    job("third", "2026-09-08T09:02:00Z"),
    job("first", "2026-09-08T09:00:00Z"),
    job("second", "2026-09-08T09:01:00Z"),
  ] };
  const result = runWorkerBatch(state, { maxSteps: 2 });
  assert.deepEqual(result.attempts.map(({ jobId }) => jobId), ["first", "second"]);
  assert.deepEqual(state.jobs.map(({ id, status, attempts }) => ({ id, status, attempts })), [
    { id: "third", status: "pending", attempts: 0 },
    { id: "first", status: "completed", attempts: 1 },
    { id: "second", status: "completed", attempts: 1 },
  ]);
  assert.deepEqual(Object.keys(result.outputs), ["first", "second"]);
  assert.deepEqual(result.errors, []);
});

test("CSV output preserves commas, quotes, and embedded newlines", () => {
  const state = { jobs: [job("export", "2026-09-08T09:00:00Z", [
    { account: 'Example, "North"', total: 120 },
    { account: "Example\nSouth", total: 75 },
  ])] };
  const result = runWorkerBatch(state);
  assert.equal(result.outputs.export, 'account,total\n"Example, ""North""",120\n"Example\nSouth",75\n');
  assert.equal(state.jobs[0].status, "completed");
  assert.deepEqual(result.errors, []);
});

test("completed jobs are not repeated when another batch runs", () => {
  const state = { jobs: [job("daily", "2026-09-08T09:00:00Z")] };
  runWorkerBatch(state);
  const result = runWorkerBatch(state, { maxSteps: 8 });
  assert.deepEqual(result, { attempts: [], outputs: {}, errors: [] });
  assert.equal(state.jobs[0].attempts, 1);
});
