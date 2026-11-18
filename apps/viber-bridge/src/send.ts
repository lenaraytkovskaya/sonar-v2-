import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ViberMessage } from './database.js';
import { outgoingScreenConfirmed } from './screen.js';

export type SendInput = { to: string; text: string; idempotencyKey: string };
export type SendResult = {
  state: 'sent' | 'uncertain';
  providerMessageId?: string;
  screenshot?: string;
  reason?: string;
};
export function chatUrl(input: SendInput) {
  if (
    !/^\+[1-9]\d{6,14}$/.test(input.to) ||
    !input.text.trim() ||
    input.text.length > 10000 ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  )
    throw Error('invalid_send');
  const query = new URLSearchParams({
    number: input.to.slice(1),
    draft: input.text,
  });
  return `viber://chat?${query.toString()}`;
}
export function createSend(
  root: string,
  desktop: {
    messages(since: Date): Promise<ViberMessage[]>;
    open(url: string, to: string): Promise<void>;
    enter(): Promise<void>;
    screen(): Promise<Buffer>;
    confirm?(): Promise<{
      composer: string;
      outgoingBubble: string;
      messageTime?: string;
    }>;
    wait(): Promise<void>;
  },
) {
  let pending = Promise.resolve();
  return (input: SendInput): Promise<SendResult> => {
    const operation = pending.then(async () => {
      const url = chatUrl(input);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const key = createHash('sha256')
        .update(input.idempotencyKey)
        .digest('hex');
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([input.to, input.text]))
        .digest('hex');
      const receipt = join(root, `${key}.json`);
      const existing = await readFile(receipt, 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      if (existing) {
        const prior = JSON.parse(existing) as {
          fingerprint: string;
          result: SendResult;
        };
        if (prior.fingerprint !== fingerprint)
          throw Error('idempotency_conflict');
        return prior.result;
      }
      const started = new Date();
      // Fail before reserving if the database cannot be read. Never send without confirmation capability.
      let databaseReadable = true;
      let beforeMessages: ViberMessage[] = [];
      try {
        beforeMessages = await desktop.messages(started);
      } catch {
        databaseReadable = false;
      }
      const before = new Set(beforeMessages.map((m) => m.providerMessageId));
      let result: SendResult = {
        state: 'uncertain',
        reason: 'dispatch_interrupted',
      };
      // Exclusive creation is durable across process restarts; any interrupted attempt is never resent.
      await writeFile(receipt, JSON.stringify({ fingerprint, result }), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      try {
        await desktop.open(url, input.to);
        await desktop.enter();
        for (let i = 0; i < 8; i++) {
          await desktop.wait();
          if (desktop.confirm) {
            const screen = await desktop.confirm();
            if (
              outgoingScreenConfirmed(
                input.text,
                screen.composer,
                screen.outgoingBubble,
                screen.messageTime,
                started,
              )
            ) {
              result = {
                state: 'sent',
                providerMessageId: `screen:${createHash('sha256')
                  .update(`${input.idempotencyKey}:${started.toISOString()}`)
                  .digest('hex')}`,
              };
              break;
            }
          }
          let match: ViberMessage | undefined;
          if (databaseReadable) {
            try {
              match = (await desktop.messages(started)).find(
                (m) =>
                  m.outgoing &&
                  m.from === input.to &&
                  m.text === input.text &&
                  !before.has(m.providerMessageId),
              );
            } catch {
              databaseReadable = false;
            }
          }
          if (match) {
            result = {
              state: 'sent',
              providerMessageId: match.providerMessageId,
            };
            break;
          }
        }
        if (result.state === 'uncertain')
          result.reason = 'outgoing_not_confirmed';
      } catch (error) {
        result.reason =
          error instanceof Error ? error.message : 'desktop_operation_failed';
      }
      if (result.state === 'uncertain') {
        try {
          const screen = await desktop.screen();
          await writeFile(join(root, 'last-failure.jpg'), screen, {
            mode: 0o600,
          });
          result.screenshot = screen.toString('base64');
        } catch {
          /* Keep the receipt even when Xvfb is unavailable. */
        }
      }
      await writeFile(receipt, JSON.stringify({ fingerprint, result }), {
        mode: 0o600,
        flush: true,
      });
      return result;
    });
    pending = operation.then(
      () => {},
      () => {},
    );
    return operation;
  };
}
