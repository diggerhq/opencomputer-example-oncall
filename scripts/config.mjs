import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const root = new URL("../", import.meta.url);
const env = new URL(".env", root);
if (existsSync(env)) loadEnvFile(env);

export function sentryConfig() {
  const names = ["SENTRY_DSN", "SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Set ${missing.join(", ")} in .env (see .env.example)`);
  return {
    dsn: process.env.SENTRY_DSN,
    token: process.env.SENTRY_AUTH_TOKEN,
    organization: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
  };
}

export async function opencomputerConfig() {
  const binding = JSON.parse(await readFile(new URL(".opencomputer/project.json", root), "utf8"));
  const config = JSON.parse(await readFile(
    process.env.OPENCOMPUTER_CONFIG ?? join(homedir(), ".opencomputer/config.json"), "utf8",
  ));
  const origin = new URL(binding.apiUrl).origin;
  if (origin !== "https://app.opencomputer.dev") throw new Error("Expected a project linked to https://app.opencomputer.dev");
  if (new URL(config.apiUrl ?? origin).origin !== origin || !config.apiKey) {
    throw new Error("Run npx opencomputer login for this API target");
  }
  return { origin, apiKey: config.apiKey, projectId: binding.projectId };
}

export function serviceArgument() {
  const service = process.argv[2];
  if (!["api", "worker"].includes(service) || process.argv.length !== 3) {
    throw new Error("Choose api or worker, for example: npm run demo -- worker");
  }
  return service;
}
