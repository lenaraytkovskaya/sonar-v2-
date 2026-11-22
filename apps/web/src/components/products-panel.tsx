'use client';
import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';
import type { ProductDto } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { CrudButton } from './crud-dialog';
import { ProductEditor } from './product-editor';
import { ProductImage } from './product-image';
import { Card, EmptyState, PageHeader, StatusBadge } from './shared';
import { Button } from './ui/button';
import { Callout } from './ui/layout';
import { RowActions } from './ui/row-actions';

type Filter = 'all' | 'active' | 'archived';
export function ProductsPanel() {
  const [products, setProducts] = useState<ProductDto[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [editor, setEditor] = useState<ProductDto | 'new' | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/products');
      if (!response.ok) throw Error();
      setProducts((await response.json()).products);
    } catch {
      setError(uk.products.loadFailed);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const saved = (product: ProductDto) => {
    setProducts((current) =>
      current.some((row) => row.id === product.id)
        ? current.map((row) => (row.id === product.id ? product : row))
        : [product, ...current],
    );
    setError('');
  };
  const changeStatus = async (product: ProductDto) => {
    setPending(product.id);
    setError('');
    try {
      const response = await fetch(`/api/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: product.status === 'active' ? 'archived' : 'active',
        }),
      });
      if (!response.ok) throw Error();
      saved(await response.json());
    } catch {
      setError(uk.products.updateFailed);
    } finally {
      setPending(null);
    }
  };
  const visible = products.filter(
    (product) => filter === 'all' || product.status === filter,
  );
  return (
    <>
      <PageHeader
        title={uk.pages.products.title}
        description={uk.pages.products.description}
        actions={
          <CrudButton
            variant="default"
            disabled={loading || Boolean(pending)}
            onClick={() => setEditor('new')}
          >
            {uk.products.create}
          </CrudButton>
        }
      />
      <div className="space-y-6">
        <div
          role="group"
          aria-label={uk.products.filterLabel}
          className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-chip p-1"
        >
          {(['all', 'active', 'archived'] as const).map((status) => (
            <Button
              key={status}
              variant={filter === status ? 'tabActive' : 'tab'}
              aria-pressed={filter === status}
              onClick={() => setFilter(status)}
            >
              {uk.products.filters[status]}{' '}
              <span className="tabular-nums">
                {status === 'all'
                  ? products.length
                  : products.filter((product) => product.status === status)
                      .length}
              </span>
            </Button>
          ))}
        </div>
        {loading && (
          <p role="status" className="text-sm text-muted-foreground">
            {uk.products.loading}
          </p>
        )}
        {pending && (
          <p role="status" className="text-sm text-muted-foreground">
            {uk.ai.pending}
          </p>
        )}
        {error && (
          <div role="alert" className="space-y-3">
            <Callout tone="err">{error}</Callout>
            <Button
              variant="outline"
              disabled={loading || Boolean(pending)}
              onClick={() => void load()}
            >
              {uk.products.retry}
            </Button>
          </div>
        )}
        {!loading && !error && !visible.length && (
          <EmptyState
            icon={<Package className="size-6" />}
            title={
              products.length
                ? uk.products.emptyFilter
                : uk.pages.products.empty
            }
            description={
              products.length
                ? uk.products.emptyFilterHint
                : uk.pages.products.detail
            }
          />
        )}
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((product) => (
            <Card
              key={product.id}
              aria-busy={pending === product.id}
              className="min-w-0 overflow-hidden"
            >
              {product.photos[0] && (
                <ProductImage
                  url={product.photos[0]}
                  alt={product.name}
                  className="aspect-video w-full"
                />
              )}
              <div className="space-y-3 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <h2 className="text-base font-semibold [overflow-wrap:anywhere]">
                      <button
                        type="button"
                        className="text-left hover:underline"
                        aria-haspopup="dialog"
                        disabled={loading || Boolean(pending)}
                        onClick={() => setEditor(product)}
                      >
                        {product.name}
                      </button>
                    </h2>
                    <StatusBadge status={product.status}>
                      {uk.products.statuses[product.status]}
                    </StatusBadge>
                  </div>
                  <RowActions
                    disabled={loading || Boolean(pending)}
                    actions={[
                      {
                        kind: 'edit',
                        label: uk.products.edit,
                        onSelect: () => setEditor(product),
                      },
                      {
                        kind: product.status === 'active' ? 'hide' : 'restart',
                        label:
                          product.status === 'active'
                            ? uk.products.archive
                            : uk.products.restore,
                        onSelect: () => void changeStatus(product),
                      },
                    ]}
                  />
                </div>
                {product.tagline && (
                  <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                    {product.tagline}
                  </p>
                )}
              </div>
            </Card>
          ))}
        </div>
      </div>
      {editor !== null && (
        <ProductEditor
          key={editor === 'new' ? 'new' : editor.id}
          product={editor === 'new' ? undefined : editor}
          open
          onOpenChange={(open) => {
            if (!open) setEditor(null);
          }}
          onSaved={saved}
        />
      )}
    </>
  );
}
