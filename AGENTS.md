# Project repository

https://github.com/markdlabrecque/r2

Prefer `gh-axi` over `gh` for interactive GitHub operations. Factory's tracker adapter uses its shipped GitHub CLI integration.

# Factory workflow

- Implement Slice #1 through Factory task runs. `spike-1` is the integration branch. Task PRs target `spike-1`, never `main`.
- Use the existing `.sandcastle/` personal profile. Sonnet implements; Opus verifies. Factory squash-merges only after a PASS verdict and all checks on the exact pushed head pass.
- Preserve the Factory dependencies, `test:factory` script, CI workflow, and `.sandcastle/` scaffold when adding the application. The repository now has automation files; it is no longer empty.
- Read `PRD.md` and the task ticket. The approved plan is `docs/first-slice.packed.html`.
- Run `npm run test:factory` and the application checks that exist: typecheck, build, test, and Chromium browser tests. Add coverage for changed behavior. Do not weaken CI to get a pass.
- Use synthetic data and injected clocks, model adapters, and push transports. Real Firefox/Tailscale acceptance requires owner evidence. A mock does not prove real notification delivery.
- Never connect to production or write to production servers. Do not use 1Password without an explicit request from the owner.
- Keep secrets out of source, logs, screenshots, and evidence. `.sandcastle/.env` holds only local Factory agent credentials and stays untracked.
