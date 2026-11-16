# Explicit reboot preparation and resume

`scripts/acceptance/reboot.ts` implements [32](https://github.com/markdlabrecque/r2/issues/32). It is a library over the existing runner, host, API, cases and journal. No CLI, persistent resume service, SSH orchestration or live executor is installed. Development and review used synthetic inputs only. This document does not establish owner acceptance.

## Wiring for the CLI

Construct `AcceptanceReboot` with the same actual adapters and owned `JournalLease` used by `AcceptanceRunner`, plus the reboot-specific options:

```ts
const reboot = new AcceptanceReboot({
  api, host, lease, clock, wait, prompt,
  mode: 'non-production-live', hostDisruption: true,
  rebootCapability: true,
  interactive: () => actualTerminalIsInteractive(),
  reauthenticate: async () => api.login(await privatePasswordPrompt()),
  acknowledgeResume: async runId => {
    // Render the EXACT invocation supported by the future CLI, with this run's
    // private state path and explicit reboot-resume mode. No password or cookie.
    // Explain that the operator must invoke it manually after reconnecting.
    return displayCommandAndAskForAcknowledgement(runId);
  },
});
await reboot.prepare(); // explicit, potentially disruptive operation
// In a NEW process after boot: verify host identity, take over the SAME run's
// stale lock, re-create adapters and this object with the replacement lease.
await reboot.resume();
```

This is a wiring example, not runnable CLI syntax. [33](https://github.com/markdlabrecque/r2/issues/33) owns command spelling, private password entry, terminal/signal handling and real trusted executor/process adapters. `acknowledgeResume` is mandatory. It must display the exact supported manual command and wait for explicit acknowledgement, not merely print a generic instruction or return a flag's value. The library passes only the safe run UUID; the caller already knows its private state location. Credentials must be requested again in memory, never copied into a state or auto-resume file.

`RebootOptions` extends `RunnerOptions`. The host additionally supplies `identity`, `bootId`, `inspectBoot` and `reboot`. Its roots/executor/UID mapping remain trusted boundaries, never CLI overrides. The caller must bind its configured HTTPS origin to this same installed host. `interactive()` is an actual terminal fact, not a user assertion. Every affirmative prompt is fresh, with no default. Preparation requires live non-production mode, host-disruption opt-in and a distinct reboot capability. Resume requires the same explicit capabilities and terminal because it can perform approved service recovery and temporary unpause, but it has **no reboot or new-case path**.

`RebootError.code` and its fixed message are safe. Never print arbitrary caught errors, transport data or command output. Journal/report failures must stop the caller; an error after atomic rename is an uncertain committed checkpoint, not permission to retry the action.

## Preparation order

1. Prove the current lease is still owned, and its boot ID agrees with `host.bootId()`. The host reads `/proc/sys/kernel/random/boot_id` using bounded, non-following reads. No hostname is returned.
2. Enter the runner's existing same-lease exclusive gate and obtain non-production live approval. Recover all owned host changes and original notification pause through the existing coordinator. Model overrides, service restoration, reload debt, API pause debt and operator conflicts cannot survive into the reboot intent. A/B/C/devices must be completed with no active interrupted stage. The installation must already be ready; preparation never starts an initially failed installation to pass preflight.
3. Inspect boot prerequisites. `inspectBoot()` includes the existing supported unit/revision, active/enabled service, actual service Node, restrictive permissions, synchronized clock, health, matching loopback listener, Serve HTTPS upstream and Funnel absence. It additionally requires `tailscale status --json` to report `BackendState: Running`. All commands are read-only and bounded.
4. Reuse an existing confirmed `reboot` case. If none exists, request separate model-quota and explicit-save approvals and use `AcceptanceCases` to propose, validate and confirm one unique synthetic reminder. An unresolved/proposed/blocked reboot case is not silently replaced. Lost confirmation responses are recovered through `AcceptanceRunner.recover()` and the existing stable proposal/request protocol before trying preparation again. A lost model response needs deliberate owner reconciliation, not another implicit request. Browser subscription, Connect, timezone and app policy never change.
5. Verify the exact known reminder and unchanged original schedule with no attempt yet. Persist `phase: prepared` using runner checkpoint eligibility, bound to the installed fingerprint/revision, original boot and stable case request ID. The case already holds proposal/reminder IDs and due time. Default lead time is ten minutes, supported reboot lead time is two minutes to one hour. More than sixty seconds must remain after all approvals; expiry/late approval blocks instead of moving the due time.
6. Have the caller display the exact manual resume command and obtain acknowledgement. Then ask a separate explicit `reboot` approval for this run/stage/action. Declined or unavailable acknowledgements/approvals are recorded and perform no reboot.
7. Recheck current boot, owned lease, pause restoration and due window. Atomically persist `phase: pending` plus the exact reboot mutation intent while cleanup is verified. Only a successful persistence return permits the host call.
8. The real host implementation independently enforces current installation, privilege, TTY, single-use scoped approval, verified cleanup, owned lease and the pending checkpoint. After another read-only boot inspection it sends only `/usr/bin/systemctl reboot --no-ask-password` to the injected executor. There is no shell, force flag, reboot daemon or ordinary-run reboot fallback.

There is no deliberate pause debt across reboot. When the original owner pause is true it stays true throughout preparation and boot. The post-boot runner extension waits through the original due instant, then separately explains and requests temporary unpause. That action can release **all** overdue owner reminders, not just this synthetic case. It restores the original true preference in `finally`. A declined unpause leaves the case incomplete and the preference unchanged. Repeated completed resume does not unpause again.

## Interruption and ownership

A prepared checkpoint is not scheduling evidence or reusable authority. Preparation is single-shot once a reboot checkpoint exists. Resume refuses prepared/declined checkpoints. It cannot finish an interrupted approval by assuming yes. A later deliberately new run can have new permanent cases; the operator must review existing future reminders first. This conservative design avoids an implicit second model request or reboot.

A pending or failed reboot intent is never replayed. Even a nonzero systemctl exit may follow an accepted D-Bus action, so command error, lost response, timeout and process death retain scheduling uncertainty and the lock. The failure is recorded without claiming a new boot. Cleanup was already restored and verified before this action; do not introduce a restart to make uncertainty disappear. Generic `run()` and `recover()` export this state and its fixed explicit-reboot recovery guidance without changing the intent.

After a verified new boot, use `AcceptanceRegistry.owner()` and `takeoverStale()` with the same run, a fresh token and the actual new boot/PID/start identity. Feed `classifyOwner` independently verified current boot/process facts. Do not synthesize a `stale` verdict in live wiring. A live owner, unknown process facts, corrupt journal or ownership gate left by a crash blocks takeover. Never unlink a lock or ownership gate on an age assumption. The old lease cannot write or release after takeover. See [acceptance-journal.md](acceptance-journal.md).

If a command failed and the machine never rebooted, same-boot resume remains blocked. The owner must privately establish that no orphan command, reboot job or delayed shutdown remains before manual reconciliation. This library deliberately provides no automatic clear/retry method for that uncertain case. Do not copy a credential file, blindly delete the lock or edit the boot ID to make acceptance pass.

## Resume order and truthful evidence

Resume first validates the checkpoint, exclusive current-boot lease, the same stable installed identity and a different boot ID. A different revision is a different installation for this protocol. Another later reboot after a recorded resume snapshot is blocked rather than being attributed to this test.

Before coordinator recovery can start/restart a service or change pause, resume performs read-only host/Tailscale/Serve/listener/health inspection and attempts authenticated HTTPS settings and known-reminder reads. It reauthenticates only through the caller's in-memory callback after a 401. If the service is down, the reminder read is attempted but unavailable; it can only be verified after approved repair. Absence from the app's bounded reminder list is not proof of deletion.

The first new-boot snapshot atomically records the current boot and time, immutable automatic-recovery outcome, changed-boot and automatic-recovery checks, and any available retained-reminder result. This commit also resolves the old reboot intent. There is no crash gap in which repair can run without a durable pre-repair result. On repeat resume, that outcome and first resume time cannot be rewritten. Host readiness after repair does not change failed automatic recovery to pass.

An inspectable inactive or unhealthy service records restoration debt in that snapshot. The existing runner/host recovery path then requires a fresh `restore-model` approval before restarting and checking health. Unsupported layouts, unknown inspection results, Serve/Tailscale errors or unsafe listeners are not permission to repair their configuration; those need private owner investigation. The library never starts Tailscale or edits Serve/Funnel. If automatic recovery fails, later successful provider acceptance still leaves the automatic-recovery check failed.

The retained-reminder check compares the known ID, proposal, original UTC instant, local date/time and timezone. A positively observed mismatch remains failed rather than being erased after repair, and cannot authorize temporary unpause. An owner pause change without this run's restoration intent is an operator conflict, not permission to silently unpause or overwrite the new preference. Cleanup now verifies the actual original pause even when no restoration flag remains. Provider polling uses only that known reminder and records the original attempt/acceptance times. It is bounded by fake/injected clock and wait in tests. Reports distinguish:

- `normal-window`: first resume was before due, notifications were not originally paused, and acceptance was within sixty seconds of original due.
- `overdue-recovery`: first resume was at/after due, or the originally paused run deliberately waited through due before unpausing. This never counts as normal on-time evidence.
- `missed-window`: the normal submission window was not established. Overall acceptance remains blocked even if provider acceptance and observed display pass.
- `pending`: provider evidence has not yet been classified.

Provider acceptance, changed boot, automatic recovery, retained time and owner-observed display are separate checks. A `reboot-observed` answer must explicitly refer to the reboot case in real stock Firefox on the MacBook. A resumed process cannot infer a historical notification from provider acceptance. Unavailable observation stays blocked; an explicit negative observation fails. Missing human/device checks elsewhere in the run remain untouched.

Opting into the reboot stage durably sets `coordinator.rebootSelected = true` and makes all reboot checks required in the report, even if they were optional at journal creation. This flag cannot be removed; a declined model/save step remains incomplete even after later ordinary completion. Before opt-in, the original optionality remains. Safe report projection exposes phase/time/submission classification only, never boot IDs, fingerprints, revision, internal case IDs, hostname, origin, session, credentials, subscription or reminder content.

## Test limits

`tests/acceptance-reboot.test.ts` drives the complete A/B/C/device baseline and reboot operations with real acceptance adapters, actual app routes and temporary SQLite. The dedicated fixture uses synthetic host files, systemd/Serve/backend/listener facts, model results, push transport, clocks and scripted prompt answers. Atomic-write and host-command interruption tests do not kill or reboot the development machine. They prove durable protocol behavior, not systemd startup or Firefox display on the owner's host.

No actual reboot, service operation, Tailscale mutation, provider call, live push, credential entry, production access or 1Password operation was performed. Real automatic host recovery, private HTTPS reachability from intended devices, Firefox permissions/display/click-through and excluded/outside-client denial remain owner evidence.
