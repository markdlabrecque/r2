# r2 Factory environment

The project uses the installed shared Factory workflow, GitHub tracking and
OpenAI Pi. Configuration lives in `factory.toml`; additive environment guidance
is in `../docs/factory-common.md`. No workflow code is copied into this repo.

- Eligible tickets require `ready-for-agent`; `blocked`, `needs-human` and
  `wontfix` veto selection. Selected parents confer eligibility on children.
- Automatic squash merge requires Factory gates and the exact CI job `tests`.
- The image is `r2-factory`, with Node 24.20.0, Pi 1.5.2 and Playwright 1.65.0.
- Startup installs locked application dependencies with `npm ci` as non-root.
- `skills/writing-tests/SKILL.md` is a project-owned snapshot of
  `~/.agents/skills/writing-tests/SKILL.md`, installed in the image at
  `/home/agent/.agents/skills/writing-tests/SKILL.md`, with a symlink from
  `/home/agent/.pi/agent/skills/writing-tests` for bundled Pi discovery. To refresh
  it, copy the reviewed host skill into that build-context path and rebuild the
  image. Host skill edits do not automatically update this snapshot.
- `.env` is private and ignored. Standard sandboxes do not receive GitHub tokens.

## Operator commands

Run from the repository root:

```sh
factory config explain --project "$PWD"
factory doctor --project "$PWD" --probe-filesystem
factory schedule status --project "$PWD"
```

To rebuild, use the selected installed runtime's private Sandcastle executable
with `docker build-image --image-name r2-factory` from the repository root. Its
default build context is `.factory/`; `.dockerignore` excludes private/state files.
Do not use a project npm-installed SDK or patch the installed runtime.

Rebuild after changing the Dockerfile or bundled skills, then create fresh
sandboxes. An existing image/container does not inherit source edits. The image
sets `TMPDIR=/dev/shm` for synthetic fixtures and
`npm_package_config_node_gyp_nodedir=/usr/local` for native builds using the
bundled Node headers. It does not relocate persistent evidence or application
data. See `../docs/factory-common.md` for storage and durability limits.

Dispatch, dry-run analysis and scheduling are separate operator actions. Setup
does not authorize running tickets or enabling the scheduler. Commit the tracked
setup files before dispatch so newly created worktrees include them.

## Setup verification — 2026-11-16

- Image built through the installed runtime's private patched Sandcastle SDK.
- Factory configuration explanation: no errors or warnings.
- Active host filesystem probe: readiness and write capability both ready.
- Factory owned image capability probe: non-root Chromium launch, inline DOM
  check and confirmed container cleanup passed, with networking disabled and no
  host mounts or credentials. Image ID:
  `sha256:169411ded7545e6f38eff9a93d46f4dc946308f6ce36498c736a6578a7f7acb7`.
- Isolated non-root container copy: `npm ci`, typecheck, build and all 79 Vitest
  tests passed. The temporary container was removed.
- `npm run test:browser` failed: no Playwright config/specs exist, so default
  discovery imports Vitest files. This is missing application browser coverage,
  not failed Chromium provisioning. No tests or CI were changed to hide it.
- Required tracker labels exist. Host GitHub CLI 2.102.1 supports attachments;
  live attachment upload and credential upload compatibility were not tested.
- Host Pi OpenAI credential record exists; live model authentication/inference
  was not tested. No credentials were added to the image or project.
- Scheduler remains off. No ticket dispatch or analysis dry run was performed.

This verifies local environment provisioning, not real Firefox/Tailscale push
notification delivery or an end-to-end Factory ticket run.

## Temporary-storage verification — 2026-11-16

Rebuilt `r2-factory` using the selected installed runtime's private Sandcastle
`docker build-image --image-name r2-factory` command against current `main` plus
this environment change. Verified image ID:
`sha256:e4ac1c5d2631cf396468ea2dcf1dc69f8532aa9aca53073138dacdf8003f341e`.

A fresh container with a copied checkout (no host credentials, services or socket
mounts) ran as UID/GID 1000:1000, with Node 24.20.0:

- Confirmed `os.tmpdir()` is `/dev/shm` and created/removed a synthetic fixture.
- Fresh `npm ci` passed; `better-sqlite3` loaded and queried SQLite 3.54.1.
- `npm run typecheck` and `npm run build` passed.
- `npm test`: 19 files passed, 489 tests passed, 1 existing root-only case skipped
  under non-root execution. No skips, test code or configuration were changed.
- `npm run test:browser`: both Chromium journeys passed.
- Default `/dev/shm` capacity was 64 MiB; 3.7 MiB remained in use after the checks.
  Capacity is bounded and shared with browsers, not guaranteed for larger suites.
- Verification logs were written outside `TMPDIR` to persistent host storage.

These are synthetic checks, including restart/reopen behavior, not evidence of
real disk durability or Firefox/Tailscale delivery. No application durability
code, timeouts, test discovery, CI gates, scheduler state or other tickets were
changed. No Factory dispatch, recovery, live model/push calls, production access
or actual host-service/Tailscale operations were performed.

## Consolidated application baseline

`main` is the integration target. The completed application and acceptance runner
from `spike-1` include both Chromium journeys and their typecheck/teardown fixes
(the former consolidation branch's application changes were already squash-merged
into `spike-1`). The removed Factory v1 scaffold and npm dependency stay removed.
The application now has a Playwright config; the missing-suite limitation recorded
in the original setup verification above no longer applies.

Consolidation validation with Node 24.20.0: locked dependency installation,
typecheck and build passed; Vitest passed 489 tests with the existing root-only
`rejects foreign ownership` case skipped as a non-root operator. Its non-root
injected-stat counterpart passed. Both Chromium journeys passed. No live acceptance,
Factory dispatch, scheduler changes, model calls or real push sends were performed.
