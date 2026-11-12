// Host preflight for the pi-claude-subscription provider, run by dispatch.sh before a pass. Prints each
// problem to stderr and exits 1; exits 0 when the configured models need no subscription provider or it is ready.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { AGENT, GRAPH } from "./config.mts";
import { subscriptionPreflight } from "./models.mts";

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 });
const problems = subscriptionPreflight({
  models: [...Object.values(AGENT.modelLabels), AGENT.model, GRAPH.model],
  env: process.env,
  run,
  exists: existsSync,
});
for (const p of problems) console.error(`preflight: ${p}`);
process.exitCode = problems.length ? 1 : 0;
