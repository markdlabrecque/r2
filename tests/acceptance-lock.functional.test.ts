import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, installation } from './acceptance-fixtures.ts';

it('contends with a separate Node process sharing the fixed registry', () => {
  const f = fixture();
  try {
    f.registry.acquire(installation, f.owner);
    const script = `import { AcceptanceRegistry } from './scripts/acceptance/state.ts';
      try { new AcceptanceRegistry({root: ${JSON.stringify(f.root)}}).acquire(${JSON.stringify(installation)}, ${JSON.stringify({ ...f.owner, runId: randomUUID(), token: randomUUID() })}); process.exit(2); }
      catch(e) { if(e.code !== 'locked') process.exit(3); }`;
    expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), timeout: 10000 })).not.toThrow();
  } finally { f.remove(); }
});
