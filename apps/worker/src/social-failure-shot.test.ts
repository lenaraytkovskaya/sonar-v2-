import { expect, it, vi } from 'vitest';
import { captureFailureShot } from './social-send-browser.js';

function pageWith(images: Buffer[]) {
  return {
    url: () => 'https://www.facebook.com/messages/?tab=inbox',
    screenshot: vi.fn(async () => images.shift()!),
  };
}

it('stores the failure metadata and a capped JPEG without query parameters', async () => {
  const persistFailureShot = vi.fn(async () => {});
  const page = pageWith([Buffer.from('jpeg')]);
  await captureFailureShot(
    page as never,
    { persistFailureShot } as never,
    'check',
    'auth',
  );
  expect(persistFailureShot).toHaveBeenCalledWith(
    'check',
    expect.objectContaining({
      path: '/messages/',
      stage: 'auth',
      jpeg: Buffer.from('jpeg').toString('base64'),
    }),
  );
});

it('retries at lower JPEG quality and never stores images above 3 MB', async () => {
  const persistFailureShot = vi.fn(async () => {});
  const page = pageWith([
    Buffer.alloc(3 * 1024 * 1024 + 1),
    Buffer.from('small'),
  ]);
  await captureFailureShot(
    page as never,
    { persistFailureShot } as never,
    'send',
    'send',
  );
  expect(page.screenshot).toHaveBeenCalledTimes(2);
  expect(persistFailureShot).toHaveBeenCalledTimes(1);
  const noSmallImage = pageWith([
    Buffer.alloc(3 * 1024 * 1024 + 1),
    Buffer.alloc(3 * 1024 * 1024 + 1),
    Buffer.alloc(3 * 1024 * 1024 + 1),
  ]);
  const rejectedPersist = vi.fn(async () => {});
  await captureFailureShot(
    noSmallImage as never,
    { persistFailureShot: rejectedPersist } as never,
    'send',
    'send',
  );
  expect(rejectedPersist).not.toHaveBeenCalled();
});

it('persists the sanitized DOM alongside the image and survives screenshot failure', async () => {
  const dom = {
    version: 1,
    phase: 'dialog',
    elapsedMs: 0,
    truncated: false,
    nodes: [],
  };
  const persistFailureShot = vi.fn<
    (kind: string, shot: { jpeg?: string; dom?: unknown }) => Promise<void>
  >(async () => {});
  const page = {
    ...pageWith([Buffer.from('jpeg')]),
    evaluate: vi.fn(async () => dom),
  };
  await captureFailureShot(
    page as never,
    { persistFailureShot } as never,
    'send',
    'dialog',
  );
  expect(persistFailureShot).toHaveBeenLastCalledWith(
    'send',
    expect.objectContaining({
      dom,
      jpeg: Buffer.from('jpeg').toString('base64'),
    }),
  );
  page.screenshot.mockRejectedValueOnce(new Error('closed screenshot'));
  await captureFailureShot(
    page as never,
    { persistFailureShot } as never,
    'send',
    'dialog',
  );
  expect(persistFailureShot).toHaveBeenLastCalledWith(
    'send',
    expect.objectContaining({ dom }),
  );
  expect(persistFailureShot.mock.lastCall?.[1]).not.toHaveProperty('jpeg');
});

it('masks conversation regions from Facebook failure screenshots', async () => {
  const page = {
    ...pageWith([Buffer.from('jpeg')]),
    locator: vi.fn(() => ({ selector: 'conversation-mask' })),
  };
  await captureFailureShot(
    page as never,
    { persistFailureShot: vi.fn(async () => {}) } as never,
    'send',
    'profile',
  );
  expect(page.screenshot).toHaveBeenCalledWith(
    expect.objectContaining({
      mask: [{ selector: 'conversation-mask' }],
      maskColor: '#000000',
    }),
  );
});

it('leaves Facebook failure screenshots unmasked only when no composer is visible', async () => {
  const withCount = (count: number) => ({
    ...pageWith([Buffer.from('jpeg')]),
    locator: vi.fn(() => ({
      selector: 'any',
      filter: () => ({ count: async () => count }),
    })),
  });
  const absent = withCount(0);
  await captureFailureShot(
    absent as never,
    { persistFailureShot: vi.fn(async () => {}) } as never,
    'send',
    'first_lookup',
  );
  expect(absent.screenshot).toHaveBeenCalledWith(
    expect.not.objectContaining({ mask: expect.anything() }),
  );
  const present = withCount(1);
  await captureFailureShot(
    present as never,
    { persistFailureShot: vi.fn(async () => {}) } as never,
    'send',
    'first_lookup',
  );
  expect(present.screenshot).toHaveBeenCalledWith(
    expect.objectContaining({ maskColor: '#000000' }),
  );
});

it('leaves the Facebook screenshot unmasked at the unconfirmed-delivery stage even with a composer', async () => {
  const page = {
    ...pageWith([Buffer.from('jpeg')]),
    locator: vi.fn(() => ({
      selector: 'any',
      filter: () => ({ count: async () => 1 }),
    })),
  };
  await captureFailureShot(
    page as never,
    { persistFailureShot: vi.fn(async () => {}) } as never,
    'send',
    'confirmation',
  );
  expect(page.screenshot).toHaveBeenCalledWith(
    expect.not.objectContaining({ mask: expect.anything() }),
  );
});
