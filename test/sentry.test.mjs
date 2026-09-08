import assert from "node:assert/strict";
import test from "node:test";
import { captureSentryIncident } from "../scripts/sentry.mjs";

const eventId = "0123456789abcdef0123456789abcdef";
const config = {
  dsn: "https://example@o1.ingest.sentry.io/2",
  token: "test-token-never-print",
  organization: "example-org",
  project: "oncall-example",
};

function incident() {
  return {
    service: "worker",
    release: "oncall-reporting@abc123",
    commit: "c".repeat(40),
    snapshot: { version: 1, jobs: [{ id: "job-1", rows: [{ account: "Example", total: 2 }] }] },
    error: new TypeError("Cannot read properties of null"),
    breadcrumbs: [{ category: "report-worker", message: "Job failed", level: "error" }],
  };
}

function harness(input, { flush = true } = {}) {
  const calls = { requests: [], sleeps: [], closes: 0, captures: 0 };
  class NodeClient {
    constructor(options) { calls.clientOptions = options; }
    async flush(timeout) { calls.flushTimeout = timeout; return flush; }
    async close() { calls.closes++; return true; }
  }
  class Scope {
    setClient(client) { calls.client = client; }
    setTag(key, value) { calls.tag = [key, value]; }
    setContext(key, value) { calls.context = { [key]: value }; }
    setFingerprint(value) { calls.fingerprint = value; }
    addBreadcrumb(value) { (calls.breadcrumbs ??= []).push(value); }
    captureException(error) { calls.error = error; calls.captures++; return eventId; }
  }
  const event = {
    eventID: eventId,
    groupID: "12345",
    release: { version: input.release },
    contexts: { oncall: { service: input.service, release: input.release, commit: input.commit, snapshot: structuredClone(input.snapshot) } },
  };
  const responses = [new Response(JSON.stringify(event))];
  const options = {
    sentry: { NodeClient, Scope, makeNodeTransport() {}, defaultStackParser() {} },
    async fetch(url, init) {
      calls.requests.push({ url, init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response ?? new Response("", { status: 404 });
    },
    async sleep(ms) { calls.sleeps.push(ms); },
    maxAttempts: 3,
    pollIntervalMs: 0,
  };
  return { calls, event, responses, options };
}

test("captures the original Error and reads back the same release and nested snapshot", async () => {
  const input = incident();
  const { calls, options } = harness(input);
  const result = await captureSentryIncident(input, config, options);
  assert.deepEqual(result, { eventId, issueUrl: "https://sentry.io/organizations/example-org/issues/12345/" });
  assert.equal(calls.error, input.error);
  assert.equal(calls.error.stack, input.error.stack);
  assert.equal(calls.captures, 1);
  assert.equal(calls.closes, 1);
  assert.deepEqual(calls.context.oncall.snapshot, input.snapshot);
  assert.deepEqual(calls.breadcrumbs, input.breadcrumbs);
  assert.deepEqual(calls.tag, ["service", "worker"]);
  assert.equal(calls.clientOptions.release, input.release);
  assert.equal(calls.clientOptions.defaultIntegrations, false);
  assert.deepEqual(calls.clientOptions.integrations, []);
  assert.equal(calls.clientOptions.sendDefaultPii, false);
  assert.equal(calls.clientOptions.debug, false);
  assert.equal(calls.clientOptions.enableLogs, false);
  assert.equal(calls.clientOptions.enableMetrics, false);
  assert.ok(calls.clientOptions.normalizeDepth > 6);
  assert.equal(calls.requests[0].url,
    `https://sentry.io/api/0/projects/example-org/oncall-example/events/${eventId}/`);
  assert.equal(calls.requests[0].init.headers.Authorization, `Bearer ${config.token}`);
  assert.equal(calls.requests[0].init.redirect, "error");
  assert.ok(calls.requests[0].init.signal instanceof AbortSignal);
});

test("waits for ingestion and rate limiting without recapturing the error", async () => {
  const input = incident();
  const { calls, options, responses } = harness(input);
  responses.unshift(new Response("", { status: 404 }), new Response("", { status: 429 }));
  await captureSentryIncident(input, config, options);
  assert.equal(calls.requests.length, 3);
  assert.equal(calls.sleeps.length, 2);
  assert.equal(calls.captures, 1);
});

test("will not dispatch if Sentry changes an event ID, release, service or snapshot", async (t) => {
  const mutations = {
    "event ID": (event) => { event.eventID = "f".repeat(32); },
    release: (event) => { event.release.version = "wrong-release"; },
    "context release": (event) => { event.contexts.oncall.release = "wrong-release"; },
    commit: (event) => { event.contexts.oncall.commit = "d".repeat(40); },
    service: (event) => { event.contexts.oncall.service = "api"; },
    snapshot: (event) => { event.contexts.oncall.snapshot.jobs[0].rows = "[Array]"; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const input = incident();
      const { event, options, responses } = harness(input);
      mutate(event);
      responses[0] = new Response(JSON.stringify(event));
      await assert.rejects(captureSentryIncident(input, config, options), /did not preserve/);
    });
  }
});

test("accepts a string release and links the exact event when no group is available", async () => {
  const input = incident();
  const { event, options, responses } = harness(input);
  event.release = input.release;
  delete event.groupID;
  responses[0] = new Response(JSON.stringify(event));
  const result = await captureSentryIncident(input, config, options);
  assert.equal(result.issueUrl, `https://sentry.io/organizations/example-org/issues/?query=${eventId}`);
});

test("authentication failures stop immediately and never echo a provider body", async () => {
  const input = incident();
  const { calls, options, responses } = harness(input);
  responses[0] = new Response(`debug: ${config.token}`, { status: 403 });
  await assert.rejects(captureSentryIncident(input, config, options), (error) => {
    assert.match(error.message, /HTTP 403.*project:read/);
    assert.ok(!error.message.includes(config.token));
    return true;
  });
  assert.equal(calls.requests.length, 1);
});

test("network and absent-event retries have a finite limit with redacted errors", async () => {
  const input = incident();
  const { calls, options, responses } = harness(input);
  responses.splice(0, 1, new Error(`transport leaked ${config.token}`));
  await assert.rejects(captureSentryIncident(input, config, options), (error) => {
    assert.match(error.message, /polling limit/);
    assert.ok(!error.message.includes(config.token));
    return true;
  });
  assert.equal(calls.requests.length, options.maxAttempts);
  assert.equal(calls.captures, 1);
});

test("flush failure closes the client and never attempts to dispatch an unreadable event", async () => {
  const input = incident();
  const { calls, options } = harness(input, { flush: false });
  await assert.rejects(captureSentryIncident(input, config, options), /could not flush/);
  assert.equal(calls.closes, 1);
  assert.equal(calls.requests.length, 0);
});

test("malformed provider JSON fails without leaking the response", async () => {
  const input = incident();
  const { options, responses } = harness(input);
  responses[0] = new Response(config.token);
  await assert.rejects(captureSentryIncident(input, config, options), /unreadable event/);
});

test("rejects oversized or lossy snapshots before any capture", async () => {
  for (const snapshot of [{ text: "x".repeat(64 * 1024) }, { value: undefined }, null]) {
    const input = { ...incident(), snapshot };
    const { calls, options } = harness(incident());
    await assert.rejects(captureSentryIncident(input, config, options), /64 KiB|JSON values|snapshot must be an object/);
    assert.equal(calls.captures, 0);
  }
});

test("rejects invalid configuration without echoing credentials", async () => {
  const input = incident();
  const { calls, options } = harness(input);
  await assert.rejects(captureSentryIncident(input, { ...config, organization: "../other" }, options), /Configure SENTRY/);
  await assert.rejects(captureSentryIncident(input, { ...config, dsn: config.token }, options), /valid HTTPS Sentry DSN/);
  assert.equal(calls.captures, 0);
});

test("the real SDK serializes the worker Error and complete replay snapshot without network access", async () => {
  const sdk = await import("@sentry/node");
  const { captureIncident } = await import("../app/incidents.mjs");
  const input = { ...await captureIncident("worker"), commit: "c".repeat(40) };
  const payloads = [];
  let sentEvent;
  const result = await captureSentryIncident(input, config, {
    sentry: {
      ...sdk,
      makeNodeTransport: (transportOptions) => sdk.createTransport(transportOptions, async ({ body }) => {
        const lines = (typeof body === "string" ? body : Buffer.from(body).toString("utf8")).split("\n");
        payloads.push(lines);
        sentEvent = JSON.parse(lines[2]);
        return { statusCode: 200 };
      }),
    },
    async fetch() {
      return new Response(JSON.stringify({
        ...sentEvent, eventID: sentEvent.event_id, groupID: "12345",
      }));
    },
    maxAttempts: 1,
  });
  assert.equal(payloads.length, 1);
  assert.equal(JSON.parse(payloads[0][1]).type, "event");
  assert.equal(sentEvent.exception.values[0].type, input.error.name);
  assert.equal(sentEvent.exception.values[0].value, input.error.message);
  assert.ok(sentEvent.exception.values[0].stacktrace.frames.some((frame) =>
    frame.function === "generateReport" && frame.filename.endsWith("/app/worker.mjs")));
  assert.equal(sentEvent.release, input.release);
  assert.deepEqual(sentEvent.contexts.oncall.snapshot, input.snapshot);
  assert.equal(sentEvent.breadcrumbs.length, input.breadcrumbs.length);
  assert.equal(result.eventId, sentEvent.event_id);
});
