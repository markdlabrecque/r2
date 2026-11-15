# Acceptance journal contracts

This is the persistence/reporting layer for issue [28](https://github.com/markdlabrecque/r2/issues/28), not an acceptance CLI. It does not call R2, systemd, a model, push, Tailscale or reboot. Synthetic tests establish tooling behavior only. Real Firefox display and outside-client denial still require owner evidence.

## Public modules

- `scripts/acceptance/contracts.ts` defines strict version-1 schemas and their inferred types. `validateJournal(unknown)` is the persistence boundary. `AcceptanceError.code` is safe to display; do not attach raw causes, DTOs, command output or HTTP bodies.
- `scripts/acceptance/state.ts` exports `AcceptanceRegistry` and `JournalLease`. All filesystem operations are synchronous, bounded, and guarded by host/unit ownership. Callers inject external operations elsewhere, not into the journal.
- `scripts/acceptance/report.ts` exports `projectReport`, `jsonReport`, `markdownReport` and the typed `evidence` helper. Renderers validate unknown input again and project named fields only. They return data/strings, not a live endpoint.

`tsconfig.json` includes these scripts in the existing application/tests check. No existing check or Factory dependency is removed.

## Schemas and meanings

All UTC instants are bounded integer epoch milliseconds, compatible with JavaScript Date. Local schedule strings have minute or second precision and valid calendar values. Timezone strings must name a runtime-supported zone. Run, request and intent IDs are lowercase UUID-shaped values. Proposal and reminder IDs use the application's `prp_` and `rem_` prefixes followed by 22 base64url characters. Host fingerprints are lowercase SHA-256 hex; installed revisions are full 40-digit commit IDs. Hash a stable nonsecret machine identity in the future host adapter, never record a hostname or use a per-run random identity. `Installation` binds host fingerprint, `r2.service` and installed revision. Revision is deliberately absent from the lock key, so an upgrade cannot evade an existing lock.

`Journal` retains initial boot ID, initial/updated times, stage, sequence, check results, cases, cleanup, optional pending mutation and reboot checkpoint. The coordinator adds optional strict `coordinator: { completed, active }` stage progress, with catalogued stage names only and no duplicate/completed-active entries. See [acceptance-runner.md](acceptance-runner.md) for interruption and deliberate-retry semantics. Runtime origin, password and session cookie belong only to `RuntimeSession`. It must never be passed to persistence. Unknown fields at every level are errors, not fields to silently strip.

`CheckResult` contains only a catalog ID, `pass|fail|blocked|not-run`, `automated|owner-reported`, a narrow reason, and evidence time. A pass must use `verified`. Observed display, Firefox permissions, wording/click-through, device and external-client checkpoints require owner provenance. The typed helper is convenience, not validation; the journal/renderers still validate it. Add any future catalog changes deliberately in this shared module and its tests.

`SyntheticCase` retains a label `A|B|C|reboot`, bounded `caseNumber`, stable confirmation request ID, proposal/reminder IDs, phase, reason and original schedule. There are at most 32 cases per run. Request IDs and label/number pairs are unique. Explicit retries append a new case number and request ID; never replace an earlier blocked case. At this limit, stop rather than discard history. `attemptAt` means the first recorded submission attempt, not browser display; `acceptedAt` is provider acceptance. Known IDs and non-null attempt/acceptance times cannot change on resume. Due time, local schedule, zone, case identity and creation time cannot change at all. A blocked case's outcome is immutable. An established reboot checkpoint cannot lose or change its original binding, case, boot ID or time.

`Clock`, `Wait`, `PromptOutcome` and `StageApproval` are injected adapter contracts. Approval is in-memory, operation/run/stage-scoped, and has no default affirmative answer. A persisted stage is not authority to repeat an operation. Fresh interactive approval and capability checks belong to the future host/coordinator modules.

`CleanupIntent` records the original pause once, pause/service restoration, daemon reload, and up to two owned artifact kinds. Kinds identify fixed paths in the host adapter, never arbitrary persisted paths. Compute the expected content fingerprint before exclusive artifact creation and store `create-intent`; after creation store `created`, and before deletion store `remove-intent`. A missing artifact after interruption requires inspection, not blind recreation. `verified` rejects outstanding flags/artifacts. A cleanup conflict/failure remains in the journal and cannot yield overall pass.

A reboot checkpoint refers to a confirmed reboot case by its stable request ID and binds the same installation plus previous boot ID and phase. The case holds the original reminder/proposal IDs and due instant. No new-boot or automatic-recovery claim follows from writing this checkpoint.

## Location, permissions and ownership

The live registry is fixed at `/var/lib/r2-acceptance`, outside the checkout and `/var/lib/r2`. It must belong to one designated OS operator, with mode 0700. Other operators must fail access to that same location, not substitute per-user roots. Provisioning/privilege policy is not implemented here. Constructor `root`, `appDataRoots` and `onWrite` options are trusted test boundaries; the future CLI must not expose a registry-root override. Every mutating invocation must compute the same host identity and use this registry.

Run directories are `<registry>/<run UUID>/`. `journal.json`, `report.json`, `report.md` and temporary write files are 0600. Existing insecure paths are rejected without chmod/chown/adoption. Root/app-data locations, relative paths, dot components, symlinks, non-files, hard-linked files, wrong owners and unsafe permissions are rejected. Ancestors must belong to the operator or root and not be group/world writable. Root-owned sticky ancestors such as `/tmp` are allowed only outside the dedicated directory, for synthetic temp fixtures. Live default writes never use world-writable directories.

The host/unit lock sits directly in the shared registry, not inside a run directory. `LockOwner` includes run ID, random ownership token, PID, boot ID and process start ticks. Generate a fresh token for each acquisition. Never treat PID existence alone as proof of the same process.

`acquire(installation, owner)` refuses an existing lock, even for the same run. `owner(installation)` reads the validated owner for explicit recovery. `release()` compares the complete owner record before unlinking and synchronizes the parent directory. A superseded lease cannot release or write through a new owner's lock. Release refuses pending mutations or unverified cleanup, preserving the host lock so another run cannot bypass recovery.

`recoverStale(installation, expectedOwner, probe)` is explicit and compares the complete expected record under the same ownership gate. It releases only if no journal recovery is outstanding. If a pending action or cleanup remains, use `takeoverStale(installation, expectedOwner, replacementOwner, probe)` with the same run ID and a fresh ownership token. This atomically transfers the lock to the recovery process without exposing an unlocked interval for a different run. Corrupt journals block release and need operator inspection. `classifyOwner` helps a trusted host adapter classify verified boot/process facts:

- Matching boot and start ticks are live.
- A verified different boot, absent process, or reused PID with different start ticks is stale.
- Missing/invalid boot facts, permission failures, unknown process identity or probe exceptions block takeover. Missing permission is never process absence.

The probe must inspect the recorded PID on the same verified host and return current boot/start facts. This ticket provides no real `/proc` adapter. A synthetic probe returning `stale` is a test boundary, not live evidence.

## Commit and recovery order

1. Acquire the shared lock before any mutation-capable stage. Create a version-1 journal with sequence zero using `lease.create(state)`, or load an existing run using `lease.load()` after explicit stale-lock takeover or safe stale release and fresh acquisition.
2. Inspect unfinished cleanup and `pending` before starting new work. Do not replay an interrupted external operation automatically.
3. Prepare the next journal with `sequence = previous.sequence + 1` and nondecreasing `updatedAt`. Ordinary progress uses `commit(next, previous.sequence)`. It cannot introduce or clear a pending mutation.
4. Before an external effect, set the exact `MutationIntent` and all required cleanup ownership/restore flags in that same next snapshot. Call `beginMutation(next, previous.sequence)` and wait for successful return. Only then call the injected external boundary. If journal persistence throws, perform no new external action.
5. Between partial effects, use `checkpointMutation(next, pendingSequence, intentId)` to record artifact progress while preserving the exact pending operation. Ordinary `commit` cannot update a pending action. After the external action, inspect/reconcile the actual result. Use `resolveRecovery(next, pendingSequence, intentId)` with `pending: null`. It checks the exact pending ID and sequence. It does not assume success, replay a confirmation, or declare restoration verified for you.
6. If the external result is lost, retain `pending`. Next run must reconcile it before starting another stage. Confirmation recovery retries the recorded proposal/request pair, not a new request. Unknown model-response recovery stays unresolved until a deliberate retry.
7. Restore and verify actual host/pause state before clearing cleanup flags. Export progress using `lease.exportReports()`, then release the owned lock. If cleanup remains needed, release fails closed and retains the lock for explicit same-run takeover. Export the failed recovery state and stop; do not start another run.

Proposal intent requires an `intended` or `proposal-unresolved` case with no known proposal; a lost response remains unresolved. Confirmation intent requires an existing `confirm-intent` case with known proposal and request IDs. Pause intent requires a captured original pause and outstanding pause restoration. Host mutation intent requires `restore-needed` cleanup. Reboot intent instead requires verified cleanup and a pending reboot checkpoint. These are persistence preconditions, not substitutes for host safety/approval checks.

Journal updates use an exclusive random temp file, write, file fsync, atomic rename, then directory fsync. New private directories also synchronize their parent. An interrupted pre-rename write leaves the old checkpoint; a post-rename interruption leaves a complete new checkpoint. Temporary files are never considered committed state or blindly promoted. They contain only already-validated safe state and can remain for inspection. A persistence error after rename is an uncertain commit, so reload before any external action. Reports are individually atomic, not a two-file transaction; compare their checkpoint sequences after interruption and re-export from the journal if they differ.

Ownership transitions and journal operations use an exclusive `.ownership-gate` directory so stale-owner check/unlink/acquire cannot race. An actual process death inside this short filesystem section can leave the gate behind. Automation deliberately does not guess whether an unidentified gate owner is dead. The designated operator must stop all acceptance processes and reconcile the lock/journal before manually removing that empty gate. Do not delete a live or uncertain lock or automatically remove a gate based on age. Ordinary interruption outside the gate uses the explicit stale-owner recovery above.

## Report truthfulness and limits

The report enumerates the entire check catalog, including missing checks as `not-run` with no invented provenance/time. Only reboot checks can be explicitly optional, fixed when the journal is created; optional checks stay visible. All other checks are required. Overall pass requires every required check to pass, cleanup to be verified, and no pending mutation. Required failure or cleanup conflict/failure yields fail; other incomplete states yield blocked.

Reports show case labels/numbers, reasons and original/evidence times. The coordinator extension adds a fixed recovery-instruction code/text and remaining future case labels/due instants, measured at the journal checkpoint. An active interrupted coordinator stage prevents overall pass. They exclude installation fingerprint/revision, boot/process/lock data, request/proposal/reminder IDs, credential material, reminder text, subscription data, output and arbitrary errors. Provider acceptance never fills an observed-display check.

This is schema-based data minimization, not arbitrary secret detection. A caller can lie using valid IDs or evidence enums. Same-UID hostile code or root can also tamper with private files. The protocol protects cooperating adapters from unsafe/raw data entry, accidental overwrite and concurrent operations; it does not sandbox those adapters. Host identity verification, truthful external facts, fresh approval, secret prompts and real acceptance are downstream responsibilities.
