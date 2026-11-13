import { describe, expect, it, vi } from 'vitest';
import { Api, errors } from 'telegram';
import { returnBigInt } from 'telegram/Helpers.js';
import {
  createTelegramAdapter,
  decryptTelegramSession,
  encryptTelegramSession,
  normalizeTelegramRecipient,
  telegramError,
  telegramRandomId,
  type TelegramConnection,
  codeDelivery,
} from './telegram.js';
vi.mock('telegram/Password.js', () => ({
  computeCheck: vi.fn(async () => new Api.InputCheckPasswordEmpty()),
}));

const credentials = { apiId: 1234, apiHash: 'stub-hash' };
const user = new Api.User({
  id: returnBigInt(7),
  accessHash: returnBigInt(8),
  phone: '380501234567',
  firstName: 'Original',
});
const saved = (exists = false) =>
  new Api.contacts.Contacts({
    contacts: exists
      ? [new Api.Contact({ userId: user.id, mutual: false })]
      : [],
    savedCount: exists ? 1 : 0,
    users: exists ? [user] : [],
  });
const imported = () =>
  new Api.contacts.ImportedContacts({
    users: [user],
    imported: [
      new Api.ImportedContact({ userId: user.id, clientId: returnBigInt(1) }),
    ],
    popularInvites: [],
    retryContacts: [],
  });
const delivery = {
  accountId: 'account',
  session: 'private-session',
  to: '+380501234567',
  body: 'Hello',
  idempotencyKey: 'persisted-key',
};
function mockClient(handler: (request: Api.AnyRequest) => unknown) {
  const invoke = vi.fn(async (request: Api.AnyRequest) => handler(request));
  const client = {
    invoke,
    connect: vi.fn(async () => true),
    destroy: vi.fn(async () => {}),
    getInputEntity: vi.fn(
      async () =>
        new Api.InputPeerUser({
          userId: user.id,
          accessHash: user.accessHash!,
        }),
    ),
    session: { save: () => 'saved-session' },
  };
  const factory = vi.fn(() => client as unknown as TelegramConnection);
  return {
    client,
    factory,
    adapter: createTelegramAdapter(credentials, factory),
  };
}
describe('encrypted Telegram sessions', () => {
  it('round trips with separate random nonces and rejects wrong keys or tampering', () => {
    const secret = 'test-auth-secret-with-at-least-32-characters';
    const value = encryptTelegramSession('private-session', secret);
    expect(value).not.toContain('private-session');
    expect(decryptTelegramSession(value, secret)).toBe('private-session');
    expect(encryptTelegramSession('private-session', secret)).not.toBe(value);
    expect(() => decryptTelegramSession(value, secret + '-wrong')).toThrow(
      'розшифрувати',
    );
    expect(() => decryptTelegramSession(value + '.extra', secret)).toThrow(
      'розшифрувати',
    );
    const parts = value.split('.');
    parts[2] = Buffer.alloc(4).toString('base64url');
    expect(() => decryptTelegramSession(parts.join('.'), secret)).toThrow(
      'розшифрувати',
    );
    parts[1] = Buffer.alloc(8).toString('base64url');
    expect(() => decryptTelegramSession(parts.join('.'), secret)).toThrow(
      'розшифрувати',
    );
    expect(() => encryptTelegramSession('private', '')).toThrow('AUTH_SECRET');
  });
});
describe('Telegram transport', () => {
  it('imports then sends then removes only its new contact, reusing one client per account', async () => {
    const { adapter, client, factory } = mockClient((r) =>
      r instanceof Api.contacts.GetContacts
        ? saved()
        : r instanceof Api.contacts.ImportContacts
          ? imported()
          : new Api.UpdateShortSentMessage({
              id: 42,
              pts: 1,
              ptsCount: 1,
              date: 1,
            }),
    );
    expect(await adapter.send(delivery)).toBe('42');
    expect(await adapter.send(delivery)).toBe('42');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(
      client.invoke.mock.calls.slice(0, 4).map(([r]) => r.className),
    ).toEqual([
      'contacts.GetContacts',
      'contacts.ImportContacts',
      'messages.SendMessage',
      'contacts.DeleteContacts',
    ]);
    const messages = client.invoke.mock.calls
      .map(([r]) => r)
      .filter((r) => r instanceof Api.messages.SendMessage);
    expect(messages[0]?.randomId?.toString()).toBe(
      messages[1]?.randomId?.toString(),
    );
    await adapter.closeAll();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });
  it('preserves an existing contact and sends usernames without importing', async () => {
    const { adapter, client } = mockClient((r) =>
      r instanceof Api.contacts.GetContacts
        ? saved(true)
        : r instanceof Api.contacts.ImportContacts
          ? imported()
          : new Api.UpdateShortSentMessage({
              id: 42,
              pts: 1,
              ptsCount: 1,
              date: 1,
            }),
    );
    await adapter.send(delivery);
    expect(client.invoke.mock.calls.map(([r]) => r.className)).toEqual([
      'contacts.GetContacts',
      'contacts.ImportContacts',
      'messages.SendMessage',
    ]);
    const request = client.invoke.mock.calls[1]?.[0];
    expect(
      request instanceof Api.contacts.ImportContacts && request.contacts[0],
    ).toMatchObject({ firstName: 'Original', lastName: '' });
    await adapter.send({ ...delivery, to: '@stub_user' });
    expect(client.getInputEntity).toHaveBeenCalledWith('@stub_user');
    expect(client.invoke.mock.calls.at(-1)?.[0]).toBeInstanceOf(
      Api.messages.SendMessage,
    );
    await adapter.closeAll();
  });
  it('cleans up after failed sends; cleanup failure cannot undo confirmed send', async () => {
    let failSend = true;
    const { adapter, client } = mockClient((r) => {
      if (r instanceof Api.contacts.GetContacts) return saved();
      if (r instanceof Api.contacts.ImportContacts) return imported();
      if (r instanceof Api.contacts.DeleteContacts)
        throw new Error('cleanup private');
      if (failSend) throw new Error('USER_PRIVACY_RESTRICTED');
      return new Api.UpdateShortSentMessage({
        id: 42,
        pts: 1,
        ptsCount: 1,
        date: 1,
      });
    });
    await expect(adapter.send(delivery)).rejects.toMatchObject({
      unavailable: true,
    });
    expect(client.invoke.mock.calls.at(-1)?.[0]).toBeInstanceOf(
      Api.contacts.DeleteContacts,
    );
    failSend = false;
    await expect(adapter.send(delivery)).rejects.toMatchObject({
      code: 'cleanup_failed',
      providerMessageId: '42',
      retryable: false,
    });
    await adapter.closeAll();
  });
  it('does not send to unregistered/private phone and exposes no provider text', async () => {
    const { adapter, client } = mockClient((r) =>
      r instanceof Api.contacts.GetContacts
        ? saved()
        : new Api.contacts.ImportedContacts({
            users: [],
            imported: [],
            popularInvites: [],
            retryContacts: [],
          }),
    );
    await expect(adapter.send(delivery)).rejects.toMatchObject({
      code: 'unavailable',
      unavailable: true,
    });
    expect(
      client.invoke.mock.calls.some(
        ([r]) => r instanceof Api.messages.SendMessage,
      ),
    ).toBe(false);
    expect(
      telegramError(new Error('token session private')).reasonUk,
    ).not.toContain('private');
    expect(
      telegramError(new errors.FloodWaitError({ capture: 42 })),
    ).toMatchObject({ retryAfterSeconds: 42, retryable: true });
    client.getInputEntity.mockRejectedValueOnce(
      new Error('No user has "missing_user" as username'),
    );
    await expect(
      adapter.send({ ...delivery, to: '@missing_user' }),
    ).rejects.toMatchObject({ unavailable: true });
    await adapter.closeAll();
  });
  it('does not retry cleanup flood waits and retains delivery or primary privacy error', async () => {
    let privateRecipient = false;
    const { adapter, client } = mockClient((r) => {
      if (r instanceof Api.contacts.GetContacts) return saved();
      if (r instanceof Api.contacts.ImportContacts) return imported();
      if (r instanceof Api.contacts.DeleteContacts)
        throw new errors.FloodWaitError({ capture: 75 });
      if (privateRecipient) throw new Error('USER_PRIVACY_RESTRICTED');
      return new Api.UpdateShortSentMessage({
        id: 42,
        pts: 1,
        ptsCount: 1,
        date: 1,
      });
    });
    await expect(adapter.send(delivery)).rejects.toMatchObject({
      code: 'cleanup_failed',
      providerMessageId: '42',
      accountRetryAfterSeconds: 75,
    });
    expect(
      client.invoke.mock.calls.filter(
        ([r]) => r instanceof Api.contacts.DeleteContacts,
      ),
    ).toHaveLength(1);
    privateRecipient = true;
    await expect(adapter.send(delivery)).rejects.toMatchObject({
      code: 'unavailable',
      unavailable: true,
      accountRetryAfterSeconds: 75,
    });
    expect(
      client.invoke.mock.calls.filter(
        ([r]) => r instanceof Api.contacts.DeleteContacts,
      ),
    ).toHaveLength(2);
    expect(telegramError(new Error('USER_DEACTIVATED_BAN'))).toMatchObject({
      code: 'session_expired',
      unavailable: false,
    });
    await adapter.closeAll();
  });
  it('runs code and 2FA as separate calls and destroys temporary login clients', async () => {
    const { adapter, client } = mockClient((r) => {
      if (r instanceof Api.auth.SendCode)
        return new Api.auth.SentCode({
          type: new Api.auth.SentCodeTypeApp({ length: 5 }),
          phoneCodeHash: 'hash',
        });
      if (r instanceof Api.auth.SignIn)
        throw { errorMessage: 'SESSION_PASSWORD_NEEDED' };
      return {};
    });
    expect(await adapter.startLogin('+380501234567')).toEqual({
      session: 'saved-session',
      phoneCodeHash: 'hash',
      deliveryUk: expect.stringContaining('застосунок Telegram'),
    });
    expect(
      codeDelivery(new Api.auth.SentCodeTypeSetUpEmailRequired({})),
    ).toContain('пошта для входу');
    expect(
      codeDelivery(
        new Api.auth.SentCodeTypeEmailCode({
          emailPattern: 'l***@gmail.com',
          length: 6,
        }),
      ),
    ).toContain('l***@gmail.com');
    const input = {
      session: 'saved-session',
      phone: '+380501234567',
      phoneCodeHash: 'hash',
    };
    expect(
      await adapter.finishLogin({ ...input, code: '12345' }),
    ).toMatchObject({ requiresPassword: true });
    expect(
      await adapter.finishLogin({ ...input, password: 'private' }),
    ).toMatchObject({ requiresPassword: false });
    await adapter.logout('saved-session');
    expect(client.destroy).toHaveBeenCalledTimes(4);
    expect(client.invoke.mock.calls.map(([r]) => r.className)).toEqual([
      'auth.SendCode',
      'auth.SignIn',
      'account.GetPassword',
      'auth.CheckPassword',
      'auth.LogOut',
    ]);
  });
  it('logs in by QR: shows a token, follows a DC migration, then returns the phone', async () => {
    let scanned = false;
    const { adapter, client } = mockClient((r) => {
      if (r instanceof Api.auth.ExportLoginToken)
        return scanned
          ? new Api.auth.LoginTokenMigrateTo({
              dcId: 4,
              token: Buffer.from('t2'),
            })
          : new Api.auth.LoginToken({ expires: 30, token: Buffer.from('t1') });
      if (r instanceof Api.auth.ImportLoginToken)
        return new Api.auth.LoginTokenSuccess({
          authorization: new Api.auth.Authorization({ user }),
        });
      return {};
    });
    const switchDC = vi.fn(async () => true);
    Object.assign(client, { switchDC });
    expect(await adapter.qrLogin('')).toEqual({
      session: 'saved-session',
      status: 'qr',
      url: 'tg://login?token=' + Buffer.from('t1').toString('base64url'),
    });
    scanned = true;
    expect(await adapter.qrLogin('saved-session')).toEqual({
      session: 'saved-session',
      status: 'done',
      phone: '+380501234567',
    });
    expect(switchDC).toHaveBeenCalledWith(4);
  });
  it('asks for the 2FA password after a QR scan', async () => {
    const { adapter } = mockClient(() => {
      throw { errorMessage: 'SESSION_PASSWORD_NEEDED' };
    });
    expect(await adapter.qrLogin('saved-session')).toEqual({
      session: 'saved-session',
      status: 'password',
    });
  });
  it('validates identifiers and fails safely when credentials are missing', async () => {
    expect(normalizeTelegramRecipient('https://t.me/stub_user')).toBe(
      '@stub_user',
    );
    expect(normalizeTelegramRecipient('+380501234567')).toBe('+380501234567');
    expect(normalizeTelegramRecipient('bad username')).toBeNull();
    expect(telegramRandomId('key').toString()).toBe(
      telegramRandomId('key').toString(),
    );
    const factory = vi.fn();
    await expect(
      createTelegramAdapter({ apiId: '', apiHash: '' }, factory).send(delivery),
    ).rejects.toMatchObject({ code: 'telegram_config' });
    expect(factory).not.toHaveBeenCalled();
  });
  it('pauses uncertain delivery and retries temporary imports without sending', async () => {
    const uncertain = mockClient(
      () =>
        new Api.Updates({ updates: [], users: [], chats: [], date: 1, seq: 1 }),
    );
    await expect(
      uncertain.adapter.send({ ...delivery, to: '@stub_user' }),
    ).rejects.toMatchObject({ code: 'delivery_uncertain', retryable: false });
    await uncertain.adapter.closeAll();
    const retry = mockClient((r) =>
      r instanceof Api.contacts.GetContacts
        ? saved()
        : new Api.contacts.ImportedContacts({
            users: [],
            imported: [],
            popularInvites: [],
            retryContacts: [returnBigInt(1)],
          }),
    );
    await expect(retry.adapter.send(delivery)).rejects.toMatchObject({
      code: 'import_retry',
      retryable: true,
      unavailable: false,
    });
    expect(
      retry.client.invoke.mock.calls.some(
        ([r]) => r instanceof Api.messages.SendMessage,
      ),
    ).toBe(false);
    await retry.adapter.closeAll();
  });
});

it('attaches one incoming listener per account and reuses its client for send', async () => {
  const stub = mockClient(
    () =>
      new Api.UpdateShortSentMessage({ id: 91, pts: 1, ptsCount: 1, date: 1 }),
  );
  const onIncoming = vi.fn();
  Object.assign(stub.client, { onIncoming });
  const handler = vi.fn(async () => {});
  await Promise.all([
    stub.adapter.listen('account', 'private-session', handler),
    stub.adapter.listen('account', 'private-session', handler),
  ]);
  expect(onIncoming).toHaveBeenCalledTimes(1);
  expect(stub.adapter.listeningAccounts()).toEqual(['account']);
  await stub.adapter.send({ ...delivery, to: '@company' });
  expect(stub.factory).toHaveBeenCalledTimes(1);
  await stub.adapter.closeAll();
  expect(stub.adapter.listeningAccounts()).toEqual([]);
  expect(stub.client.destroy).toHaveBeenCalledTimes(1);
});

it('replaces a cached listener when the account session changes', async () => {
  const stub = mockClient(() => undefined);
  const onIncoming = vi.fn();
  Object.assign(stub.client, { onIncoming });
  const handler = vi.fn(async () => {});
  await stub.adapter.listen('account', 'session-one', handler);
  await stub.adapter.listen('account', 'session-two', handler);
  expect(stub.factory).toHaveBeenCalledTimes(2);
  expect(stub.client.destroy).toHaveBeenCalledTimes(1);
  expect(onIncoming).toHaveBeenCalledTimes(2);
  await stub.adapter.closeAll();
});

it('replies to private users without public username or phone using persisted peer access hash', async () => {
  const stub = mockClient(
    () =>
      new Api.UpdateShortSentMessage({ id: 91, pts: 1, ptsCount: 1, date: 1 }),
  );
  expect(normalizeTelegramRecipient('telegram:user:7:-8')).toBe(
    'telegram:user:7:-8',
  );
  await stub.adapter.send({ ...delivery, to: 'telegram:user:7:-8' });
  const sent = stub.client.invoke.mock.calls[0]![0] as Api.messages.SendMessage;
  expect(sent.peer).toBeInstanceOf(Api.InputPeerUser);
  expect((sent.peer as Api.InputPeerUser).userId.toString()).toBe('7');
  expect((sent.peer as Api.InputPeerUser).accessHash.toString()).toBe('-8');
  expect(stub.client.getInputEntity).not.toHaveBeenCalled();
  await stub.adapter.closeAll();
});
