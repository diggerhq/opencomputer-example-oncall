import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { RELEASE } from "../app/release.mjs";

const agent = new URL("../opencomputer/agents/oncall/", import.meta.url);
// CLI 0.6.7 otherwise discovers its previous generated modules as authored tools.
await rm(new URL(".opencomputer/runtime/", agent), { recursive: true, force: true });
await rm(new URL("workspace/", agent), { recursive: true, force: true });
await mkdir(new URL("workspace/", agent), { recursive: true });
await cp(new URL("../app/", import.meta.url), new URL("workspace/app/", agent), { recursive: true });
await writeFile(new URL("workspace/app/release.json", agent), JSON.stringify({ release: RELEASE }) + "\n");
console.log(`Packaged reporting app ${RELEASE}`);
