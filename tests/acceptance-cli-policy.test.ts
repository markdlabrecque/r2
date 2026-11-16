import { describe, expect, it, vi } from 'vitest';
import { recoverySafeApi } from '../scripts/acceptance/main.ts';

describe('acceptance recovery policy', () => {
  it('uses a network-disabled API only for explicit recovery when Serve is unavailable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const host = { privateOrigin: async () => { throw new Error('PRIVATE_CANARY'); } };
      await expect(recoverySafeApi(host, false)).rejects.toThrow();
      const api = await recoverySafeApi(host, true);
      await expect(api.login('synthetic-password-canary')).rejects.toMatchObject({ code: 'network' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
});
