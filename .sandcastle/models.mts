// Model choice. AGENT.modelLabels (config.mts) maps ticket labels to models. Empty: one fixed model,
// AGENT.model, for every run. Non-empty: the ticket's single model label picks the implementer's
// model, and those models are the only ones allowed anywhere (AGENT.model, GRAPH.model).

import { homedir } from "node:os";

/** The implementer's model for a ticket, or why it has none. */
export function ticketModel(labels: string[], modelLabels: Record<string, string>, fixed: string): { model: string } | { error: string } {
  const choices = Object.keys(modelLabels);
  if (!choices.length) return { model: fixed };
  const found = labels.filter((l) => l in modelLabels);
  if (found.length === 1) return { model: modelLabels[found[0]] };
  const list = choices.join(", ");
  return { error: found.length ? `has ${found.length} model labels (${found.join(", ")}); keep one of ${list}` : `needs a model label: one of ${list}` };
}

/** Configured models outside the allowlist, as an error message; undefined when all are allowed. */
export function disallowedModels(modelLabels: Record<string, string>, configured: string[]): string | undefined {
  const allowed = new Set(Object.values(modelLabels));
  if (!allowed.size) return undefined;
  const bad = configured.filter((m) => !allowed.has(m));
  return bad.length ? `model(s) ${bad.join(", ")} are not in AGENT.modelLabels (${[...allowed].join(", ")}); config.mts may only use those.` : undefined;
}

// ---- Pi provider wiring ------------------------------------------------------------------------
// Models are "<pi provider>/<id>". The personal config uses the pi-claude-subscription provider, a Pi
// extension that runs `claude -p` on a Claude subscription. It is not part of Pi, so it must be loaded
// explicitly wherever Pi runs with extension discovery off (host analysis), and installed in the image.

export const SUBSCRIPTION_PROVIDER = "pi-claude-subscription";
/** The supported host install: a pi package install runs the package's husky `prepare` hook and fails. */
const INSTALL_HINT = "git clone --depth 1 --branch <tag> https://github.com/markdlabrecque/pi-claude-subscription.git ~/.pi/agent/extensions/pi-claude-subscription && cd ~/.pi/agent/extensions/pi-claude-subscription && npm ci --omit=dev --ignore-scripts";
export const isSubscriptionModel = (model: string) => model.startsWith(`${SUBSCRIPTION_PROVIDER}/`);

/** Where the provider extension's index.ts lives on the host. FACTORY_PI_SUBSCRIPTION_EXTENSION overrides. */
export function subscriptionExtensionPath(env: Record<string, string | undefined>): string {
  return env.FACTORY_PI_SUBSCRIPTION_EXTENSION || `${env.HOME || homedir()}/.pi/agent/extensions/${SUBSCRIPTION_PROVIDER}/index.ts`;
}

/**
 * Environment for a container Pi run. The subscription provider needs none from here: the image's Claude
 * Code CLI reads CLAUDE_CODE_OAUTH_TOKEN, which Sandcastle passes from .sandcastle/.env. Only an openai/
 * model (a custom config) gets a per-run OpenAI credential, minted lazily so it is never asked for otherwise.
 */
export function piEnvFor(model: string, openaiCredential: () => string): Record<string, string> {
  return model.startsWith("openai/") ? { OPENAI_API_KEY: openaiCredential() } : {};
}

/** Arguments for the read-only host analysis. Only the provider extension is loaded, by an explicit -e. */
export function piAnalysisArgs(model: string, env: Record<string, string | undefined>, exists: (path: string) => boolean): string[] {
  const args = ["-p", "--model", model, "--tools", "read,grep,find,ls", "--no-extensions", "--no-skills", "--no-context-files", "--no-session"];
  if (!isSubscriptionModel(model)) return args;
  const extension = subscriptionExtensionPath(env);
  if (!exists(extension)) throw new Error(`${SUBSCRIPTION_PROVIDER} extension not found at ${extension}. Install it (see orchestrator/ADAPTING.md) or set FACTORY_PI_SUBSCRIPTION_EXTENSION.`);
  return [...args, "-e", extension];
}

/** Host checks for the subscription provider; one message per problem, none when no model needs it. Never sees a credential. */
export function subscriptionPreflight(args: {
  models: string[];
  env: Record<string, string | undefined>;
  run: (cmd: string, args: string[]) => string;
  exists: (path: string) => boolean;
}): string[] {
  const used = [...new Set(args.models.filter(isSubscriptionModel))];
  if (!used.length) return [];
  const problems: string[] = [];
  const extension = subscriptionExtensionPath(args.env);
  if (!args.exists(extension)) {
    return [`${SUBSCRIPTION_PROVIDER} extension not found at ${extension}. Install it with: ${INSTALL_HINT}`];
  }
  try {
    if (!/"loggedIn":\s*true/.test(args.run("claude", ["auth", "status"]))) throw new Error("not logged in");
  } catch {
    problems.push("claude isn't logged in on the host. Run: claude auth login");
  }
  try {
    const listed = args.run("pi", ["--offline", "--no-extensions", "-e", extension, "--list-models", SUBSCRIPTION_PROVIDER]);
    for (const m of used) if (!listed.includes(m.slice(SUBSCRIPTION_PROVIDER.length + 1))) problems.push(`pi does not list ${m} from the provider; update the extension.`);
  } catch {
    problems.push(`pi could not load the ${SUBSCRIPTION_PROVIDER} extension from ${extension}.`);
  }
  return problems;
}
