import { interruptPrompt, passwordPrompt } from '../scripts/acceptance/prompts.ts';
if (process.argv[2] === 'cancel') {
  process.once('SIGTERM', interruptPrompt);
  let cancelled = false;
  try { await passwordPrompt(); } catch { cancelled = true; }
  if (!cancelled) throw Error('Cancellation was accepted.');
  console.log(process.stdin.isRaw ? 'TERMINAL_STILL_RAW' : 'TERMINAL_RESTORED');
} else {
  const password = await passwordPrompt();
  if (password !== 'password-canary-9381') throw Error('Synthetic password mismatch.');
  console.log('PASSWORD_RECEIVED');
}
