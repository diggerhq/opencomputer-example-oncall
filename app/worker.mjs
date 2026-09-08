function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function generateReport(job) {
  if (!Array.isArray(job.rows)) throw new Error("Report job rows must be an array");
  if (job.rows.length === 0) return "";
  const columns = Object.keys(job.rows[0]);
  return [columns, ...job.rows.map((row) => columns.map((column) => row[column]))]
    .map((row) => row.map(csvCell).join(","))
    .join("\n") + "\n";
}

export function runWorkerBatch(state, { maxSteps = 4 } = {}) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 8) {
    throw new Error("maxSteps must be an integer between 1 and 8");
  }
  const attempts = [];
  const outputs = {};
  const errors = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    const job = state.jobs
      .filter((item) => item.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!job) break;
    job.attempts += 1;
    try {
      outputs[job.id] = generateReport(job);
      job.status = "completed";
      attempts.push({ step, jobId: job.id, outcome: "completed" });
    } catch (error) {
      job.lastError = error.message;
      errors.push(error);
      attempts.push({ step, jobId: job.id, outcome: "failed", error: error.message });
    }
  }
  return { attempts, outputs, errors };
}
