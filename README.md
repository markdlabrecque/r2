# R2

A personal reminder agent for one owner. The first slice uses private web chat through Tailscale and generic browser notifications.

- [Product requirements](PRD.md)
- [Approved first-slice plan](docs/first-slice.packed.html)
- [Slice #1 and its task issues](https://github.com/markdlabrecque/r2/issues/1)

## Factory

`spike-1` is the integration branch. Factory runs the task sub-issues with Sonnet and verifies them with Opus. A PASS verdict and passing CI on the exact pushed commit are required before Factory squash-merges the task PR into `spike-1`. No task merges into `main`.

The project is registered with the local Factory board at <http://127.0.0.1:4444>. The personal profile lives in `.sandcastle/config.mts`. Both dispatcher entrypoints refuse any base other than `spike-1`.

```sh
# Node.js 24
npm ci
npm run test:factory
npx sandcastle docker build-image --image-name sandcastle-r2
factory dispatch --dry-run
factory dispatch
factory status
```

The local R2-only user timer runs a dispatcher pass five minutes after each pass ends. It reconciles merged work and starts newly unblocked tasks. The checkout must remain on `spike-1`; both entrypoints refuse another branch. Other projects' timers are unchanged. The board can show other projects too.

```sh
systemctl --user status factory-r2-dispatch.timer
journalctl --user -u factory-r2-dispatch.service
systemctl --user disable --now factory-r2-dispatch.timer  # stop future passes
```

Stopping the timer does not stop ticket runs that already started. Factory's failed runs require an explicit retry. Unit templates are in `.sandcastle/systemd/`; their paths match this checkout on the setup machine. On another machine, adapt the paths before installing the two user units. The local Claude token remains outside Git.

### Agent credential

The host already needs a Claude login and the `pi-claude-subscription` extension. The container also requires a separate Claude token:

1. Run `claude setup-token` yourself in a terminal.
2. Store its result as `CLAUDE_CODE_OAUTH_TOKEN` in `.sandcastle/.env`, mode 0600.
3. Run `factory dispatch --dry-run`. This validates the token without printing it.

Do not put the token in GitHub, the Docker image, screenshots, shell arguments, or chat. `.sandcastle/.env` is ignored. No application OpenAI or VAPID credentials are needed for synthetic tests.

### Checks

CI runs on every PR. The initial automation scaffold runs `npm run test:factory`. Once `src/main.ts` exists, CI also requires `typecheck`, `build`, and `test`. Once `playwright.config.ts` exists, CI installs Chromium and requires `test:browser`. These checks are not optional when their files exist.

The image contains Playwright 1.65.0 and Chromium. Application tasks must retain that version for browser compatibility and preserve the automation dependencies and scripts when extending `package.json`.

The sandbox pins `pi-claude-subscription` to upstream commit `05be412cb37cf3b5f5436ed88694c2a84f69bdb6`, which includes the image-handling fix `b3dfb24`. The baked `.factory-revision` file records the fetched commit. Package version numbers do not identify this fix.

After an image rebuild, run the credential-free request-construction probe. It checks the baked revision and source hash, accepts an image-bearing `read` result in replay and resume, and rejects malformed attachments. It does not call Claude or prove a live model response.

```sh
docker run --rm \
  --mount type=bind,src="$PWD/.sandcastle/probes/image-results.mjs",dst=/tmp/image-results.mjs,readonly \
  --entrypoint node sandcastle-r2 /tmp/image-results.mjs
```

Real Firefox notifications, Tailscale isolation, and host restart need owner-run evidence on a non-production host. Mocked browser tests do not satisfy those gates. The final task and parent remain incomplete until that evidence exists.

## Local development

Node.js 24. R2 binds only to `127.0.0.1` (default port 3000) and needs no real credentials to start.

```sh
npm ci
npm run typecheck
npm run build        # dist/server (with migrations/) and dist/web
npm test
npm run test:factory

# Run locally with synthetic values. R2_ORIGIN must be a single https origin and
# R2_DATA_DIR an absolute directory outside this checkout.
R2_ORIGIN=https://r2.example.ts.net R2_DATA_DIR=/tmp/r2-data npm run dev
R2_ORIGIN=https://r2.example.ts.net R2_DATA_DIR=/tmp/r2-data npm start
```

Configuration: `R2_ORIGIN` and `R2_DATA_DIR` (required); `R2_PORT` (3000), `R2_SESSION_TTL_HOURS` (168), `R2_PAUSE_NOTIFICATIONS` (false); optional `R2_PASSWORD_HASH`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `OPENAI_API_KEY`, `OPENAI_MODEL`. Missing auth, VAPID or model values leave that feature disabled and do not stop the service. `test:browser` runs Playwright once the browser-test task adds `playwright.config.ts`.

The database schema is `migrations/001.sql`. This unreleased build refuses an older, incompatible database instead of altering it; use a fresh data directory.

## Private installation

The packaging task will add the systemd unit, example application configuration, and owner-run Tailscale setup. R2 will bind to loopback behind Tailscale Serve with HTTPS. Tailnet access does not replace the owner login. No Funnel or public listener is in scope.

## Acceptance evidence

Pending implementation. No real reminder delivery or host installation is claimed by the Factory setup.
