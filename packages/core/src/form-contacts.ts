export type SharedFormContact = 'email' | 'phone' | 'telegram' | 'whatsapp';
export type FormContactValues = {
  email: string;
  phone: string;
  telegram?: string;
  whatsapp?: string;
};

export function prepareFormContacts(
  contacts: FormContactValues,
  body: string,
  fields: string[],
): { body: string; sharedContacts: SharedFormContact[] } {
  const present = (kind: SharedFormContact) => {
    const value = contacts[kind]?.trim();
    if (!value) return false;
    if (fields.includes(kind)) return true;
    if (body.toLowerCase().includes(value.toLowerCase())) return true;
    if (kind === 'phone' || kind === 'whatsapp') {
      const digits = value.replace(/\D/g, '');
      return (
        digits.length >= 7 && body.replace(/[^\d\n]/g, '').includes(digits)
      );
    }
    if (kind === 'telegram') {
      const username = value
        .replace(/^(?:https?:\/\/)?(?:t|telegram)\.me\//i, '')
        .replace(/^@/, '')
        .replace(/\/$/, '');
      return [
        `@${username}`,
        `t.me/${username}`,
        `telegram.me/${username}`,
      ].some((v) => body.toLowerCase().includes(v.toLowerCase()));
    }
    return false;
  };
  const missing = [
    contacts.phone && !present('phone') ? `телефон ${contacts.phone}` : '',
    contacts.telegram && !present('telegram')
      ? `Telegram ${contacts.telegram}`
      : '',
  ].filter(Boolean);
  if (missing.length)
    body = `${body.trimEnd()}\n\nЗв’язатися: ${missing.join(', ')}`;
  return {
    body,
    sharedContacts: (
      ['email', 'phone', 'telegram', 'whatsapp'] as const
    ).filter(present),
  };
}

/** Infer which contact fields were saved in a legacy form request snapshot. */
export function sharedFormContactsFromValues(
  contacts: FormContactValues,
  savedSharedContacts?: SharedFormContact[] | null,
): SharedFormContact[] {
  const saved = savedSharedContacts?.filter(
    (kind): kind is SharedFormContact =>
      ['email', 'phone', 'telegram', 'whatsapp'].includes(kind) &&
      Boolean(contacts[kind]?.trim()),
  );
  if (saved?.length) return saved;
  return (['email', 'phone', 'telegram', 'whatsapp'] as const).filter((kind) =>
    Boolean(contacts[kind]?.trim()),
  );
}
