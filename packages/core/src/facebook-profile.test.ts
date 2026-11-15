import { expect, it } from 'vitest';
import { parseSocialProfile, socialTarget } from './social.js';

const target = socialTarget('https://facebook.com/202020202020202/')!;
const own = target.canonicalUrl;
const foreign = 'https://www.facebook.com/303030303030303/';
// Synthetic structures, not captured HTML. Generic DIVs, semantic author headings,
// photo links and external aria-labelledby dates reflect the root's live observations.
const post = (author: string, photo: string, label: string) => `
  <div data-virtualized="false">
    <div role="heading" aria-level="2"><a href="${author}">Demo author</a> updated a photo.</div>
    <a role="link" href="/profile.php#?tracking"><span><span aria-labelledby="${label}">S͏ p͏ n͏ r͏</span></span></a>
    <a href="/photo/?fbid=${photo}&amp;set=synthetic">Photo</a>
  </div>`;
const page = (content: string, labels = '') => `
  <meta property="og:url" content="${own}">
  <div role="main"><h1>Demo profile</h1>${content}</div>${labels}`;

it('keeps a target-bound friends counter separate from followers and foreign counters', () => {
  const html = page(`<a href="${foreign}?sk=friends_all">900 friends</a>
    <a href="${own}&amp;sk=friends_all">73 friends</a><span>19 followers</span>`);
  expect(parseSocialProfile(html, target, 'GB')).toMatchObject({
    friendsCount: 73,
    followers: 19,
    postsCount: null,
  });
  expect(
    parseSocialProfile(
      page(`<a href="${foreign}?sk=friends_all">900 friends</a>`),
      target,
      'GB',
    ),
  ).toMatchObject({ friendsCount: null, followers: null });
});

it('recognizes only target-bound User JSON and own photo posts', () => {
  const html = `<script type="application/json">${JSON.stringify({
    profile: { __typename: 'User', id: target.handle, name: 'Demo profile' },
    feed: [
      {
        __typename: 'Story',
        actors: [{ id: target.handle }],
        creation_time: 1562889600,
        url: 'https://www.facebook.com/photo/?fbid=SYNTHETIC&set=synthetic',
      },
      {
        __typename: 'Story',
        actors: [{ id: '303030303030303' }],
        creation_time: 1798761600,
        url: 'https://www.facebook.com/photo/?fbid=FOREIGN',
      },
    ],
  })}</script>`;
  expect(parseSocialProfile(html, target, 'GB')).toMatchObject({
    name: 'Demo profile',
    lastPostAt: '2019-07-12T00:00:00.000Z',
    posts: [
      {
        date: '2019-07-12T00:00:00.000Z',
        url: 'https://www.facebook.com/photo/?fbid=SYNTHETIC&set=synthetic',
      },
    ],
  });
});

it('resolves an external accessible date for a scoped own photo without an article wrapper', () => {
  const html = page(
    post(own, 'OWN', 'date-own') + post(foreign, 'OTHER', 'date-other'),
    '<span id="date-own">12 July 2019</span><span id="date-other">1 January 2027</span>',
  );
  expect(parseSocialProfile(html, target, 'GB')).toMatchObject({
    lastPostAt: '2019-07-12T00:00:00.000Z',
    posts: [
      {
        date: '2019-07-12T00:00:00.000Z',
        url: 'https://www.facebook.com/photo/?fbid=OWN&set=synthetic',
      },
    ],
  });
});

it('retains unknown own post dates without borrowing another post or Messenger date', () => {
  const html = page(
    post(own, 'UNKNOWN', 'unresolved') +
      post(own, 'DATED', 'date-own') +
      `
    <div role="dialog">${post(own, 'MESSAGE', 'date-message')}</div>`,
    '<span id="date-own">12 July 2019</span><span id="date-message">1 January 2027</span>',
  );
  const profile = parseSocialProfile(html, target, 'GB');
  expect(profile.posts).toHaveLength(2);
  expect(profile.posts).toContainEqual({
    date: null,
    url: 'https://www.facebook.com/photo/?fbid=UNKNOWN&set=synthetic',
  });
  expect(profile.lastPostAt).toBeNull();
});

it.each(['Yesterday', '12 July', '31 February 2019', '07/12/2019'])(
  'does not guess the ambiguous or invalid date %s',
  (date) => {
    const profile = parseSocialProfile(
      page(
        post(own, 'UNKNOWN', 'date-own'),
        `<span id="date-own">${date}</span>`,
      ),
      target,
      'GB',
    );
    expect(profile.posts).toEqual([
      {
        date: null,
        url: 'https://www.facebook.com/photo/?fbid=UNKNOWN&set=synthetic',
      },
    ]);
    expect(profile.lastPostAt).toBeNull();
  },
);

it('does not infer a boundary across sibling author and photo containers', () => {
  const html = page(
    `<div><div role="heading" aria-level="2"><a href="${own}">Demo</a></div></div>
    <div><a href="/photo/?fbid=UNSCOPED">Photo</a><a aria-label="12 July 2019" href="/permalink.php?story_fbid=UNSCOPED&amp;id=${target.handle}">date</a></div>
    ${post(foreign, 'FOREIGN', 'date-other')}`,
    '<span id="date-other">1 January 2027</span>',
  );
  expect(parseSocialProfile(html, target, 'GB').posts).toEqual([]);
});

it('preserves author-bound machine timestamps and excludes generic post contact text', () => {
  const html = page(
    `<article><a rel="author" href="${own}">Demo</a><a href="/202020202020202/posts/MACHINE"><time datetime="2019-07-12">date</time></a></article>` +
      post(own, 'PHOTO', 'date-own').replace(
        'Photo</a>',
        'photo@wrong.invalid +44 20 7946 0999</a>',
      ),
    '<span id="date-own">12 July 2019</span>',
  );
  expect(parseSocialProfile(html, target, 'GB')).toMatchObject({
    lastPostAt: '2019-07-12T00:00:00.000Z',
    phones: [],
    emails: [],
  });
});

it('does not choose between duplicate referenced date labels', () => {
  const profile = parseSocialProfile(
    page(
      post(own, 'AMBIGUOUS', 'date-own'),
      '<span id="date-own">12 July 2019</span><span id="date-own">1 January 2027</span>',
    ),
    target,
    'GB',
  );
  expect(profile.posts).toEqual([
    {
      date: null,
      url: 'https://www.facebook.com/photo/?fbid=AMBIGUOUS&set=synthetic',
    },
  ]);
});

it('uses a resolved own permalink once when the same post also has a photo link', () => {
  const profile = parseSocialProfile(
    page(
      post(own, 'PHOTO', 'date-own').replace(
        '/profile.php#?tracking',
        `/permalink.php?story_fbid=SYNTHETIC&amp;id=${target.handle}`,
      ),
      '<span id="date-own">12 July 2019</span>',
    ),
    target,
    'GB',
  );
  expect(profile.posts).toEqual([
    {
      date: '2019-07-12T00:00:00.000Z',
      url: `https://www.facebook.com/permalink.php?story_fbid=SYNTHETIC&id=${target.handle}`,
    },
  ]);
});

it.each([false, true])(
  'does not borrow a sibling post heading when its own author boundary is missing (reverse=%s)',
  (reverse) => {
    const siblings = [
      post(own, 'OWN', 'date-own'),
      '<div><a href="/photo/?fbid=UNBOUND">Photo</a></div>',
    ];
    if (reverse) siblings.reverse();
    const profile = parseSocialProfile(
      page(
        `<section>${siblings.join('')}</section>`,
        '<span id="date-own">12 July 2019</span>',
      ),
      target,
      'GB',
    );
    expect(profile.posts).toHaveLength(1);
    expect(profile.posts[0]?.url).toContain('fbid=OWN');
  },
);

const commentUrls = [
  `/permalink.php?story_fbid=OWN&id=${target.handle}&comment_id=COMMENT`,
  `/${target.handle}/posts/OWN?reply_comment_id=REPLY`,
  `/${target.handle}/posts/OWN/comments/COMMENT`,
  `/${target.handle}/posts/OWN/replies/REPLY`,
];
it.each(commentUrls)('never borrows a comment/reply date from %s', (href) => {
  for (const dateLink of [
    '<a href="COMMENT_URL" aria-label="1 January 2027">Comment</a>',
    '<a href="COMMENT_URL"><span aria-labelledby="comment-date">obfuscated</span></a>',
    '<a href="COMMENT_URL"><time datetime="2027-01-01">Comment</time></a>',
  ]) {
    const content = post(own, 'OWN', 'missing').replace(
      /<\/div>\s*$/,
      `${dateLink.replace('COMMENT_URL', href)}</div>`,
    );
    const profile = parseSocialProfile(
      page(content, '<span id="comment-date">1 January 2027</span>'),
      target,
      'GB',
    );
    expect(profile.posts).toEqual([
      {
        date: null,
        url: 'https://www.facebook.com/photo/?fbid=OWN&set=synthetic',
      },
    ]);
    expect(profile.lastPostAt).toBeNull();
  }
});

it.each(commentUrls)(
  'rejects comment/reply identity in embedded own-author posts: %s',
  (url) => {
    const html = `<script type="application/json">${JSON.stringify({
      profile: { __typename: 'User', id: target.handle },
      story: {
        actors: [{ id: target.handle }],
        url,
        creation_time: 1798761600,
      },
    })}</script>`;
    const profile = parseSocialProfile(html, target, 'GB');
    expect(profile.posts).toEqual([]);
    expect(profile.lastPostAt).toBeNull();
  },
);

it.each([`/${target.handle}/videos/VIDEO`, '/reel/REEL'])(
  'preserves an own machine-dated video/reel at %s and rejects foreign/missing authors',
  (href) => {
    const article = (author: string) =>
      `<article>${author}<a href="${href}"><time datetime="2019-07-12">date</time></a></article>`;
    const profile = parseSocialProfile(
      page(article(`<a rel="author" href="${own}">Demo</a>`)),
      target,
      'GB',
    );
    expect(profile.posts).toEqual([
      {
        date: '2019-07-12T00:00:00.000Z',
        url: `https://www.facebook.com${href}`,
      },
    ]);
    expect(profile.lastPostAt).toBe('2019-07-12T00:00:00.000Z');
    for (const author of ['', `<a rel="author" href="${foreign}">Other</a>`]) {
      expect(
        parseSocialProfile(page(article(author)), target, 'GB').posts,
      ).toEqual([]);
    }
  },
);

it('does not use a foreign video URL inside an otherwise own-author article', () => {
  const html = page(
    `<article><a rel="author" href="${own}">Demo</a><a href="/303030303030303/videos/VIDEO"><time datetime="2027-01-01">date</time></a></article>`,
  );
  expect(parseSocialProfile(html, target, 'GB').posts).toEqual([]);
});

it.each(['Comment', 'Reply'])(
  'does not promote an embedded %s with a parent post URL',
  (__typename) => {
    const html = `<script type="application/json">${JSON.stringify({
      profile: { __typename: 'User', id: target.handle },
      response: {
        __typename,
        actors: [{ id: target.handle }],
        url: `/${target.handle}/posts/OWN`,
        creation_time: 1798761600,
      },
    })}</script>`;
    expect(parseSocialProfile(html, target, 'GB').posts).toEqual([]);
  },
);

it.each(['Comment', 'Reply'])(
  'rejects a nested %s date even when metadata inherits its parent post URL',
  (__typename) => {
    const html = `<script type="application/json">${JSON.stringify({
      profile: { __typename: 'User', id: target.handle },
      story: {
        actors: [{ id: target.handle }],
        url: `/${target.handle}/posts/OWN`,
        comet_sections: {
          context_layout: {
            story: {
              comet_sections: {
                metadata: [
                  { story: { __typename, creation_time: 1798761600 } },
                ],
              },
            },
          },
        },
      },
    })}</script>`;
    const profile = parseSocialProfile(html, target, 'GB');
    expect(profile.posts).toEqual([
      {
        date: null,
        url: `https://www.facebook.com/${target.handle}/posts/OWN`,
      },
    ]);
    expect(profile.lastPostAt).toBeNull();
  },
);

const nestedDateLinks = [
  `<a href="/${target.handle}/posts/OWN" aria-label="1 January 2027">date</a>`,
  `<a href="/${target.handle}/posts/OWN"><span aria-labelledby="nested-date">obfuscated</span></a>`,
  `<a href="/${target.handle}/posts/OWN"><time datetime="2027-01-01">date</time></a>`,
];
const nestedContexts = [
  (date: string) => `<ul><li><a href="${foreign}">Other</a>${date}</li></ul>`,
  (date: string) =>
    `<div role="listitem"><a href="${own}">Own comment</a>${date}</div>`,
  (date: string) =>
    `<div data-recommendations><a href="${foreign}">Other</a>${date.replaceAll(`/${target.handle}/posts/OWN`, '/permalink.php?story_fbid=FOREIGN')}</div>`,
  (date: string) =>
    `<div><a href="${foreign}">Other</a>${date.replaceAll(`/${target.handle}/posts/OWN`, '/permalink.php?story_fbid=FOREIGN')}</div>`,
];
it.each(nestedContexts)(
  'binds dates to the own publication header, excluding a nested discussion/card (%#)',
  (wrap) => {
    for (const date of nestedDateLinks) {
      for (const beforeMedia of [false, true]) {
        const extra = wrap(date);
        const body = beforeMedia
          ? post(own, 'OWN', 'missing').replace(
              '<a href="/photo/',
              `${extra}<a href="/photo/`,
            )
          : post(own, 'OWN', 'missing').replace(
              /<\/div>\s*$/,
              `${extra}</div>`,
            );
        const profile = parseSocialProfile(
          page(body, '<span id="nested-date">1 January 2027</span>'),
          target,
          'GB',
        );
        expect(profile.posts).toEqual([
          {
            date: null,
            url: 'https://www.facebook.com/photo/?fbid=OWN&set=synthetic',
          },
        ]);
        expect(profile.lastPostAt).toBeNull();
      }
    }
  },
);

it('does not treat an unmarked body date as publication metadata', () => {
  const body = post(own, 'OWN', 'missing').replace(
    /<\/div>\s*$/,
    `<div>${nestedDateLinks[0]}</div></div>`,
  );
  expect(parseSocialProfile(page(body), target, 'GB').lastPostAt).toBeNull();
});

it('preserves an external own-header date in a transparent wrapper and outer feed list item', () => {
  const body = `<ul><li><article><div><div role="heading" aria-level="2"><a href="${own}">Demo</a></div>
    <div><span><a href="/profile.php"><span aria-labelledby="own-date">obfuscated</span></a></span></div></div>
    <a href="/photo/?fbid=OWN">Photo</a>${nestedContexts[0]!(nestedDateLinks[0]!)}</article></li></ul>`;
  const profile = parseSocialProfile(
    page(body, '<span id="own-date">12 July 2019</span>'),
    target,
    'GB',
  );
  expect(profile.posts).toEqual([
    {
      date: '2019-07-12T00:00:00.000Z',
      url: 'https://www.facebook.com/photo/?fbid=OWN',
    },
  ]);
  expect(profile.lastPostAt).toBe('2019-07-12T00:00:00.000Z');
});

it('does not let a body permalink with machine time replace the primary photo source', () => {
  const body = post(own, 'OWN', 'missing').replace(
    '<a href="/photo/',
    `<div>${nestedDateLinks[2]}</div><a href="/photo/`,
  );
  const profile = parseSocialProfile(page(body), target, 'GB');
  expect(profile.posts).toEqual([
    {
      date: null,
      url: 'https://www.facebook.com/photo/?fbid=OWN&set=synthetic',
    },
  ]);
  expect(profile.lastPostAt).toBeNull();
});

it.each(['missing', 'own-date'])(
  'reads only the author-adjacent metadata inside a shared header wrapper (%s)',
  (label) => {
    const body = `<div><header><h2><a href="${own}">Demo</a></h2>
    <a href="/profile.php"><span aria-labelledby="${label}">obfuscated</span></a>
    <div><a href="/permalink.php?story_fbid=FOREIGN" aria-label="1 January 2027">date</a></div></header>
    <a href="/photo/?fbid=OWN">Photo</a></div>`;
    const profile = parseSocialProfile(
      page(body, '<span id="own-date">12 July 2019</span>'),
      target,
      'GB',
    );
    expect(profile.posts).toEqual([
      {
        date: label === 'missing' ? null : '2019-07-12T00:00:00.000Z',
        url: 'https://www.facebook.com/photo/?fbid=OWN',
      },
    ]);
  },
);

const boundaryMedia = [
  '/photo/?fbid=PRIMARY',
  `/${target.handle}/videos/VIDEO`,
  '/reel/REEL',
];
const dateCarriers = [
  'aria-label',
  'title',
  'aria-labelledby',
  'time',
] as const;
const datedLink = (
  href: string,
  carrier: (typeof dateCarriers)[number],
  id: string,
  date: string,
) => {
  const attribute =
    carrier === 'time'
      ? ''
      : `${carrier}="${carrier === 'aria-labelledby' ? id : date}"`;
  const content =
    carrier === 'time'
      ? `<time datetime="${date === '12 July 2019' ? '2019-07-12' : '2027-01-01'}">date</time>`
      : 'date';
  return `<a href="${href}" ${attribute}>${content}</a>`;
};
const boundaryLabels =
  '<span id="primary-date">12 July 2019</span><span id="nested-date">1 January 2027</span>';
const authorHeading = (href: string, semantic: boolean) =>
  semantic
    ? `<div role="heading" aria-level="2"><a href="${href}">Demo</a></div>`
    : `<h2><a href="${href}">Demo</a></h2>`;
const discussionFrames = [
  ['li', '<ul><li>', '</li></ul>'],
  ['listitem', '<div role="listitem">', '</div>'],
  ['recommendation', '<div data-recommendations>', '</div>'],
  ['article', '<article>', '</article>'],
  ['role-article', '<div role="article">', '</div>'],
] as const;
const nestedParentCases = discussionFrames
  .slice(0, 2)
  .flatMap(([frame, open, close]) =>
    [false, true].flatMap((semantic) =>
      ['aria-label', 'aria-labelledby', 'time'].flatMap((carrier) =>
        [false, true].flatMap((wrapped) =>
          [own, foreign].map((author) => ({
            frame,
            open,
            close,
            semantic,
            carrier: carrier as (typeof dateCarriers)[number],
            wrapped,
            author,
          })),
        ),
      ),
    ),
  );
it.each(nestedParentCases)(
  'never promotes a headed comment scope: $frame/$semantic/$carrier/wrapped=$wrapped/author=$author',
  ({ open, close, semantic, carrier, wrapped, author }) => {
    const comment =
      authorHeading(author, semantic) +
      datedLink(
        `/${target.handle}/posts/OWN`,
        carrier,
        'nested-date',
        '1 January 2027',
      );
    const body = post(own, 'OWN', 'missing').replace(
      /<\/div>\s*$/,
      `${open}${wrapped ? `<div>${comment}</div>` : comment}${close}</div>`,
    );
    const profile = parseSocialProfile(
      page(body, boundaryLabels),
      target,
      'GB',
    );
    expect(profile.posts).toEqual([
      {
        date: null,
        url: 'https://www.facebook.com/photo/?fbid=OWN&set=synthetic',
      },
    ]);
    expect(profile.lastPostAt).toBeNull();
  },
);

const primaryCases = boundaryMedia.flatMap((href) =>
  dateCarriers.flatMap((carrier) =>
    [
      'article',
      'role-article',
      'heading',
      'semantic-heading',
      'feed-li',
      'feed-listitem',
    ].map((layout) => ({ href, carrier, layout })),
  ),
);
it.each(primaryCases)(
  'binds the primary media date: $layout/$href/$carrier',
  ({ href, carrier, layout }) => {
    const author =
      layout.includes('heading') || layout === 'feed-listitem'
        ? authorHeading(own, layout === 'semantic-heading')
        : `<a rel="author" href="${own}">Demo</a>`;
    const body =
      author + datedLink(href, carrier, 'primary-date', '12 July 2019');
    const publication =
      layout === 'role-article'
        ? `<div role="article">${body}</div>`
        : layout.includes('heading') || layout === 'feed-listitem'
          ? `<div>${body}</div>`
          : `<article>${body}</article>`;
    const framed =
      layout === 'feed-li'
        ? `<ul><li>${publication}</li></ul>`
        : layout === 'feed-listitem'
          ? `<div role="listitem">${publication}</div>`
          : publication;
    const profile = parseSocialProfile(
      page(framed, boundaryLabels),
      target,
      'GB',
    );
    expect(profile.posts).toEqual([
      {
        date: '2019-07-12T00:00:00.000Z',
        url: `https://www.facebook.com${href}`,
      },
    ]);
    expect(profile.lastPostAt).toBe('2019-07-12T00:00:00.000Z');
  },
);

const destructiveMediaCases = boundaryMedia.flatMap((href) =>
  dateCarriers.flatMap((carrier) =>
    discussionFrames.flatMap(([frame, open, close]) =>
      [own, foreign].map((author) => ({
        href,
        carrier,
        frame,
        open,
        close,
        author,
      })),
    ),
  ),
);
it.each(destructiveMediaCases)(
  'keeps nested media separate from its owner card: $frame/$href/$carrier/author=$author',
  ({ href, carrier, open, close, author }) => {
    const nested = `${open}<div>${authorHeading(author, false)}${datedLink(href, carrier, 'nested-date', '1 January 2027')}</div>${close}`;
    const body = post(own, 'OWN', 'missing').replace(
      /<\/div>\s*$/,
      `${nested}</div>`,
    );
    const profile = parseSocialProfile(
      page(body, boundaryLabels),
      target,
      'GB',
    );
    expect(profile.posts).toEqual([
      {
        date: null,
        url: 'https://www.facebook.com/photo/?fbid=OWN&set=synthetic',
      },
    ]);
    expect(profile.lastPostAt).toBeNull();
  },
);

it.each(
  boundaryMedia.flatMap((href) =>
    dateCarriers.map((carrier) => ({ href, carrier })),
  ),
)('requires an unambiguous own author: $href/$carrier', ({ href, carrier }) => {
  for (const author of [
    '',
    `<a rel="author" href="${foreign}">Other</a>`,
    `<a rel="author" href="${own}">Demo</a><a rel="author" href="${foreign}">Other</a>`,
  ]) {
    const profile = parseSocialProfile(
      page(
        `<article>${author}${datedLink(href, carrier, 'primary-date', '12 July 2019')}</article>`,
        boundaryLabels,
      ),
      target,
      'GB',
    );
    expect(profile.posts).toEqual([]);
    expect(profile.lastPostAt).toBeNull();
  }
});

it.each(boundaryMedia)(
  'does not interpret the primary media caption as a timestamp: %s',
  (href) => {
    const body = `<article><a rel="author" href="${own}">Demo</a><a href="${href}">12 July 2019</a></article>`;
    expect(parseSocialProfile(page(body), target, 'GB').lastPostAt).toBeNull();
  },
);
