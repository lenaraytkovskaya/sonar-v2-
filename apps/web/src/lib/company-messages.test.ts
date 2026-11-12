import { beforeEach, describe, expect, it, vi } from 'vitest';
const { session, create, messaging, approve, submit } = vi.hoisted(() => ({
  session: vi.fn(),
  create: vi.fn(),
  messaging: vi.fn(),
  approve: vi.fn(),
  submit: vi.fn(),
}));
vi.mock('./auth', () => ({ getSession: session }));
vi.mock('@/lib/api-access', () => import('./api-access'));
vi.mock('@/lib/email-api', () => import('./email-api'));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@sonar/db/email', () => ({
  createCompanyMessage: create,
  getCompanyMessaging: messaging,
  approveMessage: approve,
  submitMessage: submit,
  EmailValidationError: class extends Error {
    reasonUk = 'Некоректні дані.';
  },
}));
import { POST } from '../app/api/companies/[id]/messages/route';
const id = '00000000-0000-0000-0000-000000000001';
const context = { params: Promise.resolve({ id }) };
const fields = {
  action: 'send',
  campaignId: id,
  accountId: id,
  idempotencyKey: id,
  toAddress: '+380671234567',
  subject: '',
  body: 'Добрий день',
  channel: 'whatsapp',
};
const request = (body: unknown, origin = 'http://localhost') =>
  new Request(`http://localhost/api/companies/${id}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Host: 'localhost',
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  session.mockResolvedValue({ user: { id: 'actor' } });
  create.mockResolvedValue({ id });
});
describe('company WhatsApp messages', () => {
  it('forwards WhatsApp through the shared approval and idempotency pipeline', async () => {
    expect((await POST(request(fields), context)).status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      {
        companyId: id,
        campaignId: id,
        accountId: id,
        idempotencyKey: id,
        toAddress: fields.toAddress,
        subject: '',
        body: fields.body,
        channel: 'whatsapp',
        submit: true,
      },
      'actor',
    );
  });
  it('rejects unauthorized, cross-origin and malformed sends', async () => {
    session.mockResolvedValue({});
    expect((await POST(request(fields), context)).status).toBe(401);
    session.mockResolvedValue({ user: { id: 'actor' } });
    expect(
      (await POST(request(fields, 'https://other.example'), context)).status,
    ).toBe(401);
    for (const patch of [
      { channel: 'sms' },
      { accountId: 'bad' },
      { body: null },
      { idempotencyKey: 'bad' },
    ])
      expect(
        (await POST(request({ ...fields, ...patch }), context)).status,
      ).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects approval for a message belonging to a different company', async () => {
    messaging.mockResolvedValue({ messages: [] });
    expect(
      (await POST(request({ action: 'approve', messageId: id }), context))
        .status,
    ).toBe(400);
    expect(approve).not.toHaveBeenCalled();
  });
});
