// Service worker: shows one fixed, generic notification. The push payload is never displayed:
// reminder text and due times stay inside the authenticated app.
declare const self: ServiceWorkerGlobalScope;

const TITLE = 'You have an R2 reminder';
const BODY = 'Open R2 and sign in to read it.';

/** Only an opaque id is used, and only as a tag so a repeat of one reminder replaces itself. */
function tagOf(event: PushEvent): string {
  try {
    const id = (event.data?.json() as { reminderId?: unknown } | undefined)?.reminderId;
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
  } catch {
    // a malformed payload still shows the generic notification
  }
  return 'r2-reminder';
}

self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification(TITLE, { body: BODY, tag: tagOf(event) }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open !== undefined) await open.focus();
      else await self.clients.openWindow('/');
    })(),
  );
});

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
