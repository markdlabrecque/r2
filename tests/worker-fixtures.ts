import type { PushResult, PushSubscriptionKeys, PushTransport } from '../src/contracts.ts';

export const KEYS: PushSubscriptionKeys = {
  endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/synthetic',
  p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'),
  auth: Buffer.alloc(16, 9).toString('base64url'),
};

export class FakeTransport implements PushTransport {
  sent: { reminderId: string; endpoint: string }[] = [];
  results: PushResult[] = [];
  async send(sub: PushSubscriptionKeys, reminderId: string): Promise<PushResult> {
    this.sent.push({ reminderId, endpoint: sub.endpoint });
    return this.results.shift() ?? { outcome: 'accepted', httpStatus: 201 };
  }
}
