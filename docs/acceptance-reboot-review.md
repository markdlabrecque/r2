# Reboot preparation/resume review

Verdict: **PASS** after fixes and final Node v24.20.0 checks. This is a self-review, not a delegated or independent verifier verdict. No live acceptance was run.

Scope: [32](https://github.com/markdlabrecque/r2/issues/32), based on `a613614ea01275d752fea7058ce939eb75d75582`. Read the full parent/task and dependency tickets, actual acceptance adapters and their journal/API/host/runner docs, PRD, approved first-slice plan, application DTO/routes/worker and installed unit/layout. The implementation does not reuse discarded branches or parent-checkout edits.

## Findings fixed

1. **Generic recovery versus a reboot intent.** Ordinary runner cleanup would label pending reboot work as failed service cleanup. `run` and `recover` now preserve and export a pending reboot intent with specific same-run explicit-resume instructions. Neither can schedule or replay reboot.
2. **Originally true pause.** Leaving temporary unpause debt through reboot violated the checkpoint's verified-cleanup boundary. Preparation restores true before intent; the tested post-boot runner scope waits through due, requests fresh temporary-unpause approval, and restores true on success, provider failure and lost session. Completed resume does not unpause again.
3. **Repair destroying automatic-recovery evidence.** The first new-boot snapshot atomically stores immutable automatic recovery, changed boot and any available retained-time result before clearing reboot intent or permitting a restart. Failed automatic recovery stays failed after approved repair and repeated resume. Missing credentials/HTTPS and malformed/non-running Tailscale/Serve/Funnel/listener facts cannot become a pass.
4. **Atomic-write crash gaps.** Prepared and pending writes are tested at temp creation, file fsync, rename and directory fsync. A thrown persistence operation never permits the command, even if its checkpoint reached disk. The resume snapshot has the same four-boundary matrix; a retry uses committed state, never a new reminder or reboot.
5. **Assuming nonzero exit means no side effect.** A systemctl failure may follow accepted D-Bus work. All uncertain command outcomes retain failed/pending scheduling intent and the lock. Same-boot resume blocks; no automatic clear/retry invents certainty. Owner reconciliation remains explicit.
6. **Late final inspection.** Approval-time lead checks alone were insufficient because host inspection is asynchronous. The host now rechecks the stable case's confirmed phase and remaining due window immediately before the reboot effect.
7. **Hidden opt-in and misleading timing.** A declined case step could otherwise become optional again after generic completion. Immutable `coordinator.rebootSelected` preserves required reboot gates. Provider acceptance remains separate from submission classification; a missed normal window blocks overall acceptance, while a return after due is explicitly overdue recovery.
8. **Unjournaled operator changes.** Cleanup now verifies actual original pause even without a remaining flag. A changed owner pause is a conflict, not permission to overwrite it. A positively observed retained-time mismatch stays failed and cannot authorize temporary unpause.
9. **CI crash-matrix granularity.** The initial pushed head hit Vitest's five-second limit while one test executed four complete baseline/crash/resume scenarios. Each phase/boundary combination is now its own test with identical assertions and the unchanged five-second timeout. No checks, coverage or CI limits were weakened.

No unresolved code defect was found in the reviewed scope. Unknown/live external state remains fail-closed rather than being guessed into a result.

## Executable evidence

`tests/acceptance-reboot.test.ts` adds 57 tests. Its dedicated fixture uses the actual `AcceptanceRunner`, `AcceptanceHost`, `AcceptanceApi`, `AcceptanceCases`, private journal/lock/report implementation, real application routes and temporary SQLite. Only host commands/files, clock/wait, prompts, model and push boundaries are synthetic. Each reboot setup runs the integrated A/B/C/device baseline first. There are no wall-clock sleeps or real host actions.

Coverage includes both original pause values; cleanup/checkpoint/acknowledgement/approval/command order; capability, TTY, privilege and scoped approval gates; same/new boot; old-boot takeover and stale-lease invalidation; live/uncertain ownership refusal; changed installed revision; missing/corrupt/prepared-only checkpoints; failed automatic startup followed by approved repair; stopped Tailscale, missing Serve, enabled Funnel, unsafe listener and HTTPS failure; in-memory reauthentication and lost-session restoration; retained-time mismatch; missed normal window and overdue recovery; owner display unavailable independently of provider acceptance; declined creation/save/reboot/instructions/unpause; failed/uncertain command outcomes; repeated resume; checkpoint and snapshot crash matrices; and missing volatile artifacts reconciled through the existing host journal without recreation. Sensitive synthetic canaries remain absent from state/reports and fixed errors.

Final local checks under Node **v24.20.0**:

| Check | Result |
| --- | --- |
| `npm run test:factory` | 7 passed; suite only, no Factory task run |
| `npm run typecheck` | Passed, including acceptance scripts and tests |
| `npm run build` | Passed |
| `npm test` | 461 passed, 1 existing skip across 18 files |
| `npm run test:browser` | 2 Chromium tests passed |
| `git diff --check` | Passed |

Application source/routes/policies, deployment units, package dependencies/lockfile, CI and `.sandcastle/` are unchanged. The source change is confined to acceptance modules, their synthetic tests and documentation.

## Downstream boundaries

[acceptance-reboot.md](acceptance-reboot.md) documents `AcceptanceReboot.prepare()` and `resume()`, mandatory exact-command acknowledgement, the original-pause runner extension, trusted host facts, explicit stale-owner takeover, journal transitions and report classification for the CLI task. The CLI must supply actual TTY/privilege/process facts, hidden in-memory credential entry, same-host HTTPS origin binding, exact command rendering and terminal/signal handling. No CLI syntax or privileged persistent resume unit is introduced here.

A command that failed without a new boot remains uncertain until the owner privately reconciles orphan commands and reboot jobs. Unsupported host/network state is not automatically repaired. A later boot after the first recorded resume cannot be attributed to this checkpoint. Original due times are never moved, cases are never deleted, and no retry silently creates another permanent reminder.

Synthetic PASS does not prove systemd automatic startup, Tailscale/HTTPS recovery on the installed host, actual provider submission, Firefox notification display/click-through or excluded/outside-client denial. No actual reboot, service/Tailscale mutation, provider/push call, owner credential entry, production access or 1Password operation occurred. All missing owner checks remain incomplete.
