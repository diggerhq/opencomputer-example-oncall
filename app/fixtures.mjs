export { RELEASE } from "./release.mjs";

export function createApiSnapshot() {
  return {
    version: 1,
    request: { method: "GET", path: "/reports/report-legacy" },
    reports: [
      {
        id: "report-legacy",
        title: "June usage",
        timezone: null,
        createdAt: "2026-06-30T12:00:00.000Z",
      },
      {
        id: "report-current",
        title: "August usage",
        timezone: "Europe/London",
        createdAt: "2026-08-31T12:00:00.000Z",
      },
    ],
  };
}

export function createWorkerSnapshot() {
  return {
    version: 1,
    maxSteps: 4,
    jobs: [
      {
        id: "job-101",
        createdAt: "2026-09-08T09:00:00.000Z",
        status: "pending",
        attempts: 0,
        reportId: "report-101",
        rows: null,
      },
      {
        id: "job-102",
        createdAt: "2026-09-08T09:01:00.000Z",
        status: "pending",
        attempts: 0,
        reportId: "report-102",
        rows: [{ account: "Example North", total: 120 }],
      },
      {
        id: "job-103",
        createdAt: "2026-09-08T09:02:00.000Z",
        status: "pending",
        attempts: 0,
        reportId: "report-103",
        rows: [{ account: "Example South", total: 75 }],
      },
    ],
  };
}
