import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { accountDatabase, readMessages, run } from './database.js';
import { createSend, type SendInput } from './send.js';
import { createMissingKeyServer } from './missing-key.js';
import { groupOcrLines, parseTsvWords, screenMessageId } from './screen.js';

const key = process.env.VIBER_BRIDGE_KEY?.trim();
if (!key) {
  const server = createMissingKeyServer();
  server.listen(3000, '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => server.close());
} else {
  const data = process.env.VIBER_DATA_DIR || '/data';
  const version = process.env.VIBER_DESKTOP_VERSION || '29.4.0.7';
  await mkdir(data, { recursive: true, mode: 0o700 });
  const xvfb = spawn(
    'Xvfb',
    [':99', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'],
    { stdio: 'inherit' },
  );
  await delay(1500);
  const wm = spawn('openbox', [], { stdio: 'ignore' });
  const notificationMonitor = spawn(
    'dbus-monitor',
    ['--session', "interface='org.freedesktop.Notifications',member='Notify'"],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const notifications: { title: string; text: string; at: string }[] = [];
  let notificationBlock: string[] = [];
  notificationMonitor.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.startsWith('method call ')) notificationBlock = [];
      notificationBlock.push(line);
      const strings = notificationBlock.flatMap((value) =>
        [...value.matchAll(/string "((?:\\.|[^"])*)"/g)].map((match) =>
          match[1]!.replace(/\\n/g, '\n').replace(/\\"/g, '"'),
        ),
      );
      if (strings.length >= 4) {
        if (/viber/i.test(strings[0]!)) {
          notifications.push({
            title: strings[2]!,
            text: strings[3]!,
            at: new Date().toISOString(),
          });
          if (notifications.length > 100) notifications.shift();
        }
        notificationBlock = [];
      }
    }
  });
  const viber = spawn('/opt/viber/Viber', [], { stdio: 'inherit' });
  let processError = false;
  for (const child of [xvfb, wm, viber])
    child.on('error', () => {
      processError = true;
    });
  const screen = async () =>
    (
      await run('import', ['-window', 'root', '-quality', '85', 'jpeg:-'], {
        encoding: 'buffer',
        timeout: 10000,
        maxBuffer: 3 * 1024 * 1024,
      })
    ).stdout;
  const ocr = async (image: Buffer, crop?: string, psm = '11') => {
    const source = join(data, 'ocr-source.jpg');
    const target = join(data, 'ocr-target.png');
    await writeFile(source, image, { mode: 0o600 });
    await run(
      'convert',
      crop ? [source, '-crop', crop, '+repage', target] : [source, target],
      { timeout: 5000 },
    );
    return run(
      'tesseract',
      [target, 'stdout', '-l', 'ukr+rus+eng', '--psm', psm, 'tsv'],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
    );
  };
  const database = () => accountDatabase(join(data, '.ViberPC'));
  const messages = async (since: Date) => {
    const account = await database();
    if (!account) throw Error('needs_activation');
    return readMessages(account.path, since);
  };
  const inboxFromScreen = async (since: Date) => {
    const list = await ocr(await screen());
    const badges = parseTsvWords(list.stdout)
      .filter(
        (word) =>
          /^\d{1,2}$/.test(word.text) &&
          word.left >= 300 &&
          word.left < 430 &&
          word.top >= 90 &&
          word.top < 780,
      )
      .map((word) => Math.round((word.top + word.height / 2) / 48) * 48)
      .filter((row, index, rows) => rows.indexOf(row) === index);
    const found = [];
    for (const row of badges.slice(0, 20)) {
      await run('xdotool', ['mousemove', '370', String(row), 'click', '1'], {
        timeout: 3000,
      });
      await delay(500);
      const chat = await ocr(await screen());
      const lines = groupOcrLines(parseTsvWords(chat.stdout));
      const header = lines
        .filter((line) => line.top < 110 && line.right > 410)
        .map((line) => line.text)
        .join(' ');
      const phoneMatch = header.match(/\+?\d[\d ()-]{7,}\d/);
      let from = phoneMatch ? `+${phoneMatch[0].replace(/\D/g, '')}` : '';
      const threadId = `screen:${screenMessageId(header || `chat-${row}`, '', '')}`;
      if (!from) {
        await run('xdotool', ['mousemove', '700', '45', 'click', '1']).catch(
          () => {},
        );
        await delay(300);
        const profile = await ocr(await screen());
        const profileText = groupOcrLines(parseTsvWords(profile.stdout))
          .map((line) => line.text)
          .join(' ');
        const profilePhone = profileText.match(/\+?\d[\d ()-]{7,}\d/);
        if (profilePhone) from = `+${profilePhone[0].replace(/\D/g, '')}`;
        await run('xdotool', ['key', 'Escape']).catch(() => {});
        await delay(200);
      }
      const bodyLines = lines.filter(
        (line) => line.top > 130 && line.left > 410 && line.right < 1080,
      );
      let timeIndex = -1;
      bodyLines.forEach((line, index) => {
        if (/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(line.text)) timeIndex = index;
      });
      const timeText =
        timeIndex >= 0
          ? bodyLines[timeIndex]!.text.match(
              /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/,
            )![0]
          : '';
      let screenAt: Date | undefined;
      if (timeText) {
        const [hour, minute] = timeText.split(':').map(Number);
        screenAt = new Date();
        screenAt.setHours(hour!, minute!, 0, 0);
        if (screenAt.getTime() > Date.now() + 12 * 60 * 60_000)
          screenAt.setDate(screenAt.getDate() - 1);
      }
      const noticeIndex = notifications.findIndex(
        (notice) =>
          new Date(notice.at) >= since &&
          notice.text.trim() &&
          (!notice.title ||
            header
              .toLocaleLowerCase('uk')
              .includes(notice.title.toLocaleLowerCase('uk')) ||
            notice.title
              .toLocaleLowerCase('uk')
              .includes(header.toLocaleLowerCase('uk'))),
      );
      const notice =
        noticeIndex >= 0 ? notifications.splice(noticeIndex, 1)[0] : undefined;
      const text = notice
        ? notice.text.trim()
        : timeIndex >= 0
          ? bodyLines
              .slice(Math.max(0, timeIndex - 5), timeIndex)
              .map((line) => line.text)
              .join(' ')
              .trim()
          : '';
      if (
        text &&
        (notice ? new Date(notice.at) >= since : screenAt && screenAt >= since)
      )
        found.push({
          from,
          text,
          at: notice?.at ?? screenAt!.toISOString(),
          threadId,
          providerMessageId: screenMessageId(
            threadId,
            text,
            notice?.at ?? timeText,
          ),
        });
      await run('xdotool', ['mousemove', '420', '45', 'click', '1']).catch(
        () => {},
      );
      await delay(200);
    }
    return found;
  };
  const send = createSend(join(data, 'receipts'), {
    messages,
    screen,
    async confirm() {
      const image = await screen();
      const composer = await ocr(image, '620x80+500+790');
      const bubble = await ocr(image, '660x650+620+120');
      return {
        composer: groupOcrLines(parseTsvWords(composer.stdout))
          .map((line) => line.text)
          .join(' '),
        outgoingBubble: groupOcrLines(parseTsvWords(bubble.stdout))
          .map((line) => line.text)
          .join(' '),
      };
    },
    wait: () => delay(1000),
    async open(url, to) {
      // The official .desktop entry is Exec=/opt/viber/Viber %u. A second instance
      // forwards its URI to the running single-instance Qt application.
      await run('/opt/viber/Viber', [url], { timeout: 10000 });
      await delay(2000);
      const { stdout } = await run(
        'xdotool',
        ['search', '--onlyvisible', '--class', 'Viber'],
        { timeout: 3000 },
      );
      const window = stdout.trim().split('\n').at(-1);
      if (!window || !/^\d+$/.test(window)) throw Error('chat_window_missing');
      await run('xdotool', ['windowsize', window, '1280', '900']);
      await run('xdotool', ['windowmove', window, '0', '0']);
      await run('xdotool', ['windowactivate', '--sync', window]);
      // Only a visibly verified numeric chat header permits pressing Enter.
      // Named contacts or a changed layout fail closed and retain an uncertain receipt.
      const crop = join(data, 'chat-header.png');
      await run('import', ['-window', window, '-crop', '900x110+380+0', crop]);
      const { stdout: header } = await run(
        'tesseract',
        [crop, 'stdout', '--psm', '11'],
        { timeout: 10000 },
      );
      if (!header.replace(/[^\d]/g, '').includes(to.slice(1)))
        throw Error('recipient_not_verified');
      // Clipboard paste preserves multiline text without producing Enter events.
      // Verify the exact composer selection before dispatching the message.
      const text = new URL(url).searchParams.get('draft')!;
      const draftFile = join(data, 'draft.txt');
      await writeFile(draftFile, text, { mode: 0o600 });
      await run('xdotool', [
        'mousemove',
        '--window',
        window,
        '800',
        '835',
        'click',
        '1',
        'key',
        '--clearmodifiers',
        'ctrl+a',
      ]);
      await run('xclip', ['-selection', 'clipboard', '-i', draftFile], {
        timeout: 3000,
      });
      await run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
      await delay(200);
      // Copy must replace a fresh sentinel; otherwise a failed Ctrl+C could
      // leave our original clipboard value and falsely verify an empty composer.
      await writeFile(draftFile, randomUUID(), { mode: 0o600 });
      await run('xclip', ['-selection', 'clipboard', '-i', draftFile], {
        timeout: 3000,
      });
      await run('xdotool', ['key', '--clearmodifiers', 'ctrl+a', 'ctrl+c']);
      await delay(200);
      const { stdout: copied } = await run(
        'xclip',
        ['-selection', 'clipboard', '-o'],
        { timeout: 3000 },
      );
      if (copied !== text) throw Error('draft_not_verified');
      await run('xdotool', ['key', '--clearmodifiers', 'Right']);
    },
    async enter() {
      await run('xdotool', ['key', '--clearmodifiers', 'Return']);
    },
  });

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const authorization =
      req.headers.authorization?.replace(/^Bearer /, '') ||
      req.headers['x-api-key'];
    const supplied = Buffer.from(
      typeof authorization === 'string' ? authorization : '',
    );
    const secret = Buffer.from(key);
    if (
      supplied.length !== secret.length ||
      !timingSafeEqual(supplied, secret)
    ) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url || '/', 'http://bridge');
    const json = (code: number, value: unknown) => {
      res
        .writeHead(code, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(value));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        if (
          processError ||
          viber.exitCode !== null ||
          viber.signalCode !== null ||
          xvfb.exitCode !== null ||
          xvfb.signalCode !== null
        )
          return json(200, { state: 'not_running', version });
        const account = await database();
        if (!account) return json(200, { state: 'needs_activation', version });
        try {
          await readMessages(account.path, new Date());
          return json(200, {
            state: 'ready',
            number: account.number,
            version,
            mode: 'database',
          });
        } catch {
          // Viber Desktop encrypts viber.db in some installations; screen OCR is the fallback.
          return json(200, {
            state: 'ready',
            number: account.number,
            version,
            mode: 'screen',
          });
        }
      }
      if (req.method === 'GET' && url.pathname === '/screen') {
        const bytes = url.searchParams.has('lastFailure')
          ? await readFile(join(data, 'receipts', 'last-failure.jpg'))
          : await screen();
        res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(bytes);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/inbound') {
        const since = new Date(url.searchParams.get('since') || '');
        if (!Number.isFinite(since.getTime())) throw Error('invalid_since');
        const account = await database();
        let incoming;
        try {
          incoming = account
            ? (await readMessages(account.path, since))
                .filter((message) => !message.outgoing)
                .map((message) => ({
                  from: message.from,
                  text: message.text,
                  at: message.at,
                  providerMessageId: message.providerMessageId,
                  threadId: message.threadId,
                }))
            : await inboxFromScreen(since);
        } catch {
          incoming = await inboxFromScreen(since);
        }
        return json(200, incoming);
      }
      if (req.method === 'POST' && url.pathname === '/send') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 65536) {
            json(413, { error: 'body_too_large' });
            req.destroy();
            return;
          }
        }
        return json(200, await send(JSON.parse(raw) as SendInput));
      }
      json(404, { error: 'not_found' });
    } catch (error) {
      const code =
        error instanceof Error &&
        [
          'invalid_send',
          'invalid_since',
          'idempotency_conflict',
          'needs_activation',
        ].includes(error.message)
          ? error.message
          : 'bridge_operation_failed';
      json(
        code.startsWith('invalid')
          ? 400
          : code === 'idempotency_conflict'
            ? 409
            : 503,
        { error: code },
      );
    }
  });
  server.requestTimeout = 60000;
  server.listen(3000, '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => {
      server.close();
      for (const child of [viber, notificationMonitor, wm, xvfb])
        child.kill('SIGTERM');
    });
}
