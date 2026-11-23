'use client';
import { useState, useEffect, type ReactNode, type CSSProperties } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import * as Dialog from '@radix-ui/react-dialog';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import {
  Radar,
  LayoutDashboard,
  Megaphone,
  Package,
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
import {
  FailureBadge,
  TasksProvider,
  WorkerStatus,
} from '@/components/task-overview';
import { uk } from '@/i18n/uk';
import { logout } from '@/app/login/actions';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { MessageNotifier } from './message-notifier';
import { SocialSessionNotices } from './social-session-notices';
import { BuildVersion } from './build-version';
import { PageHeaderContext } from './page-header';
const links = [
  ['/', 'overview', LayoutDashboard],
  ['/campaigns', 'campaigns', Megaphone],
  ['/products', 'products', Package],
  ['/companies', 'companies', Building2],
  ['/inbox', 'inbox', Inbox],
  ['/channels', 'channels', Radio],
  ['/finance', 'finance', Wallet],
  ['/settings', 'settings', Settings],
] as const;
export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5 font-heading text-xl font-bold">
      <Radar aria-hidden="true" className="size-6 text-accent" />
      {uk.appName}
    </span>
  );
}
export function ThemeSelect() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <label className="flex min-h-9 items-center gap-3 text-sm text-muted-foreground">
      <span>{uk.theme}</span>
      <select
        aria-label={uk.theme}
        value={mounted ? theme : 'system'}
        onChange={(event) => setTheme(event.target.value)}
        className="min-h-9 min-w-0 rounded-lg border border-border bg-surface px-2 text-foreground"
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
  const inbox = path === '/inbox';
  const [inboxHeight, setInboxHeight] = useState<number>();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!inbox || !viewport) return;
    const update = () => {
      if (viewport.scale === 1) setInboxHeight(viewport.height);
    };
    update();
    viewport.addEventListener('resize', update);
    return () => viewport.removeEventListener('resize', update);
  }, [inbox]);
  const [open, setOpen] = useState(false);
  const [titleTarget, setTitleTarget] = useState<HTMLDivElement | null>(null);
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const current = links.find(([href]) =>
    href === '/' ? path === '/' : path === href || path.startsWith(href + '/'),
  )?.[1];
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
              'flex min-h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium',
              href === '/settings' && 'mt-auto',
              active
                ? 'bg-surface text-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-surface/70 hover:text-foreground',
            )}
          >
            <Icon
              aria-hidden="true"
              className={cn('size-4', active && 'text-accent')}
            />
            {uk.pages[key].title}
            {key === 'overview' && <FailureBadge />}
            {key === 'inbox' && <FailureBadge inbox />}
          </Link>
        );
      })}
    </nav>
  );
  return (
    <TasksProvider>
      <MessageNotifier />
      <div
        style={
          inbox && inboxHeight
            ? ({
                height: inboxHeight,
                '--inbox-height': `${inboxHeight}px`,
              } as CSSProperties)
            : undefined
        }
        className={cn(
          'min-h-dvh bg-background md:grid md:grid-cols-[232px_minmax(0,1fr)]',
          inbox && 'flex h-dvh min-h-0 flex-col overflow-hidden md:grid',
        )}
      >
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-surface focus:p-3"
        >
          {uk.skip}
        </a>
        <aside className="sticky top-0 hidden h-dvh flex-col gap-6 px-3 py-4 md:flex">
          <Link href="/" className="px-2">
            <Logo />
          </Link>
          {navigation}
          <ThemeSelect />
          <BuildVersion />
        </aside>
        {/* Inset panel (shadcn sidebar-inset): the page sits on a raised sheet beside the sidebar. */}
        <div
          className={cn(
            'min-w-0 md:py-2 md:pr-2',
            inbox && 'flex min-h-0 flex-1 flex-col',
          )}
        >
          <div
            className={cn(
              'flex min-h-dvh flex-col bg-surface md:min-h-[calc(100dvh-1rem)] md:rounded-xl md:border md:border-border md:shadow-xs',
              inbox && 'min-h-0 flex-1 overflow-hidden md:min-h-0',
            )}
          >
            <header className="grid min-h-16 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border px-4 py-2 md:grid-cols-[minmax(0,1fr)_auto_auto] md:px-6">
              <div className="flex items-center md:hidden">
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
                      <BuildVersion />
                    </Dialog.Content>
                  </Dialog.Portal>
                </Dialog.Root>
              </div>
              <div className="group min-w-0 md:col-start-1 md:row-start-1">
                <div ref={setTitleTarget} />
                <p className="truncate text-sm font-medium group-has-[h1]:hidden">
                  {current ? uk.pages[current].title : ''}
                </p>
              </div>
              <div
                ref={setActionsTarget}
                className="col-span-3 row-start-2 flex min-w-0 max-w-full flex-wrap items-center gap-2 pt-2 empty:hidden md:col-span-1 md:col-start-2 md:row-start-1 md:pt-0 [&_button]:max-w-full [&_form]:max-w-full [&_form]:min-w-0 [&_select]:max-w-full"
              />
              <div className="col-start-3 row-start-1 min-w-0">
                <Dropdown.Root>
                  <Dropdown.Trigger asChild>
                    <Button
                      variant="ghost"
                      aria-label={uk.userMenu}
                      className="max-w-24 md:max-w-40"
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
                            className="flex min-h-9 w-full items-center gap-3 rounded-lg px-3 text-sm hover:bg-chip"
                          >
                            <LogOut aria-hidden="true" className="size-4" />
                            {uk.logout}
                          </button>
                        </Dropdown.Item>
                      </form>
                    </Dropdown.Content>
                  </Dropdown.Portal>
                </Dropdown.Root>
              </div>
            </header>
            <WorkerStatus />
            <main
              id="content"
              tabIndex={-1}
              className={cn(
                'mx-auto w-full max-w-[1760px] px-4 py-5 md:px-8 md:py-7',
                inbox && 'max-w-none min-h-0 flex-1 overflow-hidden p-2 md:p-3',
              )}
            >
              <SocialSessionNotices />
              <PageHeaderContext.Provider
                value={{ title: titleTarget, actions: actionsTarget }}
              >
                {children}
              </PageHeaderContext.Provider>
            </main>
          </div>
        </div>
      </div>
    </TasksProvider>
  );
}
