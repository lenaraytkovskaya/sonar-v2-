import { beforeEach, expect, it, vi } from 'vitest';

const { apiUser, claimViberAccount, updateViberAccount, listViberAccounts } =
  vi.hoisted(() => ({
    apiUser: vi.fn(),
    claimViberAccount: vi.fn(),
    updateViberAccount: vi.fn(),
    listViberAccounts: vi.fn(),
  }));
vi.mock('@/lib/api-access', () => ({ apiUser }));
vi.mock('@/i18n/uk', () => import('../../../i18n/uk'));
vi.mock('@sonar/db/viber', () => ({
  claimViberAccount,
  updateViberAccount,
  listViberAccounts,
}));
import { POST } from './route.js';

beforeEach(() => {
  apiUser.mockReset();
  claimViberAccount.mockReset();
  updateViberAccount.mockReset();
  listViberAccounts.mockReset();
  apiUser.mockResolvedValue({ id: 'crm-owner' });
  listViberAccounts.mockResolvedValue([]);
});

it('explicitly claims an unowned Viber account when connecting', async () => {
  claimViberAccount.mockResolvedValue({ id: 'account', ownerId: 'crm-owner' });
  const response = await POST(
    new Request('http://localhost/api/viber', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimOwner: true }),
    }),
  );
  expect(response.status).toBe(200);
  expect(claimViberAccount).toHaveBeenCalledWith('crm-owner');
  expect(updateViberAccount).not.toHaveBeenCalled();
});

it('returns a clear forbidden response when a non-owner tries to claim Viber', async () => {
  claimViberAccount.mockRejectedValue(
    new Error('Лише власник CRM може призначити власника каналу Viber.'),
  );
  const response = await POST(
    new Request('http://localhost/api/viber', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimOwner: true }),
    }),
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: 'Лише власник CRM може призначити власника каналу Viber.',
  });
});
