import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { root, sentryConfig } from "./config.mjs";

async function cli(args, { input, quiet = false } = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("node_modules/@opencomputer/cli/dist/index.js", root)), ...args], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; if (!quiet) process.stdout.write(data); });
  child.stderr.on("data", (data) => { if (!quiet) process.stderr.write(data); });
  child.stdin.end(input);
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`opencomputer ${args[0]} failed (exit ${code})`)));
  });
  return quiet ? JSON.parse(output) : undefined;
}

try {
  const sentry = sentryConfig();
  await import("./prepare-agent.mjs");
  await cli(["doctor"]);
  if (!existsSync(new URL(".opencomputer/project.json", root))) {
    await cli(["link", "--create-project", "oncall"]);
  }
  await cli(["secrets", "set", "SENTRY_AUTH_TOKEN", "--environment", "development",
    "--allow-origin", "https://sentry.io", "--value-stdin"], { input: sentry.token });
  await cli(["deploy", "--alias", "development"]);
  const webhookPath = new URL(".opencomputer/webhook.json", root);
  if (!existsSync(webhookPath)) {
    const webhook = await cli(["webhooks", "create", "sentry-demo", "--agent", "oncall",
      "--environment", "development", "--json"], { quiet: true });
    if (!webhook.token || !webhook.invocationUrl) {
      throw new Error("Webhook already exists but its token is not saved locally. Restore .opencomputer/webhook.json or create a new webhook in the dashboard.");
    }
    const binding = JSON.parse(await readFile(new URL(".opencomputer/project.json", root), "utf8"));
    await mkdir(new URL(".opencomputer/", root), { recursive: true });
    await writeFile(webhookPath, JSON.stringify({
      projectId: binding.projectId, environment: "development", agentId: "oncall",
      id: webhook.id, url: webhook.invocationUrl, token: webhook.token,
    }) + "\n", { mode: 0o600 });
  }
  console.log("Ready. Run npm run demo -- api, then npm run demo -- worker.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
