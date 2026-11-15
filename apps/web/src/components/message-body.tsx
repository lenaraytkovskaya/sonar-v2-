import { uk } from '@/i18n/uk';
import { emailHistoryLines, splitEmailHistory } from '@/lib/email-display';

export function MessageBody({
  body,
  channel,
}: {
  body: string;
  channel: string;
}) {
  if (channel !== 'email')
    return <p className="whitespace-pre-wrap break-words">{body}</p>;
  const { current, history } = splitEmailHistory(body, channel);
  return (
    <div className="min-w-0 space-y-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      <p className="leading-relaxed">{history ? current.trimEnd() : current}</p>
      {history && (
        <details className="group/email whitespace-normal">
          <summary className="min-h-11 cursor-pointer content-center rounded text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent">
            <span className="group-open/email:hidden">
              {uk.outreach.showHistory}
            </span>
            <span className="hidden group-open/email:inline">
              {uk.outreach.hideHistory}
            </span>
          </summary>
          <div className="mt-2 border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
            {emailHistoryLines(history).map((line, index) => (
              <div
                key={index}
                className="whitespace-pre-wrap"
                style={{
                  marginInlineStart: `${Math.min(line.depth, 4) * 0.75}rem`,
                }}
              >
                {line.text || '\n'}
              </div>
            ))}
            <details className="mt-3">
              <summary className="min-h-11 cursor-pointer content-center rounded">
                {uk.outreach.originalMessage}
              </summary>
              <p className="whitespace-pre-wrap">{body}</p>
            </details>
          </div>
        </details>
      )}
    </div>
  );
}
