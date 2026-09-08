import { appendFile, mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { root } from "./config.mjs";

function readable(value) {
  if (typeof value === "string") {
    // Code tools serialize their result as JSON inside a text content block.
    if (/^\s*[\[{]/.test(value)) {
      try { return readable(JSON.parse(value)); } catch { /* Keep ordinary tool text verbatim. */ }
    }
    return value;
  }
  if (value === undefined) return "(no output)";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (value.every((item) => item?.type === "text" && typeof item.text === "string")) {
      return value.map((item) => readable(item.text)).join("\n");
    }
    return value.map((item) => `- ${readable(item).replace(/\n/g, "\n  ")}`).join("\n");
  }
  if (typeof value === "object") {
    if (Object.keys(value).length === 1 && Array.isArray(value.content)) return readable(value.content);
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return entries.map(([key, item]) => {
      const text = readable(item);
      return text.includes("\n") || (item !== null && typeof item === "object")
        ? `${key}:\n  ${text.replace(/\n/g, "\n  ")}`
        : `${key}: ${text}`;
    }).join("\n");
  }
  return String(value);
}

// Only the terminal view is shortened. The JSONL log keeps the original event.
export function formatToolOutput(value) {
  const text = stripVTControlCharacters(readable(value))
    .replace(/(?:file:\/\/)?\/blue\/sessions\/[^\s"']+?\/workspace\b/g, "<workspace>")
    .replace(/(?:file:\/\/)?\/workspace\b/g, "<workspace>");
  const lines = text.split("\n");
  const bounded = lines.slice(0, 100).join("\n").slice(0, 8000);
  return bounded + (lines.length > 100 || bounded.length < text.length ? "\n… output shortened; full event saved in .oncall/" : "");
}

function show(label, value) {
  console.log(`\nOpenComputer · ${label}`);
  for (const line of formatToolOutput(value).split("\n")) console.log(`OpenComputer │ ${line}`);
}

export async function followSession(sessionId, config) {
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("Invalid OpenComputer session ID");
  const directory = new URL(".oncall/", root);
  await mkdir(directory, { recursive: true });
  const log = new URL(`${sessionId}.jsonl`, directory);
  let cursor = 0;
  let shownTools;
  console.log(`OpenComputer: following session ${sessionId}. Raw events: .oncall/${sessionId}.jsonl`);
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${config.origin}/api/managed-agents/sessions/${sessionId}/events?after=${cursor}`, {
      headers: { "x-api-key": config.apiKey }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Reading session events failed (HTTP ${response.status})`);
    const { events } = await response.json();
    if (!Array.isArray(events)) throw new Error("OpenComputer returned invalid session events");
    for (const event of events) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= cursor) continue;
      cursor = event.seq;
      await appendFile(log, JSON.stringify(event) + "\n", { mode: 0o600 });
      const data = event.data ?? {};
      if (event.type === "agent.rendered") {
        const tools = (Array.isArray(data.enabledTools) ? data.enabledTools : []).filter((tool) => typeof tool === "string").sort().join(", ");
        if (tools !== shownTools) { console.log(`\nOpenComputer · Tools: ${tools}\n`); shownTools = tools; }
      } else if (event.type === "tool.started") {
        if (data.input != null) show(`${data.tool ?? "tool"} · started`, data.input);
        else console.log(`OpenComputer → ${data.tool ?? "tool"}`);
      } else if (event.type === "tool.completed") {
        show(`${data.tool ?? "tool"} · completed`, data.output);
      } else if (event.type === "tool.failed") {
        show(`${data.tool ?? "tool"} · failed`, data.error ?? data.message ?? data.output ?? data);
      } else if (event.type === "message.completed" && data.text) {
        show("Agent", data.text);
      } else if (event.type === "turn.completed") {
        // Keep the replay workspace available for inspection without leaving it running.
        const suspended = await fetch(`${config.origin}/api/managed-agents/sessions/${sessionId}/suspend`, {
          method: "POST", headers: { "x-api-key": config.apiKey }, redirect: "error", signal: AbortSignal.timeout(30_000),
        });
        console.log(suspended.ok ? "OpenComputer: session suspended." : `OpenComputer: session finished; suspend returned HTTP ${suspended.status}.`);
        return;
      } else if (event.type === "turn.failed" || event.type === "session.failed" || event.type === "runtime.disconnected") {
        throw new Error(`OpenComputer session stopped: ${formatToolOutput(data.message ?? data.reason ?? event.type)}`);
      }
    }
    await sleep(1000);
  }
  throw new Error(`Stopped following after 12 minutes. The session may still be running; inspect ${sessionId} in the dashboard.`);
}
