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
