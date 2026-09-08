import { execFile } from "node:child_process";
import path from "node:path";
import type { DataValue } from "@opencomputer/agent";
import type { ApiSnapshot, Service, WorkerSnapshot } from "./incident.js";

export function replay(service: Service, snapshot: ApiSnapshot | WorkerSnapshot, cwd = process.cwd(), signal?: AbortSignal): Promise<DataValue> {
  return new Promise((resolve, reject) => {
    const child = execFile("node", [path.join(cwd, "app/replay.mjs"), service], {
      cwd, timeout: 15_000, maxBuffer: 65_536, signal,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Replay runner failed (${error.code ?? "unknown"}): ${stderr.trim().slice(0, 1000)}`));
        return;
      }
      try { resolve(JSON.parse(stdout) as DataValue); } catch { reject(new Error("Replay runner did not return valid JSON evidence")); }
    });
    child.stdin?.on("error", () => { /* Process errors are returned by execFile. */ });
    child.stdin?.end(JSON.stringify(snapshot));
  });
}
