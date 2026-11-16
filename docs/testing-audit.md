# Testing strategy audit — consolidated Factory v2 baseline

## Summary table

Refreshed 2026-11-16 against the consolidation of `origin/main` at `580c2b2`
and `origin/spike-1` at `cdaf9f0`. This supersedes the historical audit at
`cfadd75`, which inspected a different, partly dirty tree. That audit's 90-test
counts, timings and missing-worker claim do not describe this baseline.
The browser/typecheck/teardown changes on `origin/chore/consolidation-baseline`
are already present through the squash merge `1556818`; importing them again
would duplicate work.

| Suite / tier | Current result | Measured runtime | Current scheduling |
| --- | --- | --- | --- |
| Vitest: mixed unit, real SQLite/Fastify/filesystem integration, service and synthetic CLI process tests | 489 passed, 1 existing root-only ownership case skipped; 19 files, 490 cases | 15.43 s, first consolidation run under Node 24.20.0 | `npm test`; PRs and pushes to `main`, after typecheck/build in CI |
| Chromium: functional/end-to-end | 2 passed | 7.6 s, first consolidation run | `npm run test:browser`; same CI triggers |
| Individual cheap/functional tiers | Not yet independently selectable; timings unknown | Unknown | Mixed together; no nightly trigger |
| Factory v2 environment/workflow | Not an application test tier | Not remeasured here | Installed shared runtime; `.factory/factory.toml`; required CI job `tests` |

Locked dependency installation, typecheck and build passed. A second Vitest run
also passed 489 with the same skip. The skipped case is `paths and ownership >
rejects foreign ownership`, guarded by `process.getuid() === 0`; the injected-stat
non-root counterpart passes. No new skip or test/config change was introduced.
Two passes are not a flake-rate measurement. Savings from all proposed moves
remain **unmeasured**.

Inventory: application tests in `tests/{app,auth,chat,config,packaging,push,
server-cleanup,storage,sw,web,worker}.test.ts`; acceptance-tool tests in
`tests/acceptance-{api,cases,cli,host,reboot,report,runner,state}.test.ts`.
Vitest uses `tests/helpers.ts` (FakeClock/tempDir/syntheticEnv), local explicit
adapters, and acceptance fixtures. Signals: real SQLite/filesystem/Fastify for
integration; actual service sockets and spawned CLI/Node processes for functional
checks; VM/jsdom and fake-adapter cases can be cheaper. Playwright discovers both
`browser/slice.spec.ts` and `e2e/reminder-flow.spec.ts` and uses real Chromium,
synthetic HTTPS, file SQLite and fake model/push adapters. This is a bounded
refresh of the seven existing moves, not an exhaustive new pruning audit of the
recently added acceptance framework.

## Proposed state

Keep the completed worker and acceptance runner. Close concrete gaps before
cleanup; prune by failure ownership, not a deletion quota. Existing seven issue
numbers remain the units of work. All target `main` under Factory v2. None is
authorization to dispatch or apply `ready-for-agent`.

| Retain | Change |
| --- | --- |
| Existing default-worker restart delivery, overdue/retry/crash/pause behavior | Strengthen the existing scenario's attempt/readiness evidence and add only missing real two-connection lease checks (#41) |
| Database constraints, migration rollback/version safety, token hashing and durable writes | Remove incidental schema/enum/index snapshots (#42) |
| Service lifecycle, public health and one installed-build smoke | Consolidate repeated lifecycle/health/persistence assertions (#43) |
| Route response wiring, pure time validation, SQL ordering | Move throttle and DTO policy assertions to units (#44) |
| Explicit durable, idempotent confirmation | Enforce current-subscription readiness for a new save, retaining successful replay (#45) |
| Real socket/process/browser wiring | Remove artificial waits and introduce honest cheap/PR/nightly commands (#46) |
| Production push endpoint/address restrictions | Prove guarded DNS filtering and default-agent connection wiring narrowly (#47) |

## Critical journeys

- **Owner saves once and reloads after restart:** retain `e2e/reminder-flow.spec.ts`,
  including double-save, wrong-password and clarification UI wiring.
- **Saved reminder submits after restart without a model:** retain
  `browser/slice.spec.ts` and the existing service-level case in
  `tests/worker.test.ts`. They already use the real default worker. Service
  coverage owns lease/attempt assertions; do not create a third broad journey.
- **Installed artifact starts from another working directory and stops on SIGTERM:**
  retain one trimmed process smoke in `tests/app.test.ts`; improve its lifecycle
  safety and scheduling rather than substituting Fastify injection.
- **Acceptance CLI preserves approvals, secrets, interruption recovery and truthful
  evidence:** retain existing synthetic acceptance-tool tests. Their successful
  execution does not prove an installed host passed acceptance.
- **Actual browser notification with tabs closed and real access isolation:** keep
  the owner-operated `docs/automated-acceptance.md` gates. Historical Chromium/Zen
  test notifications do not prove scheduled delivery, reboot or tailnet isolation.

## Recommended moves

### Move 1: Strengthen existing restart and delivery-lease coverage

- **Change:** Extend the existing default-worker restart case and add narrowly scoped two-connection lease coverage; do not implement a replacement worker.
- **Files:** `tests/worker.test.ts`, `tests/storage.test.ts`; inspect `src/service.ts`, `src/worker.ts`, `src/db.ts` and `src/contracts.ts`.
- **Target tier:** Integration for real SQLite leases; existing service-level functional composition case.
- **Protection:** The worker, transactional claims and crash/retry recovery already exist. The restart test already reaches accepted with no injected worker and no model, but does not assert a ready persisted subscription or the recorded attempt. Overlap tests share one storage instance; they do not prove ownership across separate SQLite connections or rejection of an old claim after recovery/reclaim. Retain existing overdue, pause, bounded retry and crash-settlement cases rather than adding a second matrix. Subscription-readiness product changes belong to Move 5, not a new worker dispatch policy here.
- **Why:** Rules 4 and 7; close an actual boundary gap without duplicating implemented behavior.
- **Cost impact:** Current focused costs and savings unknown; do not reuse the old audit's 22 ms or missing-worker claim.
- **Acceptance:** The retained restart scenario uses a persisted ready subscription, fake transport, no model and no fake worker; it records an accepted attempt, preserves due time and fails if default-worker construction is removed. Separate connections cannot both own the same live claim; after expired-lease recovery/reclaim the previous token cannot settle the new claim. Use existing fake-clock facilities, no new sleeps. Move 6 owns removal of the existing polling helper.
- **Effort:** Medium; reduced from the obsolete large implementation task. Issue #41.

### Move 2: Delete schema-layout snapshots and retain database behavior tests

- **Change:** Delete the standalone schema inventory after transferring credential-storage protection to the existing migration case.
- **Files:** `tests/storage.test.ts`; inspect the migration, contracts and database implementation without changing their production behavior.
- **Target tier:** Retained integration.
- **Protection:** Retain constraints, migration rollback/version rejection, reopen, duplicate IDs, foreign keys, token hashing and no VAPID-key-table protection. Delete ordered column lists, exact table/index-name inventories and duplicated enum snapshots.
- **Why:** Rules 1 and 7; harmless schema additions should not require updating a second schema definition.
- **Cost impact:** Savings unmeasured; payoff is lower representation coupling.
- **Acceptance:** Remove `creates exactly the contracted tables, columns and no VAPID key table`; preserve its meaningful credential safeguard in an existing case and account for each deleted assertion. A harmless column no longer fails only an inventory assertion. No production schema/version change.
- **Effort:** Small. Issue #42.

### Move 3: Consolidate overlapping lifecycle and health scenarios

- **Change:** Delete the isolated fake-worker lifecycle and separate auth health cases after moving useful assertions to named survivors; trim the second process launch.
- **Files:** `tests/app.test.ts`, `tests/auth.test.ts`; inspect storage/chat/worker/browser survivors.
- **Target tier:** Integration for public health/storage; functional for service/process lifecycle.
- **Protection:** Retain `stops cleanly: the port is released, the database handle closed and the worker stopped`, including once-only shutdown; retain database reopen and model-disabled API/default-worker restart cases. Built-process smoke keeps another cwd, migrations/assets/health and SIGTERM, but loses raw timezone write/relaunch/readback. Fold `keeps /healthz public and generic` into the unauthenticated-access case; retain app health privacy assertions.
- **Why:** Rules 2, 6 and 7; one owner per failure without removing distinct wiring protection.
- **Cost impact:** Savings unmeasured; one less process launch and less repeated setup. Existing process helper has random fixed ports, polling and incomplete failure cleanup.
- **Acceptance:** Remove two redundant standalone cases and the second child launch, with a survivor mapping for every useful assertion. Default-worker restart remains; neither Chromium journey is removed. Coordinate shared-file edits, not artificial dependencies.
- **Effort:** Small. Issue #43.

### Move 4: Demote pure policy assertions without expanding the matrix

- **Change:** Unit-test throttle/DTO decisions directly and remove duplicate DST route assertions.
- **Files:** `tests/auth.test.ts`, `tests/storage.test.ts`, `tests/chat.test.ts`; focused unit file(s) if useful; inspect `src/auth.ts`, `src/contracts.ts`, `src/reminders.ts`.
- **Target tier:** Unit, with retained integration response/ordering assertions.
- **Protection:** FakeClock-driven LoginThrottle limit/window/reset, direct DTO privacy/ISO inputs, one route 429/Retry-After mapping, real SQL ordering/persistence/session hashes, pure DST gap/repeat cases and one invalid-time route clarification. Keep browser clarification wiring.
- **Why:** Rules 1–3; remove framework/database setup from pure decisions without a new abstraction.
- **Cost impact:** Savings unmeasured.
- **Acceptance:** Remove migrated assertions at the old tier. Broken throttle reset/expiry or leaked DTO claim fields fail units; missing HTTP mapping still fails integration. No new browser/error matrix.
- **Effort:** Small. Issue #44.

### Move 5: Extend confirmation tests to enforce notification readiness

- **Change:** Guard a new reminder save on the current subscription's successful push test; extend existing confirmation and UI cases.
- **Files:** `src/chat.ts`, `tests/chat.test.ts`, `src/push-routes.ts`, `web/app.ts`, existing browser/acceptance fixtures only where required.
- **Target tier:** Integration; minimal existing browser-fixture wiring changes.
- **Protection:** `/api/reminders/confirm` currently calls `confirmProposal` without a readiness check. Missing, untested or replaced subscriptions must not create a new reminder. Successful idempotent replay returns the original reminder even if readiness later changes. Worker setup currently uses subscriptions without readyAt; do not silently expand this ticket into a new worker dispatch policy.
- **Why:** Rules 1 and 7; concrete approved-plan gap, not an excuse for another broad journey.
- **Cost impact:** Savings/cost unknown.
- **Acceptance:** Existing confirmation scenario rejects missing/unready/replaced subscription states without writes, allows the current tested subscription, and preserves durable/idempotent behavior. UI explains the prerequisite. Removing the guard breaks retained integration coverage. Fixtures establish readiness through synthetic boundaries. Provider acceptance is not desktop-display evidence.
- **Effort:** Medium. Issue #45.

### Move 6: Remove wall-clock waiting and separate execution tiers

- **Change:** Make transport deadlines and default-worker restart synchronization deterministic; separate cheap checks, functional checks and timing-sensitive nightly checks.
- **Files:** `tests/push.test.ts`, `tests/worker.test.ts`, `tests/app.test.ts`, `package.json`, `vitest.config.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`; classify the new acceptance-tool process tests before adjusting discovery.
- **Target tier:** Unit/integration on commits; deterministic functional/end-to-end on PRs/nightly; unresolved polling-sensitive checks nightly.
- **Protection:** Preserve real bind/occupied/released-port checks, both Chromium journeys, CLI signal/secret/recovery safety and the installed-artifact smoke. Current `npm test` mixes all tiers, the process smoke can skip without a build, the transport waits 20 ms, and the worker restart helper polls wall time. CI has PR/main-push triggers but no nightly; it does not run on arbitrary feature pushes.
- **Why:** Rules 1 and 8 and the writing-tests run schedule.
- **Cost impact:** Current combined timings are above; separate-tier timing and savings unknown. The old sub-second audit numbers are not current evidence.
- **Acceptance:** Deadline failure/cleanup and default-worker composition use controlled synchronization without new sleeps. Document exhaustive file/case ownership so acceptance tooling is not accidentally dropped. Unit/integration checks run on every commit; deterministic functional/browser journeys run on PRs/nightly. Polling-sensitive process checks remain nightly until bounded startup, allocated ports and guaranteed child cleanup are implemented. Explicit smoke command fails without artifacts. Keep the exact required CI job `tests` gating applicable checks; preserve Factory v2 config/runtime separation and exact-head merge gates. No restored `test:factory` or `.sandcastle/` profile tests.
- **Effort:** Medium; one coupled command/discovery/CI scheduling change. Issue #46.

### Move 7: Test the guarded DNS connection boundary narrowly

- **Change:** Cover injected resolver answers and the default HTTPS agent's use of the guarded lookup.
- **Files:** `src/push.ts`, `tests/push.test.ts`, a focused boundary test if needed.
- **Target tier:** Unit for filtering; integration for connection wiring.
- **Protection:** Existing address predicates and fake sends never invoke guardedLookup/default-agent resolution. An allowlisted host resolving privately could bypass SSRF protections if the filter or agent attachment regressed. `classifyStatus(302)` proves outcome mapping, not non-following of redirects; correct its misleading test name and exercise non-following in the same bounded fixture where feasible.
- **Why:** Rules 4 and 7; application security policy merits one focused boundary check, not a protocol harness.
- **Cost impact:** New cost unknown; no live vendor endpoint calls.
- **Acceptance:** Private-only answers reject, mixed answers return only allowed addresses, errors/all-mode are handled; removing filtering or default-agent lookup attachment fails retained coverage. Preserve allowlist, TLS validation and private/tailnet restrictions. No encryption/decryption reimplementation or production relaxation.
- **Effort:** Medium. Issue #47.

## Accepted omissions

No new OpenAI SDK contract server, push encryption harness, broad browser error
matrix, universal fixture or acceptance framework. The existing acceptance runner
is already implemented and must be preserved, not rebuilt. Memory, recurrence,
cancellation, snooze, backups and deployment remain out of scope. Synthetic model
responses do not prove model quality. Real Firefox/desktop display, actual
Tailscale isolation and installed-host reboot evidence remain owner-run gates.

## Schedule changes

Move 6 owns schedule changes; this consolidation does not weaken or change CI.
Cheap checks belong on every commit; retained deterministic functional/browser
checks on PRs and nightly. Until process helpers have bounded startup, reliable
cleanup and allocated ports, timing-sensitive process cases belong nightly.
Factory's shared workflow and required `tests` gate stay intact. No dispatch,
scheduler enablement or ready label is authorized by this audit refresh.

## Ticket creation

Moves map to existing issues #41–#47 under #40; refresh them rather than create
another set. Their baseline is consolidated `main`, Factory v2, and this document.
Shared edits require coordination/rebase, not hard dependency links. Labels remain
unchanged and the backlog is not dispatched. New evidence and remaining human
gates must be reported separately.
