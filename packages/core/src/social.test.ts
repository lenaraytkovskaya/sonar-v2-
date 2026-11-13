import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  detectSocialBlock,
  parseSocialProfile,
  socialTarget,
} from './social.js';
const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/social/${name}.html`, import.meta.url),
    'utf8',
  );
const facebook = socialTarget('https://www.facebook.com/demo.tools')!;
const instagram = socialTarget('https://instagram.com/demo.studio')!;
const linkedin = socialTarget('https://linkedin.com/company/demo-systems')!;

describe('socialTarget', () => {
  it.each([
    'facebook.com',
    'www.facebook.com',
    'm.facebook.com',
    'mbasic.facebook.com',
    'fb.com',
    'www.fb.com',
    'fb.me',
  ])('normalizes Facebook alias %s and strips tails', (host) => {
    expect(
      socialTarget(`https://${host}/Demo.Tools/about?locale=uk_UA#intro`),
    ).toEqual(facebook);
  });
  it.each([
    'profile.php?id=101010101010101&ref=bookmarks',
    'pages/Demo-Tools/101010101010101/about',
    'p/Demo-Tools-101010101010101/reviews',
  ])('normalizes legacy Facebook ID %s', (path) => {
    expect(socialTarget(`https://m.facebook.com/${path}`)).toMatchObject({
      network: 'facebook',
      kind: 'page',
      handle: '101010101010101',
      canonicalUrl: 'https://www.facebook.com/profile.php?id=101010101010101',
    });
  });
  it.each([
    'instagram.com',
    'www.instagram.com',
    'm.instagram.com',
    'instagr.am',
  ])('normalizes Instagram alias %s', (host) =>
    expect(socialTarget(`https://${host}/Demo.Studio/?igsh=tracking`)).toEqual(
      instagram,
    ),
  );
  it.each([
    'linkedin.com',
    'www.linkedin.com',
    'm.linkedin.com',
    'uk.linkedin.com',
    'pl.linkedin.com',
    'de.linkedin.com',
  ])('normalizes LinkedIn host %s', (host) =>
    expect(
      socialTarget(`https://${host}/company/demo-systems/posts/?trk=foo`),
    ).toEqual(linkedin),
  );
  it.each(['company', 'showcase', 'school'])(
    'supports LinkedIn %s and numeric IDs',
    (kind) => {
      expect(
        socialTarget(`https://uk.linkedin.com/${kind}/12345/about/`),
      ).toMatchObject({
        network: 'linkedin',
        kind,
        handle: kind === 'company' ? '12345' : `${kind}:12345`,
        canonicalUrl: `https://www.linkedin.com/${kind}/12345/`,
      });
    },
  );
  it.each([
    'https://facebook.com/groups/demo',
    'https://facebook.com/people/Demo/123',
    'https://instagram.com/p/abc',
    'https://instagram.com/reel/abc',
    'https://linkedin.com/in/someone',
  ])('recognizes excluded social URL %s', (url) =>
    expect(socialTarget(url)?.kind).toBe('unsupported'),
  );
  it.each([
    'not a url',
    'javascript:alert(1)',
    'https://facebook.com.evil.invalid/demo',
    'https://evilfacebook.com/demo',
    'https://facebook.com/',
    'https://instagram.com/',
    'https://instagram.com/%ZZ',
    'https://user:password@facebook.com/demo',
    'https://facebook.com/profile.php',
    'https://facebook.com/profile.php?id=abc',
    'https://example.com/demo',
  ])('rejects invalid/non-social URL %s', (url) =>
    expect(socialTarget(url)).toBeNull(),
  );
});

describe('parseSocialProfile', () => {
  it('extracts scoped Facebook header, intro tiles, contacts and own posts', () => {
    const profile = parseSocialProfile(fixture('facebook'), facebook, 'GB');
    expect(profile).toMatchObject({
      name: 'Demo Tools',
      description:
        'Independent equipment service. Write to office@demo.invalid',
      category: 'Industrial services',
      website: 'https://demo.invalid/',
      phones: ['+442079460123'],
      emails: ['office@demo.invalid'],
      followers: 1480,
      followingCount: 0,
      lastPostAt: '2026-03-01T00:00:00.000Z',
    });
    expect(profile.posts).toHaveLength(2);
    expect(profile.postsCount).toBeNull();
  });
  it('extracts nested Instagram JSON without importing recommended users', () => {
    const profile = parseSocialProfile(fixture('instagram'), instagram, 'PL');
    expect(profile).toMatchObject({
      name: 'Demo Studio',
      category: 'Design studio',
      website: 'https://studio.demo.invalid/',
      followers: 2345,
      followingCount: 12,
      postsCount: 42,
      phones: ['+48221234567'],
      emails: ['studio@demo.invalid'],
      lastPostAt: '2026-04-01T00:00:00.000Z',
    });
    expect(profile.posts).toHaveLength(2);
    expect(profile.industry).toBeNull();
  });
  it('extracts LinkedIn organization JSON-LD, overview and author-scoped post dates', () => {
    expect(
      parseSocialProfile(fixture('linkedin'), linkedin, 'PL'),
    ).toMatchObject({
      name: 'Demo Systems',
      website: 'https://demo.invalid/',
      industry: 'Software Development',
      companySize: '51-200',
      headquarters: 'Warsaw, PL',
      foundedYear: 2012,
      phones: ['+48221234567'],
      lastPostAt: '2026-05-01T08:30:00.000Z',
      posts: [
        {
          date: '2026-05-01T08:30:00.000Z',
          url: 'https://www.linkedin.com/feed/update/urn:li:activity:123456789/',
        },
      ],
    });
  });
  it('uses matching metadata and machine DOM dates, never relative dates', () => {
    expect(
      parseSocialProfile(fixture('instagram-meta'), instagram, 'PL'),
    ).toMatchObject({
      name: 'Demo Studio',
      followers: 12500,
      followingCount: 20,
      postsCount: 31,
      lastPostAt: '2026-06-01T00:00:00.000Z',
      posts: [
        {
          date: '2026-06-01T00:00:00.000Z',
          url: 'https://www.instagram.com/p/CALENDAR/',
        },
      ],
    });
  });
  it('keeps unknown scalars null and empty contacts without inventing a profile', () => {
    const profile = parseSocialProfile(
      '<main><h1>Log in</h1></main>',
      instagram,
      'UA',
    );
    expect(
      Object.entries(profile)
        .filter(([key]) => !['phones', 'emails', 'posts'].includes(key))
        .every(([, value]) => value === null),
    ).toBe(true);
    expect(profile.phones).toEqual([]);
    expect(profile.posts).toEqual([]);
  });
  it('does not use another identity or unrelated embedded dates', () => {
    const html = fixture('instagram').replaceAll('demo.studio', 'other.studio');
    expect(parseSocialProfile(html, instagram, 'PL').name).toBeNull();
    expect(parseSocialProfile(html, instagram, 'PL').posts).toEqual([]);
  });
  it('bounds own post sample to 12 and picks its maximum despite pinned order', () => {
    const node = {
      username: 'demo.studio',
      polaris_ordered_timeline_connection: {
        edges: Array.from({ length: 15 }, (_, i) => ({
          node: { code: `CODE${i}`, taken_at: 1767225600 + i * 86400 },
        })),
      },
    };
    const profile = parseSocialProfile(
      `<script type="application/json">${JSON.stringify(node)}</script>`,
      instagram,
      'PL',
    );
    expect(profile.posts).toHaveLength(12);
    expect(profile.lastPostAt).toBe('2026-01-15T00:00:00.000Z');
  });
  it('ignores malformed JSON, unsafe websites, unknown counts and impossible machine dates', () => {
    const node = {
      username: 'demo.studio',
      external_url: 'javascript:alert(1)',
      follower_count: -2,
      following_count: 'unknown',
      media_count: Number.MAX_SAFE_INTEGER + 1,
    };
    const html = `<script type="application/json">{broken</script><script type="application/json">${JSON.stringify(node)}</script><main><article><a href="/p/INVALID/"><time datetime="2026-99-99">Date</time></a></article><article><a href="/p/OVERFLOW/"><time datetime="2026-02-31">Date</time></a></article></main>`;
    expect(parseSocialProfile(html, instagram, 'PL')).toMatchObject({
      website: null,
      followers: null,
      followingCount: null,
      postsCount: null,
      lastPostAt: null,
    });
  });
  it('normalizes local phones with the campaign country', () => {
    expect(
      parseSocialProfile(
        '<script type="application/json">{"username":"demo.studio","public_phone_number":"020 7946 0123"}</script>',
        instagram,
        'GB',
      ).phones,
    ).toEqual(['+442079460123']);
  });
  it('reads logged-in Facebook nested story timestamps and excludes foreign actors and comments', () => {
    expect(
      parseSocialProfile(fixture('facebook-session'), facebook, 'GB'),
    ).toMatchObject({
      category: 'Промислові послуги',
      followers: 1500,
      rating: '4.8',
      reviewsCount: 37,
      emails: [],
      phones: [],
      lastPostAt: '2026-03-01T00:00:00.000Z',
      posts: [
        {
          date: '2026-03-01T00:00:00.000Z',
          url: 'https://www.facebook.com/demo.tools/posts/LATEST',
        },
        {
          date: '2026-01-01T00:00:00.000Z',
          url: 'https://www.facebook.com/demo.tools/posts/PINNED',
        },
      ],
    });
  });
  it.each([
    ['1,5K', 1500],
    ['1.5K', 1500],
    ['1,5 тис.', 1500],
    ['2,4 тыс.', 2400],
    ['1,2 млн', 1200000],
    ['1 234', 1234],
    ['1.234', 1234],
    ['1,234', 1234],
  ])('parses localized follower count %s', (value, expected) => {
    const node = {
      __typename: 'Page',
      url: facebook.canonicalUrl,
      followers_count: value,
    };
    expect(
      parseSocialProfile(
        `<script type="application/json">${JSON.stringify(node)}</script>`,
        facebook,
        'UA',
      ).followers,
    ).toBe(expected);
  });
  it('merges Facebook contact About data without copying account controls', () => {
    const profile = parseSocialProfile(
      fixture('facebook-session'),
      facebook,
      'GB',
      [
        {
          url: `${facebook.canonicalUrl}about_contact_and_basic_info`,
          html: `<main><h1>Demo Tools</h1><a href="mailto:office@demo.invalid">Email</a><a href="tel:+442079460123">Call</a><nav><a href="mailto:account@wrong.invalid">Account</a></nav></main>`,
        },
      ],
    );
    expect(profile).toMatchObject({
      emails: ['office@demo.invalid'],
      phones: ['+442079460123'],
    });
  });
  it('reads Facebook visible intro lines without embedded profile JSON or custom attributes', () => {
    const html = `<meta property="og:url" content="${facebook.canonicalUrl}"><div role="main"><div><h1>Demo Tools</h1><span>5.4K followers • 1 following</span></div><section><h2>Intro</h2><p>Independent equipment service</p><div><span>Page · Car dealership</span></div><div><span>office@demo.invalid</span></div><div><span>+44 20 7946 0123</span></div><div><a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fdemo.invalid%2F">demo.invalid</a></div><span>94% recommend (10 reviews)</span></section><nav>account@wrong.invalid</nav><article><p>Post author writes post@wrong.invalid +44 20 7946 0999</p></article></div>`;
    expect(parseSocialProfile(html, facebook, 'GB')).toMatchObject({
      name: 'Demo Tools',
      category: 'Car dealership',
      description: 'Independent equipment service',
      followers: 5400,
      followingCount: 1,
      website: 'https://demo.invalid/',
      emails: ['office@demo.invalid'],
      phones: ['+442079460123'],
      rating: '94% recommend',
      reviewsCount: 10,
    });
  });
  it('reads Instagram real header sections and links without embedded profile JSON or custom attributes', () => {
    const html = `<meta property="og:url" content="${instagram.canonicalUrl}"><main><header><section><h2>demo.studio</h2><button>Follow</button><button>Message</button></section><section><ul><li><span>42</span> posts</li><li><span>2,5K</span> followers</li><li><span>12</span> following</li></ul></section><section><div><span>Demo Studio</span></div><div><span>Design studio</span></div><div><span>Branding and identity.</span><br><span>studio@demo.invalid +48 22 123 45 67</span></div><a href="https://www.instagram.com/explore/locations/123/example/">Example 12, Warsaw</a><a href="https://l.instagram.com/?u=https%3A%2F%2Fstudio.demo.invalid%2F">studio.demo.invalid</a></section></header><nav>account@wrong.invalid</nav><article><p>post@wrong.invalid</p></article></main>`;
    expect(parseSocialProfile(html, instagram, 'PL')).toMatchObject({
      name: 'Demo Studio',
      category: 'Design studio',
      description:
        'Branding and identity. studio@demo.invalid +48 22 123 45 67',
      address: 'Example 12, Warsaw',
      website: 'https://studio.demo.invalid/',
      followers: 2500,
      followingCount: 12,
      postsCount: 42,
      emails: ['studio@demo.invalid'],
      phones: ['+48221234567'],
    });
  });
  it('uses Instagram profile data and opened permalink times, excluding comments and unrelated documents', () => {
    const profile = parseSocialProfile(
      fixture('instagram-session'),
      instagram,
      'PL',
      [
        {
          url: 'https://www.instagram.com/p/LATEST/',
          html: fixture('instagram-post'),
        },
        {
          url: 'https://www.instagram.com/p/PINNED/',
          html: fixture('instagram-post')
            .replaceAll('LATEST', 'PINNED')
            .replace('2026-06-01T10:00:00Z', '2026-01-01T10:00:00Z'),
        },
        {
          url: 'https://www.instagram.com/p/FOREIGN/',
          html: fixture('instagram-post')
            .replaceAll('LATEST', 'FOREIGN')
            .replaceAll('demo.studio', 'other.studio'),
        },
        {
          url: 'https://www.instagram.com/p/UNRELATED/',
          html: '<main><article><time datetime="2026-11-12">Today</time></article></main>',
        },
        {
          url: 'https://evil.invalid/p/LATEST/',
          html: fixture('instagram-post'),
        },
      ],
    );
    expect(profile).toMatchObject({
      category: 'Дизайн-студія',
      description: 'Design and branding',
      address: 'Example 12, Warsaw, 00-001',
      website: 'https://studio.demo.invalid/',
      followers: 2500,
      followingCount: 12,
      postsCount: 42,
      emails: ['studio@demo.invalid'],
      lastPostAt: '2026-06-01T10:00:00.000Z',
    });
    expect(profile.posts).toHaveLength(2);
  });
  it.each([
    ['<ul><li>', '</li></ul>'],
    ['<div role="list"><div role="listitem">', '</div></div>'],
    ['<ul><li><ul><li>', '</li></ul></li></ul>'],
  ])(
    'excludes Instagram comment and reply times linked to the same post inside %s',
    (open, close) => {
      const url = 'https://www.instagram.com/p/OWN/';
      const comment = `${open}<a href="/commenter/">Commenter</a><a href="/p/OWN/"><time datetime="2026-11-13T10:00:00Z">Comment time</time></a>${close}`;
      const publication =
        '<a href="/p/OWN/"><time datetime="2026-01-01T10:00:00Z">Post time</time></a>';
      const article = `<article><header><a href="/demo.studio/">demo.studio</a></header>${comment}${publication}</article>`;
      // A list item wrapping the whole post is valid; only list items inside it are comments.
      const profile = parseSocialProfile(
        `<meta property="og:url" content="${instagram.canonicalUrl}"><main><a href="/p/OWN/">Post</a></main>`,
        instagram,
        'PL',
        [
          {
            url,
            html: `<meta property="og:url" content="${url}"><main><ul><li>${article}</li></ul></main>`,
          },
        ],
      );
      expect(profile.lastPostAt).toBe('2026-01-01T10:00:00.000Z');
      expect(profile.posts).toEqual([
        { date: '2026-01-01T10:00:00.000Z', url },
      ]);
      expect(
        parseSocialProfile(fixture('instagram-session'), instagram, 'PL', [
          { url, html: `<main>${article.replace(publication, '')}</main>` },
        ]).lastPostAt,
      ).toBeNull();
    },
  );
  it('rejects conflicting Instagram JSON owners even if the opened post displays the target author', () => {
    const html = `${fixture('instagram-post')}<script type="application/json">{"code":"LATEST","taken_at":1798761600,"user":{"username":"foreign"}}</script>`;
    expect(
      parseSocialProfile(fixture('instagram-session'), instagram, 'PL', [
        { url: 'https://www.instagram.com/p/LATEST/', html },
      ]).posts,
    ).toEqual([]);
  });
  it('merges LinkedIn About and owned machine-dated posts, rejecting foreign company and relative dates', () => {
    const profile = parseSocialProfile(
      '<meta property="og:url" content="https://www.linkedin.com/company/demo-systems/">',
      linkedin,
      'PL',
      [
        {
          url: `${linkedin.canonicalUrl}about/`,
          html: fixture('linkedin-session'),
        },
        {
          url: 'https://www.linkedin.com/company/other/about/',
          html: fixture('linkedin-session').replaceAll('Demo Systems', 'Wrong'),
        },
        {
          url: `${linkedin.canonicalUrl}posts/`,
          html: '<meta property="og:url" content="https://www.linkedin.com/company/other/"><main><h1>Wrong</h1></main>',
        },
      ],
    );
    expect(profile).toMatchObject({
      name: 'Demo Systems',
      industry: 'Software Development',
      companySize: '51-200 employees',
      headquarters: 'Warsaw, PL',
      website: 'https://demo.invalid/',
      foundedYear: 2012,
      followers: 3200,
      emails: [],
      lastPostAt: '2026-06-01T10:00:00.000Z',
    });
    expect(profile.posts).toHaveLength(1);
  });
});

describe('detectSocialBlock', () => {
  it('reads LinkedIn machine timestamps only for the company author', () => {
    const html = `<script type="application/json">${JSON.stringify([
      {
        author: { url: linkedin.canonicalUrl },
        createdAt: 1780308000000,
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      },
      {
        author: { url: 'https://www.linkedin.com/company/foreign/' },
        createdAt: 1794477600000,
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:999/',
      },
      {
        author: { url: linkedin.canonicalUrl },
        publishedAt: '2w',
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:456/',
      },
    ])}</script>`;
    const profile = parseSocialProfile(html, linkedin, 'UA');
    expect(profile.lastPostAt).toBe('2026-06-01T10:00:00.000Z');
    expect(profile.posts).toHaveLength(1);
  });
  it('detects 403/429 without requiring an HTML message', () => {
    expect(detectSocialBlock('', instagram.canonicalUrl, 403)).toBe(
      'forbidden',
    );
    expect(detectSocialBlock('', instagram.canonicalUrl, 429)).toBe(
      'rate_limit',
    );
  });
  it('detects CAPTCHA and login HTML and login redirects', () => {
    expect(
      detectSocialBlock(
        '<main>Підтвердіть, що це ви</main>',
        facebook.canonicalUrl,
        200,
      ),
    ).toBe('captcha');
    expect(
      detectSocialBlock(fixture('captcha'), instagram.canonicalUrl, 200),
    ).toBe('captcha');
    expect(
      detectSocialBlock(fixture('login-wall'), instagram.canonicalUrl, 200),
    ).toBe('login_wall');
    expect(
      detectSocialBlock('', 'https://www.linkedin.com/authwall?trk=x', 200),
    ).toBe('login_wall');
    expect(
      detectSocialBlock('', 'https://www.instagram.com/accounts/login/', 200),
    ).toBe('login_wall');
    expect(detectSocialBlock('', 'https://facebook.com/checkpoint/', 200)).toBe(
      'captcha',
    );
  });
  it('does not mistake public company content plus login/password widget for a wall', () => {
    expect(
      detectSocialBlock(
        fixture('facebook'),
        facebook.canonicalUrl,
        200,
        facebook,
      ),
    ).toBeNull();
    expect(
      detectSocialBlock(
        fixture('instagram-meta') +
          '<form><input name="username"><input type="password">Log in to view more</form>',
        instagram.canonicalUrl,
        200,
        instagram,
      ),
    ).toBeNull();
    expect(
      detectSocialBlock(
        '<main><h1>Public company</h1><input type="password"><a>Log in</a></main>',
        facebook.canonicalUrl,
        200,
      ),
    ).toBeNull();
  });
  it('accepts visible company content alongside a password widget without metadata', () => {
    expect(
      detectSocialBlock(
        '<main><h1>Demo Systems</h1><p>Business software and support for industrial clients.</p><form><input name="email"><input type="password">Log in to continue</form></main>',
        linkedin.canonicalUrl,
        200,
      ),
    ).toBeNull();
  });
  it('ignores security words in hidden data and detects a visible rate-limit message', () => {
    expect(
      detectSocialBlock(
        '<script>"verify you are human"</script><div hidden>Complete captcha</div><main>Public company</main>',
        linkedin.canonicalUrl,
        200,
      ),
    ).toBeNull();
    expect(
      detectSocialBlock(
        '<main>Please wait a few minutes before you try again</main>',
        instagram.canonicalUrl,
        200,
      ),
    ).toBe('rate_limit');
  });
});
