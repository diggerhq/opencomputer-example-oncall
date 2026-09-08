import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "../opencomputer/agents/oncall/lib/verification.js";
import { checkoutDirectory, repository } from "../opencomputer/agents/oncall/lib/target.js";

const run = promisify(execFile);
const app = fileURLToPath(new URL("../app", import.meta.url));
const regression = `import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../api.mjs";
test("old reports without a timezone remain readable", async () => {
  const response = await handleRequest(new Request("http://reporting.local/reports/old"), {
    reports: [{ id: "old", title: "Old report", timezone: null, createdAt: "2026-06-30T12:00:00Z" }],
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).timezone, "UTC");
});
`;

async function fixture(action: (context: { cwd: string; checkout: string; commit: string; source: string }) => Promise<void>) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "oncall-verifier-test-"));
  const checkout = path.join(cwd, checkoutDirectory);
  try {
    await mkdir(checkout);
    await cp(app, path.join(checkout, "app"), { recursive: true });
    for (const args of [["init", "--quiet"], ["config", "user.name", "Example test"], ["config", "user.email", "example@test.invalid"], ["remote", "add", "origin", `https://github.com/${repository}.git`], ["add", "app"], ["commit", "--quiet", "-m", "original app"]]) {
      await run("git", args, { cwd: checkout });
    }
    const commit = (await run("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const source = await readFile(path.join(checkout, "app/api.mjs"), "utf8");
    await writeFile(path.join(checkout, "app/api.mjs"), source.replace("report.timezone.trim()", '(report.timezone ?? "UTC").trim()'));
    await writeFile(path.join(checkout, "app/test/api.regression.test.mjs"), regression);
    await action({ cwd, checkout, commit, source });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("verifier proves a new regression fails before the exact two-file correction passes", async () => {
  await fixture(async ({ cwd, checkout, commit }) => {
    const result = await verifyWorkspace({ service: "api", commit, cwd });
    assert.equal(result.before.exitCode, 1);
    assert.match(result.before.output, /# fail 1/);
    assert.equal(result.after.exitCode, 0);
    assert.match(result.after.output, /# tests 7/);
    assert.match(result.after.output, /# fail 0/);
    assert.equal(result.before.command, result.after.command);
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0].content, await readFile(path.join(checkout, "app/api.mjs"), "utf8"));
    assert.equal(result.files[1].content, regression);
    assert.match(result.diff, /diff --git a\/app\/api.mjs b\/app\/api.mjs/);
    assert.match(result.diff, /\+test\("old reports/);
    assert.ok(!result.before.output.includes(cwd));
    assert.ok(!result.before.output.includes("/oncall-verify-"));
    assert.ok(!result.diff.includes(cwd));
  });
});

test("unchanged source and edits outside the two-file proposal are rejected", async () => {
  await fixture(async ({ cwd, checkout, commit, source }) => {
    await writeFile(path.join(checkout, "app/api.mjs"), source);
    await assert.rejects(verifyWorkspace({ service: "api", commit, cwd }), /Change exactly/);
    await writeFile(path.join(checkout, "app/api.mjs"), source + "\n");
    await writeFile(path.join(checkout, "unrelated.txt"), "outside the proposed change");
    await assert.rejects(verifyWorkspace({ service: "api", commit, cwd }), /no other/);
  });
});

test("worker verification proves healthy jobs proceed after the failing job is retained", async () => {
  await fixture(async ({ cwd, checkout, commit, source }) => {
    await writeFile(path.join(checkout, "app/api.mjs"), source);
    await rm(path.join(checkout, "app/test/api.regression.test.mjs"));
    const workerPath = path.join(checkout, "app/worker.mjs");
    const worker = await readFile(workerPath, "utf8");
    await writeFile(workerPath, worker.replace("job.lastError = error.message;", 'job.status = "failed";\n      job.lastError = error.message;'));
    await writeFile(path.join(checkout, "app/test/worker.regression.test.mjs"), `import assert from "node:assert/strict";
import test from "node:test";
import { runWorkerBatch } from "../worker.mjs";
test("a malformed report does not starve another job", () => {
  const state = { jobs: [
    { id: "bad", createdAt: "2026-01-01T00:00:00Z", status: "pending", attempts: 0, rows: null },
    { id: "good", createdAt: "2026-01-01T00:01:00Z", status: "pending", attempts: 0, rows: [{ total: 12 }] },
  ] };
  const result = runWorkerBatch(state);
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[1].status, "completed");
  assert.equal(result.outputs.good, "total\\n12\\n");
});
`);
    const result = await verifyWorkspace({ service: "worker", commit, cwd });
    assert.equal(result.before.exitCode, 1);
    assert.equal(result.after.exitCode, 0);
    assert.deepEqual(result.files.map(file => file.path), ["app/worker.mjs", "app/test/worker.regression.test.mjs"]);
  });
});

test("symlink and executable-mode proposals are rejected", async () => {
  await fixture(async ({ cwd, checkout, commit }) => {
    const testPath = path.join(checkout, "app/test/api.regression.test.mjs");
    await rm(testPath);
    await symlink("api.test.mjs", testPath);
    await assert.rejects(verifyWorkspace({ service: "api", commit, cwd }), /symlinks/);
    await rm(testPath);
    await writeFile(testPath, regression);
    await chmod(testPath, 0o755);
    await assert.rejects(verifyWorkspace({ service: "api", commit, cwd }), /nonexecutable/);
  });
});

test("a new test that already passes on the baseline is not accepted as regression evidence", async () => {
  await fixture(async ({ cwd, checkout, commit }) => {
    await writeFile(path.join(checkout, "app/test/api.regression.test.mjs"), 'import test from "node:test"; import assert from "node:assert/strict"; test("unrelated", () => assert.equal(2 + 2, 4));\n');
    await assert.rejects(verifyWorkspace({ service: "api", commit, cwd }), /must fail on the original/);
  });
});

test("commit and origin must match the captured public checkout", async () => {
  await fixture(async ({ cwd, checkout, commit }) => {
    await assert.rejects(verifyWorkspace({ service: "api", commit: "0".repeat(40), cwd }), /HEAD/);
    await run("git", ["remote", "set-url", "origin", "https://example.com/another/repository"], { cwd: checkout });
    await assert.rejects(verifyWorkspace({ service: "api", commit, cwd }), /fixed public/);
  });
});
