# Test plan: slice #1 (private web chat reminder)

Scope: owner login over Tailscale Serve HTTPS, timezone setting, one-browser Web Push, natural-language one-off reminders through chat, durable storage, and delivery after restart.

## Current coverage

The merged `spike-1` base includes `src/worker.ts`, worker tests, installation packaging and `browser/slice.spec.ts`. The browser delivery test restarts the real local service with the model disabled and checks submission to an injected push transport. It does not prove real notification delivery. Part C still requires the owner-run evidence described below.

## A. Automated

Run under Node 24: `npm ci && npm run test:factory && npm run typecheck && npm run build && npm test && npm run test:browser`.

Check that each PRD acceptance line maps to at least one test.

Gaps to add:
- Time resolution: DST gap and overlap, and "tomorrow" across midnight in a non-server timezone.
- Duplicate confirm from two tabs.
- Prompt injection in reminder text. The model has no tools, so check it can't alter the schema output.
- Quota reset at the day boundary.
- Real push connection and delivery in Chromium. The browser suites cover login, timezone, chat, duplicate confirmation, restart persistence and worker submission with injected adapters. They do not connect a real push subscription or prove notification display.

## B. Manual, owner-run

| # | Check | Pass |
|---|---|---|
| 1 | Open over Tailscale Serve HTTPS from two devices | Login works on both |
| 2 | Reach the app from a non-tailnet device, by `http://`, or by raw port | Refused or unreachable |
| 3 | Wrong password repeatedly | Throttled, then recovers |
| 4 | Sign in, restart, then log out | Session survives restart; logout revokes it |
| 5 | Chat "remind me tomorrow" | R2 asks for a time and saves nothing |
| 6 | Chat "bins tomorrow 7pm" | Correct date, time and zone; saved only after Save |
| 7 | Press Save twice, then reload | One reminder |
| 8 | Real OpenAI key, with model failing or key removed | Clear error, no save, no retry loop |
| 9 | Restart the service | Reminder still listed, model disabled |

## C. Delivery acceptance

1. Reminder 2 minutes out, R2 tab closed: generic notification within 60 s of due.
2. Stop the service across the due time, restart: one overdue delivery.
3. `kill -9` mid-send, restart: no duplicate beyond what the lease allows.
4. Expired subscription: failed outcome, bounded retries (30 s, 2 min, 10 min; 4 attempts), visible status.
5. Notification never contains reminder text or due time.
6. Repeat C1 in stock Firefox (only Chromium and Zen are verified).

## D. Security and privacy

- Unauthenticated calls to every `/api` route return 401.
- Cross-origin write with a valid cookie is rejected.
- Logs and `/healthz` contain no keys, cookies, password hash or message text.
- Service binds loopback only; Funnel is off.
- Push subscription to a private or non-allowlisted host is rejected (SSRF).

## E. Exit criteria

- A, D and manual B pass.
- C1 passes in real Chromium and stock Firefox.
- C2-C4 pass under the fake clock.
- Residual risks recorded in `docs/`, as in `push-delivery-verification.md`.

---

# Historical findings: original dirty checkout (2026-11-14)

These results predate the browser test and consolidation. They describe the dirty original checkout, not the final committed branch.

Branch `spike-1`, commit `e9b091a`, Node v24.20.0 (nvm). The default `node` on PATH is v22.23.2, below the project's `>=24` requirement, so use the nvm install.

| Check | Result |
|---|---|
| `npm ci` | Completed. Warning: `better-sqlite3` and `esbuild` have install scripts not covered by `allowScripts`. |
| `npm run test:factory` | Pass, 8/8 |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm test` | Pass, 90/90 across 7 files (~0.8 s) |

## Observations

- Test counts are higher than in `push-delivery-verification.md` (79 and 7), so tests were added since that run (#5 chat and confirmation).
- `npm run test:browser` was not run: no `playwright.config.ts` exists. This is the largest automated gap, because no test exercises the browser UI, service worker registration or the restart-then-deliver path end to end.
- `src/worker.ts` is absent, so no automated test can cover delivery after restart, retries or crash recovery. `tests/storage.test.ts` covers only attempt records and the schema.
- The working tree is dirty: many modified `.sandcastle/` files, staged deletions and untracked files. These are Factory tooling changes, not application code, but results reflect the working tree rather than a clean checkout of `e9b091a`.
- `npm ci` ran against that working tree. No application source changes were observed.
- Existing tests cover config, migrations and schema, auth and sessions, timezone, push endpoint validation, the service worker, chat and confirmation, and service lifecycle including log redaction.

## Gaps at the initial run

At that point, section A's DST edge cases, two-tab confirm, prompt injection, quota day-boundary and Chromium test were missing. Parts B, C and the manual portion of D had no owner-run evidence. The updates below record the browser work added since then.

---

# Update: Chromium end-to-end test added (2026-11-14)

At this historical checkpoint, added `playwright.config.ts` and `e2e/reminder-flow.spec.ts`. `npm run test:browser` passes (1 test, ~1 s) under Node 24.20.0. CI now runs browser tests, because it keys on `playwright.config.ts`.

The test uses a fake clock and model with no real credentials. A temporary self-signed TLS proxy sits in front of the loopback service, so the browser sees the HTTPS origin the service requires. It covers:
1. A wrong password is rejected.
2. Login succeeds.
3. The timezone is required, then saved.
4. An ambiguous request ("Remind me tomorrow") asks a question and saves nothing.
5. A complete request shows a proposal with its zone, and nothing is saved until Save.
6. Double-clicking Save sends two identical confirmation requests to the real service. Both return HTTP 200 with the same reminder. Direct SQLite-backed storage assertions prove exactly one reminder exists.
7. After a service restart on the same data, the session and reminder persist.
8. Logout returns to the login form.

Not covered:
- **Push:** no push connect, service-worker registration or notification display, because real push needs a real browser subscription.
- **Delivery:** nothing about sending, since `src/worker.ts` is still absent.
- **Two tabs:** the duplicate-save test uses one page, not independent tabs.
- **Browser coverage:** Chromium only.

# Historical consolidated verification (2026-11-14)

Branch `chore/consolidation-baseline` starts at `e9b091a` and includes only the three handoff files plus the typecheck configuration change. No dirty Factory changes from the original checkout were copied.

`tsconfig.json` now includes `e2e` and `playwright.config.ts`. Both pass the normal `npm run typecheck` without exclusions or suppressions.

The double-save test uses a request barrier so neither response can hide the Save button before both requests exist. Both requests pass through the TLS proxy to the real loopback service. It asserts identical nonempty proposal and request IDs, matching response bodies, exactly one stored reminder with the returned ID, and exactly one stored reminder after reopening the service. It also checks one UI item after reload and no extra model call on save. There are no mocked save responses or timing sleeps. The isolated implementation passed 10 repeated Chromium runs.

The final combined-branch check results are recorded below. Factory counts differ from the historical dirty-checkout results because unrelated Factory edits were deliberately excluded. The isolated implementation runs reported 89 passed and 1 skipped before building. `tests/app.test.ts` skips its dist service test when built assets are absent. The final run built first and passed all 90 tests. No notification delivery or owner-run acceptance is claimed.

Final checks under Node v24.20.0, after integrating both implementation commits:

| Check | Result |
|---|---|
| `npm run test:factory` | 7 passed |
| `npm run typecheck` | Passed, including e2e and Playwright config |
| `npm run build` | Passed |
| `npm test` | 90 passed across 7 files, no skips |
| `npm run test:browser` | 1 Chromium test passed |
| `git diff --check` | Passed |

# Merge-resolution verification

Merged `origin/spike-1` at `97b1b58` into PR head `567ce05`. The only textual conflict was the add/add in `playwright.config.ts`: each branch selected a different browser test directory. The resolved configuration explicitly discovers both `e2e/**/*.spec.ts` and `browser/**/*.spec.ts`, keeps one worker and disables full parallelism. Typechecking now includes both directories and the Playwright configuration.

`e2e/reminder-flow.spec.ts` is unchanged. It still sends two matching real save requests, asserts identical successful responses, and checks exactly one stored reminder with the returned ID before and after restart. The base's worker, browser delivery suite, packaging and Factory tooling are retained. No files were copied from the original dirty checkout.

Checks under Node v24.20.0 after the merge resolution:

| Check | Result |
|---|---|
| `npm ci` | Passed; install-script review warnings for better-sqlite3 and esbuild |
| `npm run test:factory` | 7 passed |
| `npm run typecheck` | Passed, including both browser suites and Playwright config |
| `npm run build` | Passed |
| `npm test` | 114 passed across 10 files, no skips |
| `npm run test:browser` | 2 Chromium tests passed |
| `git diff --check` and `git diff --cached --check` | Passed |

Both browser suites use local services and synthetic adapters. Real push delivery, stock Firefox and Tailscale acceptance still require owner evidence.

# CI timeout investigation

Investigated CI run `43621890741` from PR head `0ebb8f67279bf19e936c34847e8cb11115b7f4b2` in an isolated checkout under Node v24.20.0. The original dirty checkout was not used or changed.

The failed CI log reports an overall 60-second timeout in `browser/slice.spec.ts`, without a failing locator or stack. `gh-axi run download` reports no artifacts. The trace mentioned in the runner log was not uploaded, so the exact CI hanging step cannot be recovered from that run.

Local repetition reproduced the same timeout. The retained trace shows all assertions, including model-free delivery and logout, completed about 6.4 seconds into the test. Temporary teardown steps isolated the wait to `proxy.close()`, not `service.stop()`. One instrumented run retained an established TLS socket with zero HTTP requests, zero application bytes read or written, and socket timeout `0` while proxy close was pending. A separate slow run spent 36.25 seconds in proxy close while service stop took less than a millisecond. These are test-proxy connections, not a stuck delivery worker or database shutdown.

`server.close()` stops accepting connections but waits for these idle browser preconnections. The browser context normally closes after the test body returns; this test instead awaited proxy close inside its body. The e2e suite did not await proxy close at all, hiding the same cleanup risk.

Both suites now register `createServerCleanup()` before listening. Teardown stops the listener, destroys tracked raw sockets, and awaits the close callback. Tracking raw connections also covers peers that never finish TLS. This is test-only cleanup; the application service lifecycle is unchanged. Named teardown steps remain in the delivery test for future traces.

`tests/server-cleanup.test.ts` holds open real local TCP and TLS clients that never send HTTP. With socket destruction temporarily removed, both cases fail the one-second cleanup deadline. With the fix, both pass. No test timeout, retry policy, browser assertions, double-save request barrier, SQLite assertions, or Factory files were weakened or removed.

Validation after the fix:

| Check | Result |
|---|---|
| `npm run test:factory` | 7 passed |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | 116 passed across 11 files, no skips |
| `npm run test:browser` | Both Chromium suites passed |
| `npm run test:browser -- --repeat-each=10` | 20 passed; delivery runs 6.4–6.5 seconds |
| `git diff --check` | Passed |

Local diagnostic logs, red/green regression output and reproduced timeout traces are retained outside the repository at `/tmp/r2-pr23-evidence/`. They are local evidence, not recovered CI artifacts. Real notification delivery remains unverified.
