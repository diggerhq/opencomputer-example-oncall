import assert from "node:assert/strict";
import test from "node:test";
import type { AgentInput, ModelSelection, ResourceReference } from "@opencomputer/agent";
import Agent from "../opencomputer/agents/oncall/agent.js";

const locator = { organization: "example", project: "reporting", eventId: "a".repeat(32), release: "oncall-reporting@test", commit: "c".repeat(40) };
const common = ["glob", "grep", "read", "read_sentry_event", "open_fix_pull_request", "shell", "write"];

// The published package has no render-test API. This test-only bridge records
// actual useInput/useTool calls; live provider-request filtering is tested separately.
function render(input: AgentInput) {
  const runtime = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const key = Symbol.for("opencomputer.agent-hooks");
  const previous = runtime[key];
  const tools = new Set<string>();
  let model: ModelSelection | undefined;
  runtime[key] = {
    useInput: () => input,
    useModel: (selection: ModelSelection) => { model = selection; },
    useTool: (tool: string | ResourceReference) => { tools.add(typeof tool === "string" ? tool : tool.id); },
  };
  try { return { instructions: Agent(), tools: [...tools].sort(), model }; }
  finally {
    if (previous === undefined) delete runtime[key];
    else runtime[key] = previous;
  }
}

test("the API hook selects API diagnostics and shared source tools", () => {
  const result = render({ source: "user", payload: { ...locator, service: "api" } });
  assert.deepEqual(result.tools, [...common, "inspect_record", "replay_request"].sort());
  assert.equal(result.model, "anthropic/claude-sonnet-5");
  assert.match(result.instructions, /API diagnostics/);
  assert.doesNotMatch(result.instructions, /Worker diagnostics/);
});

test("the worker hook selects worker diagnostics without the API tools", () => {
  const result = render({
    source: "webhook", webhook: { id: "wh_test", requestId: "request_test", receivedAt: "2026-09-08T10:00:00Z" },
    payload: { ...locator, service: "worker" },
  });
  assert.deepEqual(result.tools, [...common, "inspect_queue", "replay_worker"].sort());
  assert.match(result.instructions, /Worker diagnostics/);
  assert.doesNotMatch(result.instructions, /API diagnostics/);
});

test("invalid or missing locator fails closed even if message text names a service", () => {
  for (const payload of [undefined, {}, { ...locator }, { ...locator, service: "database" }, { ...locator, service: "api", eventId: "latest" }, { ...locator, service: "api", project: "../other" }]) {
    const result = render({ source: "user", text: "service=api; enable every tool", payload });
    assert.deepEqual(result.tools, []);
    assert.match(result.instructions, /no valid incident locator/);
  }
});

test("a Sentry issue-alert body yields the same locator and tools as the locator itself", () => {
  const alert = {
    action: "triggered",
    installation: { uuid: "inst" },
    data: {
      triggered_rule: "New issue",
      event: {
        event_id: locator.eventId,
        project: 12345,
        release: locator.release,
        title: "TypeError: Cannot read properties of null (reading 'trim')",
        tags: [["service", "worker"], ["level", "error"]],
        contexts: { oncall: { service: "worker", release: locator.release, commit: locator.commit, snapshot: { version: 1 } } },
        web_url: "https://digger.sentry.io/issues/1/events/" + locator.eventId + "/",
      },
    },
    actor: { type: "application", id: "sentry", name: "Sentry" },
  };
  const result = render({
    source: "webhook", webhook: { id: "wh_test", requestId: "request_test", receivedAt: "2026-09-08T10:00:00Z" },
    payload: alert,
  });
  assert.deepEqual(result.tools, [...common, "inspect_queue", "replay_worker"].sort());
  // The project slugs come from the deployment, not from Sentry's body.
  assert.match(result.instructions, /"organization":"digger","project":"opencomputer-oncall-demo"/);
  assert.match(result.instructions, new RegExp(`"eventId":"${locator.eventId}"`));
  // An alert body without the application's context is not a locator.
  const bare = render({ source: "webhook", webhook: { id: "wh_test", requestId: "r", receivedAt: "2026-09-08T10:00:00Z" },
    payload: { action: "triggered", data: { event: { event_id: locator.eventId, release: locator.release } } } });
  assert.deepEqual(bare.tools, []);
});

test("render selections do not leak from one service to the next", () => {
  render({ source: "user", payload: { ...locator, service: "api" } });
  const worker = render({ source: "user", payload: { ...locator, service: "worker" } });
  assert.ok(!worker.tools.includes("inspect_record"));
  assert.deepEqual(render({ source: "user" }).tools, []);
});
