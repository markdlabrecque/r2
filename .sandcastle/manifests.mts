import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { keyFor, stateDir } from "./board.mts";
import type { Manifest } from "./graph.mts";

// Manifest store: <stateDir>/graph/<project>--<iid>.json, next to the run records.

const dir = () => resolve(stateDir(), "graph");
const file = (project: string, iid: number) => resolve(dir(), `${keyFor(String(iid), project)}.json`);

export function readManifest(project: string, iid: number): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(file(project, iid), "utf8"));
  } catch {
    return undefined;
  }
}

export function writeManifest(m: Manifest): void {
  mkdirSync(dir(), { recursive: true });
  const f = file(m.project, m.iid);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, f);
}

/** Merge fields into a ticket's manifest, creating a bare one if the ticket was never analysed. */
export function patchManifest(project: string, iid: number, patch: Partial<Manifest>): void {
  const cur: Manifest = readManifest(project, iid) ?? {
    iid, project, hash: "", analyzedAt: "", base: "", baseSha: "",
    provides: [], requires: [], footprint: [], catalogueIids: [], blockerHashes: {},
  };
  writeManifest({ ...cur, ...patch, iid, project });
}

export function readManifests(project: string): Map<number, Manifest> {
  const out = new Map<number, Manifest>();
  if (!existsSync(dir())) return out;
  const prefix = keyFor("", project);
  for (const f of readdirSync(dir()).filter((n) => n.startsWith(prefix) && n.endsWith(".json"))) {
    try {
      const m: Manifest = JSON.parse(readFileSync(resolve(dir(), f), "utf8"));
      if (m.project === project) out.set(m.iid, m);
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

export function removeManifest(project: string, iid: number): void {
  rmSync(file(project, iid), { force: true });
}
