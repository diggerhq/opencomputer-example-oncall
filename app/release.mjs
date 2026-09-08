import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

const directory = new URL("./", import.meta.url);
const hash = createHash("sha256");
for (const name of readdirSync(directory).filter((name) => name.endsWith(".mjs")).sort()) {
  hash.update(name).update("\0").update(readFileSync(new URL(name, directory))).update("\0");
}
export const RELEASE = `oncall-reporting@${hash.digest("hex").slice(0, 12)}`;
