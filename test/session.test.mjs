import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { formatToolOutput, followSession } from "../scripts/session.mjs";

const textOutput = (value) => [{ type: "text", text: JSON.stringify(value) }];

test("renders public tool text arrays and nested publication evidence as readable lines", () => {
  const result = {
    publication: { url: "https://github.com/example/reports/pull/12", branch: "fix/report-timezone" },
    diff: "--- a/app/api.mjs\n+++ b/app/api.mjs\n-old line\n+new line",
    before: { command: "node --test", exitCode: 1, output: "TAP version 13\nnot ok 1 - legacy report" },
    after: { command: "node --test", exitCode: 0, output: "TAP version 13\nok 1 - legacy report" },
  };
  const output = formatToolOutput(textOutput(result));
  assert.match(output, /publication:\n  url: https:\/\/github.com\/example\/reports\/pull\/12/);
  assert.match(output, /diff:\n  --- a\/app\/api.mjs\n  \+\+\+ b\/app\/api.mjs/);
  assert.match(output, /before:\n  command: node --test\n  exitCode: 1\n  output:\n    TAP version 13\n    not ok 1/);
  assert.match(output, /after:\n  command: node --test\n  exitCode: 0\n  output:\n    TAP version 13\n    ok 1/);
  assert.ok(!output.includes('\\n'));
  assert.equal(formatToolOutput([
    { type: "text", text: "Cloning into 'reports'...\nReceiving objects: 100%" },
    { type: "text", text: "Exit status: 0" },
  ]), "Cloning into 'reports'...\nReceiving objects: 100%\nExit status: 0");
});

test("keeps publication metadata visible before bounded logs and removes terminal escapes and VM prefixes", () => {
  const output = formatToolOutput(textOutput({
    publication: { url: "https://github.com/example/reports/pull/12" },
    diff: Array.from({ length: 150 }, (_, index) => `line ${index}`).join("\n"),
  }));
  assert.ok(output.includes("https://github.com/example/reports/pull/12"));
  assert.ok(output.includes("output shortened"));
  assert.ok(!output.includes("line 100"));
  assert.ok(output.split("\n").length <= 101);
  assert.ok(formatToolOutput("x".repeat(9000)).length < 8100);
  assert.equal(formatToolOutput("\u001b[31mfile:///blue/sessions/pool-abc123/workspace/reports/app/api.mjs:5\u001b[0m"),
    "<workspace>/reports/app/api.mjs:5");
  assert.equal(formatToolOutput("/blue/sessions/pool-def/workspace/app/worker.mjs\n/workspace/app/api.mjs"),
    "<workspace>/app/worker.mjs\n<workspace>/app/api.mjs");
});

test("following displays normalized tool results but preserves the original events in JSONL", async (t) => {
  const sessionId = `test-follow-${randomUUID()}`;
  const log = new URL(`../.oncall/${sessionId}.jsonl`, import.meta.url);
  const events = [
    { seq: 1, type: "tool.started", data: { tool: "shell", input: { command: "node --test" } } },
    { seq: 2, type: "tool.completed", data: { tool: "shell", output: [
      { type: "text", text: "TAP version 13\nok 1 - report\n/blue/sessions/pool-abc/workspace/app/api.mjs" },
    ] } },
    { seq: 3, type: "turn.completed", data: {} },
  ];
  const original = JSON.stringify(events);
  const printed = [];
  const requests = [];
  t.mock.method(console, "log", (...args) => printed.push(args.join(" ")));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, method: options.method ?? "GET" });
    return new Response(JSON.stringify({ events }));
  });
  try {
    await followSession(sessionId, { origin: "https://example.invalid", apiKey: "test-only" });
    const display = printed.join("\n");
    assert.match(display, /OpenComputer │ command: node --test/);
    assert.match(display, /OpenComputer │ TAP version 13\nOpenComputer │ ok 1 - report/);
    assert.ok(display.includes("<workspace>/app/api.mjs"));
    assert.ok(!display.includes("/blue/sessions/"));
    assert.equal(JSON.stringify(events), original);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").map(JSON.parse), events);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].url.endsWith("/suspend"));
    assert.equal(requests[1].method, "POST");
  } finally {
    await rm(log, { force: true });
  }
});
