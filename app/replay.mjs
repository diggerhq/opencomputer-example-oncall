import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleRequest } from "./api.mjs";
import { runWorkerBatch } from "./worker.mjs";

function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 1) {
    throw new Error("Expected a version 1 snapshot");
  }
}

export function errorEvidence(error) {
  return { name: error.name, message: error.message, stack: error.stack };
}

export async function replayApi(snapshot) {
  assertSnapshot(snapshot);
  if (!Array.isArray(snapshot.reports) || snapshot.reports.length > 10 ||
      snapshot.request?.method !== "GET" ||
      typeof snapshot.request.path !== "string" ||
      !/^\/reports\/[a-zA-Z0-9_-]+$/.test(snapshot.request.path)) {
    throw new Error("Expected a GET /reports/:id request and at most 10 report records");
  }
  const state = structuredClone(snapshot);
  try {
    const response = await handleRequest(
      new Request(`http://reporting.local${state.request.path}`, { method: state.request.method }),
      state,
    );
    return {
      service: "api",
      request: state.request,
      response: { status: response.status, body: await response.json() },
      error: null,
    };
  } catch (error) {
    return {
      service: "api",
      request: state.request,
      response: { status: 500, body: { error: "Internal server error" } },
      error: errorEvidence(error),
    };
  }
}

export function replayWorker(snapshot) {
  assertSnapshot(snapshot);
  if (!Array.isArray(snapshot.jobs) || snapshot.jobs.length > 10 ||
      snapshot.jobs.some((job) => !job || typeof job.id !== "string" ||
        typeof job.createdAt !== "string" || !Number.isInteger(job.attempts) ||
        job.attempts < 0 || (Array.isArray(job.rows) && job.rows.length > 100))) {
    throw new Error("Expected at most 10 jobs with IDs, timestamps, and attempt counts");
  }
  const state = structuredClone(snapshot);
  const result = runWorkerBatch(state, { maxSteps: snapshot.maxSteps ?? 4 });
  return {
    service: "worker",
    maxSteps: snapshot.maxSteps ?? 4,
    attempts: result.attempts,
    jobs: state.jobs.map(({ id, status, attempts, lastError }) => ({
      id, status, attempts, ...(lastError ? { lastError } : {}),
    })),
    outputs: result.outputs,
    errors: result.errors.map(errorEvidence),
  };
}

async function main() {
  const service = process.argv[2];
  if (!["api", "worker"].includes(service) || process.argv.length !== 3) {
    throw new Error("Usage: node app/replay.mjs api|worker < snapshot.json");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Snapshot exceeds 64 KiB");
    chunks.push(chunk);
  }
  const snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const evidence = service === "api" ? await replayApi(snapshot) : replayWorker(snapshot);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
