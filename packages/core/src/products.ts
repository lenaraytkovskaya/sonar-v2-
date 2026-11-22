import { z } from 'zod';

const text = z.string().trim().max(20000).default('');
const httpsUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
});
export const productStatusSchema = z.enum(['active', 'archived']);
export const productSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    tagline: z
      .string()
      .trim()
      .max(500)
      .refine((value) => !/[\r\n]|[.!?…]\s+\p{L}/u.test(value))
      .default(''),
    description: text,
    audience: text,
    benefits: text,
    terms: text,
    links: z
      .array(
        z
          .object({ label: z.string().trim().min(1).max(120), url: httpsUrl })
          .strict(),
      )
      .max(20)
      .default([]),
    photos: z.array(httpsUrl).max(30).default([]),
    videos: z.array(httpsUrl).max(10).default([]),
    status: productStatusSchema.default('active'),
  })
  .strict();
export type ProductInput = z.infer<typeof productSchema>;
export type ProductDto = ProductInput & {
  id: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// Explicit allowlist: human-only terms and future private fields never enter AI context.
export function productOfferText(
  product: Pick<
    ProductInput,
    'name' | 'tagline' | 'description' | 'audience' | 'benefits' | 'links'
  >,
): string {
  return [
    product.name,
    product.tagline,
    product.description,
    product.audience,
    product.benefits
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `- ${line}`)
      .join('\n'),
    product.links.map((link) => `${link.label}: ${link.url}`).join('\n'),
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}
