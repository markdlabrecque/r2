# Browser push delivery verification

## Result

On 2026-11-12, the owner confirmed real desktop notification delivery in Chromium and Zen Browser on the Omarchy test machine. These were manual tests using real browser subscriptions and the production Web Push transport, not mocked push sends or injected service-worker events.

The owner accepted Chromium delivery as satisfying the browser-delivery requirement for ticket [#4](https://github.com/markdlabrecque/r2/issues/4). Zen is Firefox-based, but its successful result is not a stock Firefox test.

## Test setup

- Branch: `4-connect-one-browser-and-send-privacy-saf`, with the subscription-format and Chromium-host fixes applied.
- Local Node.js 24 service bound to loopback, exposed privately through Tailscale Serve on HTTPS port 4466. No public Funnel or production deployment was used.
- Temporary SQLite data, a generated owner password, and generated VAPID keys. No OpenAI credentials were needed.
- Each browser used the Notifications section to connect, grant notification permission, and send a test notification. Connecting Zen replaced Chromium's stored subscription, as designed.

## Observations

| Browser | Owner-observed result |
| --- | --- |
| Chromium | A desktop notification arrived. The owner described being prompted to sign in to R2 and read it. |
| Zen Browser | The owner confirmed that the same test worked. |

The observed test notification was generic, with title `You have an R2 reminder` and body `Open R2 and sign in to read it.` The current service worker instead uses `You have an R2 reminder` for both title and body; that wording has not been verified by this historical owner test. Reminder text and due times are not included. Automated tests independently cover payload and service-worker privacy.

Two defects were fixed before these successful results:

1. The strict subscription schema rejected the browser's `expirationTime` field. It now accepts an optional null or numeric value without storing it, while continuing to reject unknown fields and malformed values.
2. Chromium returned a subscription hosted at `jmt17.google.com`, which the allowlist did not include. That exact hostname is now allowed. Arbitrary Google hosts, subdomains of that host, and suffix look-alikes remain rejected. HTTPS, DNS address restrictions, and transport timeouts remain in place.

## Automated checks

After both fixes, all of these passed under Node.js 24:

- `npm run test:factory`: 7 tests.
- `npm run typecheck`.
- `npm run build`.
- `npm test`: 79 tests, including browser subscription JSON and hostname validation regressions.
- `git diff --check`.

## Evidence limits

The desktop-delivery evidence is the owner's report in the interactive session. No screenshots or browser-version records were captured.

These results do not establish delivery with the R2 tab closed, after a browser or host restart, or for scheduled reminders. Stock Firefox delivery and a full Tailscale isolation audit remain unverified. Provider acceptance alone is still not proof of desktop display; the manual observations above are the evidence for these two successful deliveries.
