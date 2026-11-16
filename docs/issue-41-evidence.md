# Issue 41: restart and delivery-lease evidence

## Scope and retained owners

- `tests/worker.test.ts > restart, end to end, without OpenAI > delivers a reminder saved before restart, with chat disabled and an overdue due time` remains the service composition owner. It uses the real default worker, no model, a fake transport, and a file-backed subscription explicitly marked ready before shutdown. Reopening preserves the subscription including readiness/version; one accepted attempt records that version and the injected submission/finish time. The reminder retains its original due/local time.
- `tests/storage.test.ts > delivery leases across SQLite connections` adds two integration cases using distinct real SQLite connections to one disposable file. The second connection cannot recover or claim a live lease; at expiry it can recover/reclaim, but the old token cannot accept, retry or fail the new claim. Rejected settlement changes neither reminder nor attempt records; the current owner can settle successfully and both connections see it.
- No assertions or tests were removed/demoted. Existing same-instance overlap, overdue ordering, pause, bounded retry, interrupted recovery, recorded-acceptance recovery and transactional settlement rollback cases remain distinct owners. No worker replacement, readiness dispatch policy, new sleeps, test tier/configuration or CI change. Existing restart polling remains owned by issue 46.

## Regression detection

Each temporary production-source mutation was applied separately, run against the named retained case, and restored in `finally`. These are intentional failing runs, not suite skips: `-t` deselected the other cases.

| Named broken behavior | Mutation | Observed failure | Wall time |
| --- | --- | --- | --- |
| Default worker not constructed | Replace default `new DeliveryWorker(...)` in `src/service.ts` with `undefined` | Restart case times out waiting for acceptance | 3.40 s |
| Accepted reminder lacks accepted attempt evidence | In `finishDeliveryAttempt`, persist `failed` instead of `accepted` | Restart case sees `outcome: failed`, expected `accepted` | 0.42 s |
| Live claim stolen by another connection | Include `sending` in claim candidates | Live-lease case receives a second claim instead of `[]` | 0.26 s |
| Old token settles a replacement claim | Remove token predicate/bind from `#settle` | Stale-token case sees `markAccepted(oldToken) === true`, expected false | 0.25 s |

Production source is unchanged in the resulting diff.

## Local validation

Node **24.20.0**, synthetic inputs only; initial base `b052c82`.

- `npm ci`: pass, 170 packages installed, zero reported vulnerabilities.
- Focused `vitest run tests/storage.test.ts tests/worker.test.ts`: **46 passed**, no skips/failures; command wall time 0.618 s (reported case totals: storage 49.3 ms, worker 124.0 ms).
- `npm run typecheck`: pass.
- `npm run build`: pass.
- `npm test`: **491 passed, 1 existing skip**, 19 files, 17.70 s. The skip is the existing root-only foreign-ownership case when run non-root; its injected-stat counterpart passes. Two added lease cases account for the increase from the 489-pass baseline.
- `npm run test:browser`: **2 passed**, 7.9 s.

These are measured local costs, not savings or CI performance guarantees. Exact final-head local checks, CI result and PR/merge identity are also recorded on the PR/issue after rebasing to current `origin/main`. Required CI job `tests` and Factory exact-head gates are unchanged; no Factory dispatch, scheduling or host-service changes were performed.

## Pending owner acceptance

Synthetic transport/provider acceptance is not proof of desktop notification display. Real Firefox display, actual Tailscale isolation and installed-host reboot/durable-storage acceptance remain pending separate owner evidence under `docs/automated-acceptance.md`. No live provider calls, credentials, production access, installation or deployment were used.
