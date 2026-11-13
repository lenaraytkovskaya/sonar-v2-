import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  session,
  chat,
  read,
  generate,
  reply,
  query,
  edit,
  send,
  approve,
  skip,
  manual,
} = vi.hoisted(() => ({
  session: vi.fn(),
  chat: vi.fn(),
  read: vi.fn(),
  generate: vi.fn(),
  reply: vi.fn(),
  query: vi.fn(),
  edit: vi.fn(),
  send: vi.fn(),
  approve: vi.fn(),
  skip: vi.fn(),
  manual: vi.fn(),
}));
vi.mock('./auth', () => ({ getSession: session }));
vi.mock('@/lib/api-access', () => import('./api-access'));
vi.mock('@/lib/email-api', () => import('./email-api'));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
vi.mock('@sonar/db/inbound', () => ({
  getConversationChat: chat,
  markConversationRead: read,
  enqueueReply: generate,
  queueConversationReply: reply,
}));
vi.mock('@sonar/db/outreach', () => ({
  editOutreachDraft: edit,
  sendOutreachDraft: send,
  approveOutreachDraft: approve,
  skipOutreachMessage: skip,
  markOutreachManualSent: manual,
}));
vi.mock('@sonar/db/email', () => ({
  EmailValidationError: class extends Error {
    reasonUk = 'Некоректні дані.';
  },
}));
import { GET, POST } from '../app/api/conversations/[id]/route';

const id = '00000000-0000-0000-0000-000000000001';
const incoming = '00000000-0000-0000-0000-000000000002';
const outgoing = '00000000-0000-0000-0000-000000000003';
const foreign = '00000000-0000-0000-0000-000000000004';
const context = { params: Promise.resolve({ id }) };
const request = (body: unknown, origin = 'http://localhost') =>
  new Request(`http://localhost/api/conversations/${id}`, {
    method: 'POST',
    headers: { Origin: origin, Host: 'localhost' },
    body: JSON.stringify(body),
  });
const get = (search = '') =>
  new Request(`http://localhost/api/conversations/${id}${search}`);

beforeEach(() => {
  vi.clearAllMocks();
  session.mockResolvedValue({ user: { id: 'actor' } });
  chat.mockResolvedValue({
    conversation: { id },
    messages: [
      { id: incoming, direction: 'in' },
      { id: outgoing, direction: 'out' },
    ],
    blocked: false,
  });
  generate.mockResolvedValue({ id: foreign, status: 'queued' });
  reply.mockResolvedValue({ id: outgoing, status: 'queued' });
  for (const action of [edit, send, approve, skip, manual])
    action.mockResolvedValue({ id: outgoing });
});

describe('conversation API boundaries', () => {
  it('requires an explicit social delivery choice so a manual mark cannot silently queue a send', async () => {
    chat.mockResolvedValue({
      conversation: { id, channel: 'social' },
      messages: [],
      blocked: false,
      socialAvailable: true,
    });
    const body = {
      action: 'reply',
      requestId: foreign,
      body: 'Reply',
      subject: '',
    };
    expect((await POST(request(body), context)).status).toBe(400);
    expect(
      (await POST(request({ ...body, socialDelivery: 'unexpected' }), context))
        .status,
    ).toBe(400);
    expect(reply).not.toHaveBeenCalled();
    for (const socialDelivery of ['browser', 'manual']) {
      expect(
        (await POST(request({ ...body, socialDelivery }), context)).status,
      ).toBe(200);
      expect(reply).toHaveBeenLastCalledWith(
        {
          conversationId: id,
          requestId: foreign,
          body: 'Reply',
          subject: '',
          socialDelivery,
        },
        'actor',
      );
    }
  });

  it('rejects unauthenticated reads and writes, and cross-origin writes', async () => {
    session.mockResolvedValue({});
    expect((await GET(get(), context)).status).toBe(401);
    expect(
      (await POST(request({ action: 'generate', requestId: foreign }), context))
        .status,
    ).toBe(401);
    session.mockResolvedValue({ user: { id: 'actor' } });
    expect(
      (
        await POST(
          request(
            { action: 'read', messageId: incoming },
            'https://other.example',
          ),
          context,
        )
      ).status,
    ).toBe(401);
    expect(chat).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('reads history without marking messages read and scopes task polling to the conversation', async () => {
    expect((await GET(get(), context)).status).toBe(200);
    expect(read).not.toHaveBeenCalled();
    query.mockResolvedValue({ rows: [] });
    expect((await GET(get(`?taskId=${foreign}`), context)).status).toBe(404);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("type='ai.reply'"),
      [foreign, id],
    );
    query.mockResolvedValue({ rows: [{ id: foreign, status: 'done' }] });
    expect(
      await (await GET(get(`?taskId=${foreign}`), context)).json(),
    ).toEqual({ id: foreign, status: 'done' });
  });
  it('marks only a member incoming message as read', async () => {
    for (const messageId of [foreign, outgoing, 'invalid'])
      expect(
        (await POST(request({ action: 'read', messageId }), context)).status,
      ).toBe(400);
    expect(read).not.toHaveBeenCalled();
    expect(
      (await POST(request({ action: 'read', messageId: incoming }), context))
        .status,
    ).toBe(200);
    expect(read).toHaveBeenCalledWith(id, incoming);
  });
  it('generates a draft with the authenticated actor and request id without dispatching send', async () => {
    expect(
      (await POST(request({ action: 'generate', requestId: foreign }), context))
        .status,
    ).toBe(202);
    expect(generate).toHaveBeenCalledWith(id, foreign, 'actor');
    expect(send).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(
      (
        await POST(
          request({ action: 'generate', requestId: 'invalid' }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('rejects outgoing mutations for messages outside this conversation or incoming messages', async () => {
    for (const action of ['save', 'send', 'approve', 'skip', 'manual']) {
      for (const messageId of [foreign, incoming])
        expect(
          (
            await POST(
              request({ action, messageId, subject: '', body: 'Reply' }),
              context,
            )
          ).status,
        ).toBe(400);
    }
    for (const action of [edit, send, approve, skip, manual])
      expect(action).not.toHaveBeenCalled();
    expect(
      (await POST(request({ action: 'send', messageId: outgoing }), context))
        .status,
    ).toBe(200);
    expect(send).toHaveBeenCalledWith(outgoing, 'actor');
  });
  it('requires an existing conversation and valid reply fields', async () => {
    for (const patch of [
      { requestId: 'invalid' },
      { body: '' },
      { body: null },
      { subject: null },
      { body: 'x'.repeat(20001) },
    ])
      expect(
        (
          await POST(
            request({
              action: 'reply',
              requestId: foreign,
              body: 'Reply',
              subject: '',
              ...patch,
            }),
            context,
          )
        ).status,
      ).toBe(400);
    expect(reply).not.toHaveBeenCalled();
    expect(
      (
        await POST(
          request({
            action: 'reply',
            requestId: foreign,
            body: 'Reply',
            subject: '',
          }),
          context,
        )
      ).status,
    ).toBe(200);
    expect(reply).toHaveBeenCalledWith(
      { conversationId: id, requestId: foreign, body: 'Reply', subject: '' },
      'actor',
    );
    chat.mockResolvedValue({ conversation: null, messages: [] });
    expect(
      (await POST(request({ action: 'generate', requestId: foreign }), context))
        .status,
    ).toBe(400);
    expect(generate).not.toHaveBeenCalled();
    expect((await GET(get(), context)).status).toBe(404);
  });
});
