import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkoutDirectory, repository } from "./target.js";

type Evidence = { command: string; exitCode: number; output: string };
type Options = { service: "api" | "worker"; commit: string; cwd?: string; signal?: AbortSignal };
const fileLimit = 64 * 1024;

function execute(command: string, args: string[], cwd: string, signal?: AbortSignal, maxBuffer = 256 * 1024): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  const env = { ...process.env };
  // A verifier invoked by node:test must start an independent TAP-producing run.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, signal, timeout: 20_000, maxBuffer, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== "number" || error.killed || error.signal)) {
        reject(new Error(`${command} did not complete within the verification limits`));
      } else {
        resolve({ exitCode: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      }
    });
  });
}

async function git(args: string[], cwd: string, signal?: AbortSignal) {
  const result = await execute("git", args, cwd, signal);
  if (result.exitCode !== 0) throw new Error("Could not verify the repository checkout against the supplied commit");
  return result.stdout.toString("utf8");
}

async function regularFile(filename: string): Promise<Buffer> {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) !== 0) throw new Error("Proposed files must be regular, nonexecutable files, not symlinks");
  if (info.size === 0 || info.size > fileLimit) throw new Error("Proposed files must contain 1 to 65536 bytes");
  const bytes = await readFile(filename);
  if (bytes.length > fileLimit || bytes.includes(0)) throw new Error("Proposed files must contain bounded text");
  if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Error("Proposed files must be valid UTF-8");
  return bytes;
}

function sanitize(output: string, temporary: string, checkout: string, cwd: string) {
  return output
    .replaceAll(temporary, "<verification>")
    .replaceAll(checkout, "<repository>")
    .replaceAll(cwd, "<workspace>");
}

function counts(output: string) {
  const result: Record<string, number> = {};
  for (const match of output.matchAll(/^# (tests|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) result[match[1]] = Number(match[2]);
  return result;
}

export async function verifyWorkspace({ service, commit, cwd = process.cwd(), signal }: Options): Promise<{
  files: { path: string; content: string }[]; diff: string; before: Evidence; after: Evidence;
}> {
  if ((service !== "api" && service !== "worker") || !/^[a-f0-9]{40}$/i.test(commit)) throw new Error("Verification requires api or worker and a full 40-character commit SHA");
  const checkout = path.resolve(cwd, checkoutDirectory);
  const head = (await git(["rev-parse", "HEAD"], checkout, signal)).trim();
  if (head.toLowerCase() !== commit.toLowerCase()) throw new Error("Checkout HEAD does not match the incident commit");
  const top = (await git(["rev-parse", "--show-toplevel"], checkout, signal)).trim();
  if (await realpath(top) !== await realpath(checkout)) throw new Error("The repository directory must be the checkout root");
  const origin = (await git(["remote", "get-url", "origin"], checkout, signal)).trim();
  if (origin !== `https://github.com/${repository}` && origin !== `https://github.com/${repository}.git`) throw new Error("The checkout origin must be the fixed public example repository");

  const source = `app/${service}.mjs`;
  const regression = `app/test/${service}.regression.test.mjs`;
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], checkout, signal);
  const entries = status.split("\0").filter(Boolean);
  const expected = new Map([[source, [" M", "M ", "MM"]], [regression, ["??", "A ", "AM"]]]);
  if (entries.length !== 2 || entries.some(entry => !expected.get(entry.slice(3))?.includes(entry.slice(0, 2)))) {
    throw new Error(`Change exactly ${source} and add ${regression}; no other tracked, untracked, or ignored changes are allowed`);
  }
  const original = await git(["ls-tree", commit, "--", source, regression], checkout, signal);
  if (!new RegExp(`^100644 blob [a-f0-9]{40}\\t${source.replaceAll(".", "\\.")}\\n$`).test(original)) {
    throw new Error("The source must be a regular file in the incident commit and the regression must be new");
  }
  const index = await git(["ls-files", "--stage", "--", source, regression], checkout, signal);
  if (index.trim().split("\n").some(line => !/^100644 [a-f0-9]{40} 0\t/.test(line))) throw new Error("File mode or merge-state changes are not allowed");
  for (const directory of [checkout, path.join(checkout, "app"), path.join(checkout, "app/test")]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Application directories must not be symlinks");
  }
  const fixedSource = await regularFile(path.join(checkout, source));
  const newTest = await regularFile(path.join(checkout, regression));
  const originalSource = Buffer.from(await git(["show", `${commit}:${source}`], checkout, signal));
  if (originalSource.equals(fixedSource)) throw new Error("The proposed source is unchanged");

  const archive = await execute("git", ["archive", commit, "app"], checkout, signal, 1024 * 1024);
  if (archive.exitCode !== 0) throw new Error("Could not archive the original application");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "oncall-verify-"));
  try {
    const archivePath = path.join(temporary, "original.tar");
    await writeFile(archivePath, archive.stdout);
    const beforeRoot = path.join(temporary, "before");
    const afterRoot = path.join(temporary, "after");
    for (const folder of [beforeRoot, afterRoot]) {
      await mkdir(folder);
      const extracted = await execute("tar", ["-xf", archivePath, "-C", folder], temporary, signal);
      if (extracted.exitCode !== 0) throw new Error("Could not extract the original application");
      await writeFile(path.join(folder, regression), newTest);
    }
    await writeFile(path.join(afterRoot, source), fixedSource);

    const sourceDiff = await execute("git", ["diff", "--no-index", "--no-ext-diff", "--", path.join(beforeRoot, source), path.join(afterRoot, source)], temporary, signal);
    const testDiff = await execute("git", ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", path.join(afterRoot, regression)], temporary, signal);
    if (sourceDiff.exitCode !== 1 || testDiff.exitCode !== 1) throw new Error("Could not produce the proposed source and regression diff");
    const diff = [sourceDiff.stdout, testDiff.stdout].map(buffer => buffer.toString("utf8")
      .replaceAll(beforeRoot, "").replaceAll(afterRoot, "")).join("\n");
    if (Buffer.byteLength(diff) > 128 * 1024) throw new Error("Proposed diff exceeds 128 KiB");

    const testFiles = (await readdir(path.join(beforeRoot, "app/test"))).filter(file => file.endsWith(".test.mjs")).sort().map(file => `app/test/${file}`);
    if (!testFiles.includes(regression) || testFiles.length < 3) throw new Error("Verification must include the existing application tests and new regression");
    const args = ["--test", "--test-reporter=tap", "--test-concurrency=1", ...testFiles];
    const command = `node ${args.join(" ")}`;
    const run = async (folder: string, baseline: boolean): Promise<Evidence> => {
      const result = await execute("node", args, folder, signal);
      if (!(await readFile(path.join(folder, source))).equals(baseline ? originalSource : fixedSource) || !(await readFile(path.join(folder, regression))).equals(newTest)) {
        throw new Error("Tests must not modify the source or regression being verified");
      }
      const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
      const summary = counts(result.stdout.toString("utf8"));
      if (!(summary.tests > 0) || summary.cancelled !== 0 || summary.skipped !== 0 || summary.todo !== 0) throw new Error("Verification needs completed tests with no skipped, cancelled, or todo cases");
      if (baseline ? result.exitCode !== 1 || !(summary.fail > 0) : result.exitCode !== 0 || summary.fail !== 0) {
        throw new Error(baseline ? "The new regression must fail on the original source" : "The correction must pass the full application test suite");
      }
      const cleaned = sanitize(output, temporary, checkout, cwd);
      const bounded = cleaned.length > 16_000 ? `${cleaned.slice(0, 12_000)}\n<output truncated>\n${cleaned.slice(-4000)}` : cleaned;
      return { command, exitCode: result.exitCode, output: bounded };
    };
    const before = await run(beforeRoot, true);
    const after = await run(afterRoot, false);
    return { files: [{ path: source, content: fixedSource.toString("utf8") }, { path: regression, content: newTest.toString("utf8") }], diff, before, after };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
