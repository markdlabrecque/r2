import { createHash } from "node:crypto";

// Ticket graph: pure logic, no I/O. Two relations between tickets:
// - dependency (directed): a ticket can't start until each blocker is merged into its base or closed.
//   Stored per ticket in a manifest, from the analysis run or reported by the implementer.
// - conflict (undirected): two tickets whose file footprints overlap can't be live at the same time.
//   Computed every dispatcher pass, never stored.

// Appended to every comment Sandcastle posts, so its own comments never change a ticket's hash.
export const SANDCASTLE_MARK = "<!-- sandcastle -->";

export interface Note {
  body: string;
  system?: boolean;
}

export interface Requirement {
  what: string;
  providedBy: number | null; // iid of the open ticket that creates it, null if none does
  evidence: string;
  confidence: number; // 0..1
}

export interface ImplementerBlocker {
  iid: number | null;
  what: string;
  evidence: string;
}

export interface Manifest {
  iid: number;
  project: string;
  hash: string; // contentHash of the ticket when analysed
  analyzedAt: string;
  base: string;
  baseSha: string;
  provides: string[];
  requires: Requirement[];
  footprint: string[]; // predicted paths: files, or directories ending in "/"
  catalogueIids: number[]; // open tickets the analysis could name as providers
  blockerHashes: Record<string, string>; // providing ticket iid -> its catalogue hash when analysed
  actualFootprint?: string[]; // set once the implementer commits; replaces the prediction
  implementerBlockers?: ImplementerBlocker[]; // from blocked.json; cleared by the next analysis
}

export interface Edge {
  from: number; // blocker
  to: number; // dependent
  what: string;
  evidence: string;
  confidence: number;
  source: "analysis" | "implementer";
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const clean = (s: string | null | undefined) => (s ?? "").replace(/\r\n/g, "\n").trim();

export const isSandcastleNote = (n: Note) =>
  !!n.system || n.body.includes(SANDCASTLE_MARK) || /^## Sandcastle verification:/.test(n.body.trimStart());

/** Hash of what a person can change: title, description, and comments not written by Sandcastle or the system. Labels don't count. */
export function contentHash(t: { title: string; description?: string | null; notes?: Note[] }): string {
  const notes = (t.notes ?? []).filter((n) => !isSandcastleNote(n)).map((n) => clean(n.body));
  return sha(JSON.stringify([clean(t.title), clean(t.description), notes]));
}

export interface Parent {
  iid: number;
  title: string;
  description: string;
}

/** Hash of what an agent builds from. A task's parent counts, so editing the parent re-analyses its tasks. */
export function unitHash(t: { title: string; description?: string | null; parent?: Parent }, notes: Note[] = []): string {
  const parent = t.parent ? `\n\n#${t.parent.iid} ${clean(t.parent.title)}\n${clean(t.parent.description)}` : "";
  return contentHash({ title: t.title, description: clean(t.description) + parent, notes });
}

// ---- units of work ---------------------------------------------------------------

/** A GitLab Task under an issue. */
export interface Child {
  iid: number;
  open: boolean;
}

/**
 * Which tickets get runs. With `subtasks`, an issue that has Tasks is only a container: its open
 * Tasks are the units, and once every Task is closed the issue moves to the next stage (`advance`).
 * An issue without Tasks, or any issue when `subtasks` is off, is a unit itself.
 * Units are unique by ticket id: when a Task is ready itself as well as via its ready parent, the
 * copy with parent context wins, whatever order they were listed in.
 */
export function expandUnits(parents: number[], childrenOf: Map<number, Child[]>, subtasks: boolean): { units: { iid: number; parent?: number }[]; advance: number[] } {
  const byIid = new Map<number, { iid: number; parent?: number }>();
  const add = (u: { iid: number; parent?: number }) => {
    const seen = byIid.get(u.iid);
    if (!seen) byIid.set(u.iid, u);
    else if (seen.parent === undefined && u.parent !== undefined) seen.parent = u.parent;
  };
  const advance: number[] = [];
  for (const p of parents) {
    const kids = subtasks ? (childrenOf.get(p) ?? []) : [];
    if (!kids.length) add({ iid: p });
    else if (kids.every((k) => !k.open)) advance.push(p);
    else for (const k of kids) if (k.open) add({ iid: k.iid, parent: p });
  }
  return { units: [...byIid.values()], advance };
}

// ---- footprints ----------------------------------------------------------------

// A footprint entry is a path ("a/b.php", which also covers anything under "a/b.php/"), a directory
// ("a/"), or a glob ("a/b.*"). Directories and globs claim every path starting with their stem.
interface Claim {
  stem: string;
  prefix: boolean;
}
function claim(entry: string): Claim {
  const e = entry.trim().replace(/^\.?\/+/, "");
  const star = e.indexOf("*");
  if (star >= 0) return { stem: e.slice(0, star), prefix: true };
  return { stem: e, prefix: e.endsWith("/") || e === "" };
}
/** Every path `inner` claims is also claimed by `outer`. */
function contains(outer: Claim, inner: Claim): boolean {
  if (outer.prefix) return inner.stem.startsWith(outer.stem);
  return (!inner.prefix && inner.stem === outer.stem) || inner.stem.startsWith(`${outer.stem}/`);
}

/** Some path is claimed by both entries. */
export function pathsOverlap(a: string, b: string): boolean {
  const x = claim(a);
  const y = claim(b);
  return contains(x, y) || contains(y, x);
}

/** Entries of `a` that overlap anything in `b`. Paths inside an `ignore` entry never count. */
export function overlap(a: string[], b: string[], ignore: string[] = []): string[] {
  const ign = ignore.map(claim);
  const keep = (p: string) => !ign.some((i) => contains(i, claim(p)));
  const bb = b.filter(keep);
  return a.filter(keep).filter((p) => bb.some((q) => pathsOverlap(p, q)));
}

// ---- edges ---------------------------------------------------------------------

export function edgesOf(m: Manifest): Edge[] {
  const out: Edge[] = [];
  for (const r of m.requires) {
    if (r.providedBy != null && r.providedBy !== m.iid) out.push({ from: r.providedBy, to: m.iid, what: r.what, evidence: r.evidence, confidence: r.confidence, source: "analysis" });
  }
  for (const b of m.implementerBlockers ?? []) {
    if (b.iid != null && b.iid !== m.iid) out.push({ from: b.iid, to: m.iid, what: b.what, evidence: b.evidence, confidence: 1, source: "implementer" });
  }
  return out;
}

/** Drop the weakest edge of each cycle until none is left. Ties: analysis before implementer, then lowest (from, to). */
export function breakCycles(edges: Edge[]): { kept: Edge[]; dropped: Edge[] } {
  let kept = [...edges];
  const dropped: Edge[] = [];
  for (;;) {
    const cycle = findCycle(kept);
    if (!cycle) return { kept, dropped };
    const weakest = [...cycle].sort(
      (a, b) => a.confidence - b.confidence || (a.source === b.source ? 0 : a.source === "analysis" ? -1 : 1) || a.from - b.from || a.to - b.to,
    )[0];
    dropped.push(weakest);
    kept = kept.filter((e) => e !== weakest);
  }
}

function findCycle(edges: Edge[]): Edge[] | null {
  const out = new Map<number, Edge[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const state = new Map<number, 1 | 2>(); // 1 = on the stack, 2 = finished
  const path: Edge[] = [];
  const visit = (n: number): Edge[] | null => {
    state.set(n, 1);
    for (const e of out.get(n) ?? []) {
      if (state.get(e.to) === 1) {
        const start = path.findIndex((p) => p.from === e.to);
        return [...(start >= 0 ? path.slice(start) : []), e];
      }
      if (!state.has(e.to)) {
        path.push(e);
        const found = visit(e.to);
        if (found) return found;
        path.pop();
      }
    }
    state.set(n, 2);
    return null;
  };
  for (const n of [...out.keys()].sort((a, b) => a - b)) {
    if (!state.has(n)) {
      const found = visit(n);
      if (found) return found;
    }
  }
  return null;
}

// ---- analysis freshness --------------------------------------------------------

/** Why a ticket needs (re-)analysis, or null when its manifest is current. `catalogue` maps open ticket iid -> catalogue hash. */
export function staleReason(m: Manifest | undefined, hash: string, catalogue: Map<number, string>): string | null {
  if (!m) return "not analysed yet";
  if (m.hash !== hash) return "ticket changed";
  for (const [iid, h] of Object.entries(m.blockerHashes)) {
    const now = catalogue.get(Number(iid));
    if (now !== undefined && now !== h) return `blocker #${iid} changed`;
  }
  if (m.requires.some((r) => r.providedBy == null)) {
    const known = new Set(m.catalogueIids);
    if ([...catalogue.keys()].some((i) => i !== m.iid && !known.has(i))) return "new tickets may provide what it needs";
  }
  return null;
}

// ---- dispatch decision ---------------------------------------------------------

export interface DecideInput {
  candidates: { iid: number; hash: string }[]; // in dispatch order
  manifests: Map<number, Manifest>;
  satisfied: (iid: number) => boolean; // blocker merged into the base, or closed
  queue: Set<number>; // tickets Sandcastle will run or is running; blockers outside it need a person
  live: { iid: number; footprint: string[] }[];
  room: number;
  ignore?: string[];
}

export type Decision = { iid: number; launch: true } | { iid: number; launch: false; reason: string };

export function decide(input: DecideInput): { decisions: Decision[]; dropped: Edge[] } {
  const { kept, dropped } = breakCycles([...input.manifests.values()].flatMap(edgesOf));
  const live = input.live.map((l) => ({ ...l }));
  let room = input.room;
  const decisions: Decision[] = input.candidates.map(({ iid, hash }) => {
    const m = input.manifests.get(iid);
    if (!m || m.hash !== hash) return { iid, launch: false, reason: "not analysed yet" };
    const open = kept.filter((e) => e.to === iid && !input.satisfied(e.from));
    if (open.length) {
      const why = open.map((e) => `#${e.from}${input.queue.has(e.from) ? "" : " (outside the agent queue)"}: ${e.what}`);
      return { iid, launch: false, reason: `waiting on ${why.join("; ")}` };
    }
    const fp = m.actualFootprint ?? m.footprint;
    for (const l of live) {
      const hit = overlap(fp, l.footprint, input.ignore);
      if (hit.length) return { iid, launch: false, reason: `held by #${l.iid}: ${hit.join(", ")}` };
    }
    if (room <= 0) return { iid, launch: false, reason: "waiting for a free slot" };
    room--;
    live.push({ iid, footprint: fp });
    return { iid, launch: true };
  });
  return { decisions, dropped };
}

// ---- implementer reported a blocker --------------------------------------------

/** "wait" when every blocker names another open, unmerged ticket; otherwise a person has to look. */
export function blockedOutcome(self: number, blockers: ImplementerBlocker[], satisfied: (iid: number) => boolean): "wait" | "needs-human" {
  if (!blockers.length) return "needs-human";
  return blockers.every((b) => b.iid != null && b.iid !== self && !satisfied(b.iid)) ? "wait" : "needs-human";
}
