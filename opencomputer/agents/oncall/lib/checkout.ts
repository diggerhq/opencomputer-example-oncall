import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { repository, checkoutDirectory } from "./target.js";
import type { Locator } from "./incident.js";

const exec = promisify(execFile);

// Check the immutable Git source, so this remains valid after the agent edits
// the working tree. The digest matches app/release.mjs in the application.
export async function requireCheckout(incident: Locator, cwd = process.cwd(), signal?: AbortSignal) {
  const checkout = path.join(cwd, checkoutDirectory);
  const git = async (args: string[]) => (await exec("git", args, {
    cwd: checkout, encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576, signal,
  })).stdout;
  if ((await git(["rev-parse", "HEAD"])).trim() !== incident.commit) {
    throw new Error("Check out the exact Git commit from the Sentry incident before investigating.");
  }
  const origin = (await git(["remote", "get-url", "origin"])).trim().replace(/\.git$/, "");
  if (origin !== `https://github.com/${repository}`) throw new Error("The checkout is not the configured application repository.");
  const names = (await git(["ls-tree", "--name-only", `${incident.commit}:app`])).trim().split("\n")
    .filter(name => /^[a-zA-Z0-9_-]+\.mjs$/.test(name)).sort();
  if (!names.length || names.length > 50) throw new Error("Unexpected application source tree.");
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name).update("\0").update(await git(["show", `${incident.commit}:app/${name}`])).update("\0");
  }
  if (`oncall-reporting@${hash.digest("hex").slice(0, 12)}` !== incident.release) {
    throw new Error("The Sentry release does not match the checked-out application source.");
  }
  return checkout;
}
