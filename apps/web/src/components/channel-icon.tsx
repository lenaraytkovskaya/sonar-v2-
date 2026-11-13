import { Globe, Mail, MapPin, Phone, Send, FileText } from 'lucide-react';
import { socialTarget } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { cn } from '@/lib/utils';
const brands = {
  instagram: (
    <>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle
        cx="12"
        cy="12"
        r="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="17.5" cy="6.5" r="1" />
    </>
  ),
  facebook: (
    <path d="M14 22v-9h3l.5-4H14V7c0-1 .3-2 2-2h2V1.5A26 26 0 0 0 15 1c-3 0-5 2-5 5v3H7v4h3v9z" />
  ),
  linkedin: (
    <>
      <rect x="3" y="9" width="4" height="12" />
      <circle cx="5" cy="4.5" r="2.2" />
      <path d="M10 9h4v1.7c1-1.5 2-2 3.5-2 3 0 4.5 2 4.5 5V21h-4v-6.5c0-1.5-.5-2.5-2-2.5s-2 1-2 2.5V21h-4z" />
    </>
  ),
  telegram: <path d="m22 3-4 18-6-5-3 3 .5-6L19 5 7 12 2 10z" />,
  whatsapp: (
    <>
      <path
        d="M4 20 2 22l1-6a10 10 0 1 1 4 5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M7 6c-3 3 4 11 8 11 2 0 3-2 2-3l-3-1-1 2c-2-1-4-3-4-5l1-1-1-3z" />
    </>
  ),
  viber: (
    <>
      <path
        d="M6 3q6-2 12 0 5 3 3 12-1 4-8 4l-5 4v-4q-6 0-6-6T6 3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M7 6c-2 2 3 9 7 10l3-2-3-2-1 1-3-3 1-1z" />
      <path
        d="M13 5q5 0 5 5M13 8q2 0 2 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </>
  ),
  youtube: (
    <>
      <path d="M3 5q9-2 18 0 3 7 0 14-9 2-18 0-3-7 0-14z" />
      <path d="m10 8 6 4-6 4z" fill="var(--surface)" />
    </>
  ),
  tiktok: (
    <path d="M14 2h4c0 3 2 5 5 5v4c-2 0-4-1-5-2v8a6 6 0 1 1-6-6v4a2 2 0 1 0 2 2z" />
  ),
};
const brandColors = {
  instagram: 'text-[#a06b8b]',
  facebook: 'text-[#667fa5]',
  linkedin: 'text-[#577b94]',
  telegram: 'text-[#648fa3]',
  whatsapp: 'text-[#628d73]',
  viber: 'text-[#8878a4]',
  youtube: 'text-[#ab7272]',
  tiktok: 'text-muted-foreground',
};
export function ChannelIcon({
  channel,
  value = '',
  className,
}: {
  channel: string;
  value?: string;
  className?: string;
}) {
  const key = (
    channel === 'social'
      ? (socialTarget(value)?.network ?? 'social')
      : ({ website: 'site', call: 'phone' }[channel] ?? channel)
  ) as keyof typeof uk.channelIcons;
  const label = uk.channelIcons[key] ?? uk.channelIcons.social;
  const Icon =
    {
      email: Mail,
      phone: Phone,
      site: Globe,
      form: FileText,
      map: MapPin,
      social: Send,
    }[key as 'email' | 'phone' | 'site' | 'form' | 'map' | 'social'] ?? Globe;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-4 shrink-0 align-middle',
        key in brands
          ? brandColors[key as keyof typeof brands]
          : 'text-muted-foreground',
        className,
      )}
    >
      {key in brands ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-4"
          fill="currentColor"
        >
          {brands[key as keyof typeof brands]}
        </svg>
      ) : (
        <Icon aria-hidden="true" className="size-4" />
      )}
    </span>
  );
}
