/** Evaluate in the page: only bounded UI labels/names and structural data leave it. */
export function failureDomSkeleton(limit = 200 * 1024) {
  const nodes: Record<string, unknown>[] = [];
  const encoder = new TextEncoder();
  const sensitive =
    '[contenteditable], input, textarea, aside, [role="complementary"], [data-pagelet="IGDMessagesList"], [data-pagelet^="IGDInboxThreadList"], [role="grid"], [role="list"], [aria-label^="Messages in conversation with "], [aria-label^="Повідомлення в розмові з "], [aria-label^="Сообщения в переписке с "], [role="textbox"], [role="log"], [role="article"], [role="row"], [role="listitem"], article, [data-message-id], [data-testid*="message" i], [data-testid*="preview" i]';
  const roles = new Set(
    'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript suggestion superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem'.split(
      ' ',
    ),
  );
  const controls =
    'button, a, select, [role="button"], [role="link"], [role="combobox"], [role="searchbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="spinbutton"], [role="option"], [role="tab"], [role^="menuitem"]';
  const ui =
    /^(?:message|send message|send|messages|inbox|search|close|loading(?:\.\.\.)?|instagram|from meta|повідомлення|надіслати|пошук|закрити|завантаження|сообщение|отправить|поиск|закрыть|загрузка|aa)$/i;
  const redact = (text: string) => `<text n=${text.length}>`;
  const caption = (text: string, allowed = false, heading = false) => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized &&
      normalized.length <= 40 &&
      (heading || (allowed && ui.test(normalized)))
      ? normalized
      : redact(text);
  };
  const path = (href: string) => {
    try {
      const url = new URL(href, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return '<path>';
      const fixed = new Set([
        'profile.php',
        'direct',
        't',
        'messages',
        'inbox',
        'requests',
        'accounts',
        'login',
      ]);
      return (
        url.pathname
          .split('/')
          .slice(0, 32)
          .map((part) => (!part || fixed.has(part) ? part : '<id>'))
          .join('/') + (url.searchParams.has('id') ? '?id=<id>' : '')
      );
    } catch {
      return '<path>';
    }
  };
  const hidden = (element: Element) => {
    if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return true;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
      )
        return true;
    }
    return false;
  };
  const instagram = /^(?:(www\.)?instagram\.com|ig\.me)$/.test(
    location.hostname,
  );
  const publicModalHeading =
    /^(Turn on Notifications|Увімкнути сповіщення|Включить уведомления)$/i;
  const headings = Array.from(
    document.querySelectorAll('main h1, [role="main"] h1'),
  ).filter(
    (node) =>
      !node.closest(`${sensitive}, [role=dialog], [role=region]`) &&
      !(
        instagram && node.closest('[role="alertdialog"], [aria-modal="true"]')
      ) &&
      !hidden(node) &&
      node.getClientRects().length > 0,
  );
  const profilePage =
    /^\/(?:profile\.php|[^/]+)\/?$/.test(location.pathname) &&
    !/^\/(?:direct|messages|accounts|inbox|requests|login)\/?$/.test(
      location.pathname,
    );
  const pageHeading =
    profilePage && headings.length === 1 ? headings[0] : undefined;
  const pageName = pageHeading?.textContent?.replace(/\s+/g, ' ').trim();
  const chatHeadings = Array.from(
    document.querySelectorAll(
      '[role="dialog"] header h1, [role="dialog"] header h2, [role="dialog"] header [role="heading"]',
    ),
  ).filter(
    (node) =>
      !node.closest(sensitive) &&
      (!instagram ||
        publicModalHeading.test(
          node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        )) &&
      !hidden(node) &&
      node.getClientRects().length > 0,
  );
  const safeNames = new Set(
    [
      pageName,
      ...chatHeadings.map((node) =>
        node.textContent?.replace(/\s+/g, ' ').trim(),
      ),
    ].filter((name): name is string => Boolean(name && name.length <= 40)),
  );
  const titleName =
    pageName && safeNames.has(pageName)
      ? pageName
      : safeNames.size === 1
        ? Array.from(safeNames)[0]
        : undefined;
  const safeData = new Set([
    'data-testid',
    'data-pagelet',
    'data-lexical-editor',
    'data-scope',
    'data-user-id',
    'data-message-id',
    'data-tab',
    'data-visualcompletion',
  ]);
  const tags = new Set(
    'a article aside b body br button div em fieldset footer form h1 h2 h3 h4 header hr i iframe img input label li main nav ol p section small span strong table tbody td textarea th thead time tr ul'.split(
      ' ',
    ),
  );
  const seen = new Set<Element>();
  const platform =
    location.hostname.endsWith('instagram.com') || location.hostname === 'ig.me'
      ? 'Instagram'
      : location.hostname.endsWith('linkedin.com')
        ? 'LinkedIn'
        : location.href === 'about:blank'
          ? ''
          : 'Facebook';
  const result = {
    version: 1,
    urlPattern: path(location.href),
    title: titleName ? `${titleName} | ${platform}` : platform,
    truncated: false,
    nodes,
  };
  let bytes = encoder.encode(JSON.stringify(result)).length;
  let visited = 0;
  let truncated = false;
  const walk = (
    element: Element,
    parent: number | null,
    scoped: boolean,
    depth = 0,
  ) => {
    if (truncated || seen.has(element)) return;
    seen.add(element);
    if (++visited > 20000 || depth > 64) {
      truncated = true;
      return;
    }
    if (element.matches('script, style, noscript, template, svg, canvas'))
      return;
    const rect = element.getBoundingClientRect();
    if (hidden(element)) return;
    scoped ||= element.matches(
      'header, h1, [role="banner"], main, [role="main"], [role="dialog"], [role="region"]',
    );
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth;
    let index = parent;
    if (scoped && visible) {
      const privateArea = Boolean(element.closest(sensitive));
      // Reuse only names established by profile/chat headings, including linked
      // minichat headers. Message bodies and previews stay private.
      const nameContainer = element.closest(
        'header, [role="banner"], h1, h2, [role="heading"], a, [role="link"], button, [role="button"]',
      );
      const heading =
        !privateArea &&
        (element === pageHeading ||
          Boolean(
            nameContainer &&
            safeNames.has(
              element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            ),
          ));
      const control = element.matches(controls);
      const node: Record<string, unknown> = {
        parent,
        tag: tags.has(element.localName) ? element.localName : 'element',
        bbox: [rect.x, rect.y, rect.width, rect.height].map(Math.round),
        visible: true,
      };
      for (const name of ['role', 'aria-label', 'aria-placeholder']) {
        const value = element.getAttribute(name);
        if (value !== null)
          node[name] =
            name === 'role' && roles.has(value)
              ? value
              : privateArea
                ? redact(value)
                : name === 'aria-label' && control && value.trim().length <= 40
                  ? value.replace(/\s+/g, ' ').trim()
                  : caption(value, control);
      }
      if (element.hasAttribute('contenteditable'))
        node.contenteditable =
          element.getAttribute('contenteditable') === 'false'
            ? 'false'
            : 'true';
      const data = element
        .getAttributeNames()
        .filter((name) => name.startsWith('data-'))
        .map((name) => (safeData.has(name) ? name : 'data-<name>'));
      if (data.length) node.data = Array.from(new Set(data));
      const href = element.getAttribute('href');
      if (href !== null) node.href = path(href);
      const text = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('');
      if (text.trim())
        node.text = privateArea
          ? redact(text)
          : caption(text, control, heading);
      const size = encoder.encode(JSON.stringify(node)).length + 1;
      if (bytes + size > limit) {
        truncated = true;
        return;
      }
      bytes += size;
      index = nodes.length;
      nodes.push(node);
    }
    for (const child of Array.from(element.children))
      walk(child, index, scoped, depth + 1);
  };
  // Prioritize floating chats outside main before a long profile/feed consumes
  // the budget. Unknown layouts are still structural data, with text redacted.
  const chatSelector =
    '[role="dialog"], [role="log"], [aria-label^="Messages in conversation with "], [aria-label^="Повідомлення в розмові з "], [aria-label^="Сообщения в переписке с "], [contenteditable="true"], [role="textbox"]';
  const chats = Array.from(document.querySelectorAll(chatSelector)).map(
    (node) => {
      let root = node;
      for (
        let level = 0;
        level < 4 && root.parentElement && root.parentElement !== document.body;
        level++
      ) {
        if (
          root.matches('[role="dialog"]') ||
          root.parentElement.matches('main, [role="main"]') ||
          root.parentElement.querySelector('main, [role="main"], h1')
        )
          break;
        root = root.parentElement;
      }
      return root;
    },
  );
  const roots = [
    pageHeading,
    ...chats,
    ...Array.from(
      document.querySelectorAll('header, [role="banner"], main, [role="main"]'),
    ),
  ].filter((node): node is Element => Boolean(node));
  for (const root of roots.length ? roots : [document.body])
    walk(root, null, true);
  return { ...result, truncated };
}
