import React from 'react';
import { uk } from '../i18n/uk';

export function SocialAccountFailureShotLinks({
  accountId,
  network,
  kinds,
}: {
  accountId: string;
  network: string;
  kinds: string[];
}) {
  return kinds
    .filter((kind) => ['send', 'check'].includes(kind))
    .map((kind) => (
      <p key={kind} className="text-xs">
        <span className="mr-2">
          {kind === 'send'
            ? uk.socialAccounts.failureShotSend
            : uk.socialAccounts.failureShotCheck}
        </span>
        <a
          className="underline"
          target="_blank"
          rel="noreferrer"
          href={`/api/social-accounts/failure-shot?id=${encodeURIComponent(accountId)}&kind=${kind}`}
        >
          {uk.socialAccounts.failureShot}
        </a>
        {['facebook', 'instagram'].includes(network) && (
          <a
            className="ml-2 underline"
            target="_blank"
            rel="noreferrer"
            href={`/api/social-accounts/failure-dom?id=${encodeURIComponent(accountId)}&kind=${kind}`}
          >
            {uk.socialAccounts.failureDom}
          </a>
        )}
      </p>
    ));
}
