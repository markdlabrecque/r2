# R2

A personal reminder agent for one owner. The first slice uses private web chat through Tailscale and generic browser notifications.

- [Product requirements](PRD.md)
- [Domain glossary](GLOSSARY.md)
- [Domain model and code map](docs/domain-model.md)
- [Approved first-slice plan](docs/first-slice.packed.html)
- [Slice #1 and its task issues](https://github.com/markdlabrecque/r2/issues/1)

## Development baseline and Factory v2

`main` is the integration branch. It contains the completed reminder slice,
Chromium journeys and owner-operated acceptance runner previously developed on
`spike-1`. Historical verification records retain their original revisions;
closed implementation tickets do not establish real-host acceptance.

Factory uses the installed shared v2 workflow, not a project npm dependency.
See [Factory operator guidance](.factory/README.md) and
[shared agent instructions](docs/factory-common.md). Task PRs target `main`;
automatic merging requires Factory gates and the exact CI job `tests`.
The testing-improvement backlog is [#40](https://github.com/markdlabrecque/r2/issues/40);
its current baseline and remaining work are in [the testing audit](docs/testing-audit.md).
Planning does not authorize dispatch or adding `ready-for-agent`.

## Local development

Node.js 24. R2 binds only to `127.0.0.1` (default port 3000) and needs no real credentials to start.

```sh
npm ci
npm run typecheck
npm run build        # dist/server (with migrations/) and dist/web
npm test
npm run test:browser # synthetic Chromium journeys; build first

# Run locally with synthetic values. R2_ORIGIN must be a single https origin and
# R2_DATA_DIR an absolute directory outside this checkout.
R2_ORIGIN=https://r2.example.ts.net R2_DATA_DIR=/tmp/r2-data npm run dev
R2_ORIGIN=https://r2.example.ts.net R2_DATA_DIR=/tmp/r2-data npm start
```

Configuration: `R2_ORIGIN` and `R2_DATA_DIR` (required); `R2_PORT` (3000), `R2_SESSION_TTL_HOURS` (168), `R2_PAUSE_NOTIFICATIONS` (false); optional `R2_PASSWORD_HASH`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `OPENAI_API_KEY`, `OPENAI_MODEL`. Missing auth, VAPID or model values leave that feature disabled and do not stop the service. `test:browser` runs the two synthetic Chromium journeys in `browser/` and `e2e/`.

The database schema is `migrations/001.sql`. This unreleased build refuses an older, incompatible database instead of altering it; use a fresh data directory.

## Private installation

See [private test-host installation](docs/private-installation.md) for the systemd service, configuration, Tailscale Serve, operations and owner-run checks. The [automated acceptance runbook](docs/automated-acceptance.md) describes opt-in tooling and its human evidence gates. R2 binds to loopback behind private HTTPS. Tailnet access does not replace the owner login. No Funnel or public listener is in scope.

## Acceptance evidence

The owner confirmed real generic test-notification delivery in Chromium and Zen Browser on the non-production Omarchy host. See [the verification record](docs/push-delivery-verification.md) for setup, fixes, and evidence limits. Scheduled reminder delivery and a persistent host installation are not claimed.

### Full-slice verification

Run `npm run build && npm run test:browser` for the Chromium integration test. It runs a local synthetic HTTPS proxy and file-backed SQLite, with an injected clock, interpreter, subscription and push transport. It checks login, explicit confirmation, restart, model-independent submission, and the authenticated outcome. It does **not** use a real browser push service or establish that a notification was displayed.

The following owner-run gate remains **blocked / not yet evidenced**; the historical test notification above is not this acceptance test. On a non-production test host, follow [private installation](docs/private-installation.md), then:

1. Record the reviewed commit, date, stock Firefox version and test-host/browser OS versions without recording the hostname, credentials, subscription or private reminder text. Verify Serve uses private HTTPS, not Funnel; confirm an outside-tailnet device is denied, and a tailnet device without an owner session cannot read reminders. Verify a second authorized owner device can use chat without replacing the notification subscription.
2. In Firefox, sign in, choose an explicit IANA timezone, connect the browser and confirm a real test notification displays. Ask for a synthetic one-off reminder several minutes ahead and explicitly confirm the displayed date, time and timezone. Check it appears in the list.
3. Before it is due, remove the OpenAI configuration from the protected environment file and restart R2. Confirm the saved reminder remains and the assistant is disabled. Close the R2 tab, keeping Firefox and its notification service running. Observe the actual desktop notification; verify that it contains only `You have an R2 reminder`, without reminder text or due time. Record due time and provider submission timing separately from desktop display timing; submission should occur within 60 seconds under normal conditions.
4. Sign in again and verify the list retains the original local due time/timezone and provider outcome. Restart the test host and verify R2 and private Serve resume without public ports. Record pass/fail and any limitations; never include secrets, subscription data or private content in evidence. A provider acceptance or synthetic test alone is not proof of display.

### Browser notifications

The owner connects one browser from the web app (Notifications section). The browser asks permission, registers `/sw.js`, subscribes with the server's VAPID public key, and R2 stores the subscription (a new one replaces the old). A test notification must be accepted by the push service before the browser is marked ready. Notifications show only the generic text "You have an R2 reminder" in both title and body; the push payload carries only an opaque id, never reminder text or due times. R2 contacts only reviewed push hosts (FCM, Mozilla, Apple, Windows), over HTTPS, and refuses private, loopback and tailnet addresses. Push acceptance is not proof the owner saw the notification. Automated tests use a fake push transport. The owner separately confirmed real delivery in Chromium and Zen Browser; stock Firefox has not been tested. Chromium delivery satisfies the owner's browser-delivery acceptance criterion.

### Delivery worker

One in-process worker polls SQLite every 5 seconds, so due pushes are submitted well inside 60 seconds. It never calls OpenAI: saved reminders send with the assistant disabled. Each due reminder is claimed in a transaction with a lease longer than the push deadline, and its attempt is recorded before the network call. At most four attempts are made, with 30 second, 2 minute and 10 minute waits after attempts 1 to 3; permanent errors (such as an expired subscription) fail at once. Attempt outcomes and reminder states are committed together. After a restart, an interrupted delivery is marked `unknown` and retried (or failed when its attempt limit is exhausted), so a crash can cause a duplicate push. A previously recorded acceptance is preserved. Every overdue reminder is sent after downtime, and the reminder list keeps the original due time and the provider outcome. Pausing (`R2_PAUSE_NOTIFICATIONS` or the Pause button) stops new claims; a push already in flight may still complete. Remaining reminders send, overdue, after resume. `GET /api/status` (owner only) shows worker state and counts; `/healthz` stays generic and reports 503 if the worker fails. Real browser delivery of a scheduled reminder with the tab closed still needs the owner's Firefox acceptance run.

### Owner password

Create the value for `R2_PASSWORD_HASH` with `npm run hash-password`. It reads the password without echo (or from piped stdin), never from an argument, and prints a scrypt PHC hash. Without it, the service starts but owner sign-in reports that it is not configured. Every `/api/` route except those marked `config: { public: true }` requires the owner session cookie, and writes must come from `R2_ORIGIN`.
