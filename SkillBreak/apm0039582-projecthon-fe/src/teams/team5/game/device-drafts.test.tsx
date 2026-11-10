import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearDrafts, DraftOwner, useDeviceDraft } from './device-drafts';
import type { ReactNode } from 'react';

beforeEach(() => clearDrafts());
afterEach(() => vi.restoreAllMocks());
it('retains drafts across remounts, synchronizes readers and isolates sessions', () => {
  const first = renderHook(() => useDeviceDraft('session-1', 'sql'));
  act(() => first.result.current[1]('SELECT 1'));
  first.unmount();
  const restored = renderHook(() => useDeviceDraft('session-1', 'sql'));
  const other = renderHook(() => useDeviceDraft('session-2', 'sql'));
  expect(restored.result.current[0]).toBe('SELECT 1');
  expect(other.result.current[0]).toBe('');
  act(() => { localStorage.setItem('t5-draft::session-1:sql', 'SELECT 2'); window.dispatchEvent(new Event('storage')); });
  expect(restored.result.current[0]).toBe('SELECT 2');
  act(() => clearDrafts('session-1'));
  expect(restored.result.current[0]).toBe('');
});

it('isolates owners, preserves empty edits and falls back when writes are blocked', () => {
  const first = renderHook(() => useDeviceDraft('shared-session', 'password'), {
    wrapper: ({ children }: { children: ReactNode }) => <DraftOwner.Provider value="owner-1">{children}</DraftOwner.Provider>,
  });
  const other = renderHook(() => useDeviceDraft('shared-session', 'password'), {
    wrapper: ({ children }: { children: ReactNode }) => <DraftOwner.Provider value="owner-2">{children}</DraftOwner.Provider>,
  });
  act(() => first.result.current[1]('puzzle-password'));
  expect(other.result.current[0]).toBe('');
  act(() => first.result.current[1](''));
  expect(first.result.current[0]).toBe('');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked'); });
  act(() => first.result.current[1]('retained in memory'));
  act(() => window.dispatchEvent(new Event('storage')));
  expect(first.result.current[0]).toBe('retained in memory');
  act(() => clearDrafts());
  expect(first.result.current[0]).toBe('');
});