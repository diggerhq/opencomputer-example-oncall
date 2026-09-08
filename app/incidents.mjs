import { handleRequest } from "./api.mjs";
import { runWorkerBatch } from "./worker.mjs";
import { createApiSnapshot, createWorkerSnapshot, RELEASE } from "./fixtures.mjs";

export { createApiSnapshot, createWorkerSnapshot, RELEASE } from "./fixtures.mjs";

export async function captureIncident(service) {
  if (service === "api") {
    const snapshot = createApiSnapshot();
    try {
      await handleRequest(new Request(`http://reporting.local${snapshot.request.path}`), snapshot);
    } catch (error) {
      return {
        service, release: RELEASE, snapshot, error,
        breadcrumbs: [{
          category: "http",
          message: `${snapshot.request.method} ${snapshot.request.path}`,
          level: "error",
          data: { status: 500 },
        }],
      };
    }
  } else if (service === "worker") {
    const snapshot = createWorkerSnapshot();
    const result = runWorkerBatch(structuredClone(snapshot), { maxSteps: snapshot.maxSteps });
    if (result.errors.length) {
      return {
        service, release: RELEASE, snapshot, error: result.errors[0],
        breadcrumbs: result.attempts.map((attempt) => ({
          category: "report-worker",
          message: `Report job ${attempt.jobId}: ${attempt.outcome}`,
          level: attempt.outcome === "failed" ? "error" : "info",
          data: { step: attempt.step, jobId: attempt.jobId },
        })),
      };
    }
  } else {
    throw new Error("Service must be api or worker");
  }
  throw new Error(`The ${service} fixture did not produce an incident`);
}
