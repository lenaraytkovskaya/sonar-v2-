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
