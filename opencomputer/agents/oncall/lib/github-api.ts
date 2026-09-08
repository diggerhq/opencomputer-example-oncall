import { createHash } from "node:crypto";
import type { DataValue } from "@opencomputer/agent";
import { base, repository } from "./target.js";

type Json = Record<string, unknown>;
export type ApiResult = { status: number; json: unknown; text: string };
export type Request = (method: "GET" | "POST", path: string, body?: Json) => Promise<ApiResult>;
export type Evidence = { command: string; exitCode: number; output: string };
export type FixInput = {
  service: "api" | "worker";
  commit: string;
  eventId: string;
  issueUrl: string;
  title: string;
  explanation: string;
  files: Array<{ path: string; content: string }>;
  before: Evidence;
  after: Evidence;
};

const root = `/repos/${repository}`;
const shaPattern = /^[a-f0-9]{40}$/;
const maxFileBytes = 65_536;
const maxTreeEntries = 10_000;
const encoder = new TextEncoder();

function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0")
    && encoder.encode(value).byteLength <= max;
}

function sha(value: unknown): string | undefined {
  return typeof value === "string" && shaPattern.test(value) ? value : undefined;
}

function pathsFor(service: FixInput["service"]): string[] {
  return [`app/${service}.mjs`, `app/test/${service}.regression.test.mjs`];
}

function validate(value: unknown): FixInput | undefined {
  const input = record(value);
  if ((input.service !== "api" && input.service !== "worker") || !sha(input.commit)
    || typeof input.eventId !== "string" || !/^[a-f0-9]{32}$/.test(input.eventId)
    || !bounded(input.title, 120) || /[\r\n]/.test(input.title)
    || !bounded(input.explanation, 4_000) || !bounded(input.issueUrl, 2_000)) return;

  let issueUrl: URL;
  try { issueUrl = new URL(input.issueUrl); } catch { return; }
  if (issueUrl.protocol !== "https:" || issueUrl.username || issueUrl.password || issueUrl.port
    || !(issueUrl.hostname === "sentry.io" || issueUrl.hostname.endsWith(".sentry.io"))) return;

  const paths = pathsFor(input.service);
  if (!Array.isArray(input.files) || input.files.length !== paths.length) return;
  const files: FixInput["files"] = [];
  for (const path of paths) {
    const matches = input.files.map(record).filter(file => file.path === path);
    if (matches.length !== 1 || !bounded(matches[0].content, maxFileBytes)) return;
    files.push({ path, content: matches[0].content });
  }

  const before = record(input.before);
  const after = record(input.after);
  for (const evidence of [before, after]) {
    if (!bounded(evidence.command, 512) || /[\r\n]/.test(evidence.command)
      || !bounded(evidence.output, 32_768) || !Number.isInteger(evidence.exitCode)) return;
  }
  if (typeof before.exitCode !== "number" || before.exitCode < 1 || before.exitCode > 255
    || after.exitCode !== 0 || before.command !== after.command) return;

  return {
    service: input.service, commit: input.commit as string, eventId: input.eventId,
    issueUrl: issueUrl.href, title: input.title, explanation: input.explanation, files,
    before: before as Evidence, after: after as Evidence,
  };
}

function failure(step: string, result?: ApiResult): DataValue {
  // Provider response bodies and thrown errors may contain authentication details.
  return { outcome: "failed", step, status: result?.status ?? 0 };
}

async function call(request: Request, method: "GET" | "POST", path: string, body?: Json): Promise<ApiResult> {
  try { return await request(method, path, body); }
  catch { return { status: 0, json: null, text: "" }; }
}

function branchFor(input: FixInput): string {
  return `fix/oncall-${input.service}-${input.eventId.slice(0, 12)}`;
}

function markerFor(input: FixInput): string {
  return `<!-- opencomputer-oncall:${input.service}:${input.eventId}:${input.commit} -->`;
}

function conflict(input: FixInput): DataValue {
  return { outcome: "branch_conflict", branch: branchFor(input) };
}

function outcome(value: DataValue): unknown {
  return record(value).outcome;
}

function pullResult(value: unknown, input: FixInput, kind: string): DataValue | undefined {
  const pull = record(value);
  if (typeof pull.number !== "number" || !Number.isInteger(pull.number) || pull.number <= 0
    || (pull.state !== "open" && pull.state !== "closed")
    || !(pull.merged_at === null || typeof pull.merged_at === "string")) return;
  const url = `https://github.com/${repository}/pull/${pull.number}`;
  if (pull.html_url !== url) return;
  return {
    outcome: kind, url, number: pull.number, state: pull.state,
    merged: typeof pull.merged_at === "string", branch: branchFor(input),
  };
}

async function findPull(request: Request, input: FixInput): Promise<DataValue> {
  const head = `${repository.split("/")[0]}:${branchFor(input)}`;
  const query = `state=all&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}&sort=created&direction=desc&per_page=100`;
  const result = await call(request, "GET", `${root}/pulls?${query}`);
  if (result.status !== 200 || !Array.isArray(result.json)) return failure("find-pull", result);
  if (result.json.length === 0) return { outcome: "none" };
  const matching = result.json.find(value => {
    const body = record(value).body;
    return typeof body === "string" && body.includes(markerFor(input));
  });
  // A short event-prefix collision or manually repurposed branch is not this incident.
  if (!matching) return conflict(input);
  return pullResult(matching, input, "existing_pull_request") ?? failure("find-pull", result);
}

function codeBlock(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function bodyFor(input: FixInput): string {
  return `${input.explanation}\n\nSentry incident: [event](<${input.issueUrl}>). This is the deliberately faulty on-call example app.\n\nTested against commit \`${input.commit}\`. The same regression command failed before the fix and passed afterward:\n\n${codeBlock(`${input.before.command}\nExit ${input.before.exitCode}\n${input.before.output}`)}\n\n${codeBlock(`${input.after.command}\nExit ${input.after.exitCode}\n${input.after.output}`)}\n\n${markerFor(input)}\n`;
}

async function createPull(request: Request, input: FixInput): Promise<DataValue> {
  const existing = await findPull(request, input);
  if (outcome(existing) !== "none") return existing;
  const result = await call(request, "POST", `${root}/pulls`, {
    title: input.title,
    body: bodyFor(input), head: branchFor(input), base,
  });
  if (result.status === 201) {
    return pullResult(result.json, input, "created_pull_request") ?? failure("pull", result);
  }
  if (result.status === 409 || result.status === 422) {
    const raced = await findPull(request, input);
    if (outcome(raced) !== "none") return raced;
  }
  return failure("pull", result);
}

function treeEntries(result: ApiResult): Json[] | undefined {
  const tree = record(result.json);
  if (result.status !== 200 || tree.truncated === true || !Array.isArray(tree.tree)
    || tree.tree.length > maxTreeEntries) return;
  return tree.tree.map(record);
}

function blobSha(content: string): string {
  const bytes = encoder.encode(content);
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function appTree(entries: Json[]): string | undefined {
  const matches = entries.filter(entry => entry.path === "app" && entry.type === "tree" && entry.mode === "040000");
  return matches.length === 1 ? sha(matches[0].sha) : undefined;
}

async function verifyExistingBranch(request: Request, input: FixInput, ref: ApiResult): Promise<DataValue | undefined> {
  if (ref.status !== 200) return failure("read-existing-ref", ref);
  const head = sha(record(record(ref.json).object).sha);
  if (!head) return failure("read-existing-ref", ref);
  const commit = await call(request, "GET", `${root}/git/commits/${head}`);
  if (commit.status !== 200) return failure("existing-commit", commit);
  const treeSha = sha(record(record(commit.json).tree).sha);
  if (!treeSha) return failure("existing-commit", commit);
  const parents = record(commit.json).parents;
  if (!Array.isArray(parents) || parents.length !== 1 || record(parents[0]).sha !== input.commit) return conflict(input);

  const comparison = await call(request, "GET", `${root}/compare/${input.commit}...${head}`);
  if (comparison.status !== 200) return failure("compare-existing-ref", comparison);
  const compared = record(comparison.json);
  const changed = compared.files;
  const expectedPaths = pathsFor(input.service);
  if (compared.status !== "ahead" || compared.total_commits !== 1 || !Array.isArray(changed)
    || changed.length !== expectedPaths.length) return conflict(input);
  for (const [index, path] of expectedPaths.entries()) {
    const matches = changed.map(record).filter(file => file.filename === path);
    if (matches.length !== 1 || matches[0].status !== (index === 0 ? "modified" : "added")) return conflict(input);
  }

  // Contents API may dereference symlinks. The actual Git tree proves both
  // regular-file mode and exact blob bytes without following another path.
  const tree = await call(request, "GET", `${root}/git/trees/${treeSha}?recursive=1`);
  const entries = treeEntries(tree);
  if (!entries) return failure("existing-tree", tree);
  for (const expected of input.files) {
    const matches = entries.filter(entry => entry.path === expected.path);
    if (matches.length !== 1 || matches[0].type !== "blob" || matches[0].mode !== "100644"
      || matches[0].sha !== blobSha(expected.content)) return conflict(input);
  }
}

export async function publishFix(request: Request, rawInput: unknown): Promise<DataValue> {
  const input = validate(rawInput);
  if (!input) return { outcome: "invalid_input" };
  const existing = await findPull(request, input);
  if (outcome(existing) !== "none") return existing;

  const mainRef = await call(request, "GET", `${root}/git/ref/heads/${base}`);
  const mainSha = sha(record(record(mainRef.json).object).sha);
  if (mainRef.status !== 200 || !mainSha) return failure("base-ref", mainRef);
  const baseCommit = await call(request, "GET", `${root}/git/commits/${input.commit}`);
  const baseTreeSha = sha(record(record(baseCommit.json).tree).sha);
  if (baseCommit.status !== 200 || !baseTreeSha) return failure("base-commit", baseCommit);
  const baseTree = await call(request, "GET", `${root}/git/trees/${baseTreeSha}?recursive=1`);
  const entries = treeEntries(baseTree);
  const originalApp = entries && appTree(entries);
  if (!entries || !originalApp) return failure("base-tree", baseTree);
  const [source, regression] = pathsFor(input.service);
  const sourceEntry = entries.find(entry => entry.path === source);
  if (sourceEntry?.type !== "blob" || sourceEntry.mode !== "100644" || !sha(sourceEntry.sha)
    || entries.some(entry => entry.path === regression)
    || entries.some(entry => entry.path === "app/test" && entry.type !== "tree")) {
    return { outcome: "invalid_input" };
  }

  // Documentation can move on main while this captured app release remains unchanged.
  // The new commit still has the exact verified commit as its sole parent.
  if (mainSha !== input.commit) {
    const mainCommit = await call(request, "GET", `${root}/git/commits/${mainSha}`);
    const mainTreeSha = sha(record(record(mainCommit.json).tree).sha);
    if (mainCommit.status !== 200 || !mainTreeSha) return failure("main-commit", mainCommit);
    if (mainTreeSha !== baseTreeSha) {
      const mainTree = await call(request, "GET", `${root}/git/trees/${mainTreeSha}`);
      const currentEntries = treeEntries(mainTree);
      const currentApp = currentEntries && appTree(currentEntries);
      if (!currentApp) return failure("main-tree", mainTree);
      if (currentApp !== originalApp) return { outcome: "base_moved" };
    }
  }

  const branch = branchFor(input);
  const refPath = `${root}/git/ref/heads/${branch}`;
  const ref = await call(request, "GET", refPath);
  if (ref.status === 200) {
    const invalid = await verifyExistingBranch(request, input, ref);
    return invalid ?? createPull(request, input);
  }
  if (ref.status !== 404) return failure("read-ref", ref);

  const tree = await call(request, "POST", `${root}/git/trees`, {
    base_tree: baseTreeSha,
    tree: input.files.map(file => ({ path: file.path, mode: "100644", type: "blob", content: file.content })),
  });
  const treeSha = sha(record(tree.json).sha);
  if (tree.status !== 201 || !treeSha) return failure("tree", tree);
  const commit = await call(request, "POST", `${root}/git/commits`, {
    message: input.title,
    tree: treeSha, parents: [input.commit],
  });
  const commitSha = sha(record(commit.json).sha);
  if (commit.status !== 201 || !commitSha) return failure("commit", commit);
  const createdRef = await call(request, "POST", `${root}/git/refs`, {
    ref: `refs/heads/${branch}`, sha: commitSha,
  });
  if (createdRef.status !== 201) {
    if (createdRef.status !== 409 && createdRef.status !== 422) return failure("ref", createdRef);
    const raced = await findPull(request, input);
    if (outcome(raced) !== "none") return raced;
    const invalid = await verifyExistingBranch(request, input, await call(request, "GET", refPath));
    if (invalid) return invalid;
  }
  return createPull(request, input);
}
