import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { accountDatabase, readMessages, run } from './database.js';
import { createSend, type SendInput } from './send.js';
import { createMissingKeyServer } from './missing-key.js';
import {
  classifyViberModal,
  chatHeaderMatchesRecipient,
  chatColumnBounds,
  desktopPresenceState,
  groupOcrLines,
  parseTsvWords,
  phoneFromOcrLines,
  screenClickPoint,
  screenMessageId,
  safeLayoutClick,
  verticalColorBoundaries,
  visibleInboundMessages,
  visibleMessageTimestamp,
} from './screen.js';
import { canRestart, restartDelay } from './supervisor.js';

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
  let xvfb = spawn(
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
  let dbusNotificationsSeen = 0;
  notificationMonitor.stdout?.on('data', (chunk: Buffer) => {
    const calls = (chunk.toString().match(/method call /g) ?? []).length;
    if (!calls) return;
    dbusNotificationsSeen += calls;
    console.log(`viber_dbus_notify method_calls=${dbusNotificationsSeen}`);
  });
  spawn('/opt/viber/Viber', [], { stdio: 'inherit' });
  let xvfbAttempts = 0;
  let lastXvfbAttempt = 0;
  let missingViberSince: number | undefined;
  let viberAttempts = 0;
  let lastViberAttempt = 0;
  let supervisorReason = '';
  const hasViberProcess = async () =>
    run('pgrep', ['-f', '^/opt/viber/Viber']).then(
      ({ stdout }) => stdout.trim().length > 0,
      () => false,
    );
  const visibleViber = async () =>
    run('xdotool', ['search', '--onlyvisible', '--class', 'Viber'], {
      timeout: 3000,
    }).then(
      ({ stdout }) => stdout.trim().split(/\s+/).filter(Boolean),
      () => [],
    );
  const supervisor = setInterval(() => {
    void (async () => {
      if (shuttingDown) return;
      const now = Date.now();
      if (
        (xvfb.exitCode !== null || xvfb.signalCode !== null) &&
        xvfbAttempts < 5
      ) {
        if (now - lastXvfbAttempt >= restartDelay(xvfbAttempts)) {
          xvfbAttempts++;
          lastXvfbAttempt = now;
          xvfb = spawn(
            'Xvfb',
            [':99', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'],
            { stdio: 'inherit' },
          );
          supervisorReason = `xvfb_restart_${xvfbAttempts}`;
          if (!shuttingDown)
            await run('pkill', ['-TERM', '-f', '^/opt/viber/Viber']).catch(
              () => {},
            );
          missingViberSince = now;
        }
      } else if (xvfb.exitCode !== null || xvfb.signalCode !== null)
        supervisorReason = 'xvfb_restart_limit';
      const running = await hasViberProcess();
      if (running) {
        if ((await visibleViber()).length > 0) {
          missingViberSince = undefined;
          viberAttempts = 0;
        } else {
          missingViberSince ??= now;
        }
        return;
      }
      missingViberSince ??= now;
      if (canRestart(missingViberSince, now, viberAttempts, lastViberAttempt)) {
        if (shuttingDown) return;
        viberAttempts++;
        lastViberAttempt = now;
        supervisorReason = `viber_restart_${viberAttempts}`;
        spawn('/opt/viber/Viber', [], { stdio: 'inherit' });
      } else if (viberAttempts >= 5) {
        supervisorReason = 'viber_restart_limit';
      }
    })().catch(() => {
      supervisorReason = 'supervisor_check_failed';
    });
  }, 2000);
  supervisor.unref();
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
  const inspectChatLayout = async (image: Buffer) => {
    const source = join(data, 'layout-source.jpg');
    await writeFile(source, image, { mode: 0o600 });
    const { stdout: size } = await run(
      'identify',
      ['-format', '%w %h', source],
      {
        timeout: 3000,
      },
    );
    const dimensions = size.trim().split(/\s+/).map(Number);
    const width = dimensions[0] ?? 1280;
    const height = dimensions[1] ?? 900;
    const [ocrResult, colorResult] = await Promise.all([
      ocr(image),
      run(
        'convert',
        [source, '-resize', `${width}x1!`, '-depth', '8', 'txt:-'],
        {
          timeout: 5000,
          maxBuffer: 2 * 1024 * 1024,
        },
      ),
    ]);
    const samples = colorResult.stdout
      .split(/\r?\n/)
      .slice(1)
      .flatMap((line) => {
        const match = line.match(/\((\d+),(\d+),(\d+)/);
        return match
          ? [[Number(match[1]), Number(match[2]), Number(match[3])] as const]
          : [];
      });
    const words = parseTsvWords(ocrResult.stdout);
    const lines = groupOcrLines(words);
    const allText = lines.map((line) => line.text).join(' ');
    const profileOpen = words.some(
      (word) =>
        word.left > width * 0.65 &&
        /^(media|gifs?|links|files|participants?)$/i.test(word.text),
    );
    const bounds = chatColumnBounds(
      width,
      verticalColorBoundaries(samples),
      profileOpen,
    );
    const blockedWords = words
      .filter((word) => /^(block|report|spam)$/i.test(word.text))
      .map((word) => ({
        left: word.left,
        top: word.top,
        right: word.left + word.width,
        bottom: word.top + word.height,
      }));
    return {
      width,
      height,
      words,
      lines,
      allText,
      profileOpen,
      bounds,
      blockedWords,
    };
  };
  const normalizeChatLayout = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const layout = await inspectChatLayout(await screen());
      if (layout.profileOpen) {
        const media = layout.lines.find((line) =>
          /^(media|gifs?|links|files|participants?)/i.test(line.text),
        );
        const x = layout.width - 14;
        const y = Math.max(48, Math.min(145, (media?.top ?? 105) - 28));
        if (!safeLayoutClick(x, y, layout.blockedWords))
          throw Error('profile_close_unsafe');
        await run('xdotool', ['mousemove', String(x), String(y), 'click', '1']);
        await delay(300);
        continue;
      }
      if (
        /not\s+in\s+your\s+contact\s+list|is\s+not\s+in\s+your\s+contacts/i.test(
          layout.allText,
        )
      ) {
        const banner = layout.lines.find((line) =>
          /not in your contact list|not in your contacts/i.test(line.text),
        );
        const x = Math.min(layout.bounds.right - 12, layout.width - 12);
        const y = (banner?.top ?? 130) + 20;
        if (!safeLayoutClick(x, y, layout.blockedWords))
          throw Error('banner_close_unsafe');
        await run('xdotool', ['mousemove', String(x), String(y), 'click', '1']);
        await delay(300);
        continue;
      }
      return layout;
    }
    throw Error('chat_layout_not_normalized');
  };
  const profileRecipientMatch = async (
    layout: Awaited<ReturnType<typeof inspectChatLayout>>,
    to: string,
  ) => {
    const matches = (candidate: string) =>
      chatHeaderMatchesRecipient(candidate, to);
    const visible = phoneFromOcrLines(
      layout.lines,
      (line) =>
        line.top < 210 &&
        line.left >= layout.bounds.left &&
        line.left < layout.bounds.right,
    );
    if (matches(visible)) return true;
    let current = layout;
    if (!current.profileOpen) {
      const x = Math.min(current.width - 35, current.bounds.right - 38);
      const y = 45;
      if (safeLayoutClick(x, y, current.blockedWords)) {
        await run('xdotool', ['mousemove', String(x), String(y), 'click', '1']);
        await delay(300);
        current = await inspectChatLayout(await screen());
      }
    }
    const profileNumber = phoneFromOcrLines(
      current.lines,
      (line) =>
        line.top < current.height * 0.55 &&
        line.left >= current.bounds.right - 5,
    );
    return matches(profileNumber);
  };
  const openRecipientChat = async (to: string) => {
    const url = `viber://chat?${new URLSearchParams({ number: to.replace(/\D/g, '') })}`;
    await run('/opt/viber/Viber', [url], { timeout: 10000 });
    await delay(800);
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
    const layout = await inspectChatLayout(await screen());
    if (!(await profileRecipientMatch(layout, to)))
      throw Error('recipient_not_verified');
  };
  const returnToMyNotes = async () => {
    const layout = await inspectChatLayout(await screen());
    const notes = layout.lines.find((line) => /my\s+notes/i.test(line.text));
    if (!notes || notes.left > layout.width * 0.3) return false;
    const x = Math.max(20, Math.min(layout.width * 0.1, notes.right + 8));
    const y = notes.top + 10;
    if (!safeLayoutClick(x, y, layout.blockedWords)) return false;
    await run('xdotool', ['mousemove', String(x), String(y), 'click', '1']);
    await delay(500);
    return true;
  };
  const checkModals = async () => {
    const image = await screen();
    const result = await ocr(image);
    const text = groupOcrLines(parseTsvWords(result.stdout))
      .map((line) => line.text)
      .join(' ');
    const windows = await visibleViber();
    const titles = await Promise.all(
      windows.map((window) =>
        run('xdotool', ['getwindowname', window], { timeout: 2000 }).then(
          ({ stdout }) => stdout.trim(),
          () => '',
        ),
      ),
    );
    const modal = classifyViberModal(`${text} ${titles.join(' ')}`);
    if (modal === 'sync_history') {
      await run('xdotool', ['key', '--clearmodifiers', 'Escape'], {
        timeout: 3000,
      });
      await delay(300);
      return undefined;
    }
    if (modal === 'repair') {
      await writeFile(join(data, 'attention.jpg'), image, { mode: 0o600 });
      return 'repair';
    }
    if (modal === 'close_confirmation') {
      await writeFile(join(data, 'attention.jpg'), image, { mode: 0o600 });
      return 'unknown_modal';
    }
    if (modal === 'unknown' || windows.length > 1) {
      await writeFile(join(data, 'attention.jpg'), image, { mode: 0o600 });
      return 'unknown_modal';
    }
    return undefined;
  };
  const closeExitConfirmation = async () => {
    const image = await screen();
    const result = await ocr(image);
    const words = parseTsvWords(result.stdout);
    const text = groupOcrLines(words)
      .map((line) => line.text)
      .join(' ');
    if (classifyViberModal(text) !== 'close_confirmation') return false;
    // Viber renders this exact confirmation centered in the fixed 1280x900 display.
    // Its gray "Close anyway" label is invisible to Tesseract, so the known button
    // position is clicked only after OCR verifies the unique dialog title.
    await run('xdotool', ['mousemove', '760', '506', 'click', '1'], {
      timeout: 1500,
    });
    await delay(300);
    return true;
  };
  const database = () => accountDatabase(join(data, '.ViberPC'));
  const messages = async (since: Date) => {
    const account = await database();
    if (!account) throw Error('needs_activation');
    return readMessages(account.path, since);
  };
  const inboxFromScreen = async (since: Date, recipients: string[] = []) => {
    const modal = await checkModals();
    if (modal) throw Error('needs_attention');
    const found: ReturnType<typeof visibleInboundMessages> = [];
    const visited = new Set<string>();
    const scanCurrent = async (hint = '') => {
      let layout = await inspectChatLayout(await screen());
      let from = phoneFromOcrLines(
        layout.lines,
        (line) =>
          line.top < 210 &&
          line.left >= layout.bounds.left &&
          line.left < layout.bounds.right,
      );
      if (!from && hint) from = hint;
      if (!from && layout.profileOpen)
        from = phoneFromOcrLines(
          layout.lines,
          (line) =>
            line.top < layout.height * 0.55 &&
            line.left >= layout.bounds.right - 5,
        );
      if (!from) {
        const x = Math.min(layout.width - 35, layout.bounds.right - 38);
        if (safeLayoutClick(x, 45, layout.blockedWords)) {
          await run('xdotool', ['mousemove', String(x), '45', 'click', '1']);
          await delay(300);
          layout = await inspectChatLayout(await screen());
        }
      }
      if (!from)
        from = phoneFromOcrLines(
          layout.lines,
          (line) =>
            line.top < layout.height * 0.55 &&
            line.left >= layout.bounds.right - 5,
        );
      if (!from) return;
      const threadId = `screen:${screenMessageId(from, '', '')}`;
      if (visited.has(threadId)) return;
      visited.add(threadId);
      const headerBottom = Math.max(
        140,
        ...layout.lines
          .filter((line) => line.top < layout.height * 0.16)
          .map((line) => line.top + 28),
      );
      found.push(
        ...visibleInboundMessages(layout.lines, {
          threadId,
          from,
          since,
          left: layout.bounds.left,
          right: layout.bounds.right,
          headerBottom,
          height: layout.height,
        }),
      );
    };
    try {
      await scanCurrent();
      for (const recipient of [...new Set(recipients)].slice(0, 500)) {
        if (!/^\+[1-9]\d{6,14}$/.test(recipient)) continue;
        const threadId = `screen:${screenMessageId(recipient, '', '')}`;
        if (visited.has(threadId)) continue;
        await openRecipientChat(recipient);
        await scanCurrent(recipient);
      }
    } finally {
      await returnToMyNotes().catch(() => false);
    }
    return found;
  };
  const outgoingFromScreen = async (since: Date, recipients: string[] = []) => {
    const result: {
      from: string;
      text: string;
      at: string;
      providerMessageId: string;
    }[] = [];
    const visited = new Set<string>();
    const scanCurrent = async (hint = '') => {
      let layout = await inspectChatLayout(await screen());
      const header = layout.lines
        .filter((line) => line.top < Math.max(130, layout.height * 0.22))
        .map((line) => line.text)
        .join(' ');
      if (!hint && /my\s+notes/i.test(header)) return;
      let from =
        hint ||
        phoneFromOcrLines(
          layout.lines,
          (line) =>
            line.top < 210 &&
            line.left >= layout.bounds.left &&
            line.left < layout.bounds.right,
        );
      if (!from && layout.profileOpen)
        from = phoneFromOcrLines(
          layout.lines,
          (line) =>
            line.top < layout.height * 0.55 &&
            line.left >= layout.bounds.right - 5,
        );
      if (!from) {
        const x = Math.min(layout.width - 35, layout.bounds.right - 38);
        if (safeLayoutClick(x, 45, layout.blockedWords)) {
          await run('xdotool', ['mousemove', String(x), '45', 'click', '1']);
          await delay(300);
          layout = await inspectChatLayout(await screen());
        }
        from = phoneFromOcrLines(
          layout.lines,
          (line) =>
            line.top < layout.height * 0.55 &&
            line.left >= layout.bounds.right - 5,
        );
      }
      if (!from) return;
      const threadId = `screen:${screenMessageId(from, '', '')}`;
      if (visited.has(threadId)) return;
      visited.add(threadId);
      const headerBottom = Math.max(
        140,
        ...layout.lines
          .filter((line) => line.top < layout.height * 0.16)
          .map((line) => line.top + 28),
      );
      const lines = layout.lines.filter(
        (line) =>
          line.top > headerBottom &&
          line.top < layout.height - 100 &&
          line.left >
            layout.bounds.left +
              (layout.bounds.right - layout.bounds.left) * 0.42 &&
          line.right < layout.bounds.right,
      );
      for (let index = 0; index < lines.length; index++) {
        const time = lines[index]!.text.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/);
        if (!time) continue;
        const at = visibleMessageTimestamp(time[0], new Date());
        if (!at || at < since) continue;
        const text = lines
          .slice(Math.max(0, index - 5), index)
          .map((line) => line.text)
          .filter((line) => !/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(line))
          .join(' ')
          .trim();
        if (!text) continue;
        result.push({
          from,
          text,
          at: at.toISOString(),
          providerMessageId: screenMessageId(threadId, text, time[0]),
        });
      }
    };
    try {
      await scanCurrent();
      for (const recipient of [...new Set(recipients)].slice(0, 500)) {
        if (!/^\+[1-9]\d{6,14}$/.test(recipient)) continue;
        const threadId = `screen:${screenMessageId(recipient, '', '')}`;
        if (visited.has(threadId)) continue;
        await openRecipientChat(recipient);
        await scanCurrent(recipient);
      }
    } finally {
      await returnToMyNotes().catch(() => false);
    }
    return result;
  };
  const send = createSend(join(data, 'receipts'), {
    messages,
    screen,
    async confirm() {
      const image = await screen();
      const layout = await inspectChatLayout(image);
      const headerBottom = Math.max(
        90,
        ...layout.lines
          .filter((line) => line.top < layout.height * 0.18)
          .map((line) => line.top + 28),
      );
      const composer = await ocr(
        image,
        `${Math.max(1, layout.bounds.right - layout.bounds.left)}x${Math.min(100, Math.floor(layout.height * 0.14))}+${layout.bounds.left}+${Math.floor(layout.height * 0.86)}`,
      );
      const bodyLines = layout.lines.filter(
        (line) =>
          line.top > headerBottom &&
          line.top < layout.height - 100 &&
          line.left >
            layout.bounds.left +
              (layout.bounds.right - layout.bounds.left) * 0.42 &&
          line.right < layout.bounds.right,
      );
      const messageTime = [...bodyLines]
        .reverse()
        .map((line) => line.text.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/)?.[0])
        .find(Boolean);
      return {
        composer: groupOcrLines(parseTsvWords(composer.stdout))
          .map((line) => line.text)
          .join(' '),
        outgoingBubble: bodyLines.map((line) => line.text).join(' '),
        messageTime,
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
      let layout = await inspectChatLayout(await screen());
      if (!(await profileRecipientMatch(layout, to)))
        throw Error('recipient_not_verified');
      layout = await normalizeChatLayout();
      // Clipboard paste preserves multiline text without producing Enter events.
      // Verify the exact composer selection before dispatching the message.
      const text = new URL(url).searchParams.get('draft');
      if (text === null) return;
      const draftFile = join(data, 'draft.txt');
      await writeFile(draftFile, text, { mode: 0o600 });
      await run('xdotool', [
        'mousemove',
        '--window',
        window,
        String(Math.round((layout.bounds.left + layout.bounds.right) / 2)),
        String(layout.height - 65),
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
        if (xvfb.exitCode !== null || xvfb.signalCode !== null)
          return json(200, {
            state: 'not_running',
            version,
            reason: supervisorReason || 'xvfb_not_running',
          });
        if (
          desktopPresenceState(
            await hasViberProcess(),
            (await visibleViber()).length > 0,
          ) === 'not_running'
        )
          return json(200, {
            state: 'not_running',
            version,
            reason:
              supervisorReason ||
              (missingViberSince ? 'viber_restarting' : 'viber_not_visible'),
          });
        const modal = await checkModals();
        if (modal)
          return json(200, {
            state: 'needs_attention',
            version,
            reason: modal,
            screenshot: '/screen?attention=1',
          });
        const account = await database();
        if (!account) return json(200, { state: 'needs_activation', version });
        try {
          await readMessages(account.path, new Date());
          return json(200, {
            state: 'ready',
            number: account.number,
            version,
            mode: 'database',
            dbusNotificationsSeen,
          });
        } catch {
          // Viber Desktop encrypts viber.db in some installations; screen OCR is the fallback.
          return json(200, {
            state: 'ready',
            number: account.number,
            version,
            mode: 'screen',
            dbusNotificationsSeen,
          });
        }
      }
      if (req.method === 'GET' && url.pathname === '/screen') {
        const bytes = url.searchParams.has('attention')
          ? await readFile(join(data, 'attention.jpg'))
          : url.searchParams.has('lastFailure')
            ? await readFile(join(data, 'receipts', 'last-failure.jpg'))
            : await screen();
        res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(bytes);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/click') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 4096) throw Error('invalid_click');
        }
        const input = JSON.parse(raw) as {
          x?: number;
          y?: number;
          width?: number;
          height?: number;
          key?: string;
          screenOpen?: boolean;
        };
        if (input.screenOpen !== true) throw Error('screen_not_open');
        if (input.key === 'Escape' || input.key === 'Enter')
          await run(
            'xdotool',
            [
              'key',
              '--clearmodifiers',
              input.key === 'Escape' ? 'Escape' : 'Return',
            ],
            { timeout: 3000 },
          );
        else {
          const point = screenClickPoint(
            input.x!,
            input.y!,
            input.width!,
            input.height!,
          );
          await run(
            'xdotool',
            ['mousemove', String(point.x), String(point.y), 'click', '1'],
            { timeout: 3000 },
          );
        }
        return json(200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/inbound') {
        const modal = await checkModals();
        if (modal)
          return json(423, { error: 'needs_attention', reason: modal });
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
            : await inboxFromScreen(since, url.searchParams.getAll('to'));
        } catch (error) {
          if (error instanceof Error && error.message === 'needs_attention')
            throw error;
          incoming = await inboxFromScreen(
            since,
            url.searchParams.getAll('to'),
          );
        }
        return json(200, incoming);
      }
      if (req.method === 'GET' && url.pathname === '/outgoing') {
        const since = new Date(url.searchParams.get('since') || '');
        if (!Number.isFinite(since.getTime())) throw Error('invalid_since');
        const account = await database();
        let outgoing;
        try {
          outgoing = account
            ? (await readMessages(account.path, since))
                .filter((message) => message.outgoing)
                .map((message) => ({
                  from: message.from,
                  text: message.text,
                  at: message.at,
                  providerMessageId: message.providerMessageId,
                }))
            : await outgoingFromScreen(since, url.searchParams.getAll('to'));
        } catch {
          outgoing = await outgoingFromScreen(
            since,
            url.searchParams.getAll('to'),
          );
        }
        return json(200, outgoing);
      }
      if (req.method === 'POST' && url.pathname === '/send') {
        const modal = await checkModals();
        if (modal)
          return json(423, { error: 'needs_attention', reason: modal });
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
          'invalid_click',
          'screen_not_open',
          'needs_attention',
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
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(supervisor);
    server.close();
    console.info('Viber graceful shutdown requested');
    const windows = await visibleViber();
    for (const window of windows.reverse())
      await run('xdotool', ['windowactivate', '--sync', window], {
        timeout: 1000,
      }).catch(() => {});
    const mainWindow = windows.at(0);
    if (mainWindow) {
      const geometry = await run(
        'xdotool',
        ['getwindowgeometry', '--shell', mainWindow],
        { timeout: 1000 },
      ).catch(() => ({ stdout: '' }));
      const getGeometry = (name: string) =>
        Number(geometry.stdout.match(new RegExp(`^${name}=(\\d+)$`, 'm'))?.[1]);
      const x = getGeometry('X');
      const y = getGeometry('Y');
      const width = getGeometry('WIDTH');
      if ([x, y, width].every(Number.isFinite))
        await run(
          'xdotool',
          [
            'mousemove',
            '--sync',
            String(x + width - 11),
            String(y - 31),
            'click',
            '1',
          ],
          { timeout: 1000 },
        ).catch(() => {});
    }
    let deadline = Date.now() + 1500;
    while (Date.now() < deadline && (await hasViberProcess())) await delay(500);
    if (await hasViberProcess())
      await closeExitConfirmation().catch(() => false);
    deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await hasViberProcess())) await delay(500);
    try {
      if (await hasViberProcess()) {
        const activeWindows = await visibleViber();
        const activeWindow = activeWindows.at(-1);
        if (activeWindow)
          await run('xdotool', ['windowactivate', '--sync', activeWindow], {
            timeout: 1000,
          });
        await run('xdotool', ['key', '--clearmodifiers', 'ctrl+q'], {
          timeout: 1000,
        });
        deadline = Date.now() + 1500;
        while (Date.now() < deadline && (await hasViberProcess()))
          await delay(500);
      }
    } catch {
      /* SIGTERM below is the documented fallback when X11 cannot close Viber. */
    }
    if (await hasViberProcess()) {
      console.info(
        'Viber is still open; sending SIGTERM and waiting up to 20 seconds',
      );
      await run('pkill', ['-TERM', '-f', '^/opt/viber/Viber']).catch(() => {});
      deadline = Date.now() + 20_000;
      while (Date.now() < deadline && (await hasViberProcess()))
        await delay(500);
    }
    if (!(await hasViberProcess())) {
      console.info('Viber closed cleanly');
    } else {
      console.error('Viber did not exit after SIGTERM; sending SIGKILL');
      await run('pkill', ['-KILL', '-f', '^/opt/viber/Viber']).catch(() => {});
    }
    console.info('Stopping Viber bridge helpers');
    for (const child of [notificationMonitor, wm, xvfb]) child.kill('SIGTERM');
    const childDeadline = Date.now() + 2500;
    while (
      Date.now() < childDeadline &&
      [notificationMonitor, wm, xvfb].some((child) => child.exitCode === null)
    )
      await delay(100);
    console.info('Viber bridge shutdown complete');
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => void shutdown());
}
