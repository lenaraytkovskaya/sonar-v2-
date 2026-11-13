import { beforeEach, describe, expect, it, vi } from 'vitest';
const {
  session,
  chat,
  generate,
  send,
  approve,
  edit,
  manual,
  skip,
  call,
  query,
} = vi.hoisted(() => ({
  session: vi.fn(),
  chat: vi.fn(),
  generate: vi.fn(),
  send: vi.fn(),
  approve: vi.fn(),
  edit: vi.fn(),
  manual: vi.fn(),
  skip: vi.fn(),
  call: vi.fn(),
  query: vi.fn(),
}));
vi.mock('./auth', () => ({ getSession: session }));
vi.mock('@/lib/api-access', () => import('./api-access'));
vi.mock('@/lib/email-api', () => import('./email-api'));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@sonar/db/outreach', () => ({
  getCompanyChat: chat,
  enqueueDraft: generate,
  sendOutreachDraft: send,
  approveOutreachDraft: approve,
  editOutreachDraft: edit,
  markOutreachManualSent: manual,
  skipOutreachMessage: skip,
  logOutreachCall: call,
}));
vi.mock('@sonar/db/email', () => ({
  EmailValidationError: class extends Error {},
}));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
import { GET, POST } from '../app/api/companies/[id]/outreach/route';
const id = '00000000-0000-0000-0000-000000000001';
const context = { params: Promise.resolve({ id }) };
const request = (body: unknown, origin = 'http://localhost') =>
  new Request(`http://localhost/api/companies/${id}/outreach`, {
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
  chat.mockResolvedValue({ messages: [{ id }] });
  for (const fn of [generate, send, approve, edit, manual, skip, call])
    fn.mockResolvedValue({ id });
});
describe('shared contact chat actions', () => {
  it('scopes shared draft task polling to the company and drafting task type', async () => {
    query.mockResolvedValue({ rows: [{ id, status: 'done' }] });
    expect(
      (await GET(new Request(`http://localhost?taskId=${id}`), context)).status,
    ).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("type='ai.drafts' and payload->>'companyId'=$2"),
      [id, id],
    );
    query.mockResolvedValue({ rows: [] });
    expect(
      (await GET(new Request(`http://localhost?taskId=${id}`), context)).status,
    ).toBe(404);
  });
  it('queues one contact draft with the user and stable request key', async () => {
    const fields = { contactId: id, campaignId: id, requestId: id };
    const response = await POST(
      request({ action: 'generate', ...fields }),
      context,
    );
    expect(response.status).toBe(202);
    expect(generate).toHaveBeenCalledWith(
      { companyId: id, ...fields },
      'actor',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('forwards reviewed drafts to the shared send pipeline', async () => {
    expect(
      (await POST(request({ action: 'send', messageId: id }), context)).status,
    ).toBe(200);
    expect(send).toHaveBeenCalledWith(id, 'actor');
    expect(
      (await POST(request({ action: 'approve', messageId: id }), context))
        .status,
    ).toBe(200);
    expect(approve).toHaveBeenCalledWith(id, 'actor');
  });
  it('records manual delivery and call notes without enqueueing a send', async () => {
    expect(
      (await POST(request({ action: 'manual', messageId: id }), context))
        .status,
    ).toBe(200);
    expect(manual).toHaveBeenCalledWith(id, 'actor');
    const fields = {
      contactId: id,
      campaignId: id,
      requestId: id,
      body: 'Домовились про повторний дзвінок.',
    };
    expect(
      (await POST(request({ action: 'call', ...fields }), context)).status,
    ).toBe(200);
    expect(call).toHaveBeenCalledWith({ companyId: id, ...fields }, 'actor');
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects mutation of another company’s message', async () => {
    chat.mockResolvedValue({ messages: [] });
    for (const action of ['save', 'send', 'approve', 'manual', 'skip'])
      expect(
        (
          await POST(
            request({ action, messageId: id, subject: 'Тема', body: 'Текст' }),
            context,
          )
        ).status,
      ).toBe(400);
    for (const fn of [send, approve, edit, manual, skip])
      expect(fn).not.toHaveBeenCalled();
  });
  it('protects reads and mutations with authentication and origin checks', async () => {
    session.mockResolvedValue({});
    expect((await GET(new Request('http://localhost'), context)).status).toBe(
      401,
    );
    expect(
      (await POST(request({ action: 'send', messageId: id }), context)).status,
    ).toBe(401);
    session.mockResolvedValue({ user: { id: 'actor' } });
    expect(
      (
        await POST(
          request({ action: 'send', messageId: id }, 'https://other.example'),
          context,
        )
      ).status,
    ).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects malformed generation, editing and call requests', async () => {
    for (const body of [
      { action: 'generate', contactId: id, campaignId: id, requestId: 'bad' },
      { action: 'save', messageId: id, subject: 'Тема', body: '' },
      {
        action: 'call',
        contactId: id,
        campaignId: id,
        requestId: id,
        body: null,
      },
    ])
      expect((await POST(request(body), context)).status).toBe(400);
    for (const fn of [generate, edit, call]) expect(fn).not.toHaveBeenCalled();
  });
});
