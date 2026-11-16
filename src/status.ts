import { z } from 'zod';
import { R2Error } from './contracts.ts';
import type { FeaturePlugin } from './routes.ts';

const pauseBody = z.strictObject({ paused: z.boolean() });

/**
 * Owner-only operational status and the notification pause. `/healthz` stays generic;
 * counts and delivery state are only visible here, behind the owner session.
 */
export const statusPlugin: FeaturePlugin = {
  name: 'status',
  register(app, { config, storage, clock, worker, pushTransport }) {
    const status = () => {
      const settings = storage.getSettings();
      const sub = storage.getSubscription();
      const health = worker?.getStatus();
      const { byState, due } = storage.countReminders();
      return {
        now: new Date(clock.now()).toISOString(),
        worker: health
          ? {
              state: health.state,
              lastRunAt: health.lastRunAt === null ? null : new Date(health.lastRunAt).toISOString(),
              lastErrorCode: health.lastErrorCode,
            }
          : { state: 'stopped', lastRunAt: null, lastErrorCode: null },
        notifications: {
          paused: config.pauseNotifications || settings.notificationsPaused,
          pausedByConfig: config.pauseNotifications,
          pushConfigured: config.push.enabled && pushTransport !== undefined,
          browserConnected: sub !== undefined,
          browserReady: sub?.readyAt != null,
        },
        assistantConfigured: config.chat.enabled,
        reminders: { byState, due },
      };
    };

    app.get('/api/status', async () => status());

    // Pausing never deletes anything: reminders stay scheduled and send, overdue, after resume.
    app.put('/api/notifications/pause', async (request) => {
      const parsed = pauseBody.safeParse(request.body);
      if (!parsed.success) throw new R2Error('invalid_request', 'Send { "paused": true } or { "paused": false }.');
      storage.setNotificationsPaused(parsed.data.paused);
      request.log.info({ paused: parsed.data.paused }, 'notification pause changed');
      return status();
    });
  },
};
