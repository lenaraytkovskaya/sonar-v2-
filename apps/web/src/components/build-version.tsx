import { createElement } from 'react';

export function BuildVersion({
  version = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev',
  sha = process.env.NEXT_PUBLIC_BUILD_SHA ?? 'dev',
  date = process.env.NEXT_PUBLIC_BUILD_DATE ?? 'dev',
}: {
  version?: string;
  sha?: string;
  date?: string;
}) {
  return createElement(
    'p',
    { title: date, className: 'px-2 text-xs text-muted-foreground' },
    `v${version} · ${sha}`,
  );
}
