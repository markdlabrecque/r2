# Host safety review

Verdict: PASS, self-review for [29](https://github.com/markdlabrecque/r2/issues/29).

Reviewed against the full parent/host tickets, journal contracts and report projection, installed unit, private installation guide, application config/status behavior and first-slice plan. Integrated [35](https://github.com/markdlabrecque/r2/pull/35), commit `036d4565755de223409b8ffbb0951e3086d47e22`, before the combined validation below. No delegate or Factory task run was used.

## Findings fixed during review

- Compared installation fields by identity rather than serialized object key order.
- Reconciled absent `/run` ancestors after reboot without recreating files.
- Kept ordinary rollback active when a test hook is installed but has not simulated interruption.
- Bounded filesystem reads at the descriptor rather than trusting only a prior size check.
- Rejected runtime operation strings outside the fixed catalog, not only TypeScript-invalid values.
- Serialized host instances sharing a journal lease and consumed approval objects across host instances.
- Kept a timed-out mutation pending and blocked recovery until its executor acknowledges termination. A late result cannot resolve the intent.
- Required no pending systemd Job before cleanup touches files, because killing a systemctl client does not cancel the manager's job.
- Bound the sole loopback listener to the actual service PID, not merely to port 3000. Deliberate start requires an absent listener.
- Recorded explicit restore-model intent before recovery of a previously completed stop/disable operation.
- Created an absent shared runtime drop-in container only after durable intent. Never remove or adopt that container as a fingerprinted owned artifact.

## Safety checks

- Fixed executables and arguments, no shell, no live executor, no credential-bearing request environment, bounded deadlines/output and sanitized error messages.
- Non-production acknowledgement, disruption flag, fresh interactive run/stage/operation approval, privilege callback, known revision, supported layout and journal ownership precede mutation.
- Installed secret environment is metadata-only. Runtime override uses final EnvironmentFile precedence and exclusively created 0600 files. Installed unit/config contents remain unchanged in the synthetic evaluator.
- Ownership fingerprints and restoration flags precede effects. File creation, reload, restart, journal commit/checkpoint/resolve and cleanup failures are covered before and after their boundaries.
- Missing, partially written, linked, changed, pre-existing and concurrently owned artifacts are not adopted or blindly deleted. Failed health remains failed and retains the lock.
- Host facts never assert assistant availability, provider acceptance, observed notifications, real Firefox behavior, outside-client denial or reboot acceptance.
- No shared journal/schema/API files, app behavior, Factory scaffold/dependencies, CI or installation files changed.

## Node 24 validation

All checks ran with `~/.config/nvm/versions/node/v24.20.0/bin` first on PATH.

| Check | Result |
| --- | --- |
| Host synthetic suite | 76 passed |
| `npm run test:factory` | 7 passed, setup tests only, no Factory task run |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | 249 passed, 1 existing skipped test, 16 files |
| `npm run test:browser` | 2 Chromium tests passed |

## Remaining limits

The public adapter/recovery contract and fixed operator instructions are documented in `docs/acceptance-host.md`. Live command spawning, truthful deployment provenance, real service UID/privilege/TTY facts and actual boot/liveness probes still need trusted CLI wiring. The owner must reconcile orphan commands after process loss, unsupported layouts, changed revisions, uncertain ownership gates and partial-file/operator conflicts. Empty shared runtime directories can remain. The coordinator must restore API pause state and verify assistant disabled/enabled separately. Reboot preparation/resume must use the existing same-run journal ownership protocol.

All host operations in this review were synthetic. No real installation, environment file, service, Tailscale configuration, credentials, provider, push transport or production host was touched. Passing tooling tests are not owner acceptance evidence.
