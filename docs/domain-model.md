# R2 domain model and code map

## Reading this document

Start with the [glossary](../GLOSSARY.md) for canonical language. This document connects that language to behavior, persistence and source code. It records existing behavior, not a new feature specification.

**Source baseline:** the merged `spike-1` application at `1556818`, inspected on 2026-11-14. Source links below are pinned to that revision. This documentation branch is based on and targets `spike-1`, the integration branch containing the worker and status implementation described here.

The [PRD](../PRD.md), approved [first-slice plan](first-slice.packed.html) and task discussions describe intent. Where the inspected implementation differs, the discrepancy is called out below. Documentation is not evidence that real notification acceptance has passed; the [verification task](https://github.com/markdlabrecque/r2/issues/10) describes the required owner-run evidence.

## Context and boundaries

R2 has one product domain: one owner's one-off reminders. There is no need for separate glossaries for chat, scheduling and notifications. They describe different stages of the same commitment.

Factory in `.sandcastle/` is development automation, not part of the reminder domain. A Factory task, ticket, verification verdict or launch reservation is not an R2 reminder or delivery attempt. This document intentionally does not model Factory's internal workflow.

```text
Authorized owner devices
  │ owner session, explicit timezone, request and confirmation
  ▼
R2 application ── current request + current time + timezone ──► model provider
  │                       ◄── interpretation only ────────────┘
  │ saved proposal → explicit confirmation → saved reminder
  │
  └── due reminder → delivery attempt → push provider → connected browser
                                          │                  │
                                      acceptance       generic notification
                                                             │
                                                owner-observed display
```

- Tailnet membership permits private network access; it does not replace owner authentication.
- Several authorized devices can use the same owner's reminders, but only one browser subscription is current.
- The model interprets the current request. It does not own the schedule, authorize confirmation or dispatch saved reminders.
- The push provider and browser control the steps after submission. R2 records provider outcomes, not whether the owner saw a notification.
- Reminder text and original due time stay in the authenticated app. The push path receives an opaque reminder identifier, and the service worker produces fixed generic text.
- There is no durable conversation history, recurring schedule, edit, cancellation or snooze operation in this slice.

## Concepts, identities and relationships

| Concept | Identity and lifetime | Relationships |
| --- | --- | --- |
| Owner settings | One persistent settings record | Explicit timezone and stored notification pause; not a separate owner account per device |
| Reminder request | Current input, not a saved conversation record | Can produce clarification, an unsupported response or one proposal |
| Proposal | Opaque proposal ID; has an expiry | Contains candidate text and resolved time; can be associated with at most one confirmed reminder |
| Reminder | Opaque reminder ID; persists after delivery stops | Refers to its proposal; preserves text, original local time, timezone and due instant |
| Confirmation request | Client-generated request ID | Deduplicates confirmation of a proposal; not the reminder's identity |
| Current subscription | Singleton with a replacement version | Identifies the connected browser; replacing it resets readiness |
| Delivery attempt | Attempt record ID and per-reminder attempt number | Refers to one reminder, a delivery claim and the subscription version used |
| Observed notification | Owner evidence, not a persisted domain record | Establishes actual display for a particular test; cannot be inferred from an accepted attempt |

A reminder has one originating proposal and zero or more attempt records. The attempt budget counts claims, including interrupted claims that might not have reached the provider. Consequently, the reminder's attempt count is not guaranteed to equal the number of recorded provider calls or attempt rows after a crash between claiming and recording an attempt.

Implementation reference: [contracts and DTOs](https://github.com/markdlabrecque/r2/blob/1556818/src/contracts.ts), [schema](https://github.com/markdlabrecque/r2/blob/1556818/migrations/001.sql), [storage](https://github.com/markdlabrecque/r2/blob/1556818/src/db.ts).

## From request to saved reminder

```text
Current request
  ├─ missing/ambiguous/invalid information → clarification, no saved reminder
  ├─ unsupported request                 → unsupported response, no saved reminder
  ├─ model failure or quota rejection    → visible error, no saved reminder
  └─ valid one-off interpretation        → stored proposal
                                            ├─ discard/expiry → no saved reminder
                                            └─ explicit confirmation → one saved reminder
```

The proposal is already persistent, but it is not scheduled delivery work. The model's success response is not confirmation. The UI reports `Saved` only after the confirmation API returns successfully.

### Time belongs to the reminder

A proposed time is resolved using the owner's explicit named timezone. R2 rejects nonexistent local times during a daylight-saving gap and repeated local times during an overlap rather than choosing an offset silently. Valid times must be in the future and within the supported horizon.

The saved values have different purposes:

- `localDateTime` and `timezone` retain what was confirmed in the owner's calendar terms.
- `dueAt` is the corresponding UTC instant used for scheduling.
- `nextAttemptAt` determines the eligibility of the next dispatch, initially the due instant and later a retry time if needed.

Changing settings from Toronto to Vancouver does not reinterpret an existing reminder. Downtime, pause and retry do not change its original due time either. The schema's time values are epoch milliseconds internally; DTOs expose UTC timestamps as ISO strings.

### Confirmation has two deduplication boundaries

1. Reconfirming the same proposal returns the original reminder, including with a different request ID.
2. Reusing a previously stored confirmation request ID for another proposal is a conflict.

A new reminder is inserted and its proposal association updated in one immediate transaction. Confirmed proposals are retained by proposal cleanup, so retrying a completed confirmation still returns the original after its due time or proposal expiry.

A different request ID supplied when reconfirming an already confirmed proposal is not stored as an additional alias. Do not describe all later retry IDs as permanently reserved.

### Current implementation limits

These are implementation policy, not glossary definitions:

| Policy | Inspected value |
| --- | --- |
| Request text | At most 1,000 characters |
| Proposed reminder text | At most 500 characters |
| Proposal lifetime | Up to 15 minutes, capped at the due instant |
| Time horizon | At most `5 × 366` days ahead |
| Model quota | 200 requests per UTC day, persisted before calling the model |
| Reminder listing | Default maximum of 500, ordered by original due time |

The quota is a daily spending bound, not a per-minute request limit. A failed model call still consumes its reserved quota. No conversation transcript is persisted by this path.

Source: [chat and confirmation](https://github.com/markdlabrecque/r2/blob/1556818/src/chat.ts), [time resolution](https://github.com/markdlabrecque/r2/blob/1556818/src/reminders.ts), [model adapter](https://github.com/markdlabrecque/r2/blob/1556818/src/openai.ts), [storage](https://github.com/markdlabrecque/r2/blob/1556818/src/db.ts).

## Delivery is a separate lifecycle

Reminder state and attempt outcome are different axes. A failed attempt can leave a reminder eligible for retry; an unknown attempt does not prove the provider rejected it.

### Reminder states

```text
scheduled ── due and claimed ─────────────────────► sending
                                                      │
               ┌──────────────────────────────────────┤
               │                                      │
               ▼                                      ▼
            accepted                               failed
        provider accepted                  permanent error / budget spent

sending ── temporary error / uncertain result ──► retry
retry   ── next attempt time reached ───────────► sending
sending ── interrupted claim recovery ──────────► retry or failed
```

Recovery also preserves a known accepted attempt from an older settlement path by moving its reminder to `accepted` rather than dispatching it again.

`accepted` and `failed` are terminal for the inspected automatic workflow. Reconnecting a browser does not reset failed reminders. Overdue is not a sixth stored state. It describes the relationship between original due time and current progress.

### Attempt outcomes

| Outcome | Meaning | What it does not establish |
| --- | --- | --- |
| `started` | An attempt record exists before the provider call | Provider acceptance or even that the call began before a crash |
| `accepted` | The provider accepted the submission | Browser display or owner observation |
| `failed` | The transport returned a classified unsuccessful result | That the reminder has exhausted its retries |
| `unknown` | The result could not be established, including interruption | That no notification was displayed |

### Claim, send and settlement

1. The worker checks effective pause, transport availability and subscription presence.
2. Storage atomically claims eligible scheduled/retry reminders, changes each to `sending`, increments its attempt count and assigns a private claim token and lease.
3. The worker records the delivery attempt with the selected subscription version, then calls the transport outside the claim transaction.
4. Settlement updates the reminder and finishes its attempt in one transaction, guarded by the claim token and `sending` state. A stale result cannot overwrite a newer claim.
5. Expired claims are recovered during polling. Startup recovers all sending claims, based on the assumption that this is the only application process using the database.

Claiming and attempt-record insertion are separate transactions. A crash between them can leave a counted claim without an attempt row. The stored subscription version is selected after claiming, not atomically captured in the claim transaction. These details matter when reasoning about crash evidence and subscription replacement.

### Retry and pause policy

- A normal polling delay is 5 seconds after a pass, with at most 50 reminders processed sequentially in one pass. Backlog processing and network delays mean this is not a universal five-second latency guarantee.
- The transport deadline is 15 seconds; the default lease is 30 seconds.
- Temporary failures retry after 30 seconds, 2 minutes and 10 minutes from failed completion, up to four counted attempts.
- An expired or gone subscription fails that reminder permanently. The current code does not automatically clear the subscription's readiness flag.
- An uncertain transport result is recorded as `unknown` and can be retried. A crash after provider acceptance but before durable settlement can cause duplicate notification attempts.
- Lease recovery makes retry work eligible at recovery time, unless the attempt budget is exhausted. It does not apply the ordinary temporary-failure backoff.
- Missing push configuration or a missing subscription leaves due work waiting, not failed.
- Effective pause is stored owner pause OR the configuration override. It prevents new claims through worker checks, but does not retract an in-flight send. Claim storage itself does not enforce pause.
- All eligible overdue reminders can eventually be processed; no age cutoff rewrites or expires them. This is not a promise to clear an arbitrary backlog within 60 seconds.

The intended normal-condition provider-submission target is within 60 seconds of due. Provider acceptance is separate from desktop display, and no exactly-once display guarantee is made.

Source: [worker](https://github.com/markdlabrecque/r2/blob/1556818/src/worker.ts), [claim and recovery storage](https://github.com/markdlabrecque/r2/blob/1556818/src/db.ts), [transport](https://github.com/markdlabrecque/r2/blob/1556818/src/push.ts), [status and pause](https://github.com/markdlabrecque/r2/blob/1556818/src/status.ts).

## Browser connection is not proof of receipt

The implementation exposes four different facts:

| Fact | Meaning |
| --- | --- |
| Push configured | R2 has the server-side configuration needed for a transport |
| Browser connected | A current subscription exists |
| Browser ready | A test push was accepted for that subscription version |
| Notification observed | The owner actually saw a desktop notification |

Replacing the singleton subscription increments its version and clears readiness. A test result can mark ready only the version it tested; a late test acceptance cannot mark a replacement ready.

**Important discrepancy:** the approved task plan required explicit owner receipt confirmation and readiness checks before confirmation/dispatch. At the inspected revision, `/api/push/test` marks readiness immediately on provider acceptance. There is no owner receipt-confirmation endpoint, and neither `confirmProposal` nor the worker's dispatch path requires `readyAt` to be set. A connected, untested browser can therefore be used for scheduled dispatch. Readiness is a reported setup fact, not an enforced delivery gate.

The glossary describes the actual narrow meaning of readiness. It does not endorse acceptance as evidence of display or decide whether the stronger planned gate should be restored. That requires an explicit product decision and code changes.

Source: [push routes](https://github.com/markdlabrecque/r2/blob/1556818/src/push-routes.ts), [worker](https://github.com/markdlabrecque/r2/blob/1556818/src/worker.ts), [UI](https://github.com/markdlabrecque/r2/blob/1556818/web/app.ts), [service worker](https://github.com/markdlabrecque/r2/blob/1556818/web/sw.ts).

## Edge cases that test the language

| Scenario | Domain interpretation |
| --- | --- |
| The model returns a complete time, but the owner closes the tab without saving | A proposal may exist; no reminder was confirmed |
| The owner double-clicks Save, or retries after a lost response | One proposal yields one reminder, not two commitments |
| The owner changes timezone after saving | New requests use the new setting; the existing reminder keeps its confirmed time |
| A confirmed proposal is requested again after due | It identifies the original reminder, not a fresh past-due reminder |
| The service is stopped at due time | The reminder becomes overdue; its original due time is unchanged |
| The service restarts with no model configured | Saved delivery work remains independent of interpretation |
| The provider accepts but macOS suppresses the alert | Provider acceptance is recorded; observed notification is not established |
| The process dies after send but before settlement | The outcome may be unknown; recovery may cause duplicate display |
| An attempt fails temporarily and another succeeds | The earlier attempt remains failed; the reminder ends accepted |
| The owner pauses during an active send | That send may finish; subsequent claims wait |
| A second device signs in but does not connect notifications | It is another owner access device, not a new recipient |
| A browser is replaced while an old test send is in flight | Acceptance of the old test cannot make the new subscription ready |
| A subscription returns 410 | The reminder fails; current implementation may still report the browser ready |

## Code navigation

All links in this table refer to the inspected merged revision rather than assuming this checkout has been updated.

| Concern | Main source | Regression-test entry points |
| --- | --- | --- |
| Shared records and boundary types | [contracts.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/contracts.ts) | [storage.test.ts](https://github.com/markdlabrecque/r2/blob/1556818/tests/storage.test.ts) |
| Owner authentication and request protection | [auth.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/auth.ts), [routes.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/routes.ts) | [auth.test.ts](https://github.com/markdlabrecque/r2/blob/1556818/tests/auth.test.ts) |
| Timezone and pause | [settings.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/settings.ts), [status.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/status.ts) | [worker.test.ts](https://github.com/markdlabrecque/r2/blob/1556818/tests/worker.test.ts), [auth.test.ts](https://github.com/markdlabrecque/r2/blob/1556818/tests/auth.test.ts) |
| Interpretation, proposal and confirmation | [chat.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/chat.ts), [reminders.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/reminders.ts), [openai.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/openai.ts) | [chat.test.ts](https://github.com/markdlabrecque/r2/blob/1556818/tests/chat.test.ts) |
| Persistence and delivery transactions | [db.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/db.ts), [001.sql](https://github.com/markdlabrecque/r2/blob/1556818/migrations/001.sql) | [storage.test.ts](https://github.com/markdlabrecque/r2/blob/1556818/tests/storage.test.ts), [worker.test.ts](https://github.com/markdlabrecque/r2/blob/1556818/tests/worker.test.ts) |
| Notification registration and transport | [push-routes.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/push-routes.ts), [push.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/push.ts) | [push.test.ts](https://github.com/markdlabrecque/r2/blob/1556818/tests/push.test.ts) |
| Dispatch and recovery | [worker.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/worker.ts) | [worker.test.ts](https://github.com/markdlabrecque/r2/blob/1556818/tests/worker.test.ts) |
| Owner UI and generic notifications | [app.ts](https://github.com/markdlabrecque/r2/blob/1556818/web/app.ts), [sw.ts](https://github.com/markdlabrecque/r2/blob/1556818/web/sw.ts) | [web.test.ts](https://github.com/markdlabrecque/r2/blob/1556818/tests/web.test.ts), [sw.test.ts](https://github.com/markdlabrecque/r2/blob/1556818/tests/sw.test.ts) |
| Composition and lifecycle | [service.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/service.ts), [main.ts](https://github.com/markdlabrecque/r2/blob/1556818/src/main.ts) | [browser/slice.spec.ts](https://github.com/markdlabrecque/r2/blob/1556818/browser/slice.spec.ts), [e2e/reminder-flow.spec.ts](https://github.com/markdlabrecque/r2/blob/1556818/e2e/reminder-flow.spec.ts) |

The test links are navigation references, not a claim that every scenario above has coverage or that tests were rerun for this documentation change. Synthetic adapters cannot establish real provider delivery or Tailscale isolation.

## Unresolved intent versus implementation

Before treating the approved plan as an as-built specification, reconcile these differences:

- **Readiness:** owner-confirmed receipt and enforced readiness were planned; current readiness records test acceptance only and is not a confirmation/dispatch prerequisite.
- **Failure invalidation:** the plan called for a gone subscription to invalidate readiness for that version. Current dispatch records the reminder failure without clearing readiness.
- **Claim atomicity:** the plan described claiming, attempt insertion and subscription capture as one transaction. They are separate operations in the implementation.
- **Retry-After:** the plan called for bounded provider Retry-After handling. Current worker uses fixed delays, and the transport result does not carry a retry-after value.
- **Interpretation policy:** planned limits included a 10-minute proposal, 100 requests/day and a per-minute model quota. Current chat uses a 15-minute maximum proposal lifetime, 200 requests/day and no per-minute model quota in that path.

These are documented differences, not newly approved decisions or a complete correctness audit. No ADR is created here: this session discovered existing behavior but did not choose alternatives or settle those trade-offs. If the owner chooses to retain or change a consequential policy, record the rationale at that point.
