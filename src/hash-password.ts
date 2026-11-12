/**
 * Creates the value for `R2_PASSWORD_HASH`. The password is read from the terminal without
 * echo, or from stdin when piped; it is never taken from an argument or the environment.
 */
import { DEFAULT_SCRYPT_COST, hashPassword } from './password.ts';

const MIN_LENGTH = 12;
const MAX_LENGTH = 1024;

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string): void => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.exit(130);
        }
        value = c === '\u007f' || c === '\b' ? value.slice(0, -1) : value + c;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPiped(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  let password: string;
  if (process.stdin.isTTY) {
    password = await promptHidden('New owner password: ');
    if (password !== (await promptHidden('Repeat password: '))) throw new Error('The passwords do not match.');
  } else {
    password = await readPiped();
  }
  if (password.length < MIN_LENGTH) throw new Error(`Use a password of at least ${MIN_LENGTH} characters.`);
  if (password.length > MAX_LENGTH) throw new Error(`Use a password of at most ${MAX_LENGTH} characters.`);
  process.stdout.write(`${await hashPassword(password, DEFAULT_SCRYPT_COST)}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Could not create a password hash.');
  process.exit(1);
});
