import { rm } from "node:fs/promises";

const agent = new URL("../opencomputer/agents/oncall/", import.meta.url);
// CLI 0.6.7 otherwise discovers its previous generated modules as authored tools.
await rm(new URL(".opencomputer/runtime/", agent), { recursive: true, force: true });
await rm(new URL("workspace/", agent), { recursive: true, force: true });
console.log("Prepared agent runtime. Each incident session clones its source from GitHub.");
