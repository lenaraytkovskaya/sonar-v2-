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
});

describe('detectSocialBlock', () => {
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
