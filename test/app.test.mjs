import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { handleRequest } from "../app/api.mjs";
import { captureIncident, createApiSnapshot, createWorkerSnapshot, RELEASE } from "../app/incidents.mjs";
import { replayApi, replayWorker } from "../app/replay.mjs";

const appDirectory = fileURLToPath(new URL("../app", import.meta.url));

function replayProcess(directory, service, snapshot) {
  return spawnSync(process.execPath, [join(directory, "replay.mjs"), service], {
    input: JSON.stringify(snapshot), encoding: "utf8", timeout: 5000,
  });
}

test("the real API handler throws for a legacy record but serves a healthy record", async () => {
  const snapshot = createApiSnapshot();
  await assert.rejects(handleRequest(new Request("http://reporting.local/reports/report-legacy"), snapshot), TypeError);
  const response = await handleRequest(new Request("http://reporting.local/reports/report-current"), snapshot);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.timezone, "Europe/London");
  assert.match(body.generatedAt, /31 Aug 2026/);
});

test("API replay records the real failure and leaves its snapshot unchanged", async () => {
  const snapshot = createApiSnapshot();
  const before = structuredClone(snapshot);
  const result = await replayApi(snapshot);
  assert.equal(result.response.status, 500);
  assert.equal(result.error.name, "TypeError");
  assert.match(result.error.stack, /api\.mjs/);
  assert.deepEqual(snapshot, before);
});

test("the oldest malformed worker job starves both healthy jobs within a strict bound", () => {
  const snapshot = createWorkerSnapshot();
  const before = structuredClone(snapshot);
  const result = replayWorker(snapshot);
  assert.equal(result.attempts.length, 4);
  assert.deepEqual(result.attempts.map((item) => item.jobId), ["job-101", "job-101", "job-101", "job-101"]);
  assert.deepEqual(result.jobs.map((job) => job.attempts), [4, 0, 0]);
  assert.deepEqual(result.outputs, {});
  assert.deepEqual(snapshot, before);
  assert.throws(() => replayWorker({ ...snapshot, maxSteps: 100000 }), /between 1 and 8/);
});

test("healthy worker jobs produce CSV when the malformed job is absent", () => {
  const snapshot = createWorkerSnapshot();
  snapshot.jobs.shift();
  const result = replayWorker(snapshot);
  assert.deepEqual(result.jobs.map((job) => job.status), ["completed", "completed"]);
  assert.equal(result.outputs["job-102"], "account,total\nExample North,120\n");
  assert.equal(result.outputs["job-103"], "account,total\nExample South,75\n");
});

test("incident capture supplies real errors and bounded synthetic snapshots", async () => {
  for (const service of ["api", "worker"]) {
    const incident = await captureIncident(service);
    assert.equal(incident.service, service);
    assert.equal(incident.release, RELEASE);
    assert.ok(incident.error instanceof Error);
    assert.match(incident.error.stack, new RegExp(`${service}\\.mjs`));
    assert.ok(incident.breadcrumbs.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(incident.snapshot)) < 4096);
  }
});

test("fresh-process replay executes source changes in a disposable app copy", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "oncall-app-test-"));
  const copiedApp = join(temporary, "app");
  try {
    await cp(appDirectory, copiedApp, { recursive: true });
    const originalApi = replayProcess(copiedApp, "api", createApiSnapshot());
    assert.equal(originalApi.status, 0, originalApi.stderr);
    assert.equal(JSON.parse(originalApi.stdout).response.status, 500);

    const apiPath = join(copiedApp, "api.mjs");
    const apiSource = await readFile(apiPath, "utf8");
    assert.ok(apiSource.includes("report.timezone.trim()"));
    await writeFile(apiPath, apiSource.replace("report.timezone.trim()", '(report.timezone ?? "UTC").trim()'));
    const patchedApi = replayProcess(copiedApp, "api", createApiSnapshot());
    assert.equal(patchedApi.status, 0, patchedApi.stderr);
    assert.equal(JSON.parse(patchedApi.stdout).response.status, 200);
    assert.equal(JSON.parse(patchedApi.stdout).response.body.timezone, "UTC");

    const workerPath = join(copiedApp, "worker.mjs");
    const workerSource = await readFile(workerPath, "utf8");
    assert.ok(workerSource.includes("job.lastError = error.message;"));
    await writeFile(workerPath, workerSource.replace("job.lastError = error.message;", 'job.lastError = error.message;\n      job.status = "failed";'));
    const patchedWorker = replayProcess(copiedApp, "worker", createWorkerSnapshot());
    assert.equal(patchedWorker.status, 0, patchedWorker.stderr);
    const result = JSON.parse(patchedWorker.stdout);
    assert.deepEqual(result.jobs.map((job) => job.status), ["failed", "completed", "completed"]);
    assert.equal(result.attempts.length, 3);
    assert.equal(Object.keys(result.outputs).length, 2);
    assert.equal(replayWorker(createWorkerSnapshot()).jobs[0].status, "pending");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("replay CLI rejects malformed input and unbounded worker requests", () => {
  const badVersion = replayProcess(appDirectory, "api", { version: 2 });
  assert.equal(badVersion.status, 1);
  assert.match(badVersion.stderr, /version 1/);
  const badBound = replayProcess(appDirectory, "worker", { ...createWorkerSnapshot(), maxSteps: 1000 });
  assert.equal(badBound.status, 1);
  assert.match(badBound.stderr, /between 1 and 8/);
});
