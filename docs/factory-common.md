# Factory environment

Read `AGENTS.md`, `PRD.md`, the current task ticket and the approved plan at
`docs/first-slice.packed.html` before implementation or verification.

The sandbox has Node 24, native SQLite build tools, Pi and global Playwright with
shared Chromium. Startup runs `npm ci` in the mounted checkout. Project packages
remain owned by `package-lock.json`; keep Factory runtime dependencies out of it.
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

Do not weaken CI or substitute real model/push credentials to make checks pass.
