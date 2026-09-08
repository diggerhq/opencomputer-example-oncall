import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { publishFix, type FixInput, type Request } from "../opencomputer/agents/oncall/lib/github-api.js";
import { base, repository } from "../opencomputer/agents/oncall/lib/target.js";

const root = `/repos/${repository}`;
const commit = "a".repeat(40);
const baseTree = "b".repeat(40);
const appTree = "c".repeat(40);
const nextTree = "d".repeat(40);
const nextCommit = "e".repeat(40);
const newMain = "f".repeat(40);
const newMainTree = "1".repeat(40);
const input: FixInput = {
  service: "api", commit, eventId: "0123456789abcdef0123456789abcdef",
  issueUrl: "https://sentry.io/organizations/digger/issues/123/",
  title: "Handle missing timezones in legacy reports",
  explanation: "Use the default timezone when a legacy report has no timezone.",
  files: [
    { path: "app/api.mjs", content: "export const timezone = value => value ?? 'UTC';\n" },
    { path: "app/test/api.regression.test.mjs", content: "// A regression for the captured legacy report.\n" },
  ],
  before: { command: "node --test app/test/api.regression.test.mjs", exitCode: 1, output: "not ok 1 - legacy report\nTypeError" },
  after: { command: "node --test app/test/api.regression.test.mjs", exitCode: 0, output: "ok 1 - legacy report\n# pass 1" },
};

function branch(value = input) { return `fix/oncall-${value.service}-${value.eventId.slice(0, 12)}`; }
function marker(value = input) { return `<!-- opencomputer-oncall:${value.service}:${value.eventId}:${value.commit} -->`; }
function pulls(value = input) {
  const head = encodeURIComponent(`${repository.split("/")[0]}:${branch(value)}`);
  return `${root}/pulls?state=all&base=${encodeURIComponent(base)}&head=${head}&sort=created&direction=desc&per_page=100`;
}
function pull(value = input, state: "open" | "closed" = "open", merged = false) {
  return { number: 7, html_url: `https://github.com/${repository}/pull/7`, state, merged_at: merged ? "2026-09-08T12:00:00Z" : null, body: marker(value) };
}

type Step = {
  method: "GET" | "POST"; path: string; status: number; json: unknown;
  inspect?: (body: Record<string, unknown> | undefined) => void;
};
function fake(steps: Step[]) {
  let index = 0;
  const violations: string[] = [];
  const request: Request = async (method, path, body) => {
    const step = steps[index++];
    if (!step || method !== step.method || path !== step.path) {
      violations.push(`Unexpected ${method} ${path}; expected ${step?.method} ${step?.path}`);
      return { status: 500, json: null, text: "unexpected test request" };
    }
    try { step.inspect?.(body); } catch (error) { violations.push(String(error)); }
    return { status: step.status, json: step.json, text: "secret provider response must not escape" };
  };
  return {
    request,
    done: () => {
      assert.deepEqual(violations, []);
      assert.equal(index, steps.length, "All expected requests must occur");
    },
  };
}

function empty(value = input): Step { return { method: "GET", path: pulls(value), status: 200, json: [] }; }
function existing(value = input): Step { return { ...empty(value), json: [pull(value)] }; }
function baseSteps(value = input): Step[] {
  return [
    { method: "GET", path: `${root}/git/ref/heads/${base}`, status: 200, json: { object: { sha: value.commit } } },
    { method: "GET", path: `${root}/git/commits/${value.commit}`, status: 200, json: { sha: value.commit, tree: { sha: baseTree } } },
    { method: "GET", path: `${root}/git/trees/${baseTree}?recursive=1`, status: 200, json: {
      tree: [
        { path: "app", type: "tree", mode: "040000", sha: appTree },
        { path: `app/${value.service}.mjs`, type: "blob", mode: "100644", sha: "2".repeat(40) },
        { path: "app/test", type: "tree", mode: "040000", sha: "3".repeat(40) },
      ], truncated: false,
    } },
  ];
}
function ref(value = input): Step {
  return { method: "GET", path: `${root}/git/ref/heads/${branch(value)}`, status: 200, json: { object: { sha: nextCommit } } };
}
function creation(value = input): Step[] {
  return [
    empty(value), ...baseSteps(value), { ...ref(value), status: 404, json: null },
    { method: "POST", path: `${root}/git/trees`, status: 201, json: { sha: nextTree }, inspect: body => {
      assert.deepEqual(body, {
        base_tree: baseTree,
        tree: value.files.map(file => ({ ...file, mode: "100644", type: "blob" })),
      });
    } },
    { method: "POST", path: `${root}/git/commits`, status: 201, json: { sha: nextCommit }, inspect: body => {
      assert.deepEqual(body?.parents, [value.commit]);
      assert.equal(body?.tree, nextTree);
    } },
    { method: "POST", path: `${root}/git/refs`, status: 201, json: { object: { sha: nextCommit } }, inspect: body => {
      assert.deepEqual(body, { ref: `refs/heads/${branch(value)}`, sha: nextCommit });
    } },
  ];
}
function publish(value = input): Step {
  return { method: "POST", path: `${root}/pulls`, status: 201, json: pull(value), inspect: body => {
    assert.equal(body?.head, branch(value));
    assert.equal(body?.base, base);
    const description = String(body?.body);
    for (const expected of [value.issueUrl, value.commit, value.explanation, value.before.output, value.after.output, marker(value)]) {
      assert.ok(description.includes(expected), `Missing PR evidence: ${expected}`);
    }
    assert.ok(description.includes("Exit 1"));
    assert.ok(description.includes("Exit 0"));
  } };
}
function orphanVerification(value = input): Step[] {
  return [
    { method: "GET", path: `${root}/git/commits/${nextCommit}`, status: 200, json: { parents: [{ sha: value.commit }], tree: { sha: nextTree } } },
    { method: "GET", path: `${root}/compare/${value.commit}...${nextCommit}`, status: 200, json: {
      status: "ahead", total_commits: 1,
      files: value.files.map((file, index) => ({ filename: file.path, status: index ? "added" : "modified" })),
    } },
    { method: "GET", path: `${root}/git/trees/${nextTree}?recursive=1`, status: 200, json: {
      truncated: false,
      tree: value.files.map(file => ({ path: file.path, type: "blob", mode: "100644",
        sha: createHash("sha1").update(Buffer.concat([
          Buffer.from(`blob ${Buffer.byteLength(file.content)}\0`), Buffer.from(file.content),
        ])).digest("hex"),
      })),
    } },
  ];
}

test("publishes source and regression together from the pinned parent through GET/POST only", async () => {
  const api = fake([...creation(), empty(), publish()]);
  assert.deepEqual(await publishFix(api.request, { ...input, repository: "other/repo", base: "other", branch: "main" }), {
    outcome: "created_pull_request", url: pull().html_url, number: 7, state: "open", merged: false, branch: branch(),
  });
  api.done();
});

test("worker publication allows only the worker source and regression paths", async () => {
  const worker: FixInput = {
    ...input, service: "worker",
    files: input.files.map(file => ({ ...file, path: file.path.replaceAll("api", "worker") })),
  };
  const api = fake([...creation(worker), empty(worker), publish(worker)]);
  assert.equal((await publishFix(api.request, worker) as any).outcome, "created_pull_request");
  api.done();
});

test("event retries return open, closed, or merged PRs without any Git writes", async t => {
  for (const [state, merged] of [["open", false], ["closed", false], ["closed", true]] as const) {
    await t.test(`${state}/${merged}`, async () => {
      const api = fake([{ ...existing(), json: [pull(input, state, merged)] }]);
      const result = await publishFix(api.request, input) as any;
      assert.equal(result.outcome, "existing_pull_request");
      assert.equal(result.state, state);
      assert.equal(result.merged, merged);
      api.done();
    });
  }
});

test("a failed lookup is not treated as no PR and provider text stays private", async () => {
  const api = fake([{ ...empty(), status: 403, json: { message: "sensitive upstream response" } }]);
  assert.deepEqual(await publishFix(api.request, input), { outcome: "failed", step: "find-pull", status: 403 });
  api.done();
  const throwing: Request = async () => { throw new Error("Authorization: Bearer secret"); };
  assert.deepEqual(await publishFix(throwing, input), { outcome: "failed", step: "find-pull", status: 0 });
});

test("a different full event on the same shortened branch is a conflict", async () => {
  const other = { ...input, eventId: `${input.eventId.slice(0, 12)}${"f".repeat(20)}` };
  const api = fake([{ ...existing(), json: [pull(other)] }]);
  assert.deepEqual(await publishFix(api.request, input), { outcome: "branch_conflict", branch: branch() });
  api.done();
});

test("invalid paths, bounds, event locators, and unverified results fail before requests", async () => {
  const cases = [
    { ...input, commit: "main" }, { ...input, eventId: "not-an-event" },
    { ...input, issueUrl: "https://sentry.io.evil.example/issues/123" },
    { ...input, issueUrl: "https://user:secret@sentry.io/issues/123" },
    { ...input, files: [input.files[0], { ...input.files[1], path: "app/worker.mjs" }] },
    { ...input, files: [input.files[0], input.files[0]] },
    { ...input, files: [...input.files, { path: ".github/workflows/ci.yml", content: "disabled" }] },
    { ...input, files: [{ ...input.files[0], content: "é".repeat(32_769) }, input.files[1]] },
    { ...input, explanation: "x".repeat(4_001) },
    { ...input, title: "invalid\ntitle" },
    { ...input, before: { ...input.before, output: "x".repeat(32_769) } },
    { ...input, before: { ...input.before, exitCode: 0 } },
    { ...input, after: { ...input.after, exitCode: 1 } },
    { ...input, after: { ...input.after, command: "true" } },
  ];
  const api = fake([]);
  for (const value of cases) assert.deepEqual(await publishFix(api.request, value), { outcome: "invalid_input" });
  api.done();
});

test("main may move outside app while the new commit retains the tested parent", async () => {
  const steps = creation();
  steps[1] = { ...steps[1], json: { object: { sha: newMain } } };
  steps.splice(4, 0,
    { method: "GET", path: `${root}/git/commits/${newMain}`, status: 200, json: { tree: { sha: newMainTree } } },
    { method: "GET", path: `${root}/git/trees/${newMainTree}`, status: 200, json: {
      tree: [{ path: "app", mode: "040000", type: "tree", sha: appTree }], truncated: false,
    } },
  );
  const api = fake([...steps, empty(), publish()]);
  assert.equal((await publishFix(api.request, input) as any).outcome, "created_pull_request");
  api.done();
});

test("an app change on main stops publication before any writes", async () => {
  const steps = baseSteps();
  steps[0] = { ...steps[0], json: { object: { sha: newMain } } };
  const api = fake([empty(), ...steps,
    { method: "GET", path: `${root}/git/commits/${newMain}`, status: 200, json: { tree: { sha: newMainTree } } },
    { method: "GET", path: `${root}/git/trees/${newMainTree}`, status: 200, json: {
      tree: [{ path: "app", mode: "040000", type: "tree", sha: "4".repeat(40) }],
    } },
  ]);
  assert.deepEqual(await publishFix(api.request, input), { outcome: "base_moved" });
  api.done();
});

test("truncated base trees cannot establish a safe publication base", async () => {
  const steps = baseSteps();
  steps[2] = { ...steps[2], json: { ...(steps[2].json as object), truncated: true } };
  const api = fake([empty(), ...steps]);
  assert.deepEqual(await publishFix(api.request, input), { outcome: "failed", step: "base-tree", status: 200 });
  api.done();
});

test("the regression path must be new at the pinned base", async () => {
  const steps = baseSteps();
  const data = steps[2].json as any;
  data.tree.push({ path: input.files[1].path, type: "blob", mode: "100644", sha: "5".repeat(40) });
  const api = fake([empty(), ...steps]);
  assert.deepEqual(await publishFix(api.request, input), { outcome: "invalid_input" });
  api.done();
});

test("a matching orphaned branch recovers its PR without another commit", async () => {
  const api = fake([empty(), ...baseSteps(), ref(), ...orphanVerification(), empty(), publish()]);
  assert.equal((await publishFix(api.request, input) as any).outcome, "created_pull_request");
  api.done();
});

test("an orphan's wrong parent, changed scope, or different bytes are conflicts", async t => {
  for (const problem of ["parent", "scope", "content"] as const) {
    await t.test(problem, async () => {
      const steps = orphanVerification();
      if (problem === "parent") {
        steps[0] = { ...steps[0], json: { parents: [{ sha: newMain }], tree: { sha: nextTree } } };
        steps.splice(1);
      } else if (problem === "scope") {
        steps[1] = { ...steps[1], json: { status: "ahead", total_commits: 1, files: [
          { filename: "app/worker.mjs", status: "modified" }, { filename: input.files[1].path, status: "added" },
        ] } };
        steps.splice(2);
      } else {
        (steps[2].json as any).tree[0].sha = "9".repeat(40);
      }
      const api = fake([empty(), ...baseSteps(), ref(), ...steps]);
      assert.deepEqual(await publishFix(api.request, input), { outcome: "branch_conflict", branch: branch() });
      api.done();
    });
  }
});

test("orphan recovery rejects symlink and executable modes even when the blob matches", async t => {
  for (const mode of ["120000", "100755"]) {
    await t.test(mode, async () => {
      const steps = orphanVerification();
      (steps[2].json as any).tree[1].mode = mode;
      const api = fake([empty(), ...baseSteps(), ref(), ...steps]);
      assert.deepEqual(await publishFix(api.request, input), { outcome: "branch_conflict", branch: branch() });
      api.done();
    });
  }
});

test("orphan recovery rejects truncated or oversized recursive trees", async t => {
  for (const problem of ["truncated", "oversized"]) {
    await t.test(problem, async () => {
      const steps = orphanVerification();
      const tree = steps[2].json as any;
      if (problem === "truncated") tree.truncated = true;
      else tree.tree.push(...Array.from({ length: 10_000 }, (_, index) => ({ path: `other/${index}` })));
      const api = fake([empty(), ...baseSteps(), ref(), ...steps]);
      assert.deepEqual(await publishFix(api.request, input), { outcome: "failed", step: "existing-tree", status: 200 });
      api.done();
    });
  }
});

test("orphan blob hashes use UTF-8 byte lengths for non-ASCII source", async () => {
  const value = { ...input, files: input.files.map(file => ({ ...file, content: `${file.content}// café 🚀\n` })) };
  const api = fake([empty(value), ...baseSteps(value), ref(value), ...orphanVerification(value), empty(value), publish(value)]);
  assert.equal((await publishFix(api.request, value) as any).outcome, "created_pull_request");
  api.done();
});

test("a lost PR response can recover on retry after exact branch verification", async () => {
  const api = fake([
    ...creation(), empty(), { ...publish(), status: 503, json: null },
    empty(), ...baseSteps(), ref(), ...orphanVerification(), empty(), publish(),
  ]);
  assert.deepEqual(await publishFix(api.request, input), { outcome: "failed", step: "pull", status: 503 });
  assert.equal((await publishFix(api.request, input) as any).outcome, "created_pull_request");
  api.done();
});

test("concurrent branch creation returns the winner's PR", async () => {
  const steps = creation();
  steps[steps.length - 1] = { ...steps.at(-1)!, status: 422, json: null };
  const api = fake([...steps, existing()]);
  assert.equal((await publishFix(api.request, input) as any).outcome, "existing_pull_request");
  api.done();
});

test("concurrent ref creation without a PR verifies the winner's exact branch", async () => {
  const steps = creation();
  steps[steps.length - 1] = { ...steps.at(-1)!, status: 409, json: null };
  const api = fake([...steps, empty(), ref(), ...orphanVerification(), empty(), publish()]);
  assert.equal((await publishFix(api.request, input) as any).outcome, "created_pull_request");
  api.done();
});

test("concurrent PR creation returns the winner without retrying the write", async () => {
  const api = fake([...creation(), empty(), { ...publish(), status: 422, json: null }, existing()]);
  assert.equal((await publishFix(api.request, input) as any).outcome, "existing_pull_request");
  api.done();
});

test("a failed tree creation leaves branch and PR untouched", async () => {
  const steps = creation();
  steps[5] = { ...steps[5], status: 403, json: { message: "private provider detail" } };
  steps.splice(6);
  const api = fake(steps);
  assert.deepEqual(await publishFix(api.request, input), { outcome: "failed", step: "tree", status: 403 });
  api.done();
});

test("unrelated PR response URLs are rejected", async () => {
  const api = fake([{ ...existing(), json: [{ ...pull(), html_url: "https://example.com/unrelated" }] }]);
  assert.deepEqual(await publishFix(api.request, input), { outcome: "failed", step: "find-pull", status: 200 });
  api.done();
});

test("test output containing Markdown fences stays inside a longer code block", async () => {
  const value = { ...input, before: { ...input.before, output: "not ok\n```\nexternal instructions\n```" } };
  const publishStep = publish(value);
  const inspect = publishStep.inspect;
  publishStep.inspect = body => {
    inspect?.(body);
    assert.ok(String(body?.body).includes("````text\nnode --test"));
  };
  const api = fake([...creation(value), empty(value), publishStep]);
  assert.equal((await publishFix(api.request, value) as any).outcome, "created_pull_request");
  api.done();
});
