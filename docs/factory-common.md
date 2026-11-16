# Factory environment

Read `AGENTS.md`, `PRD.md`, the current task ticket and the approved plan at
`docs/first-slice.packed.html` before implementation or verification.

The sandbox has Node 24, native SQLite build tools, Pi and global Playwright with
shared Chromium. Startup runs `npm ci` in the mounted checkout. Project packages
remain owned by `package-lock.json`; keep Factory runtime dependencies out of it.
Before writing, changing, deleting or reviewing tests, fixtures or test
configuration, read `/home/agent/.agents/skills/writing-tests/SKILL.md`. The image
includes this skill; it does not require host skill mounts.

Use synthetic data, injected clocks, model adapters and push transports. Real
Firefox/Tailscale notification acceptance needs owner evidence; mocked delivery
is not that evidence. Keep production systems and credentials out of tests.

Run the application scripts that exist in `package.json`: typecheck, build and
test. Browser tooling is provisioned even when no browser suite exists. Before
running `test:browser`, check for a Playwright configuration and browser specs;
if absent, report missing application browser coverage, not a passing browser
suite. Factory's independent browser preflight is a separate environment check.
For browser work, bind the synthetic local server to the sandbox interface and
use only temporary data. Inspect `README.md` for application configuration.

## Temporary fixtures and persistent evidence

The rebuilt image sets `TMPDIR=/dev/shm`. Node's `os.tmpdir()` and the existing
synthetic filesystem/SQLite fixtures therefore use memory-backed storage rather
than the container's slow writable layer. Keep verification reports, logs,
screenshots and other evidence in the persistent checkout/evidence directories,
not under `TMPDIR`; shared memory disappears with the container. Do not relocate
application data or real durability acceptance onto shared memory.

`/dev/shm` has a separate, bounded capacity (Docker commonly defaults to 64 MiB),
shared by fixtures and browser processes. Check `df -h /dev/shm` in the actual
sandbox. If it fills, report an environment capacity failure and have the operator
review capacity or storage placement; do not add retries, increase deadlines,
skip tests or change discovery to hide it. The environment change requires an
image rebuild and a fresh sandbox; editing the Dockerfile does not update an
existing image or running container.

The image also sets `npm_package_config_node_gyp_nodedir=/usr/local` so fresh
native SQLite builds use the matching Node headers already in the image rather
than fetching headers separately. `npm ci` still installs the locked packages.

Passing synthetic restart/reopen checks on tmpfs proves application behavior,
not disk persistence across power loss, host restart or container removal. Real
durability acceptance still needs owner evidence on persistent storage, as does
real Firefox/Tailscale notification delivery.

Do not weaken CI or substitute real model/push credentials to make checks pass.
