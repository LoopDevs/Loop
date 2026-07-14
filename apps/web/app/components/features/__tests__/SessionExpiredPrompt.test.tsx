// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type * as ReactRouter from 'react-router';
import type { SessionExpiredEvent } from '~/services/api-client';

// Capture the listener the component registers so the test can fire the
// transport's session-expiry event directly, exercising the component in
// isolation from the fetch/refresh machinery (covered in
// services/__tests__/api-client.test.ts).
let capturedListener: ((event: SessionExpiredEvent) => void) | null = null;
const unsubscribe = vi.fn();
vi.mock('~/services/api-client', () => ({
  onSessionExpired: (listener: (event: SessionExpiredEvent) => void) => {
    capturedListener = listener;
    return unsubscribe;
  },
}));

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof ReactRouter>('react-router');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { SessionExpiredPrompt } from '../SessionExpiredPrompt';

function fireSessionExpired(code = 'UNAUTHORIZED'): void {
  act(() => {
    capturedListener?.({ code, requestId: undefined });
  });
}

beforeEach(() => {
  capturedListener = null;
  unsubscribe.mockReset();
  mockNavigate.mockReset();

  // jsdom ships an incomplete <dialog> — polyfill the minimum surface
  // the component uses (same shim as StepUpModal / ReasonDialog tests).
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
    open?: boolean;
  };
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
});
afterEach(cleanup);

describe('SessionExpiredPrompt (FE-40)', () => {
  it('stays closed until a session-expiry event fires', () => {
    render(
      <MemoryRouter>
        <SessionExpiredPrompt />
      </MemoryRouter>,
    );
    // Native <dialog> keeps its children in the DOM even when closed;
    // the `open` attribute is what governs whether it's shown as a
    // modal. Assert it isn't shown before any event fires.
    const dialog = document.querySelector('dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.hasAttribute('open')).toBe(false);
  });

  it('renders a re-auth prompt (not a generic error) when the session expires', () => {
    render(
      <MemoryRouter>
        <SessionExpiredPrompt />
      </MemoryRouter>,
    );

    fireSessionExpired();

    // The user gets a clear "sign in again" re-auth surface, shown modally.
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(screen.getByText(/your session expired/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /sign in again/i })).toBeDefined();
  });

  it('routes to the sign-in surface when the user chooses to re-auth', () => {
    render(
      <MemoryRouter>
        <SessionExpiredPrompt />
      </MemoryRouter>,
    );

    fireSessionExpired();
    fireEvent.click(screen.getByRole('button', { name: /sign in again/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/auth');
  });

  it('unsubscribes from the transport on unmount', () => {
    const { unmount } = render(
      <MemoryRouter>
        <SessionExpiredPrompt />
      </MemoryRouter>,
    );
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
