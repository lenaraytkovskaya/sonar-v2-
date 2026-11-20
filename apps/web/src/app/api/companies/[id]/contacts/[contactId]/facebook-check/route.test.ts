import { beforeEach, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  class FacebookRecipientCheckError extends Error {
    constructor(
      public status: number,
      public reasonUk: string,
    ) {
      super(reasonUk);
    }
  }
  return {
    apiUser: vi.fn(),
    enqueueFacebookRecipientCheck: vi.fn(),
    FacebookRecipientCheckError,
  };
});
vi.mock('@/lib/api-access', () => ({
  apiUser: db.apiUser,
  validId: (id: unknown) =>
    typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id),
}));
vi.mock('@/i18n/uk', () => import('../../../../../../../i18n/uk'));
vi.mock('@sonar/db/social-recipient-check', () => ({
  enqueueFacebookRecipientCheck: db.enqueueFacebookRecipientCheck,
  FacebookRecipientCheckError: db.FacebookRecipientCheckError,
}));
import { POST } from './route.js';

const params = Promise.resolve({
  id: '123e4567-e89b-12d3-a456-426614174000',
  contactId: '123e4567-e89b-12d3-a456-426614174001',
});

beforeEach(() => {
  db.apiUser.mockReset();
  db.enqueueFacebookRecipientCheck.mockReset();
});

it('returns 403 when the authenticated user does not own a Facebook account', async () => {
  db.apiUser.mockResolvedValue({ id: 'other-user' });
  db.enqueueFacebookRecipientCheck.mockRejectedValue(
    new db.FacebookRecipientCheckError(
      403,
      'Перевірити одержувача може лише власник Facebook-акаунта.',
    ),
  );
  const response = await POST(
    new Request('http://localhost/api/check', { method: 'POST' }),
    { params },
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: 'Перевірити одержувача може лише власник Facebook-акаунта.',
  });
});

it('requires an authenticated user before queueing a check', async () => {
  db.apiUser.mockResolvedValue(null);
  const response = await POST(
    new Request('http://localhost/api/check', { method: 'POST' }),
    { params },
  );
  expect(response.status).toBe(401);
  expect(db.enqueueFacebookRecipientCheck).not.toHaveBeenCalled();
});
