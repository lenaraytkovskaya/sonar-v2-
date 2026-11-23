import type { ChangeEvent } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoFilterForm } from './auto-filter-form';

const state = vi.hoisted(() => ({
  replace: vi.fn(),
  cleanups: [] as (() => void)[],
}));
vi.mock('next/navigation', () => ({ useRouter: () => state }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: () => ({ current: undefined }),
  useEffect: (effect: () => () => void) => state.cleanups.push(effect()),
}));
class InputField {
  constructor(public type: string) {}
}
function setup() {
  const form = {
    elements: [{ name: 'q' }, { name: 'channel' }, { name: 'unread' }],
    values: [] as [string, string][],
    checkValidity: vi.fn(() => true),
  };
  vi.stubGlobal(
    'FormData',
    class extends Map<string, string> {
      constructor(value: typeof form) {
        super(value.values);
      }
    },
  );
  const element = AutoFilterForm({});
  const change = (target: object) =>
    element.props.onChange({
      currentTarget: form,
      target,
    } as unknown as ChangeEvent<HTMLFormElement>);
  return { form, change };
}
beforeEach(() => {
  vi.useFakeTimers();
  state.replace.mockClear();
  vi.stubGlobal('HTMLInputElement', InputField);
  vi.stubGlobal('window', {
    location: { href: 'https://sonar.test/inbox?unread=1&conversation=old' },
  });
});
afterEach(() => {
  state.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('navigates immediately for selects and clears unchecked URL filters', () => {
  const { form, change } = setup();
  form.values = [['channel', 'email']];
  change({ tagName: 'SELECT' });
  expect(state.replace).toHaveBeenCalledWith('/inbox?channel=email', {
    scroll: false,
  });
});

it('waits 400ms after the latest text change before navigating', () => {
  const { form, change } = setup();
  form.values = [['q', 'first']];
  change(new InputField('text'));
  vi.advanceTimersByTime(399);
  expect(state.replace).not.toHaveBeenCalled();
  form.values = [['q', 'latest']];
  change(new InputField('text'));
  vi.advanceTimersByTime(399);
  expect(state.replace).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(state.replace).toHaveBeenCalledExactlyOnceWith('/inbox?q=latest', {
    scroll: false,
  });
});

it('applies checkboxes immediately with pending text and cancels its delayed navigation', () => {
  const { form, change } = setup();
  form.values = [['q', 'pending']];
  change(new InputField('search'));
  form.values.push(['unread', '1']);
  change(new InputField('checkbox'));
  expect(state.replace).toHaveBeenCalledExactlyOnceWith(
    '/inbox?q=pending&unread=1',
    { scroll: false },
  );
  vi.advanceTimersByTime(400);
  expect(state.replace).toHaveBeenCalledTimes(1);
});

it('cancels delayed navigation when the form unmounts', () => {
  const { change } = setup();
  change(new InputField('text'));
  state.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.advanceTimersByTime(400);
  expect(state.replace).not.toHaveBeenCalled();
});
