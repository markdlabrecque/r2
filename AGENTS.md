# Project repository

https://github.com/markdlabrecque/r2

Prefer `gh-axi` over `gh` for interactive GitHub operations.

# Development

- Read `PRD.md` and the task ticket. The approved plan is `docs/first-slice.packed.html`.
- Target `main`. Factory v2 uses `.factory/factory.toml` and the installed shared workflow; read `docs/factory-common.md` for sandbox work. Historical `spike-1`, `.sandcastle/` and `test:factory` instructions are superseded. Preserve the required CI job `tests`; dispatch requires separate owner authorization.
- Run the application checks that exist: typecheck, build, test, and Chromium browser tests. Add coverage for changed behavior. Do not weaken CI to get a pass.
- Use synthetic data and injected clocks, model adapters, and push transports. Real Firefox/Tailscale acceptance requires owner evidence. A mock does not prove real notification delivery.
- Never connect to production or write to production servers. Do not use 1Password without an explicit request from the owner.
- Keep secrets out of source, logs, screenshots, and evidence.
