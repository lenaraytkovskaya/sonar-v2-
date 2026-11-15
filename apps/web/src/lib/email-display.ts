// Presentation only: exact slices retain the original body, including line endings.
export function splitEmailHistory(body: string, channel: string) {
  const plain = { current: body, history: '' };
  if (channel !== 'email') return plain;
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const text = lines.map((line) => line.trim());
  const quoted = (line: string) => !line || line.startsWith('>');
  const address = /<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?/u;
  const date = /\d{4}|\d{1,2}:\d{2}/u;
  let hasCurrent = false;
  for (let i = 1; i < lines.length; i++) {
    hasCurrent ||= Boolean(text[i - 1]);
    if (!text[i] || text[i - 1] || !hasCurrent) continue;
    // Gmail attribution can wrap onto several lines. Require an address, date,
    // known attribution wording, and an entirely quoted tail (no inline answers).
    for (let end = i; end < Math.min(i + 3, lines.length); end++) {
      const header = text.slice(i, end + 1).join(' ');
      const attribution =
        /^(?:On\b.+\bwrote:|.+(?:пише|написав|написала|писал|писала):|(?:пн|вт|ср|чт|пт|сб|вс|нд|пн\.|вт\.|ср\.|чт\.|пт\.|сб\.|нд\.)[,. ].+:)$/iu;
      const tail = text.slice(end + 1);
      if (
        address.test(header) &&
        date.test(header) &&
        attribution.test(header) &&
        tail.some((line) => line.startsWith('>')) &&
        tail.every(quoted)
      )
        return {
          current: lines.slice(0, i).join(''),
          history: lines.slice(i).join(''),
        };
    }
    // Outlook's explicit four-field header is a strong boundary, even when its
    // old body is unquoted. Mixed quote/plain bodies stay visible conservatively.
    const marker =
      /^-+\s*(?:Original Message|Исходное сообщение|Початкове повідомлення)\s*-+$/iu;
    let start = marker.test(text[i]!) ? i + 1 : i;
    while (start < text.length && !text[start]) start++;
    const fields = [
      /^(?:From|Від|От):\s*.+/iu,
      /^(?:Sent|Надіслано|Отправлено):\s*.+/iu,
      /^(?:To|Кому):\s*.+/iu,
      /^(?:Subject|Тема):\s*.+/iu,
    ];
    if (!address.test(text[start] ?? '')) continue;
    let end = start;
    for (const field of fields) {
      while (end < text.length && !text[end]) end++;
      if (!field.test(text[end] ?? '')) break;
      end++;
    }
    const headers = text.slice(start, end).filter(Boolean);
    const tail = text.slice(end);
    if (
      headers.length === fields.length &&
      tail.some(Boolean) &&
      (!tail.some((line) => line.startsWith('>')) || tail.every(quoted))
    )
      return {
        current: lines.slice(0, i).join(''),
        history: lines.slice(i).join(''),
      };
  }
  return plain;
}

export function emailHistoryLines(history: string) {
  return history.split(/\r?\n/u).map((line) => {
    const prefix = /^(?:[ \t]*>[ \t]?)+/u.exec(line)?.[0] ?? '';
    return {
      depth: (prefix.match(/>/g) ?? []).length,
      text: line.slice(prefix.length),
    };
  });
}
