import { readFile } from "node:fs/promises";
import { root, opencomputerConfig } from "./config.mjs";
import { followSession } from "./session.mjs";

try {
  const target = process.argv[2];
  if (process.argv.length !== 3 || !target || !/^[a-zA-Z0-9-]+$/.test(target)) {
    throw new Error("Choose api, worker, or a session ID: npm run follow -- worker");
  }
  let sessionId = target;
  if (target === "api" || target === "worker") {
    let saved;
    try {
      saved = JSON.parse(await readFile(new URL(`.oncall/${target}-latest.json`, root), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`No saved ${target} session. Run npm run demo -- ${target} first.`);
      throw error;
    }
    sessionId = saved.sessionId;
    if (saved.sessionUrl) console.log(`OpenComputer session: ${saved.sessionUrl}`);
  }
  const oc = await opencomputerConfig();
  console.log("Closing this terminal does not stop the cloud session.");
  await followSession(sessionId, oc);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
