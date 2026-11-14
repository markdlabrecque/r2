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

The owner confirmed real test-notification delivery in Chromium and Zen Browser on Omarchy on 2026-11-12, accepting Chromium for the browser-delivery gate. See [browser push delivery verification](docs/push-delivery-verification.md). Stock Firefox, closed-tab delivery, Tailscale isolation, and host restart remain unverified. Mocked browser tests do not satisfy real-delivery gates, and these results do not complete the final task or parent.

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

See [private test-host installation](docs/private-installation.md) for the systemd service, configuration, Tailscale Serve, operations and owner-run checks. R2 binds to loopback behind private HTTPS. Tailnet access does not replace the owner login. No Funnel or public listener is in scope.

## Acceptance evidence

The owner confirmed real generic test-notification delivery in Chromium and Zen Browser on the non-production Omarchy host. See [the verification record](docs/push-delivery-verification.md) for setup, fixes, and evidence limits. Scheduled reminder delivery and a persistent host installation are not claimed.

### Browser notifications

The owner connects one browser from the web app (Notifications section). The browser asks permission, registers `/sw.js`, subscribes with the server's VAPID public key, and R2 stores the subscription (a new one replaces the old). A test notification must be accepted by the push service before the browser is marked ready. Notifications show the generic title "You have an R2 reminder" and body "Open R2 and sign in to read it."; the push payload carries only an opaque id, never reminder text or due times. R2 contacts only reviewed push hosts (FCM, Mozilla, Apple, Windows), over HTTPS, and refuses private, loopback and tailnet addresses. Push acceptance is not proof the owner saw the notification. Automated tests use a fake push transport. The owner separately confirmed real delivery in Chromium and Zen Browser; stock Firefox has not been tested. Chromium delivery satisfies the owner's browser-delivery acceptance criterion.

### Delivery worker

One in-process worker polls SQLite every 5 seconds, so due pushes are submitted well inside 60 seconds. It never calls OpenAI: saved reminders send with the assistant disabled. Each due reminder is claimed in a transaction with a lease longer than the push deadline, and its attempt is recorded before the network call. At most four attempts are made, with 30 second, 2 minute and 10 minute waits after attempts 1 to 3; permanent errors (such as an expired subscription) fail at once. After a restart, any half-finished delivery is marked `unknown` and retried, so a crash can cause a duplicate push but never a silent loss. Every overdue reminder is sent after downtime, and the reminder list keeps the original due time and the provider outcome. Pausing (`R2_PAUSE_NOTIFICATIONS` or the Pause button) leaves reminders scheduled; they send, overdue, after resume. `GET /api/status` (owner only) shows worker state and counts; `/healthz` stays generic and reports 503 if the worker fails. Real browser delivery of a scheduled reminder with the tab closed still needs the owner's Firefox acceptance run.

### Owner password

Create the value for `R2_PASSWORD_HASH` with `npm run hash-password`. It reads the password without echo (or from piped stdin), never from an argument, and prints a scrypt PHC hash. Without it, the service starts but owner sign-in reports that it is not configured. Every `/api/` route except those marked `config: { public: true }` requires the owner session cookie, and writes must come from `R2_ORIGIN`.
