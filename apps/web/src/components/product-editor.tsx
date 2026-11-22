'use client';
import { useId, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { productSchema, type ProductInput, type ProductDto } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { AiAssist } from './ai-assist';
import { CrudDialog } from './crud-dialog';
import { ProductImage } from './product-image';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Section } from './ui/layout';

function Field({
  label,
  hint,
  value,
  onChange,
  multiline = false,
  maxLength = 20000,
  url = false,
  disabled = false,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  maxLength?: number;
  url?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const props = {
    id,
    value,
    maxLength,
    disabled,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => onChange(event.target.value),
  };
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {multiline ? (
        <textarea
          {...props}
          rows={4}
          className="w-full rounded-lg border border-border bg-surface p-3 text-sm"
        />
      ) : (
        <Input {...props} type={url ? 'url' : 'text'} />
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <AiAssist text={value} onApply={onChange} disabled={disabled} />
    </div>
  );
}
const empty: ProductInput = {
  name: '',
  tagline: '',
  description: '',
  audience: '',
  benefits: '',
  terms: '',
  links: [],
  photos: [],
  videos: [],
  status: 'active',
};
export function ProductEditor({
  product,
  open,
  onOpenChange,
  onSaved,
}: {
  product?: ProductDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (product: ProductDto) => void;
}) {
  const [form, setForm] = useState<ProductInput>(() =>
    product ? productSchema.strip().parse(product) : empty,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof ProductInput>(
    key: K,
    value: ProductInput[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError('');
  };
  const save = async () => {
    const parsed = productSchema.safeParse(form);
    if (!parsed.success) {
      const key = parsed.error.issues[0]?.path[0];
      setError(
        key === 'name'
          ? uk.products.invalidName
          : key === 'tagline'
            ? uk.products.invalidTagline
            : ['links', 'photos', 'videos'].includes(String(key))
              ? uk.products.invalidMaterials
              : uk.products.invalidText,
      );
      return;
    }
    setPending(true);
    setError('');
    try {
      const response = await fetch(
        product ? `/api/products/${product.id}` : '/api/products',
        {
          method: product ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed.data),
        },
      );
      if (!response.ok) throw Error();
      onSaved(await response.json());
      onOpenChange(false);
    } catch {
      setError(uk.products.saveFailed);
    } finally {
      setPending(false);
    }
  };
  const textField = (
    key: 'name' | 'tagline' | 'description' | 'audience' | 'benefits' | 'terms',
    multiline = true,
  ) => (
    <Field
      label={uk.products[key]}
      hint={uk.products.hints[key]}
      value={form[key]}
      onChange={(value) => update(key, value)}
      multiline={multiline}
      disabled={pending}
      maxLength={key === 'name' ? 120 : key === 'tagline' ? 500 : 20000}
    />
  );
  return (
    <CrudDialog
      wide
      open={open}
      onOpenChange={onOpenChange}
      title={product ? uk.products.edit : uk.products.create}
      pending={pending}
      draft={form}
      actions={
        <>
          {error && (
            <p role="alert" className="max-w-xs text-sm text-err">
              {error}
            </p>
          )}
          <Button disabled={pending} onClick={() => void save()}>
            {pending ? uk.ai.pending : uk.ai.save}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <Section title={uk.products.main}>
          <div className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              {textField('name', false)}
              {textField('tagline', false)}
            </div>
            {textField('description')}
          </div>
        </Section>
        <Section title={uk.products.audienceSection}>
          <div className="grid gap-5 sm:grid-cols-2">
            {textField('audience')}
            {textField('benefits')}
          </div>
        </Section>
        <Section title={uk.products.termsSection}>{textField('terms')}</Section>
        <Section
          title={uk.products.materials}
          description={uk.products.materialsHint}
        >
          <div className="space-y-6">
            {(['links', 'photos', 'videos'] as const).map((kind) => {
              const limit = kind === 'links' ? 20 : kind === 'photos' ? 30 : 10;
              const values = form[kind];
              const replace = (index: number, value: string, label = false) => {
                if (kind === 'links')
                  update(
                    'links',
                    form.links.map((link, i) =>
                      i === index
                        ? { ...link, [label ? 'label' : 'url']: value }
                        : link,
                    ),
                  );
                else
                  update(
                    kind,
                    form[kind].map((url, i) => (i === index ? value : url)),
                  );
              };
              return (
                <fieldset key={kind} className="min-w-0 space-y-3">
                  <legend className="text-sm font-semibold">
                    {uk.products[kind]}{' '}
                    <span className="font-normal text-muted-foreground">
                      {values.length}/{limit}
                    </span>
                  </legend>
                  <p className="text-xs text-muted-foreground">
                    {uk.products.hints[kind]}
                  </p>
                  {values.map((value, index) => {
                    const link =
                      typeof value === 'string'
                        ? { label: '', url: value }
                        : value;
                    return (
                      <div
                        key={`${kind}:${values.length}:${index}`}
                        className="flex min-w-0 flex-wrap items-start gap-3 rounded-lg border border-border p-3"
                      >
                        {kind === 'photos' && (
                          <ProductImage
                            url={link.url}
                            alt={uk.products.photos}
                            className="size-16 shrink-0 rounded-md"
                          />
                        )}
                        <div className="grid min-w-0 flex-1 basis-52 gap-3 sm:grid-cols-2">
                          {kind === 'links' && (
                            <Field
                              label={uk.products.linkLabel}
                              disabled={pending}
                              value={link.label}
                              maxLength={120}
                              onChange={(value) => replace(index, value, true)}
                            />
                          )}
                          <div
                            className={kind === 'links' ? '' : 'sm:col-span-2'}
                          >
                            <Field
                              label={uk.products.url}
                              disabled={pending}
                              value={link.url}
                              url
                              onChange={(value) => replace(index, value)}
                            />
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          aria-label={`${uk.products.removeMaterial} ${index + 1}`}
                          onClick={() =>
                            kind === 'links'
                              ? update(
                                  'links',
                                  form.links.filter((_, i) => i !== index),
                                )
                              : update(
                                  kind,
                                  form[kind].filter((_, i) => i !== index),
                                )
                          }
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                    );
                  })}
                  <Button
                    variant="outline"
                    disabled={values.length >= limit}
                    onClick={() =>
                      kind === 'links'
                        ? update('links', [
                            ...form.links,
                            { label: '', url: '' },
                          ])
                        : update(kind, [...form[kind], ''])
                    }
                  >
                    {kind === 'links'
                      ? uk.products.addLink
                      : kind === 'photos'
                        ? uk.products.addPhoto
                        : uk.products.addVideo}
                  </Button>
                </fieldset>
              );
            })}
          </div>
        </Section>
      </div>
    </CrudDialog>
  );
}
