import { appendFile, mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { root } from "./config.mjs";

export async function followSession(sessionId, config) {
  const directory = new URL(".oncall/", root);
  await mkdir(directory, { recursive: true });
  const log = new URL(`${sessionId}.jsonl`, directory);
  let cursor = 0;
  let shownTools;
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${config.origin}/api/managed-agents/sessions/${sessionId}/events?after=${cursor}`, {
      headers: { "x-api-key": config.apiKey }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Reading session events failed (HTTP ${response.status})`);
    const { events } = await response.json();
    if (!Array.isArray(events)) throw new Error("OpenComputer returned invalid session events");
    for (const event of events) {
      if (event.seq <= cursor) continue;
      cursor = event.seq;
      await appendFile(log, JSON.stringify(event) + "\n", { mode: 0o600 });
      if (event.type === "agent.rendered") {
        const tools = [...event.data.enabledTools].sort().join(", ");
        if (tools !== shownTools) { console.log(`\nTools: ${tools}\n`); shownTools = tools; }
      } else if (event.type === "tool.started") {
        console.log(`→ ${event.data.tool}`);
      } else if (event.type === "message.completed" && event.data.text) {
        console.log(`\n${event.data.text}\n`);
      } else if (event.type === "turn.completed") {
        // Keep the replay workspace available for inspection without leaving it running.
        const suspended = await fetch(`${config.origin}/api/managed-agents/sessions/${sessionId}/suspend`, {
          method: "POST", headers: { "x-api-key": config.apiKey }, redirect: "error", signal: AbortSignal.timeout(30_000),
        });
        console.log(suspended.ok ? "Session suspended." : `Session finished; suspend returned HTTP ${suspended.status}.`);
        return;
      } else if (event.type === "turn.failed" || event.type === "runtime.disconnected") {
        throw new Error(`Session stopped: ${event.data.message ?? event.data.reason ?? event.type}`);
      }
    }
    await sleep(1000);
  }
  throw new Error(`Stopped following after 12 minutes. The session may still be running; inspect ${sessionId} in the dashboard.`);
}
