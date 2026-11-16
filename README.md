# R2

A personal reminder agent for one owner. The first slice uses private web chat through Tailscale and generic browser notifications.

- [Product requirements](PRD.md)
- [Approved first-slice plan](docs/first-slice.packed.html)
- [Slice #1 and its task issues](https://github.com/markdlabrecque/r2/issues/1)

## Local development

Node.js 24. R2 binds only to `127.0.0.1` (default port 3000) and needs no real credentials to start.

```sh
npm ci
npm run typecheck
npm run build        # dist/server (with migrations/) and dist/web
npm test

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

The owner confirmed real generic test-notification delivery in Chromium and Zen Browser on the non-production Omarchy host. See [the verification record](docs/push-delivery-verification.md) for setup, fixes, and evidence limits. Scheduled reminder delivery and a persistent host installation are not claimed.

### Browser notifications

The owner connects one browser from the web app (Notifications section). The browser asks permission, registers `/sw.js`, subscribes with the server's VAPID public key, and R2 stores the subscription (a new one replaces the old). A test notification must be accepted by the push service before the browser is marked ready. Notifications show the generic title "You have an R2 reminder" and body "Open R2 and sign in to read it."; the push payload carries only an opaque id, never reminder text or due times. R2 contacts only reviewed push hosts (FCM, Mozilla, Apple, Windows), over HTTPS, and refuses private, loopback and tailnet addresses. Push acceptance is not proof the owner saw the notification. Automated tests use a fake push transport. The owner separately confirmed real delivery in Chromium and Zen Browser; stock Firefox has not been tested. Chromium delivery satisfies the owner's browser-delivery acceptance criterion.

### Owner password

Create the value for `R2_PASSWORD_HASH` with `npm run hash-password`. It reads the password without echo (or from piped stdin), never from an argument, and prints a scrypt PHC hash. Without it, the service starts but owner sign-in reports that it is not configured. Every `/api/` route except those marked `config: { public: true }` requires the owner session cookie, and writes must come from `R2_ORIGIN`.
