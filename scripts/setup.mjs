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

const IDENTITY = "body:/data/event/event_id";

// The agent pins the Sentry organization and project slugs with the
// deployment (lib/target.ts); the scripts read them from .env. Refuse to
// set up a deployment whose slugs differ from the project being captured to.
async function checkSentryTarget(sentry) {
  const target = await readFile(new URL("opencomputer/agents/oncall/lib/target.ts", root), "utf8");
  const pinned = Object.fromEntries(
    ["sentryOrganization", "sentryProject"].map((name) => [name, target.match(new RegExp(`${name} = "([^"]+)"`))?.[1]]),
  );
  if (pinned.sentryOrganization !== sentry.organization || pinned.sentryProject !== sentry.project) {
    throw new Error(
      `lib/target.ts pins Sentry ${pinned.sentryOrganization}/${pinned.sentryProject} but .env names ${sentry.organization}/${sentry.project}; make them the same.`,
    );
  }
}

try {
  const sentry = sentryConfig();
  await checkSentryTarget(sentry);
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  if (!githubToken) throw new Error("Set GITHUB_TOKEN in .env with Contents and Pull requests write access to this example repository.");
  await import("./prepare-agent.mjs");
  await cli(["doctor"]);
  if (!existsSync(new URL(".opencomputer/project.json", root))) {
    await cli(["link", "--create-project", "oncall"]);
  }
  await cli(["secrets", "set", "SENTRY_AUTH_TOKEN", "--environment", "development",
    "--allow-origin", "https://sentry.io", "--value-stdin"], { input: sentry.token });
  await cli(["secrets", "set", "GITHUB_TOKEN", "--environment", "development",
    "--allow-origin", "https://api.github.com", "--value-stdin"], { input: githubToken });
  await cli(["deploy", "--alias", "development"]);
  const webhookPath = new URL(".opencomputer/webhook.json", root);
  if (!existsSync(webhookPath)) {
    // The delivery identity is the Sentry event id in the alert body, so a
    // Sentry retry of the same alert never starts a second investigation.
    const webhook = await cli(["webhooks", "create", "sentry-demo", "--agent", "oncall",
      "--environment", "development", "--identity", IDENTITY, "--json"], { quiet: true });
    if (!webhook.token || !webhook.invocationUrl) {
      throw new Error("Webhook already exists but its token is not saved locally. Restore .opencomputer/webhook.json or create a new webhook in the dashboard.");
    }
    const binding = JSON.parse(await readFile(new URL(".opencomputer/project.json", root), "utf8"));
    await mkdir(new URL(".opencomputer/", root), { recursive: true });
    await writeFile(webhookPath, JSON.stringify({
      projectId: binding.projectId, environment: "development", agentId: "oncall",
      id: webhook.id, url: webhook.invocationUrl, token: webhook.token,
    }) + "\n", { mode: 0o600 });
  } else {
    const webhook = JSON.parse(await readFile(webhookPath, "utf8"));
    await cli(["webhooks", "update", webhook.id, "--agent", "oncall", "--environment", "development",
      "--identity", IDENTITY, "--json"], { quiet: true });
  }
  const webhook = JSON.parse(await readFile(webhookPath, "utf8"));
  const deliveryUrl = webhook.url.includes(webhook.token) ? webhook.url : `${webhook.url}/${webhook.token}`;
  console.log(`
Ready. Sentry must deliver issue alerts to this agent; do this once, in Sentry:
  1. Settings → Developer Settings → Custom Integrations → Create Internal Integration.
     Name: OpenComputer on-call. Webhook URL (this is a credential; paste it, do not share it):
     ${deliveryUrl}
     Enable "Alert Rule Action". No permissions are needed for delivery.
  2. Alerts → Create Alert → Issues, project ${sentry.project}:
     when "A new issue is created", then "Send a notification via OpenComputer on-call".
Then: npm run demo -- api, and npm run demo -- worker.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
