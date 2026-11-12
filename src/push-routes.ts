import { z } from 'zod';
import { R2Error, type StoredSubscription } from './contracts.ts';
import { TEST_PUSH_ID, validatePushEndpoint, validateSubscriptionKeys } from './push.ts';
import type { FeaturePlugin } from './routes.ts';

const subscriptionBody = z.strictObject({
  endpoint: z.string().min(1).max(2048),
  keys: z.strictObject({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
});

/** Never includes the endpoint or keys: those identify the browser at the push service. */
function subscriptionStatus(sub: StoredSubscription | undefined) {
  return {
    connected: sub !== undefined,
    ready: sub?.readyAt != null,
    version: sub?.version ?? null,
  };
}

export const pushPlugin: FeaturePlugin = {
  name: 'push',
  register(app, { config, storage, pushTransport }) {
    const status = () => ({
      configured: config.push.enabled,
      publicKey: config.push.enabled ? config.push.publicKey : null,
      notificationsPaused: storage.getSettings().notificationsPaused,
      subscription: subscriptionStatus(storage.getSubscription()),
    });

    app.get('/api/push', async () => status());

    // One connected browser: a new subscription replaces the old one and must pass a test again.
    app.put('/api/push/subscription', async (request) => {
      if (!config.push.enabled) throw new R2Error('unavailable', 'Web Push is not configured on the server.');
      const parsed = subscriptionBody.safeParse(request.body);
      if (!parsed.success) throw new R2Error('invalid_request', 'Send the browser push subscription as JSON.');
      const { endpoint, keys } = parsed.data;
      validatePushEndpoint(endpoint);
      if (!validateSubscriptionKeys(keys.p256dh, keys.auth)) {
        throw new R2Error('invalid_request', 'That browser push subscription has invalid keys.');
      }
      storage.replaceSubscription({ endpoint, p256dh: keys.p256dh, auth: keys.auth });
      request.log.info('browser push subscription replaced');
      return status();
    });

    // Sends the same generic notification a reminder would. Success marks this subscription ready.
    app.post('/api/push/test', async (request) => {
      if (!config.push.enabled || pushTransport === undefined) {
        throw new R2Error('unavailable', 'Web Push is not configured on the server.');
      }
      const sub = storage.getSubscription();
      if (sub === undefined) throw new R2Error('conflict', 'Connect a browser before sending a test notification.');
      const result = await pushTransport.send(sub, TEST_PUSH_ID);
      if (result.outcome === 'accepted') {
        const ready = storage.markSubscriptionReady(sub.version);
        request.log.info({ ready }, 'test push accepted');
        return { ok: ready, code: ready ? null : 'replaced', ...status() };
      }
      request.log.warn({ code: result.code, httpStatus: result.httpStatus }, 'test push failed');
      return { ok: false, code: result.code, ...status() };
    });
  },
};
