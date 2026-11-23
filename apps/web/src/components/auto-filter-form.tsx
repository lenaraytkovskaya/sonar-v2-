'use client';
import React, { useEffect, useRef, type FormHTMLAttributes } from 'react';
import { useRouter } from 'next/navigation';
import { filterUrl } from '../lib/filter-url';

export function AutoFilterForm(props: FormHTMLAttributes<HTMLFormElement>) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const apply = (form: HTMLFormElement) => {
    clearTimeout(timer.current);
    if (!form.checkValidity()) return;
    const names = Array.from(form.elements).flatMap((field) =>
      'name' in field && typeof field.name === 'string' ? [field.name] : [],
    );
    router.replace(filterUrl(window.location.href, new FormData(form), names), {
      scroll: false,
    });
  };
  return (
    <form
      {...props}
      onSubmit={(event) => {
        event.preventDefault();
        apply(event.currentTarget);
      }}
      onChange={(event) => {
        clearTimeout(timer.current);
        const form = event.currentTarget;
        const field = event.target;
        if (
          field instanceof HTMLInputElement &&
          ['text', 'search', 'number'].includes(field.type)
        )
          timer.current = setTimeout(() => apply(form), 400);
        else apply(form);
      }}
    />
  );
}
