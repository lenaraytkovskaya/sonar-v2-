'use client';
import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { productSchema } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { cn } from '@/lib/utils';
export function ProductImage({
  url,
  alt,
  className,
}: {
  url?: string;
  alt: string;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  if (
    !url ||
    failedUrl === url ||
    !productSchema.shape.photos.safeParse([url]).success
  )
    return (
      <div
        role="img"
        aria-label={uk.products.imageUnavailable}
        className={cn(
          'flex items-center justify-center bg-chip text-muted-foreground',
          className,
        )}
      >
        <ImageOff aria-hidden="true" className="size-5" />
      </div>
    );
  return (
    <img
      key={url}
      src={url}
      alt={alt}
      width={320}
      height={180}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cn('bg-chip object-cover', className)}
      onError={() => setFailedUrl(url)}
    />
  );
}
