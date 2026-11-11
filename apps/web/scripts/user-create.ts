import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { hash } from 'argon2';
import { uk } from '../src/i18n/uk';
function secret(prompt: string): Promise<string> {
  if (!stdin.isTTY) throw new Error(uk.cli.terminal);
  stdin.setRawMode(true);
  stdout.write(prompt);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') {
          done();
          reject(new Error(uk.cli.cancelled));
          return;
        }
        if (char === '\r' || char === '\n') {
          done();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}
async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  let email: string, name: string;
  try {
    email = (await rl.question(uk.cli.email)).trim().toLowerCase();
    name = (await rl.question(uk.cli.name)).trim();
  } finally {
    rl.close();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !name)
    throw new Error(uk.cli.required);
  const password = await secret(uk.cli.password);
  if (password.length < 12 || password.length > 1024)
    throw new Error(uk.cli.length);
  if (password !== (await secret(uk.cli.confirm)))
    throw new Error(uk.cli.mismatch);
  const { sonarPool, registryPool } = await import('@sonar/db');
  try {
    const passwordHash = await hash(password);
    await sonarPool.query(
      'insert into users (email, name, password_hash) values ($1, $2, $3)',
      [email, name, passwordHash],
    );
    stdout.write(uk.cli.created + '\n');
  } finally {
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
}
main().catch((error: unknown) => {
  console.error(
    (error as { code?: string }).code === '23505'
      ? uk.cli.duplicate
      : error instanceof Error
        ? error.message
        : uk.cli.failed,
  );
  process.exitCode = 1;
});
