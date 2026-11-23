import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { accountDatabase, readMessages, run } from './database.js';
import {
  createSend,
  scrollWithSettledPointer,
  type SendInput,
} from './send.js';
import { createMissingKeyServer } from './missing-key.js';
import {
  classifyViberModal,
  chatHeaderMatchesRecipient,
  daySeparatorAt,
  chatColumnBounds,
  chatgptPanelHeader,
  desktopPresenceState,
  groupOcrLines,
  groupOcrLinesWithinBounds,
  parseTsvWords,
  phoneFromOcrLines,
  screenClickPoint,
  screenMessageId,
  safeLayoutClick,
  verticalColorBoundaries,
  visibleInboundMessages,
  visibleMessageTimestamp,
  visibleTimestampLine,
  messageBubbleRegions,
  inboundBubbleRegionsFromOcr,
  inboundBubbleMessage,
  inboundOcrFallbackText,
  copyMenuPoint,
  copyMenuSearchRegion,
  clipboardChanged,
  myNotesMenuPoint,
  hasMyNotesHeader,
  chatBodyTop,
  deriveMessageBodyTop,
  outgoingBubbleText,
  outgoingBubbleStatus,
  bubbleContentSignature,
  unfilledEmojiBody,
  matchesOutgoingText,
  normalizeOcr,
  textSimilarity,
  sameBubbleColumn,
  type ChatSlice,
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
  let attentionReason = '';
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
  const ocr = async (
    image: Buffer,
    crop?: string,
    psm = '11',
    preprocess = false,
    language = 'ukr+rus+eng',
    scale = 2,
    whitelist?: string,
    negate = false,
  ) => {
    const source = join(data, 'ocr-source.jpg');
    const target = join(data, 'ocr-target.png');
    await writeFile(source, image, { mode: 0o600 });
    const convertArgs = [source];
    if (crop) convertArgs.push('-crop', crop, '+repage');
    if (preprocess)
      convertArgs.push(
        '-resize',
        `${scale * 100}%`,
        '-colorspace',
        'Gray',
        '-threshold',
        '55%',
      );
    if (negate) convertArgs.push('-negate');
    convertArgs.push(target);
    await run('convert', convertArgs, { timeout: 5000 });
    const result = await run(
      'tesseract',
      [
        target,
        'stdout',
        '-l',
        language,
        '--psm',
        psm,
        ...(whitelist ? ['-c', `tessedit_char_whitelist=${whitelist}`] : []),
        'tsv',
      ],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
    );
    const stdout = result.stdout
      .split(/\r?\n/)
      .map((row, index) => {
        if (index === 0 || !row) return row;
        const fields = row.split('\t');
        for (const column of [6, 7, 8, 9]) {
          const value = Number(fields[column]);
          if (Number.isFinite(value))
            fields[column] = String(
              Math.round(value / (preprocess ? scale : 1)),
            );
        }
        return fields.join('\t');
      })
      .join('\n');
    return { ...result, stdout };
  };
  const copyBubble = async (bubble: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }) => {
    const layout = await inspectChatLayout(await screen());
    if (
      classifyViberModal(layout.modalText) !== 'none' ||
      bubble.top < chatBodyTop(layout.chatLines, layout.bannerBottom) ||
      bubble.bottom > layout.height - 85 ||
      bubble.left < layout.bounds.left + 8 ||
      bubble.right > layout.bounds.right - 8
    )
      throw Error('unsafe_bubble_copy');
    const clipboard = ['-selection', 'clipboard'];
    await run('xclip', [...clipboard, '-i', '/dev/null'], { timeout: 3000 });
    const before = (await run('xclip', [...clipboard, '-o'], { timeout: 3000 }))
      .stdout;
    if (before !== '') {
      attentionReason = 'clipboard_clear_failed';
      const image = await screen();
      await writeFile(join(data, 'attention.jpg'), image, { mode: 0o600 });
      throw Error('needs_attention');
    }
    try {
      const clickX = Math.round((bubble.left + bubble.right) / 2);
      const clickY = Math.round((bubble.top + bubble.bottom) / 2);
      await clickAt(clickX, clickY, 3);
      await delay(1000);
      const image = await screen();
      const search = copyMenuSearchRegion(clickX, clickY, 1280, 900);
      const firstScan = await ocr(image, search.crop, '6');
      let menuLines = groupOcrLines(parseTsvWords(firstScan.stdout));
      let localPoint = copyMenuPoint(menuLines);
      if (!localPoint) {
        const secondScan = await ocr(image, search.crop, '6', true);
        menuLines = groupOcrLines(parseTsvWords(secondScan.stdout));
        localPoint = copyMenuPoint(menuLines);
      }
      const point = localPoint
        ? { x: localPoint.x + search.left, y: localPoint.y + search.top }
        : null;
      if (!point) {
        console.log(
          'viber_copy_menu_missing',
          JSON.stringify({
            bubble,
            menuItems: menuLines
              .map((line) => line.text.trim())
              .filter(
                (text) =>
                  text.length <= 80 &&
                  /\b(reply|copy|select|translate|chatgpt|pin|forward|delete|відповісти|копіювати|виділити|перекласти|закріпити|переслати|удалить|копировать|выделить|перевести|переслать|закрепить)\b/iu.test(
                    text,
                  ),
              )
              .slice(0, 12),
          }),
        );
        await writeFile(join(data, 'attention.jpg'), image, { mode: 0o600 });
        attentionReason = 'copy_menu_missing';
        throw Error('needs_attention');
      }
      await clickAt(point.x, point.y);
      await delay(100);
      const after = (
        await run('xclip', [...clipboard, '-o'], { timeout: 3000 })
      ).stdout;
      if (!clipboardChanged(before, after)) {
        await writeFile(join(data, 'attention.jpg'), await screen(), {
          mode: 0o600,
        });
        attentionReason = 'clipboard_not_changed';
        throw Error('needs_attention');
      }
      attentionReason = '';
      await screen();
      return after;
    } catch (error) {
      if (!(error instanceof Error && error.message === 'needs_attention')) {
        attentionReason = 'copy_failed';
        const image = await screen().catch(() => null);
        if (image)
          await writeFile(join(data, 'attention.jpg'), image, {
            mode: 0o600,
          }).catch(() => {});
        throw Error('needs_attention');
      }
      throw error;
    } finally {
      await run('xdotool', ['key', '--clearmodifiers', 'Escape'], {
        timeout: 3000,
      }).catch(() => {});
      await run('xdotool', ['mousemove', '0', '0'], { timeout: 3000 }).catch(
        () => {},
      );
      const closedMenuImage = await screen().catch(() => null);
      if (closedMenuImage && attentionReason)
        await writeFile(join(data, 'attention.jpg'), closedMenuImage, {
          mode: 0o600,
        }).catch(() => {});
    }
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
        [
          source,
          '-crop',
          `${width}x1+0+${Math.floor(height / 2)}`,
          '+repage',
          '-depth',
          '8',
          'txt:-',
        ],
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
    let profileSidebarOpen = words.some(
      (word) =>
        word.left > width * 0.65 &&
        /^(media|gifs?|links|files|participants?|encrypted|mute|groups)$/i.test(
          word.text,
        ),
    );
    const boundaries = verticalColorBoundaries(samples);
    if (
      !profileSidebarOpen &&
      boundaries.some((x) => Math.abs(x / width - 0.77) < 0.07)
    ) {
      const sidebarLeft = Math.floor(width * 0.7);
      const sidebarOcr = await ocr(
        image,
        `${width - sidebarLeft}x${height - 100}+${sidebarLeft}+100`,
        '11',
        false,
      );
      const sidebarLabels = new Set(
        groupOcrLines(parseTsvWords(sidebarOcr.stdout))
          .flatMap((line) => line.text.match(/[\p{L}]+/gu) ?? [])
          .map((word) => word.toLocaleLowerCase())
          .filter((word) =>
            /^(media|gifs?|links|files|participants?|encrypted|mute|groups)$/.test(
              word,
            ),
          ),
      );
      profileSidebarOpen = sidebarLabels.size >= 2;
    }
    let chatgptHeader = chatgptPanelHeader(words, width, height, boundaries);
    if (
      !chatgptHeader &&
      boundaries.some((x) => x > width * 0.45 && x < width * 0.9)
    ) {
      // The multilingual model can read this English brand as Cyrillic. Confirm
      // the exact title in its header strip, constrained by the observed divider.
      const left = Math.floor(width * 0.45),
        top = 26;
      const header = await ocr(
        image,
        `${width - left}x84+${left}+${top}`,
        '11',
        false,
        'eng',
      );
      chatgptHeader = chatgptPanelHeader(
        parseTsvWords(header.stdout).map((word) => ({
          ...word,
          left: word.left + left,
          top: word.top + top,
        })),
        width,
        height,
        boundaries,
      );
    }
    const chatgptSidebarOpen = !!chatgptHeader;
    const profileOpen = profileSidebarOpen || chatgptSidebarOpen;
    const bounds = chatColumnBounds(
      width,
      boundaries,
      profileOpen,
      chatgptHeader?.left,
    );
    const chatLines = groupOcrLinesWithinBounds(words, bounds);
    const blockedActions = new Set([
      'block',
      'report',
      'spam',
      'delete',
      'clear',
      'видалити',
      'удалить',
      'очистити',
      'очистить',
      'leave',
      'вийти',
    ]);
    const blockedWords = words
      .filter((word) =>
        blockedActions.has(
          word.text
            .normalize('NFKC')
            .toLocaleLowerCase()
            .replace(/[^\p{L}]/gu, ''),
        ),
      )
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
      chatLines,
      allText,
      modalText: lines
        .filter(
          (line) =>
            (line.top < 105 &&
              /no connectivity|no connection/iu.test(line.text)) ||
            (line.top > height * 0.22 &&
              line.top < height * 0.75 &&
              line.left > width * 0.25 &&
              line.right < width * 0.86),
        )
        .map((line) => line.text)
        .join(' '),
      profileOpen,
      chatgptSidebarOpen,
      bounds,
      blockedWords,
      bannerBottom: (() => {
        const banner = lines.find((line) =>
          /not\s+in\s+your\s+contact\s+list|not\s+in\s+your\s+contacts/i.test(
            line.text,
          ),
        );
        return banner
          ? Math.max(
              banner.top,
              ...blockedWords
                .filter(
                  (word) =>
                    word.top < height * 0.3 &&
                    word.left >= bounds.left &&
                    word.right <= bounds.right,
                )
                .map((word) => word.bottom),
              ...words
                .filter(
                  (word) =>
                    Math.abs(word.top + word.height / 2 - (banner.top + 8)) <
                      32 &&
                    word.left >= banner.left - 16 &&
                    word.left <= banner.right + 16,
                )
                .map((word) => word.top + word.height),
            )
          : 0;
      })(),
    };
  };
  const normalizeChatLayout = async () => {
    // Panel and contact-banner coordinates overlap destructive controls in some
    // Viber layouts. Keep the visible layout and let bounded OCR handle it.
    return inspectChatLayout(await screen());
  };
  const clickAt = async (x: number, y: number, button: 1 | 3 = 1) => {
    const layout = await inspectChatLayout(await screen());
    if (!safeLayoutClick(x, y, layout.blockedWords))
      throw Error('unsafe_click');
    await run(
      'xdotool',
      [
        'mousemove',
        String(Math.round(x)),
        String(Math.round(y)),
        'click',
        String(button),
      ],
      { timeout: 3000 },
    );
  };
  const profileRecipientMatch = async (
    layout: Awaited<ReturnType<typeof inspectChatLayout>>,
    to: string,
  ) => {
    const matches = (candidate: string) =>
      chatHeaderMatchesRecipient(candidate, to);
    if ((await database())?.number === to) return notesHeader(layout);
    const phoneInCrop = async (image: Buffer, crop: string) => {
      const result = await ocr(image, crop, '11', false);
      return phoneFromOcrLines(
        groupOcrLines(parseTsvWords(result.stdout)),
        () => true,
      );
    };
    const visible = phoneFromOcrLines(
      layout.chatLines,
      (line) =>
        line.top < 210 &&
        line.left >= layout.bounds.left &&
        line.left < layout.bounds.right,
    );
    if (matches(visible)) return true;
    const headerImage = await screen();
    const headerWidth = Math.max(1, layout.bounds.right - layout.bounds.left);
    const headerCropNumber = await phoneInCrop(
      headerImage,
      `${headerWidth}x220+${layout.bounds.left}+0`,
    );
    if (matches(headerCropNumber)) return true;
    // Never toggle the ChatGPT panel or profile: either toggle can open a
    // neighboring overflow menu. A recipient must be visible in OCR already.
    const current = layout;
    const profileNumber = current.profileOpen
      ? phoneFromOcrLines(
          groupOcrLinesWithinBounds(current.words, {
            left: current.bounds.right,
            right: current.width,
          }),
          (line) =>
            line.top < current.height * 0.55 &&
            line.left >= current.bounds.right - 5,
        )
      : '';
    if (matches(profileNumber)) return true;
    if (current.bounds.right < current.width) {
      const profileImage = await screen();
      if (
        matches(
          await phoneInCrop(
            profileImage,
            `${current.width - current.bounds.right}x${Math.floor(current.height * 0.55)}+${current.bounds.right}+0`,
          ),
        )
      )
        return true;
    }
    return false;
  };
  const openRecipientChat = async (
    to: string,
    allowRequestedInboundTarget = false,
  ) => {
    if ((await database())?.number === to) {
      await openOwnNotes();
      return;
    }
    const url = `viber://chat?${new URLSearchParams({ number: to.replace(/\D/g, '') })}`;
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
    await run('xdotool', ['windowraise', window]);
    await run('xdotool', ['windowfocus', '--sync', window]);
    const layout = await inspectChatLayout(await screen());
    if (allowRequestedInboundTarget) {
      if (
        !layout.chatLines.some(
          (line) => line.top < 210 && line.text.trim().length > 0,
        )
      )
        throw Error('chat_header_missing');
    } else if (!(await profileRecipientMatch(layout, to))) {
      throw Error('recipient_not_verified');
    }
  };
  const notesHeader = async (
    layout: Awaited<ReturnType<typeof inspectChatLayout>>,
  ) => {
    if (hasMyNotesHeader(layout.words, layout.bounds)) return true;
    // Dense messages can suppress even the title in whole-window OCR.
    try {
      const header = await ocr(
        await screen(),
        `${layout.bounds.right - layout.bounds.left}x70+${layout.bounds.left}+40`,
        '11',
        false,
        'eng',
      );
      return hasMyNotesHeader(
        parseTsvWords(header.stdout).map((word) => ({
          ...word,
          left: word.left + layout.bounds.left,
          top: word.top + 40,
        })),
        layout.bounds,
      );
    } catch {
      return false;
    }
  };
  const returnToMyNotes = async () => {
    const layout = await inspectChatLayout(await screen());
    if (classifyViberModal(layout.modalText) !== 'none') return false;
    const notes = groupOcrLinesWithinBounds(layout.words, {
      left: 0,
      right: layout.bounds.left,
    }).find(
      (line) =>
        line.left < layout.width * 0.3 &&
        /^(?:my\s+notes|мої\s+нотатки|мои\s+заметки)$/iu.test(line.text.trim()),
    );
    if (!notes) return false;
    await clickAt(Math.round((notes.left + notes.right) / 2), notes.top + 10);
    await delay(500);
    return true;
  };
  const openOwnNotes = async () => {
    let layout = await inspectChatLayout(await screen());
    if (classifyViberModal(layout.modalText) !== 'none')
      throw Error('viber_modal_visible');
    if (await notesHeader(layout)) return;
    if (!(await returnToMyNotes())) {
      // Viber rejects chat URIs addressed to this account. Its own-profile menu
      // provides the supported My Notes entry in the normalized desktop window.
      await run('xdotool', ['key', 'Escape']);
      await clickAt(25, 25);
      await delay(600);
      layout = await inspectChatLayout(await screen());
      if (classifyViberModal(layout.modalText) !== 'none')
        throw Error('viber_modal_visible');
      let point = myNotesMenuPoint(
        groupOcrLinesWithinBounds(layout.words, {
          left: 0,
          right: layout.bounds.left,
        }),
        layout.width,
        layout.height,
      );
      if (!point) {
        // The profile menu obscures chat boundaries. OCR its label separately
        // from the icon, using the normalized desktop rather than chat bounds.
        const top = Math.round((layout.height * 11) / 30);
        const row = await ocr(
          await screen(),
          `235x${Math.round(layout.height / 15)}+65+${top}`,
          '6',
          true,
          'eng+ukr+rus',
        );
        point = myNotesMenuPoint(
          groupOcrLines(
            parseTsvWords(row.stdout).map((word) => ({
              ...word,
              left: word.left + 65,
              top: word.top + top,
            })),
          ),
          layout.width,
          layout.height,
        );
      }
      if (!point) throw Error('my_notes_entry_missing');
      await clickAt(point.x, point.y);
      await delay(500);
    }
    layout = await inspectChatLayout(await screen());
    if (!(await notesHeader(layout))) throw Error('recipient_not_verified');
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
    if (
      modal === 'sync_history' ||
      modal === 'sync_canceled' ||
      modal === 'repair'
    ) {
      await writeFile(join(data, 'attention.jpg'), image, { mode: 0o600 });
      return modal;
    }
    if (
      modal === 'close_confirmation' ||
      modal === 'unknown' ||
      windows.length > 1
    ) {
      await writeFile(join(data, 'attention.jpg'), image, { mode: 0o600 });
      return 'unknown_modal';
    }
    attentionReason = '';
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
    await clickAt(760, 506);
    await delay(300);
    return true;
  };
  const database = () => accountDatabase(join(data, '.ViberPC'));
  const messages = async (since: Date) => {
    const account = await database();
    if (!account) throw Error('needs_activation');
    return readMessages(account.path, since);
  };
  const inboxFromScreen = async (
    since: Date,
    recipients: string[] = [],
    afterByRecipient = new Map<string, Date>(),
  ) => {
    const found: ReturnType<typeof visibleInboundMessages> = [];
    const visited = new Set<string>();
    const scanCurrent = async (hint = '') => {
      let layout = await inspectChatLayout(await screen());
      let from = phoneFromOcrLines(
        layout.chatLines,
        (line) =>
          line.top < 210 &&
          line.left >= layout.bounds.left &&
          line.left < layout.bounds.right,
      );
      if (!from && hint) from = hint;
      if (!from && layout.profileOpen)
        from = phoneFromOcrLines(
          groupOcrLinesWithinBounds(layout.words, {
            left: layout.bounds.right,
            right: layout.width,
          }),
          (line) =>
            line.top < layout.height * 0.55 &&
            line.left >= layout.bounds.right - 5,
        );
      if (!from && !layout.profileOpen) {
        const x = Math.min(layout.width - 35, layout.bounds.right - 28);
        if (safeLayoutClick(x, 45, layout.blockedWords)) {
          await clickAt(x, 45);
          await delay(300);
          layout = await inspectChatLayout(await screen());
        }
      }
      if (!from)
        from = phoneFromOcrLines(
          groupOcrLinesWithinBounds(layout.words, {
            left: layout.bounds.right,
            right: layout.width,
          }),
          (line) =>
            line.top < layout.height * 0.55 &&
            line.left >= layout.bounds.right - 5,
        );
      if (!from) return;
      const threadId = `screen:${screenMessageId(from, '', '')}`;
      if (visited.has(threadId)) return;
      visited.add(threadId);
      const frontier = afterByRecipient.get(from);
      if (!frontier) return;
      let headerBottom = Math.max(
        layout.bannerBottom,
        140,
        ...layout.chatLines
          .filter((line) => line.top < layout.height * 0.16)
          .map((line) => line.top + 28),
      );
      const firstMessageLine = layout.chatLines
        .filter(
          (line) =>
            line.top > headerBottom &&
            line.top < layout.height - 100 &&
            visibleTimestampLine(line.text),
        )
        .sort((a, b) => a.top - b.top)[0];
      if (firstMessageLine && firstMessageLine.top < headerBottom + 55) {
        // A bubble against the contact banner can receive the context click on
        // the banner edge. Move it fully into the chat before trying Copy.
        await run('xdotool', [
          'mousemove',
          String(Math.round((layout.bounds.left + layout.bounds.right) / 2)),
          String(Math.round(layout.height / 2)),
          'click',
          '--repeat',
          '3',
          '--delay',
          '80',
          '4',
        ]);
        await delay(300);
        layout = await inspectChatLayout(await screen());
        headerBottom = Math.max(
          layout.bannerBottom,
          140,
          ...layout.chatLines
            .filter((line) => line.top < layout.height * 0.16)
            .map((line) => line.top + 28),
        );
      }
      const reference = new Date();
      const source = join(data, 'layout-source.jpg');
      const { stdout: rawPixels } = await run(
        'convert',
        [source, '-depth', '8', 'rgb:-'],
        { encoding: 'buffer', timeout: 10000, maxBuffer: 5 * 1024 * 1024 },
      );
      const pixelBubbles = messageBubbleRegions(
        rawPixels,
        layout.width,
        layout.height,
        layout.bounds,
        headerBottom,
      );
      const ocrBubbles = inboundBubbleRegionsFromOcr(layout.chatLines, {
        bounds: layout.bounds,
        headerBottom,
        height: layout.height,
        reference,
      });
      const bubbles =
        ocrBubbles.length > 0
          ? ocrBubbles
          : pixelBubbles
              .filter((bubble) => bubble.side === 'left')
              .map((bubble) => ({
                ...bubble,
                daySeparator: daySeparatorAt(
                  layout.chatLines,
                  bubble.top,
                  reference,
                ),
              }));
      const image = await readFile(source);
      for (const bubble of bubbles) {
        const daySeparator =
          bubble.daySeparator ??
          daySeparatorAt(layout.chatLines, bubble.top, reference);
        if (!daySeparator) {
          console.log(
            'viber_inbound_skipped',
            JSON.stringify({
              threadId,
              reason: 'date_unknown',
              top: bubble.top,
            }),
          );
          continue;
        }
        const crop = `${bubble.right - bubble.left}x${bubble.bottom - bubble.top}+${bubble.left}+${bubble.top}`;
        const result = await ocr(image, crop, '6');
        const bubbleLines = groupOcrLines(parseTsvWords(result.stdout));
        if (!bubbleLines.some((line) => visibleTimestampLine(line.text))) {
          const timeResult = await ocr(image, crop, '6', true);
          bubbleLines.push(
            ...groupOcrLines(parseTsvWords(timeResult.stdout)).filter((line) =>
              visibleTimestampLine(line.text),
            ),
          );
        }
        const ocrText = inboundOcrFallbackText(bubbleLines);
        const candidate = inboundBubbleMessage(bubbleLines, {
          threadId,
          from,
          since: frontier,
          reference,
          region: bubble,
          copiedText: ocrText,
          daySeparator,
        });
        if (!candidate) continue;
        let copiedText: string;
        try {
          copiedText = await copyBubble(bubble);
        } catch {
          attentionReason = '';
          console.log(
            'viber_inbound_ocr_fallback',
            JSON.stringify({ threadId, top: bubble.top }),
          );
          found.push(candidate);
          continue;
        }
        const message = inboundBubbleMessage(bubbleLines, {
          threadId,
          from,
          since: frontier,
          reference,
          region: bubble,
          copiedText,
          dedupeText: ocrText,
          daySeparator,
        });
        if (message) found.push(message);
      }
    };
    let safeToRestoreNotes = false;
    try {
      // When the caller names a recipient, navigate straight to that verified
      // chat instead of inspecting whatever private conversation was open.
      if (recipients.length === 0) {
        const modal = await checkModals();
        if (modal) throw Error('needs_attention');
        safeToRestoreNotes = true;
        await scanCurrent();
      }
      for (const recipient of [...new Set(recipients)].slice(0, 500)) {
        if (!/^\+[1-9]\d{6,14}$/.test(recipient)) continue;
        const threadId = `screen:${screenMessageId(recipient, '', '')}`;
        if (visited.has(threadId)) continue;
        await openRecipientChat(recipient, true);
        safeToRestoreNotes = true;
        const modal = await checkModals();
        if (modal) throw Error('needs_attention');
        await scanCurrent(recipient);
      }
    } finally {
      if (safeToRestoreNotes) await returnToMyNotes().catch(() => false);
    }
    return found;
  };
  const scrollChat = async (
    layout: Awaited<ReturnType<typeof inspectChatLayout>>,
    direction: 4 | 5,
    count: number,
  ) => {
    await scrollWithSettledPointer({
      move: async (inside) => {
        await run(
          'xdotool',
          inside
            ? [
                'mousemove',
                String(
                  Math.round((layout.bounds.left + layout.bounds.right) / 2),
                ),
                String(Math.round(layout.height * 0.6)),
              ]
            : ['mousemove', '0', '0'],
          { timeout: 3000 },
        );
      },
      scroll: async () => {
        await run(
          'xdotool',
          [
            'click',
            '--repeat',
            String(count),
            '--delay',
            '15',
            String(direction),
          ],
          { timeout: 4000 },
        );
      },
      wait: async (ms) => {
        await delay(ms);
      },
    });
  };
  const outgoingSlice = async (expected?: string): Promise<ChatSlice> => {
    let image = await screen();
    let layout = await inspectChatLayout(image);
    if (classifyViberModal(layout.modalText) !== 'none')
      throw Error('viber_modal_visible');
    // Scroll inside the verified chat only; a draft can otherwise leave the new
    // bubble beyond the viewport, especially after a very long message.
    await scrollChat(layout, 5, 100);
    image = await screen();
    layout = await inspectChatLayout(image);
    if (classifyViberModal(layout.modalText) !== 'none')
      throw Error('viber_modal_visible');
    const initialHeaderBottom = chatBodyTop(
      layout.chatLines,
      layout.bannerBottom,
    );
    const source = join(data, 'layout-source.jpg');
    const [raw, metadata] = await Promise.all([
      run('convert', [source, '-depth', '8', 'rgb:-'], {
        encoding: 'buffer',
        timeout: 10000,
        maxBuffer: 5 * 1024 * 1024,
      }),
      ocr(
        image,
        `${layout.bounds.right - layout.bounds.left}x${layout.height}+${layout.bounds.left}+0`,
        '11',
        true,
      ),
    ]);
    const headerBottom = deriveMessageBodyTop(
      raw.stdout,
      layout.width,
      layout.height,
      layout.bounds,
      initialHeaderBottom,
    );
    const timeWords = parseTsvWords(metadata.stdout).map((word) => ({
      ...word,
      left: word.left + layout.bounds.left,
    }));
    const timeLines = groupOcrLines(timeWords).filter((line) =>
      visibleTimestampLine(line.text),
    );
    const lines = [...layout.chatLines];
    for (const line of timeLines)
      if (
        !lines.some(
          (other) =>
            visibleTimestampLine(other.text) &&
            Math.abs(other.top - line.top) < 12,
        )
      )
        lines.push(line);
    const regions = messageBubbleRegions(
      raw.stdout,
      layout.width,
      layout.height,
      layout.bounds,
      headerBottom,
      layout.height - 50,
    ).filter((bubble) => bubble.side === 'right' && bubble.outgoingColor);
    const mappedBubbles: ChatSlice['bubbles'] = regions.map((region) => {
      const extracted = outgoingBubbleText(lines, region);
      const word = [...timeWords, ...layout.words]
        .filter(
          (word) =>
            visibleTimestampLine(word.text) &&
            word.top >= region.bottom - 34 &&
            word.top < region.bottom + 20 &&
            word.left >= region.left &&
            word.left + word.width <= region.right + 4,
        )
        .sort((a, b) => b.top - a.top)[0];
      const timestamp = word
        ? { ...word, right: word.left + word.width }
        : extracted.timestamp;
      const bodyPixels: Buffer[] = [];
      for (let y = region.top; y < region.bottom - 22; y++)
        bodyPixels.push(
          raw.stdout.subarray(
            (y * layout.width + region.left) * 3,
            (y * layout.width + region.right) * 3,
          ),
        );
      return {
        ...region,
        text: extracted.text,
        ocrText: extracted.text,
        contentSignature: bubbleContentSignature(
          raw.stdout,
          layout.width,
          layout.height,
          region,
        ),
        contentHash: createHash('sha256')
          .update(Buffer.concat(bodyPixels))
          .digest('hex'),
        messageTime: word
          ? visibleTimestampLine(word.text)
          : extracted.messageTime,
        status: outgoingBubbleStatus(
          raw.stdout,
          layout.width,
          layout.height,
          region,
          timestamp,
        ),
        clipped: region.top <= headerBottom + 4,
        daySeparator: daySeparatorAt(
          layout.chatLines,
          region.bottom,
          new Date(),
        ),
      };
    });
    const aligned = mappedBubbles.filter(
      (bubble) =>
        bubble.right >=
        layout.bounds.right - (layout.bounds.right - layout.bounds.left) * 0.12,
    );
    for (const spatialLast of aligned
      .filter(
        (bubble) =>
          !bubble.messageTime &&
          Math.min(layout.bounds.right, bubble.right - 10) >
            Math.max(layout.bounds.left, bubble.left - 4, bubble.right - 106),
      )
      .slice(-8)
      .reverse()) {
      const right = Math.min(layout.bounds.right, spatialLast.right - 10);
      const left = Math.max(
          layout.bounds.left,
          spatialLast.left - 4,
          right - 96,
        ),
        top = Math.max(headerBottom, spatialLast.bottom - 26);
      if (right <= left || spatialLast.bottom <= top) continue;
      const footer = await ocr(
        image,
        `${right - left}x${spatialLast.bottom - top}+${left}+${top}`,
        '7',
        true,
        'eng',
        3,
        '0123456789:',
        true,
      ).catch(() => ({ stdout: '' }));
      const word = parseTsvWords(footer.stdout).find((word) =>
        visibleTimestampLine(word.text),
      );
      if (word) {
        const timestamp = {
          ...word,
          left: word.left + left,
          top: word.top + top,
          right: word.left + left + word.width,
        };
        spatialLast.messageTime = visibleTimestampLine(word.text);
        spatialLast.status = outgoingBubbleStatus(
          raw.stdout,
          layout.width,
          layout.height,
          spatialLast,
          timestamp,
        );
        spatialLast.text = outgoingBubbleText(
          [...lines, timestamp],
          spatialLast,
        ).text;
      }
    }
    // Timestamp-only widgets carry an unfilled emoji above the badge. Keep every
    // visible widget in both snapshots, including older adjacent emoji anchors.
    for (const bubble of aligned) {
      if (bubble.contentSignature) continue;
      const previous = Math.max(
        headerBottom,
        ...mappedBubbles
          .filter(
            (other) =>
              other !== bubble &&
              other.messageTime &&
              other.bottom <= bubble.top,
          )
          .map((other) => other.bottom),
      );
      const body = unfilledEmojiBody(
        raw.stdout,
        layout.width,
        layout.height,
        bubble,
        previous,
      );
      if (!body) continue;
      bubble.bodyRegion = body;
      bubble.unfilled = true;
      bubble.top = body.top;
      bubble.left = Math.min(bubble.left, body.left);
      bubble.right = Math.max(bubble.right, body.right);
      bubble.text = outgoingBubbleText(lines, bubble).text;
      bubble.ocrText = bubble.text;
      bubble.contentHash = undefined;
      bubble.contentSignature = bubbleContentSignature(
        raw.stdout,
        layout.width,
        layout.height,
        bubble,
      );
    }
    const spatialLast = aligned
      .filter((bubble) => bubble.contentSignature)
      .at(-1);
    // An unreadable latest footer is uncertainty, never permission to copy an older bubble.
    const bubbles = mappedBubbles.filter(
      (bubble) => bubble.messageTime || bubble === spatialLast,
    );
    // Whole-window OCR often omits a lone letter. Read only the body pixels
    // before considering a context menu, on both sides of the send frontier.
    for (const bubble of bubbles) {
      if (bubble.text || !bubble.messageTime) continue;
      const body = bubble.bodyRegion;
      const crop = body
        ? `${body.right - body.left}x${body.bottom - body.top}+${body.left}+${body.top}`
        : `${Math.max(1, bubble.right - bubble.left - 14)}x${Math.max(1, bubble.bottom - bubble.top - 29)}+${bubble.left + 7}+${bubble.top + 5}`;
      const result = await ocr(
        image,
        crop,
        bubble.bottom - bubble.top < 80 ? '7' : '6',
      );
      bubble.text = groupOcrLines(parseTsvWords(result.stdout))
        .map((line) => line.text)
        .join('\n')
        .trim();
      bubble.ocrText = bubble.text;
    }
    const newest = bubbles.at(-1);
    if (
      expected &&
      newest?.clipped &&
      !matchesOutgoingText(expected, newest.text, true)
    ) {
      const regional = await ocr(
        image,
        `${newest.right - newest.left}x${Math.max(1, newest.bottom - newest.top - 24)}+${newest.left}+${newest.top}`,
        '6',
        true,
        'ukr+rus+eng',
        2,
        undefined,
        true,
      ).catch(() => ({ stdout: '' }));
      const text = groupOcrLines(parseTsvWords(regional.stdout))
        .map((line) => line.text)
        .join('\n')
        .trim();
      if (text) {
        newest.text = text;
        newest.ocrText = text;
      }
    }
    if (
      expected &&
      newest?.clipped &&
      matchesOutgoingText(expected, newest.text, true)
    ) {
      // Inspect bounded pages of the same wide bubble; the suffix alone cannot
      // establish the complete long message. Never copy a giant message.
      try {
        for (let page = 0; page < 8 && !newest.prefixText; page++) {
          await scrollChat(layout, 4, 6);
          const pageImage = await screen();
          const pageLayout = await inspectChatLayout(pageImage);
          if (classifyViberModal(pageLayout.modalText) !== 'none')
            throw Error('viber_modal_visible');
          const pageRaw = await run(
            'convert',
            [source, '-depth', '8', 'rgb:-'],
            { encoding: 'buffer', timeout: 10000, maxBuffer: 5 * 1024 * 1024 },
          );
          const pageTop = deriveMessageBodyTop(
            pageRaw.stdout,
            pageLayout.width,
            pageLayout.height,
            pageLayout.bounds,
            chatBodyTop(pageLayout.chatLines, pageLayout.bannerBottom),
          );
          const region = messageBubbleRegions(
            pageRaw.stdout,
            pageLayout.width,
            pageLayout.height,
            pageLayout.bounds,
            pageTop,
            pageLayout.height - 50,
          )
            .filter(
              (region) =>
                region.side === 'right' &&
                region.outgoingColor &&
                region.bottom >= pageLayout.height - 54 &&
                sameBubbleColumn(region, newest),
            )
            .sort((a, b) => b.bottom - b.top - (a.bottom - a.top))[0];
          if (!region) break;
          let text = outgoingBubbleText(pageLayout.chatLines, region).text;
          if (
            region.top > pageTop + 4 &&
            !matchesOutgoingText(
              normalizeOcr(expected).slice(0, 80),
              normalizeOcr(text).slice(0, 80),
            )
          ) {
            const body = await ocr(
              pageImage,
              `${region.right - region.left}x${region.bottom - region.top}+${region.left}+${region.top}`,
              '6',
              true,
              'ukr+rus+eng',
              2,
              undefined,
              true,
            );
            text = groupOcrLines(parseTsvWords(body.stdout))
              .map((line) => line.text)
              .join('\n');
          }
          if (
            region.top > pageTop + 4 &&
            matchesOutgoingText(
              normalizeOcr(expected).slice(0, 80),
              normalizeOcr(text).slice(0, 80),
            )
          )
            newest.prefixText = text;
        }
      } finally {
        if (
          classifyViberModal(
            (await inspectChatLayout(await screen())).modalText,
          ) === 'none'
        )
          await scrollChat(layout, 5, 100);
      }
    }
    if (
      expected &&
      newest?.messageTime &&
      !newest.clipped &&
      !!newest.contentSignature &&
      !matchesOutgoingText(expected, newest.text)
    ) {
      // Only the latest spatially validated outgoing bubble can be copied. Never
      // open a menu on a banner, date, heart, composer, profile card or modal.
      try {
        newest.text = await copyBubble(newest.bodyRegion ?? newest);
        newest.clipped = false;
      } catch {
        /* OCR or database can still confirm. */
      }
    }
    const composerResult = await ocr(
      image,
      `${Math.max(1, layout.bounds.right - layout.bounds.left - 180)}x45+${layout.bounds.left + 110}+${layout.height - 50}`,
      '7',
    ).catch(() => ({ stdout: '' }));
    const composerText = groupOcrLines(parseTsvWords(composerResult.stdout))
      .map((line) => line.text)
      .join(' ');
    const composer = [
      'type a message',
      'написати повідомлення',
      'напишіть повідомлення',
      'написать сообщение',
    ].some((placeholder) => textSimilarity(placeholder, composerText) >= 0.7)
      ? ''
      : composerText;
    return {
      observedAt: new Date().toISOString(),
      composer,
      bubbles,
      notes: await notesHeader(layout),
    };
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
      const layout = await inspectChatLayout(await screen());
      if (!hint && (await notesHeader(layout))) return;
      let from =
        hint ||
        phoneFromOcrLines(
          layout.chatLines,
          (line) =>
            line.top < 210 &&
            line.left >= layout.bounds.left &&
            line.left < layout.bounds.right,
        );
      if (!from && layout.profileOpen)
        from = phoneFromOcrLines(
          groupOcrLinesWithinBounds(layout.words, {
            left: layout.bounds.right,
            right: layout.width,
          }),
          (line) =>
            line.top < layout.height * 0.55 &&
            line.left >= layout.bounds.right - 5,
        );
      if (!from) return;
      const threadId = `screen:${screenMessageId(from, '', '')}`;
      if (visited.has(threadId)) return;
      visited.add(threadId);
      const slice = await outgoingSlice();
      for (const bubble of slice.bubbles) {
        if (
          !bubble.messageTime ||
          !(
            bubble.status === 'sent' ||
            (slice.notes && bubble.status === 'unknown')
          )
        )
          continue;
        if (!bubble.text || bubble.unfilled) {
          try {
            bubble.text = await copyBubble(bubble.bodyRegion ?? bubble);
          } catch {
            continue;
          }
        }
        const day = bubble.daySeparator;
        if (!day) continue;
        const at = visibleMessageTimestamp(bubble.messageTime, new Date(), day);
        if (!at || at < since) continue;
        result.push({
          from,
          text: bubble.text,
          at: at.toISOString(),
          providerMessageId: screenMessageId(
            threadId,
            bubble.text,
            bubble.messageTime,
          ),
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
    return result.sort(
      (left, right) => Date.parse(left.at) - Date.parse(right.at),
    );
  };
  const send = createSend(join(data, 'receipts'), {
    messages,
    screen,
    confirm: outgoingSlice,
    wait: () => delay(1000),
    async open(url, to) {
      if (
        classifyViberModal(
          (await inspectChatLayout(await screen())).modalText,
        ) !== 'none'
      )
        throw Error('viber_modal_visible');
      // The official .desktop entry is Exec=/opt/viber/Viber %u. A second instance
      // forwards its URI to the running single-instance Qt application.
      const ownAccount = (await database())?.number === to;
      if (!ownAccount) {
        const navigation = new URL(url);
        navigation.searchParams.delete('draft');
        await run('/opt/viber/Viber', [navigation.toString()], {
          timeout: 10000,
        });
        await delay(2000);
      }
      const { stdout } = await run(
        'xdotool',
        ['search', '--onlyvisible', '--class', 'Viber'],
        { timeout: 3000 },
      );
      const window = stdout.trim().split('\n').at(-1);
      if (!window || !/^\d+$/.test(window)) throw Error('chat_window_missing');
      await run('xdotool', ['windowsize', window, '1280', '900']);
      await run('xdotool', ['windowmove', window, '0', '0']);
      await run('xdotool', ['windowraise', window]);
      await run('xdotool', ['windowfocus', '--sync', window]);
      if (ownAccount) await openOwnNotes();
      let layout = await inspectChatLayout(await screen());
      if (classifyViberModal(layout.modalText) !== 'none')
        throw Error('viber_modal_visible');
      if (!(await profileRecipientMatch(layout, to)))
        throw Error('recipient_not_verified');
      layout = await normalizeChatLayout();
      // Capture the normal chat viewport before a multiline draft expands the
      // composer and reflows older bubbles against each other.
      const baseline = await outgoingSlice();
      // Clipboard paste preserves multiline text without producing Enter events.
      // Verify the exact composer selection before dispatching the message.
      const text = new URL(url).searchParams.get('draft');
      if (text === null) return;
      const draftFile = join(data, 'draft.txt');
      await writeFile(draftFile, text, { mode: 0o600 });
      await clickAt(
        Math.round((layout.bounds.left + layout.bounds.right) / 2),
        layout.height - 25,
      );
      await run('xdotool', ['key', '--clearmodifiers', 'ctrl+a']);
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
      return baseline;
    },
    async enter() {
      const layout = await inspectChatLayout(await screen());
      if (classifyViberModal(layout.modalText) !== 'none')
        throw Error('viber_modal_visible');
      await run('xdotool', ['key', '--clearmodifiers', 'Return']);
    },
  });

  let desktopQueue = Promise.resolve();
  const serializeDesktop = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = desktopQueue.then(operation, operation);
    desktopQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  };

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
        if (attentionReason)
          return json(200, {
            state: 'needs_attention',
            version,
            reason: attentionReason,
            screenshot: '/screen?attention=1',
          });
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
        const modal = await serializeDesktop(checkModals);
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
          await clickAt(point.x, point.y);
        }
        return json(200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/inbound') {
        const since = new Date(url.searchParams.get('since') || '');
        if (!Number.isFinite(since.getTime())) throw Error('invalid_since');
        const recipients = url.searchParams
          .getAll('to')
          .filter((value) => /^\+[1-9]\d{6,14}$/.test(value));
        if (recipients.length === 0) {
          const modal = await checkModals();
          if (modal)
            return json(423, { error: 'needs_attention', reason: modal });
        }
        const account = await database();
        const afterByRecipient = new Map<string, Date>();
        for (const value of url.searchParams.getAll('after')) {
          const separator = value.indexOf('|');
          if (separator < 0) continue;
          const recipient = value.slice(0, separator);
          const after = new Date(value.slice(separator + 1));
          if (
            /^\+[1-9]\d{6,14}$/.test(recipient) &&
            Number.isFinite(after.getTime())
          )
            afterByRecipient.set(recipient, after);
        }
        let incoming;
        try {
          incoming =
            account && recipients.length === 0
              ? (await readMessages(account.path, since))
                  .filter((message) => !message.outgoing)
                  .map((message) => ({
                    from: message.from,
                    text: message.text,
                    at: message.at,
                    providerMessageId: message.providerMessageId,
                    threadId: message.threadId,
                  }))
              : await serializeDesktop(() =>
                  inboxFromScreen(since, recipients, afterByRecipient),
                );
        } catch (error) {
          if (error instanceof Error && error.message === 'needs_attention')
            throw error;
          incoming = await serializeDesktop(() =>
            inboxFromScreen(since, recipients, afterByRecipient),
          );
        }
        return json(200, incoming);
      }
      if (req.method === 'GET' && url.pathname === '/outgoing') {
        const since = new Date(url.searchParams.get('since') || '');
        if (!Number.isFinite(since.getTime())) throw Error('invalid_since');
        const requestedRecipients = url.searchParams.getAll('to');
        const recipients = requestedRecipients.filter((value) =>
          /^\+[1-9]\d{6,14}$/.test(value),
        );
        if (requestedRecipients.length > 0 && recipients.length === 0)
          throw Error('invalid_recipient');
        const account = await database();
        // This undocumented database has no delivery state. Visible ticks are
        // required even when decryption succeeds; database rows supply IDs only.
        let outgoing = await serializeDesktop(() =>
          outgoingFromScreen(since, recipients),
        );
        if (account) {
          try {
            const rows = (
              await readMessages(account.path, since, recipients)
            ).filter((message) => message.outgoing);
            outgoing = outgoing.map((visible) => {
              const row = rows.find(
                (row) =>
                  row.from === visible.from &&
                  matchesOutgoingText(row.text, visible.text) &&
                  Math.abs(Date.parse(row.at) - Date.parse(visible.at)) <
                    60_000,
              );
              return row
                ? { ...visible, providerMessageId: row.providerMessageId }
                : visible;
            });
          } catch {
            /* Retain independently verified screen messages. */
          }
        }
        return json(200, outgoing);
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
        const input = JSON.parse(raw) as SendInput;
        const response = await serializeDesktop(async () => {
          const modal = classifyViberModal(
            (await inspectChatLayout(await screen())).modalText,
          );
          if (modal !== 'none')
            return {
              status: 423,
              body: { error: 'needs_attention', reason: modal },
            };
          return { status: 200, body: await send(input) };
        });
        return json(response.status, response.body);
      }
      json(404, { error: 'not_found' });
    } catch (error) {
      console.error(
        'bridge_operation_failed',
        error instanceof Error ? error.message : 'unknown_error',
      );
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
        await clickAt(x + width - 11, Math.max(0, y - 31)).catch(() => {});
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
