import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { ToolDefinition, ToolExecutionContext } from "@opencomputer/agent";
import { normalizeSentryEvent, normalizeSnapshot, parseLocator, saveIncident, type ApiSnapshot, type WorkerSnapshot, type Locator } from "../opencomputer/agents/oncall/lib/incident.js";
import { requireCheckout } from "../opencomputer/agents/oncall/lib/checkout.js";
import { repository } from "../opencomputer/agents/oncall/lib/target.js";
import { inspectRecord, replayRequest } from "../opencomputer/agents/oncall/tools/api.js";
import { inspectQueue, replayWorker } from "../opencomputer/agents/oncall/tools/worker.js";
import { readSentryEvent } from "../opencomputer/agents/oncall/tools/sentry.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureModule = new URL("../app/fixtures.mjs", import.meta.url).href;
const fixtures = await import(fixtureModule);
const locator: Locator = { service: "api", organization: "example", project: "reporting", eventId: "a".repeat(32), release: fixtures.RELEASE, commit: "c".repeat(40) };
const apiSnapshot = (): ApiSnapshot => fixtures.createApiSnapshot();
const workerSnapshot = (): WorkerSnapshot => fixtures.createWorkerSnapshot();
const event = (input = locator, snapshot: ApiSnapshot | WorkerSnapshot = apiSnapshot()) => ({
  eventID: input.eventId, release: { version: input.release }, title: "Captured fixture error",
  contexts: { oncall: { service: input.service, release: input.release, commit: input.commit, snapshot } },
  entries: [],
});
const context = (input: Record<string, unknown> = {}): ToolExecutionContext => ({
  input, sessionId: "test-session", messageId: "test-message", agentId: "oncall", async reportProgress() {},
});
async function invoke(tool: ToolDefinition, input: Record<string, unknown> = {}) {
  return await tool.run(context(input)) as any;
}

async function withWorkspace(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "oncall-tools-"));
  const previous = process.cwd();
  const previousCommit = locator.commit;
  try {
    const checkout = path.join(cwd, "repository");
    await cp(path.join(root, "app"), path.join(checkout, "app"), { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
    git(["init", "-q"]);
    git(["remote", "add", "origin", `https://github.com/${repository}.git`]);
    git(["add", "app"]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture source"]);
    locator.commit = git(["rev-parse", "HEAD"]);
    process.chdir(cwd);
    await run(cwd);
  } finally { locator.commit = previousCommit; process.chdir(previous); await rm(cwd, { recursive: true, force: true }); }
}

test("Sentry normalization requires the exact event, service, and source release", () => {
  assert.deepEqual(normalizeSentryEvent(locator, event()), { ...locator, snapshot: apiSnapshot(), issueUrl: `https://sentry.io/organizations/example/issues/?query=${locator.eventId}` });
  assert.throws(() => normalizeSentryEvent(locator, { ...event(), eventID: "b".repeat(32) }), /different event/);
  assert.throws(() => normalizeSentryEvent(locator, event({ ...locator, release: "another-release" })), /release/);
  assert.throws(() => normalizeSentryEvent(locator, event({ ...locator, commit: "d".repeat(40) })), /commit/);
  assert.throws(() => normalizeSentryEvent(locator, event({ ...locator, service: "worker" }, workerSnapshot())), /service/);
  assert.throws(() => parseLocator({ ...locator, organization: "../example" }), /slugs/);
});

test("captured state is bounded and excludes unrelated event fields", () => {
  const input = apiSnapshot();
  assert.deepEqual(normalizeSnapshot("api", { ...input, unrelated: "discarded" }), input);
  assert.throws(() => normalizeSnapshot("api", { ...input, reports: Array(11).fill(input.reports[0]) }), /at most 10/);
  assert.throws(() => normalizeSnapshot("api", { ...input, request: { method: "POST", path: "/reports/report-legacy" } }), /GET/);
  assert.throws(() => normalizeSnapshot("worker", { ...workerSnapshot(), maxSteps: 999 }), /bounds/);
  assert.throws(() => normalizeSnapshot("worker", { ...workerSnapshot(), maxSteps: 0 }), /positive/);
  assert.throws(() => normalizeSnapshot("api", { ...input, padding: "x".repeat(65537) }), /64 KiB/);
});

test("source release mismatch stops before inspection can use unrelated source", async () => {
  await withWorkspace(async () => {
    await requireCheckout(locator);
    await assert.rejects(requireCheckout({ ...locator, release: "another-release" }), /checked-out application source/);
    await assert.rejects(requireCheckout({ ...locator, commit: "d".repeat(40) }), /exact Git commit/);
  });
});

test("the Sentry tool uses managed GET egress and clears stale state when a new read fails", async () => {
  await withWorkspace(async cwd => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.OPENCOMPUTER_CONNECTIONS_URL;
    const originalToken = process.env.OPENCOMPUTER_CONNECTION_TOKEN;
    process.env.OPENCOMPUTER_CONNECTIONS_URL = "http://test-proxy.invalid/connections";
    process.env.OPENCOMPUTER_CONNECTION_TOKEN = "test-runtime-token";
    try {
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), "http://test-proxy.invalid/connections/sentry/fetch");
        assert.deepEqual(JSON.parse(String(init?.body)), { method: "GET", path: `/api/0/projects/example/reporting/events/${locator.eventId}/`, headers: {} });
        return Response.json(event());
      };
      const result = await invoke(readSentryEvent, locator);
      assert.equal(result.eventId, locator.eventId);
      assert.deepEqual(JSON.parse(await readFile(path.join(cwd, ".oncall/incident.json"), "utf8")).snapshot, apiSnapshot());
      globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
      await assert.rejects(invoke(readSentryEvent, locator), /HTTP 401/);
      await assert.rejects(invoke(inspectRecord), /ENOENT/);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.OPENCOMPUTER_CONNECTIONS_URL; else process.env.OPENCOMPUTER_CONNECTIONS_URL = originalUrl;
      if (originalToken === undefined) delete process.env.OPENCOMPUTER_CONNECTION_TOKEN; else process.env.OPENCOMPUTER_CONNECTION_TOKEN = originalToken;
    }
  });
});

test("API replay sees source edits in a fresh process and preserves a healthy control", async () => {
  await withWorkspace(async cwd => {
    await saveIncident({ ...locator, snapshot: apiSnapshot() });
    const record = await invoke(inspectRecord, { reportId: "report-legacy" });
    assert.equal(record.report.timezone, null);
    assert.equal((await invoke(replayRequest)).response.status, 500);
    assert.equal((await invoke(replayRequest, { reportId: "report-current" })).response.status, 200);
    const sourcePath = path.join(cwd, "repository/app/api.mjs");
    const original = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, original.replace("report.timezone.trim()", '(report.timezone ?? "UTC").trim()'));
    assert.equal((await invoke(replayRequest)).response.status, 200);
    const healthy = await invoke(replayRequest, { reportId: "report-current" });
    assert.equal(healthy.response.status, 200);
    assert.equal(healthy.response.body.timezone, "Europe/London");
    await assert.rejects(invoke(inspectQueue), /not for the worker service/);
  });
});

test("worker replay executes current source, retains the bad job, and makes progress on healthy jobs", async () => {
  await withWorkspace(async cwd => {
    await saveIncident({ ...locator, service: "worker", snapshot: workerSnapshot() });
    assert.equal((await invoke(inspectQueue)).jobs.length, 3);
    const before = await invoke(replayWorker);
    assert.deepEqual(before.attempts.map((attempt: { jobId: string }) => attempt.jobId), Array(4).fill("job-101"));
    const sourcePath = path.join(cwd, "repository/app/worker.mjs");
    const original = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, original.replace("job.lastError = error.message;", 'job.status = "failed";\n      job.lastError = error.message;'));
    const after = await invoke(replayWorker);
    assert.deepEqual(after.jobs.map((job: { status: string }) => job.status), ["failed", "completed", "completed"]);
    assert.match(after.outputs["job-102"], /Example North,120/);
    assert.match(after.outputs["job-103"], /Example South,75/);
    assert.equal(after.errors.length, 1);
    await assert.rejects(invoke(inspectRecord), /not for the api service/);
  });
});
