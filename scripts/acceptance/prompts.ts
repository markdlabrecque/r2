import { stdin, stdout } from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import type { PromptOutcome } from './contracts.ts';
import type { RunnerPrompt } from './runner.ts';

let cancelInput: (() => void) | undefined;
export function interruptPrompt(): void { cancelInput?.(); }
/** Read directly from the terminal; never accept piped approvals or credentials. */
async function input(message: string, secret = false): Promise<string | null> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) return null;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  try { stdin.resume(); stdout.write(message); } catch (error) { stdin.setRawMode(wasRaw); stdin.pause(); throw error; }
  return new Promise(resolve => {
    let text = '';
    let finished = false;
    const decoder = new StringDecoder('utf8');
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true; cancelInput = undefined;
      stdin.off('data', onData); stdin.off('end', onEnd); stdin.off('error', onEnd);
      stdin.setRawMode(wasRaw); stdin.pause(); stdout.write('\n'); resolve(value);
    };
    const onEnd = () => finish(null);
    const onData = (data: Buffer) => {
      for (const char of decoder.write(data)) {
        if (char === '\u0003' || char === '\u0004') return finish(null);
        if (char === '\r' || char === '\n') return finish(text);
        if (char === '\u007f' || char === '\b') { text = [...text].slice(0, -1).join(''); continue; }
        if (char >= ' ' && char !== '\u007f' && text.length + char.length <= 1024) { text += char; if (!secret) stdout.write(char); }
      }
    };
    cancelInput = () => finish(null);
    stdin.on('data', onData); stdin.once('end', onEnd); stdin.once('error', onEnd);
  });
}
export async function passwordPrompt(): Promise<string> {
  const value = await input('Password (input hidden): ', true);
  if (!value) throw new Error('Password entry cancelled or unavailable.');
  return value;
}
export async function prompt(request: RunnerPrompt): Promise<PromptOutcome> {
  const answer = await input(`\n${request.message}${request.case ? ` (${request.case.label} #${request.case.caseNumber}, due ${new Date(request.case.dueAt).toISOString()})` : ''}\nEnter pass/approve, fail/decline, or blocked: `);
  if (answer === null) return 'cancelled';
  switch (answer.trim().toLowerCase()) {
    case 'pass': case 'approve': return 'approved';
    case 'fail': case 'decline': return 'declined';
    default: return 'unavailable';
  }
}
