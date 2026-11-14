import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('host packaging', () => {
  it('ships a loopback service with persistent data and restricted execution', () => {
    const unit = readFileSync('deploy/r2.service', 'utf8');
    expect(unit).toContain('User=r2');
    expect(unit).toContain('EnvironmentFile=/etc/r2/r2.env');
    expect(unit).toContain('WorkingDirectory=/opt/r2');
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/r2/dist/server/main.js');
    expect(unit).toContain('ReadWritePaths=/var/lib/r2');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('UMask=0077');
  });

  it('provides a valid configuration template with features disabled until provisioned', () => {
    const template = readFileSync('deploy/r2.env.example', 'utf8');
    const env = Object.fromEntries(template.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }));
    const config = loadConfig(env);
    expect(config.host).toBe('127.0.0.1');
    expect(config.dataDir).toBe('/var/lib/r2');
    expect(config.auth.enabled).toBe(false);
    expect(config.push.enabled).toBe(false);
    expect(config.chat.enabled).toBe(false);
  });
});
