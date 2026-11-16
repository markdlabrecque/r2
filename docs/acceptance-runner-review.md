# Coordinator self-review

Verdict: **PASS** for the synthetic implementation of [31](https://github.com/markdlabrecque/r2/issues/31). This is a self-review, not an independent review or installed-host acceptance verdict.

## Scope checked

Read the full epic/task/dependency tickets, AGENTS.md, PRD, approved slice plan content, glossary/domain model, journal/API/host documentation, actual acceptance adapters, and app chat/worker/push/session/status contracts. Baseline includes journal `296cfe4`, API/cases `036d456` and host `276b352`. No discarded acceptance implementation was used.

Reviewed these failure boundaries against the final implementation:

- Shared host/unit lease ownership before every live stage, strict non-production mode and explicit disruption capability, fresh operation/stage approval, and initial active/ready installation. A stage rechecks installation/API/timezone facts even when preflight was completed earlier.
- Persisted stage and stable case intent before external effects. Confirmation replay keeps its proposal/request pair; lost model responses remain unresolved. Completed stages are reused; an interrupted active stage requires deliberate retry rather than an implicit new reminder.
- Original pause survives lost PUT responses and 401s. Restoration retains an unrelated pending case intent. Host debt and API pause debt are attempted independently; refusal/conflict in one does not silently drop the other. Unverified/conflicted cleanup retains a failed report and lock.
- Host stop-to-model-disabled-start and restart-with-pause-debt use the real adapter. Runtime override fingerprints, original environment protection, approval consumption and command bounds remain intact.
- Provider acceptance, normal submission timing and owner-observed desktop display remain independent. Declined/unavailable checkpoints cannot be affirmative. External denial and second-device evidence are never supplied by localhost fixtures.
- Strict journal extension contains only catalogued stage names. IDs, timestamps, unknown-field rejection and report projection remain restricted. Recovery instructions are fixed strings; report future cases show labels/due times, not private IDs or text.
- Reboot checkpoint is read-only, bound to a confirmed future case and clean journal. No reboot implementation, boot-change evidence or authority is invented. Original-true-pause preparation is explicitly left behind the existing verified-cleanup reboot precondition for the reboot task to handle safely.

## Findings fixed during self-review

1. Installation objects had different property insertion order across actual adapters. Replaced stringified-object equality with field equality. The end-to-end tests now use the real host binding.
2. A host restore exception initially prevented the API pause restore attempt. Cleanup now attempts independent obligations and preserves conflict/failure status. Tests exercise operator-edited artifacts and declined restore approval with original pause true.
3. Failed cleanup with no remaining mutation flags could otherwise be relabeled verified during deliberate retry. Retry no longer clears it. Recovery verifies ready/bound host, enabled-model API status and original pause before clearing that failure.
4. Slow operation approval could cross due before a stop/disable/pause mutation. Due-window checks now run again after approval, before the effect. Late setup cannot pass normal timing.
5. Separate coordinator instances could share a lease concurrently in one process. Live entry points now have a shared lease guard, including deliberate retry. The durable journal lock still handles separate invocations.
6. A second-device test could replace the recipient after the first comparison. The coordinator now compares subscription version again after owner-reported receipt.
7. Lost ambiguous-request responses now retain proposal-unresolved state just like lost exact-proposal responses.

No unresolved implementation finding remains in this scope. Recovery intentionally stops for operator conflicts, unreconstructable model responses, uncertain ownership, unsupported installation or unavailable human evidence.

## Execution evidence

All commands used Node **v24.20.0**, with its bin directory first in PATH:

- `npm run test:factory`: 7 passed. This is the scaffold test suite, not a Factory run.
- `npm run typecheck`: passed, including acceptance scripts and tests.
- `npm run build`: passed.
- `npm test`: 404 passed, 1 existing skipped test, 17 passing files. The runner file contributes 155 synthetic tests.
- `npm run test:browser`: 2 Chromium tests passed.

Runner tests exercise actual app routes and SQLite with injected model/transport, actual journal/API/case/host implementations with temporary synthetic host files/commands, fake time and explicit scripted prompts. Fault matrices cover before/after API mutation requests, intent commits, intermediate/resolution checkpoints, stage-completion commits, host mutation/recovery boundaries and unavailable/throwing human checkpoints. No real sleeps are used by the runner tests.

No application source, dependency, CI, Factory profile or credential file was changed. No credentials, model provider, push service, system service, Tailscale, reboot, production server or 1Password was accessed for acceptance. Synthetic tests are not owner evidence for the installed application.
