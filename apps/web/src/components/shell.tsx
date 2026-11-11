'use client';
import { useState, useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import * as Dialog from '@radix-ui/react-dialog';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import {
  Radar,
  LayoutDashboard,
  Megaphone,
  Building2,
  Inbox,
  Radio,
  Wallet,
  Settings,
  Menu,
  X,
  LogOut,
  ChevronDown,
} from 'lucide-react';
import { FailureBadge, TasksProvider } from '@/components/task-overview';
import { uk } from '@/i18n/uk';
import { logout } from '@/app/login/actions';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
const links = [
  ['/', 'overview', LayoutDashboard],
  ['/campaigns', 'campaigns', Megaphone],
  ['/companies', 'companies', Building2],
  ['/inbox', 'inbox', Inbox],
  ['/channels', 'channels', Radio],
  ['/finance', 'finance', Wallet],
  ['/settings', 'settings', Settings],
] as const;
export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5 font-heading text-2xl font-bold">
      <Radar aria-hidden="true" className="size-8 text-accent" />
      {uk.appName}
    </span>
  );
}
export function ThemeSelect() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <label className="flex min-h-11 items-center gap-3 text-sm text-muted-foreground">
      <span>{uk.theme}</span>
      <select
        aria-label={uk.theme}
        value={mounted ? theme : 'system'}
        onChange={(event) => setTheme(event.target.value)}
        className="min-h-11 min-w-0 rounded-lg border border-border bg-surface px-2 text-foreground"
      >
        {Object.entries(uk.themes).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
export function Shell({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const navigation = (
    <nav aria-label={uk.navigation} className="flex flex-1 flex-col gap-1">
      {links.map(([href, key, Icon]) => {
        const active =
          href === '/'
            ? path === '/'
            : path === href || path.startsWith(href + '/');
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium',
              href === '/settings' && 'mt-auto',
              active
                ? 'bg-chip text-accent'
                : 'text-muted-foreground hover:bg-raised hover:text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-5" />
            {uk.pages[key].title}
            {key === 'overview' && <FailureBadge />}
          </Link>
        );
      })}
    </nav>
  );
  return (
    <TasksProvider>
      <div className="min-h-dvh md:grid md:grid-cols-[240px_minmax(0,1fr)]">
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-surface focus:p-3"
        >
          {uk.skip}
        </a>
        <aside className="sticky top-0 hidden h-dvh flex-col gap-8 border-r border-border bg-surface p-5 md:flex">
          <Link href="/" className="px-2">
            <Logo />
          </Link>
          {navigation}
          <ThemeSelect />
        </aside>
        <div className="min-w-0">
          <header className="flex min-h-20 items-center justify-between gap-3 border-b border-border bg-surface px-5 md:justify-end md:px-10">
            <div className="flex items-center gap-3 md:hidden">
              <Dialog.Root open={open} onOpenChange={setOpen}>
                <Dialog.Trigger asChild>
                  <Button
                    variant="ghost"
                    className="px-2"
                    aria-label={uk.openMenu}
                  >
                    <Menu />
                  </Button>
                </Dialog.Trigger>
                <Dialog.Portal>
                  <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
                  <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[90vw] flex-col gap-6 border-r border-border bg-surface p-5">
                    <div className="flex items-center justify-between">
                      <Dialog.Title>
                        <Logo />
                      </Dialog.Title>
                      <Dialog.Close asChild>
                        <Button
                          variant="ghost"
                          className="px-2"
                          aria-label={uk.closeMenu}
                        >
                          <X />
                        </Button>
                      </Dialog.Close>
                    </div>
                    <Dialog.Description className="sr-only">
                      {uk.navigation}
                    </Dialog.Description>
                    {navigation}
                    <ThemeSelect />
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
              <Logo />
            </div>
            <Dropdown.Root>
              <Dropdown.Trigger asChild>
                <Button
                  variant="ghost"
                  aria-label={uk.userMenu}
                  className="max-w-40 md:max-w-64"
                >
                  <span className="truncate">{name}</span>
                  <ChevronDown />
                </Button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content
                  align="end"
                  sideOffset={8}
                  className="z-50 min-w-44 rounded-xl border border-border bg-surface p-1 shadow-lg"
                >
                  <form action={logout}>
                    <Dropdown.Item
                      asChild
                      onSelect={(event) => event.preventDefault()}
                    >
                      <button
                        type="submit"
                        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm hover:bg-chip"
                      >
                        <LogOut aria-hidden="true" className="size-4" />
                        {uk.logout}
                      </button>
                    </Dropdown.Item>
                  </form>
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          </header>
          <main
            id="content"
            tabIndex={-1}
            className="mx-auto max-w-7xl p-5 py-8 md:p-10"
          >
            {children}
          </main>
        </div>
      </div>
    </TasksProvider>
  );
}
