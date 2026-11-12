import { TRACKER } from "./config.mts";
import type { Parent } from "./graph.mts";
import * as github from "./tracker.github.mts";
import * as gitlab from "./tracker.gitlab.mts";

// Tracker facade: every tracker call main.mts, dispatch.mts and the ticket graph make. TRACKER.kind in
// config.mts picks the adapter: "gitlab" (tracker.gitlab.mts, `glab`) or "github" (tracker.github.mts,
// `gh`). A config without `kind` is GitLab. Every call runs on the host with that CLI's own login.

export interface Ticket {
  iid: number; // the issue number shown as #N, on either tracker
  title: string;
  description: string;
  state?: string; // "opened"/"open" or "closed"
  labels?: string[];
  parent?: Parent; // set on a Task (GitLab) or sub-issue (GitHub) whose parent is a container
}

/** Ready-list filters (the SELECT block in dispatch.mts). Fields one tracker lacks are ignored there. */
export interface Select {
  assignee?: string;
  author?: string;
  issueType?: string; // GitLab only
  confidential?: boolean; // GitLab only
  search?: string;
  order?: string;
  sort?: string;
}

export type ReadyTicket = Ticket & { assignees?: { username: string }[] };

/** What main.mts hands the adapter once the branch is pushed. */
export interface Delivery {
  branch: string;
  base: string;
  sha: string; // the pushed tip; a PR is only merged while its head is still this commit
  title: string;
  /** The PR/MR description, given the adapter's one-line CI note. */
  body: (ciNote: string) => string;
  /** Board stage updates while CI runs. */
  onStage: (stage: "ci") => void;
}
export interface Delivered {
  url: string;
  merged: boolean;
}

const impl: typeof gitlab = (TRACKER as { kind?: string }).kind === "github" ? github : gitlab;

export const {
  ticketUrl, catalogue, children, parentOf, workCatalogue, ticket, viewText, notes, readyList, comment,
  uploadEvidence, openMrBranches, mergedInto, addLabel, close, advance, ensureLabels, deliver,
} = impl;
