# Issue 44 — policy demotion evidence

Test-architecture change under issue 40; no product behavior, CI, Factory,
command discovery or browser-spec changes. Synthetic data only, Node 24.20.0.
Base: `b052c82` (consolidated main plus sandbox fixture fixes).

## Removed assertions and retained owners

| Removed/narrowed old-tier assertion | Retained owner |
| --- | --- |
| Auth route window advancement and successful recovery | `tests/policy.test.ts`: `limits attempts in a sliding window and expires them at the boundary` |
| Generic positive Retry-After | `tests/auth.test.ts`: `maps a throttled login to 429 and Retry-After`, exact `900` header and HTTP 429 after five HTTP 401 responses |
| Storage-backed reminder DTO due ISO, timezone, local time, state and null accepted-at | `tests/policy.test.ts`: `formats instants and excludes internal request and claim fields`, complete equality and null counterpart |
| Storage-backed reminder DTO private fields | Same unit: complete equality excludes request ID, lease and claim token (the former negative array assertion did not independently reject each leak) |
| Storage-backed proposal expiry ISO | Same unit: direct proposal DTO equality, also excludes request ID |
| Storage-backed delivery DTO claim exclusion and started-at ISO | Same unit: direct attempt DTO equality, including non-null and null finish time |
| Second invalid-time route call (DST gap) | `tests/chat.test.ts`: `rejects malformed, impossible, past, far, skipped and repeated local times` owns DST gap/repeat; `asks again instead of proposing when the model returns a past time` owns route clarification |

`lists reminders by due time` still proves real SQL ordering, limit and invalid
limit handling. Existing real persistence/reopen, atomic confirmation, delivery
record and session-hash cases remain. Route DTO responses remain in chat tests;
`e2e/reminder-flow.spec.ts` retains clarification UI wiring. Both Chromium
journeys are unchanged. No new browser/error matrix or production abstraction.

## Regression demonstrations

A disposable copy of `src`, `tests`, migrations and configuration used the locked
installed dependencies. Tests were unchanged; one source mutation was applied
at a time and restored. The policy control and restored runs both passed (3/3).
Each mutation exited nonzero with an assertion failure, not a loader failure:

| Deliberately broken behavior | Retained failing owner |
| --- | --- |
| Expiry uses `>=` instead of `>` | Sliding-window unit |
| `clear()` no longer resets attempts | Reset unit |
| First expired attempt resets the whole window | Sliding-window unit |
| Reminder leaks claim token | DTO unit |
| Reminder leaks request ID | DTO unit |
| Reminder leaks lease | DTO unit |
| Proposal leaks request ID | DTO unit |
| Attempt leaks claim token | DTO unit |
| ISO output replaced with locale string | DTO unit |
| Null accepted-at becomes epoch ISO | DTO unit |
| Null finished-at becomes epoch ISO | DTO unit |
| Quota HTTP mapping changed from 429 to 400 | Throttled-login integration |
| Retry-After header omitted | Throttled-login integration |

These are detection demonstrations, not claims of pre-existing product bugs.
Unlike the earlier failed sandbox attempt, the full local suite below passed.

## Observed checks before PR

- `npm ci`: exit 0, Node 24.20.0.
- Focused policy/auth/storage/chat: 4 files, **51 passed**, Vitest 0.379 s.
- `npm run typecheck`, `npm run build`: exit 0.
- `npm test`: 20 files, **492 passed, 1 skipped**, Vitest 24.70 s;
  shell wall 24.957 s. Only the existing root-only foreign-ownership case skips
  as non-root; the injected-stat counterpart passes. No new skips.
- `npm run test:browser`: **2 passed**, Playwright 8.3 s;
  shell wall 8.888 s.
- `git diff --check`: exit 0.

These are local measurements, not CI timing guarantees or measured savings.
Final-head command/CI evidence and merged PR URL are recorded on the linked PR
and issue after verification; this document does not claim an unobserved merge.

Human acceptance remains pending: real Firefox/desktop notification display,
Tailscale isolation and installed-host reboot/durability require owner evidence.
Synthetic/provider-accepted sends do not prove display. No production,
1Password, live provider, host-service change, dispatch or scheduling used.
