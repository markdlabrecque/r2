# Acceptance coordinator

`scripts/acceptance/runner.ts` implements [31](https://github.com/markdlabrecque/r2/issues/31). It is a library, not a CLI, a reboot executor, or evidence that an installed application passed acceptance. No live acceptance was performed during development.

## Wiring for the CLI

Construct `AcceptanceRunner` with the **actual** `AcceptanceApi`, `AcceptanceHost`, acquired `JournalLease`, clock, wait and prompt adapters. `RunnerOptions.host` is a structural pick of the real host methods so synthetic tests can substitute a host. The tests also run the real host implementation against a temporary filesystem and injected commands.

```ts
const runner = new AcceptanceRunner({
  api, host, lease, clock, wait, prompt,
  mode: 'non-production-live', hostDisruption: true,
  reauthenticate: async () => { await api.login(await privatePasswordPrompt()); },
});
const report = await runner.run(abortSignal);
// A signal or runner.cancel() stops new work; cleanup ignores cancellation.
// After an interruption, use the same run, not a new journal:
const recoveryReport = await runner.recover();
```

The CLI must supply trusted installation/process/boot facts and acquire the host/unit lease before creating or loading a journal. Use the journal's same-run stale-owner takeover protocol after process death. Do not release a lock with pending intent or unverified cleanup. Do not substitute per-run locks or a different registry location. `run` does not release the caller's lease. Export/report failures throw a generic journal error and must stop the CLI, not be treated as acceptance success.

Credentials, API origin, cookies and raw adapter errors stay in memory. The real routes are `POST /api/session` and `DELETE /api/session`, not the login/logout names in the original API ticket. `reauthenticate` must privately obtain credentials and call this same client's `login`. It must not persist the password or add it to process arguments. Recovery retries API calls after a 401 only when this callback exists, at most once per call.

The prompt adapter renders `RunnerPrompt.message` and optional safe case label/number/due time. It must require an explicit answer and return `approved|declined|unavailable|cancelled`. There is no default yes. Missing input, noninteractive checkpoints or an unsupported response are unavailable, never affirmative. Only real owner answers may populate human evidence in a live invocation. Synthetic prompt adapters prove the coordinator's behavior, not notification delivery or access denial. Host approval remains fresh, ephemeral, operation/run/stage-scoped and additionally subject to the host adapter's real TTY and privilege checks.

The wait adapter implements `until(epochMs, signal)` using the provided clock, and must honor cancellation. Tests advance a fake clock without sleeps. The live adapter must not run any next step before the requested instant. API polling is deadline- and iteration-bounded. Defaults are ten minutes of lead time and two minutes of provider polling. The sixty-second normal-submission target is not a browser-display deadline.

`mode: 'read-only'` makes `run` call `inspect` only. This inspects the host and sends a separate anonymous safe GET, with no session header, prompts, app writes or service operations. It returns `{ready, anonymousDenied}` without modifying the journal or evidence files. The CLI can render those safe facts in memory. A read-only invocation is not a live acceptance report. Live mode requires explicit non-production disclosure approval. Host operations also require `hostDisruption` and separate current-operation approval. Missing disruption capability blocks the scenario before creating reminders.

Do not expose trusted host roots, UID mappings, command execution or synthetic transports as user flags. No real executor, credential prompt or terminal implementation ships in this module. Preserve the host adapter's bounded fixed commands and its orphan-command/job recovery restrictions.

## Sequence and evidence

The live sequence is preflight, browser, A, B, C, devices, then cleanup. Every stage start is committed before any external stage action. Preflight requires the exact bound installation, ready/active host, existing timezone, authenticated API, invalid-origin rejection, configured model and push, and no configuration-forced pause. The runner never changes timezone or starts an initially stopped installation.

The browser stage explains recipient replacement **before** asking the owner to use Connect. It asks for stock Firefox on the MacBook, explicit OS and site permissions, then the app's Connect and test controls. API readiness establishes only provider acceptance of the connected browser's test. Actual display, generic title/body and private-origin/authentication click-through have independent owner checkpoints. There is no receipt API.

- A journals an ambiguous request and checks clarification/no new saved row. It journals and validates a separate exact proposal, checks no save before confirmation, asks explicit save approval, and repeats the same proposal/request confirmation to verify identity. It disables the model and restarts before due, checks assistant-disabled API status and retained reminder fields, and asks the owner to close **all** R2 tabs while Firefox keeps running. Provider polling and actual desktop display are separate. A late setup window cannot pass normal submission timing.
- B restores/enables the model before creating a new confirmed case. It stops before due with approval, waits past the original due instant, then separately obtains disable-model approval. The host creates its override while the owned installation is stopped, reloads, and **starts** model-disabled. The coordinator checks disabled API status, original time retention, overdue provider acceptance and owner-observed display.
- C restores/enables the model before creating its case. It pauses before due, restarts with approval, verifies stored/effective pause and no attempt across due, checks retained time, then explicitly unpauses and collects overdue provider and display evidence.

Temporarily unpausing warns that **all** overdue owner reminders can become eligible, not just synthetic cases. The original stored pause is snapshotted before change and restored on exit even when originally true. The model is restored and its enabled API status checked between scenarios. Cleanup verifies an active, healthy, bound installation. A failed or conflicted cleanup cannot become a pass.

The devices stage asks for authorized second-device chat **without Connect or Save**, compares subscription versions before and after chat and again after the receipt checkpoint, and asks for receipt on the intended MacBook Firefox. Signed-out denial, actual outside-tailnet denial and actual policy-excluded-client denial are distinct owner-reported checks. Local fixtures, localhost tests and policy inspection do not establish external denial. Missing clients stay blocked, with subsequent checks visible as not-run.

A stage stops at failed/unavailable evidence. It does not auto-affirm later gates to finish the sequence. Reports retain every required check as pass/fail/blocked/not-run with provenance. Optionality is restricted to reboot checks selected at journal creation. This task adds required coordination/model/origin/recipient/retention checks; older journals consequently remain incomplete until they have that evidence.

## Interruption, recovery and deliberate retries

`Journal.coordinator` is an optional strict version-1 extension containing only `completed` stages and `active`. It contains no raw prompt answers or authority. Existing journals without it still validate. Completed stages are reused on normal continuation. An active stage after interruption is **not automatically replayed**. First recover owned host and pause state, then return an interrupted result. This conservative stop prevents another model call or permanent reminder from being created by a resume command.

Every model and confirmation request has a stable case and persisted mutation intent before the call. Clarification uses its own case history entry but no confirmed reminder. Both kinds of lost model response remain proposal-unresolved with pending intent. Lost confirmation recovery uses the same stored proposal/request pair through `AcceptanceCases.reconcileConfirmation`, never a replacement case. The helper's near-due/expired recovery restrictions remain in force. A case needing private operator reconciliation remains pending rather than being guessed away.

`recover()` asks for non-production recovery authority, restores owned host changes with fresh restore-model approval when needed, and restores the captured original pause. Pending pause writes can be reconciled after reauthentication. Pause restoration can coexist with an unresolved proposal/confirmation intent: checkpoint that exact intent rather than overwriting or dropping it. Host recovery failure does not suppress an independent attempt to restore pause. A stopped/unreachable service can still prevent the API restore, so its durable flag remains and the lock stays held. Conflicting host artifacts are preserved.

`retryStage()` is deliberately separate from recovery and continuation. It requires explicit owner approval acknowledging retained permanent reminders and possible new quota/reminder cost. It refuses outstanding host/pause debt. It can mark an unresolved model case blocked/interrupted and resolve that exact intent. Existing blocked outcomes and stable IDs/times remain unchanged. Confirmed earlier cases get an interruption reason and remain in history; a retry appends a new numbered case. No deletion, cancellation, reset or due-time rewrite exists. After acknowledging an unresolved proposal, a previously failed cleanup is verified again against host/model/pause facts before new stages run, not simply relabeled verified.

Live `run`, `recover` and `retryStage` export sanitized JSON and Markdown in `finally`. Reports include fixed recovery instructions and remaining future synthetic case **labels and due times**, never their internal IDs or reminder text. A report-file write failure must stop the caller. Review future cases before authorizing a retry; they can still notify later. Checkpoint timestamps determine the report's future-case list, not an invented delivery outcome.

## Interface for reboot work

`rebootCheckpoint()` is a **read-only eligibility/binding method**, not preparation execution or reboot authority. It requires completed A/B/C/devices stages, no active stage/pending mutation, verified cleanup, and an independently confirmed future `reboot` case with at least sixty seconds left. It returns a prepared checkpoint binding the installation, original boot ID and stable reboot case request ID. It neither persists that checkpoint nor claims a boot changed.

The reboot module must independently obtain approval for its model request/confirmation using `AcceptanceCases`, recover through this coordinator first, and establish actual current boot/process/installation facts. Persist the prepared checkpoint, then pending checkpoint and reboot intent through the journal protocol **before** any separately authorized reboot effect. This coordinator exposes no reboot command, live process adapter or automatic-recovery evidence. Resume must take over the same run safely and call recovery before new work. Runtime artifacts missing after reboot are reconciled by the host adapter, never blindly recreated.

The current journal's reboot-intent precondition is verified cleanup. This method deliberately refuses a reboot with outstanding temporary pause or host changes. Reboot preparation must not bypass that condition or forget an originally true pause. Any reboot design needing pause-only restoration debt across reboot needs an explicit, tested shared-contract extension in the reboot task. This is a safety boundary, not evidence of reboot acceptance.

## Tested limits

`tests/acceptance-runner.test.ts` uses actual app routes, temporary SQLite, real case/API/journal/host implementations, synthetic systemd facts/files, a fake worker transport, injected clock/waits and scripted prompts. It covers both original pause values, all scenarios, late windows, rejected/expired proposals, lost model/confirmation responses, 401 restore, unavailable evidence, recipient replacement, cleanup refusal/conflict/health failure, cancellation and concurrent use of a lease. Mutation requests, intent writes, intermediate/resolution writes, host boundaries, prompt failures and stage-completion commits have before/after interruption tests.

No passing synthetic fixture proves real systemd precedence, provider operation, desktop display, Firefox permission behavior, private-origin routing, ACL behavior or reboot recovery on the owner's installation. Those remain owner acceptance work. No application behavior, dependencies, CI or Factory execution policy was changed.
