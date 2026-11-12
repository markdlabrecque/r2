import { z } from 'zod';
import { isValidTimezone, R2Error } from './contracts.ts';
import type { FeaturePlugin } from './routes.ts';

const body = z.strictObject({ timezone: z.string().min(1).max(64) });

/** The runtime's canonical spelling, so `america/toronto` is stored as `America/Toronto`. */
function canonicalTimezone(timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
}

export const settingsPlugin: FeaturePlugin = {
  name: 'settings',
  register(app, { storage }) {
    app.get('/api/settings', async () => storage.getSettings());

    // The timezone is always chosen by the owner. It is never inferred from the server.
    app.put('/api/settings', async (request) => {
      const parsed = body.safeParse(request.body);
      if (!parsed.success) throw new R2Error('invalid_request', 'Send a JSON object with a timezone.');
      if (!isValidTimezone(parsed.data.timezone)) {
        throw new R2Error('invalid_timezone', 'Timezone must be a valid IANA name such as America/Toronto.');
      }
      return storage.setTimezone(canonicalTimezone(parsed.data.timezone));
    });
  },
};
