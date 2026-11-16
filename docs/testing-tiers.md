# Execution tiers and retained ownership

Implementation of #46 under #40. This updates the scheduling recommendation in
`testing-audit.md`, not the product or owner-acceptance contract. Factory v2's
installed workflow and `.factory/factory.toml` are unchanged. No application
Factory dependency, dispatch, scheduler or host-service change is involved.

## Commands and CI

Use Node 24.20.0 and `npm ci`.

| Command | Exact ownership | When |
| --- | --- | --- |
| `npm test` | Every `tests/**/*.test.ts` except `*.functional.test.ts` and `*.nightly.test.ts` | Every push (all branches), PR and nightly |
| `npm run test:functional` | Every `tests/**/*.functional.test.ts` | PR and nightly |
| `npm run test:nightly` | Every `tests/**/*.nightly.test.ts` | Nightly |
| `npm run test:smoke` | `tests/artifact.nightly.test.ts` only; intentional nightly subset | Explicit installed-build check after build |
| `npm run test:all` | Every `tests/**/*.test.ts`, including all three tiers | Local full verification, not an extra duplicated CI run |
| `npm run test:inventory` | Collect actual expanded runnable cases and verify the three tiers are a disjoint exhaustive partition, every test file is discovered, smoke is a nonempty nightly subset | Every push, PR and nightly |
| `npm run test:browser` | Both `browser/**/*.spec.ts` and `e2e/**/*.spec.ts` via unchanged Playwright config | PR and nightly |

The exact job ID/name **`tests`** remains the single required gate. No
`continue-on-error`, bypass, allow-failure, optional dependency or empty-suite
success is introduced. Typecheck and build run before tests; conditional
file-existence guards were removed. Only the expensive tiers are event-gated.
The authorized GitHub Actions nightly trigger is `23 4 * * *` (UTC, default
branch; GitHub may delay scheduled runs). This is not Factory scheduling.

Run `npm run build` first for smoke/nightly/all. The smoke checks server,
migrations and all web artifacts up front and **fails** if any are absent,
instead of silently skipping when `dist` is missing. It retains real child
execution from another cwd, generic health, web assets, migration startup and
SIGTERM exit. Its legacy random fixed port/polling still makes it nightly-only;
startup now has a bound and teardown force-reaps the child on assertion/startup
failure. The PTY helpers still need process-group cleanup hardening before
promotion. No retries or enlarged deadlines were added to mask failures.

## Exhaustive file and case ownership

**Every case in each listed file belongs to the indicated tier**, including all
`it.each` expansions. There are no case-name filters and no partially excluded
suites. Counts are a verification snapshot, not frozen expected counts: new
ordinary test files enter commit discovery automatically; new suffixed files
enter their named tier. Reclassify/document additions during rebases. The
inventory command uses file-local case ordinals because existing parameterized
display names can duplicate or contain fresh UUIDs. It checks multiplicity, not
a deduplicated set of names. Browser discovery is separate and unchanged.

| File under `tests/` | Runnable cases | Owner (all cases) / protected failure |
| --- | ---: | --- |
| `acceptance-api.test.ts` | 5 | Commit integration: synthetic HTTPS API, authentication, bounded errors and redaction |
| `acceptance-cases.test.ts` | 6 | Commit integration: synthetic approval/case submission and truthful observation gates |
| `acceptance-cli-policy.test.ts` | 1 | Commit: recovery-only network-disabled API; no fetch when Serve is unavailable |
| `acceptance-host.test.ts` | 77 | Commit integration: injected command transport, inspection, operation approvals, restore intent, conflicts and interruption recovery; no host mutation |
| `acceptance-reboot.test.ts` | 63 | Commit integration: synthetic boot/clock/API/host, durable reboot intent, repair approvals, resumed snapshots, pause restoration and no fabricated display |
| `acceptance-report.test.ts` | 10 | Commit: bounded/redacted JSON/Markdown evidence and honest verdicts |
| `acceptance-runner.test.ts` | 155 | Commit integration: injected waits, approvals, cancellation, model restoration, retry/recovery, secrets and distinct provider/display outcomes |
| `acceptance-state.test.ts` | 35 | Commit integration: real private filesystem/journal/lock storage, ownership, atomic writes, malformed inputs and recovery; separate-process case moved below |
| `app.test.ts` | 10 | Commit integration: Fastify injection, health privacy, headers, errors, plugins/adapters, body limits and loopback proxy trust |
| `auth.test.ts` | 12 | Commit integration: owner access, sessions, CSRF and HTTP rate-limit mapping |
| `chat.test.ts` | 11 | Commit integration: model/proposal/confirmation, limits and durable/idempotent storage wiring |
| `config.test.ts` | 12 | Commit: safe configuration, paths, credentials and VAPID persistence |
| `packaging.test.ts` | 2 | Commit: systemd/example/documentation contract, not installed host acceptance |
| `policy.test.ts` | 3 | Commit units: throttle reset/window and safe DTO projection (concurrent #44 protection) |
| `push.test.ts` | 14 | Commit unit/integration: endpoint/address/status rules, controlled transport deadlines/cleanup, synthetic push API/readiness |
| `storage.test.ts` | 26 | Commit integration: real SQLite constraints, migration/rollback, sessions, durable state and cross-connection leases (concurrent #41/#42 protection) |
| `sw.test.ts` | 2 | Commit: VM service-worker payload/display/click policy |
| `worker.test.ts` | 18 | Commit integration: real SQLite with injected clock/transport, due/overdue, pause, attempts, retries, overlap, crash settlement and status routes |
| `acceptance-cli.functional.test.ts` | 18 | Functional: real CLI arguments/help and synthetic coordinator processes, including SIGINT/SIGTERM, recovery and reboot resume |
| `acceptance-lock.functional.test.ts` | 1 | Functional: separate Node process cannot acquire a held filesystem registry lock |
| `service.functional.test.ts` | 5 | Functional: real loopback bind, stop/restart, released/occupied ports, invalid config cleanup and log secrecy |
| `restart.functional.test.ts` | 1 | Functional: default worker delivers overdue saved reminder after reopen without model, persisted ready subscription and accepted attempt evidence |
| `acceptance-terminal.nightly.test.ts` | 2 | Nightly: actual PTY password non-echo and terminal restoration after interruption; unresolved polling/cleanup |
| `artifact.nightly.test.ts` | 1 | Nightly: installed artifact/cwd/assets/health/SIGTERM process smoke; unresolved port allocation/polling |
| `server-cleanup.nightly.test.ts` | 2 | Nightly: actual synthetic HTTPS listener cleanup with idle and active connections; races a real 1-second deadline |
| `web.nightly.test.ts` | 3 | Nightly: existing jsdom refresh/status/error outcomes; still uses a real 20-ms readiness wait, so it is not misrepresented as deterministic commit coverage |
| **Total** | **495** | **462 commit + 25 functional + 8 nightly** |

Vitest `list` omits skipped cases. The additional existing case
`acceptance-state.test.ts > paths and ownership > rejects foreign ownership`
is also commit-owned; it runs only as root. In this non-root environment that
means **496 total = 495 passes + 1 existing skip** (commit: 462 passes + 1 skip).
The injected-stat non-root counterpart runs. No new skip was introduced.

Playwright owners (one case each):

- `browser/slice.spec.ts`: confirmed reminder survives restart and is submitted
  without a model; real Chromium/HTTPS/default-worker wiring with synthetic adapters.
- `e2e/reminder-flow.spec.ts`: owner login, timezone, chat, double save and restart
  persist exactly one reminder; includes wrong-password/clarification UI wiring.

Helpers are not independent test entrypoints: `helpers.ts` serves clock/temp/env
fixtures; `app-fixtures.ts` shares FakeWorker between app/service owners;
`worker-fixtures.ts` shares synthetic subscription/transport between worker/restart
owners. `acceptance-fixtures.ts` serves acceptance state/case/report/lock owners;
`acceptance-reboot-fixture.ts` serves acceptance reboot/runner/CLI synthetic
coordinators. `acceptance-cli-fixture.ts` is launched only by functional CLI
cases, `acceptance-password-fixture.ts` only by nightly PTY cases.
`server-cleanup.ts` serves the browser fixtures and its nightly boundary checks.
No fixture is accidentally discovered as a standalone test or counted as a
passing application case.

## Transfers: no useful assertion dropped

- `app.test.ts > service lifecycle` moved intact to
  `service.functional.test.ts`, retaining real bind/occupied/released-port,
  database-close, worker-stop, persisted restart and redacted-log assertions.
  `built service` moved to `artifact.nightly.test.ts`; it no longer skips for
  missing build artifacts. No browser journey was removed.
- `worker.test.ts > restart, end to end, without OpenAI` moved to
  `restart.functional.test.ts`. The polling helper is deleted, not retained
  alongside a duplicate. Timer-only virtualization drives the real default
  worker's first scheduled pass to completion; SQLite and service listen remain
  real. The merged #41 ready-subscription, due time, accepted state/count/time
  and recorded subscription-version attempt assertions are retained.
- `acceptance-cli.test.ts` is fully partitioned: recovery API policy (1) to
  commit; help/docs (2), invalid-argument expansions (6), non-TTY refusal (1),
  synthetic coordinator scenarios (9) to functional; real PTY cases (2) to
  nightly. The 9 coordinator scenarios are preflight, decline, no-display,
  failure, recovery-stopped, resume-stopped, sigint, sigterm and reboot. They
  retain process exit, secret-canary, approval, cleanup and truthful-report
  assertions, including signal resume without duplicate reminders.
- `acceptance-state.test.ts > contends with a separate Node process sharing the
  fixed registry` moved intact to `acceptance-lock.functional.test.ts` with
  explicit finally cleanup; all other journal/lock protections stay commit-tier.
- All cases in `web.test.ts` and `server-cleanup.test.ts` moved unchanged to
  their `.nightly.test.ts` owners. Their timing assumptions are demoted, not
  hidden by retries, broader tolerances or skips.
- The real 20-ms hung-transport assertion in `push.test.ts` is replaced by the
  named controlled-deadline case. Separate early-success/failure assertions
  now detect leaked deadline timers; provider error and invalid-input coverage
  remains in its original owner. Production transport behavior is unchanged.

## Regression demonstrations and remaining acceptance

Local mutation probes (reverted before committing):

1. Omit `clearTimeout(timer)` in `src/push.ts`: `clears the unused deadline after
   an early provider success or failure` fails, timer count **1 vs 0**.
2. Expire the transport one millisecond early: `expires a stalled send at the
   controlled deadline and clears the deadline timer` fails, settled **true vs
   false** at 19 ms. Normal deadline is pending at 19 ms and fails at 20 ms.
3. Omit the default worker from `createApp` dependencies in `src/service.ts`:
   the retained restart case fails, reminder **scheduled vs accepted**. It does
   not manually invoke `runOnce` or inject a fake worker to hide this failure.
4. Temporarily move `dist` aside: `npm run test:smoke` exits nonzero with
   `Missing dist/server/main.js; run npm run build before npm run test:smoke.`
   Restoring artifacts makes it pass. This is a failed suite, not a successful
   skipped smoke.
5. Exclude `tests/push.test.ts` from commit discovery without assigning another
   owner: `npm run test:inventory` fails, tier union **481 vs 495**. Restoring
   discovery verifies the partition again.

Measured pre-PR run after incorporating #41/#42/#44/#45: locked install,
typecheck and build passed; commit 462 passed + 1 existing skip (16.84 s),
functional 25 passed (4.05 s), nightly 8 passed (0.530 s), explicit smoke 1 passed
(0.514 s), all 495 passed + 1 existing skip (16.05 s), inventory 495 runnable
cases partitioned, Chromium 2 passed (7.7 s). All new commands executed.

Final-head full-suite results, exact-head CI and subsequent rebase evidence are
recorded in the linked implementation PR/issue. The only conditional skip remains the existing
root-only foreign-ownership case; its injected-stat non-root counterpart runs.
Filtered mutation runs naturally exclude unrelated cases; these are not new
suite skips.

Baseline before changes on this machine: 489 passes + 1 existing skip, 19 files,
17.66 s; build passed. This is not a controlled timing experiment: concurrent
#41–#47 changes alter coverage, and separate-tier startup has overhead. Record
actual command costs rather than claiming sub-second commit checks or savings.

All evidence is synthetic. Real desktop notification display, Firefox/Tailscale
access isolation, installed-host reboot and persistent-disk durability remain
**pending owner evidence** under `automated-acceptance.md`. Provider acceptance,
mocked display and passing CLI tooling are not real acceptance.
