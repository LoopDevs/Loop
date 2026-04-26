// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { MerchantResyncButton } from '../MerchantResyncButton';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    resyncMerchants: vi.fn(),
  },
}));

// A2-509: service takes `{ reason }` and returns an ADR-017 envelope.
// A2-1107: prompt source migrated from window.prompt to the
// ReasonDialog native-<dialog> component; tests now interact with
// the dialog form directly.
vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    resyncMerchants: (args: { reason: string }) => adminMock.resyncMerchants(args),
  };
});

/** Wrap result in the ADR-017 {result, audit} envelope — matches backend. */
function envelope<T>(result: T): { result: T; audit: Record<string, unknown> } {
  return {
    result,
    audit: {
      actorUserId: 'admin',
      actorEmail: 'a@loop.test',
      idempotencyKey: 'k'.repeat(32),
      appliedAt: '2026-04-22T14:00:00.000Z',
      replayed: false,
    },
  };
}

beforeEach(() => {
  // jsdom doesn't ship a complete <dialog> implementation: showModal
  // and close are missing on HTMLDialogElement. Polyfill the minimum
  // surface ReasonDialog.tsx exercises so the dialog opens / closes
  // in tests without a heavier vendor dep.

  const proto = HTMLDialogElement.prototype as any;
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

function renderButton(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MerchantResyncButton />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  adminMock.resyncMerchants.mockReset();
});

/**
 * Open the reason dialog by clicking the "Resync catalog" button,
 * then enter `reason` in the textarea and submit the form. jsdom's
 * `<dialog method="dialog">` form-submission semantics aren't
 * complete — `fireEvent.click` on a type=submit button doesn't
 * always fire the form's onSubmit. Use `fireEvent.submit` on the
 * form directly so the React handler runs deterministically.
 */
async function submitReasonDialog(reason: string): Promise<void> {
  // Open dialog
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Resync catalog/i }));
  });
  const textarea = await screen.findByRole('textbox');
  await act(async () => {
    fireEvent.change(textarea, { target: { value: reason } });
  });
  const form = textarea.closest('form');
  if (form === null) throw new Error('reason dialog form not found');
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe('<MerchantResyncButton />', () => {
  it('flashes the synced merchant count on triggered: true', async () => {
    adminMock.resyncMerchants.mockResolvedValue(
      envelope({
        merchantCount: 473,
        loadedAt: '2026-04-22T14:00:00.000Z',
        triggered: true,
      }),
    );
    renderButton();
    await submitReasonDialog('ops-initiated resync');
    await waitFor(() => {
      expect(screen.getByText(/Synced 473 merchants/i)).toBeDefined();
    });
  });

  it('flashes "Already in sync" on coalesced responses (triggered: false)', async () => {
    adminMock.resyncMerchants.mockResolvedValue(
      envelope({
        merchantCount: 10,
        loadedAt: '2026-04-22T14:00:00.000Z',
        triggered: false,
      }),
    );
    renderButton();
    await submitReasonDialog('ops-initiated resync');
    await waitFor(() => {
      expect(screen.getByText(/Already in sync/i)).toBeDefined();
    });
  });

  it('renders an upstream-error message on 502', async () => {
    adminMock.resyncMerchants.mockRejectedValue(
      new ApiException(502, {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to refresh merchant catalog from upstream',
      }),
    );
    renderButton();
    await submitReasonDialog('ops-initiated resync');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Upstream CTX refused the sweep/i);
  });

  it('renders a rate-limit message on 429', async () => {
    adminMock.resyncMerchants.mockRejectedValue(
      new ApiException(429, { code: 'RATE_LIMITED', message: 'Too many requests' }),
    );
    renderButton();
    await submitReasonDialog('ops-initiated resync');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Too many resyncs/i);
  });

  it('disables the button while the request is in flight', async () => {
    let resolve!: (v: unknown) => void;
    adminMock.resyncMerchants.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderButton();
    await submitReasonDialog('ops-initiated resync');
    await waitFor(() => {
      const triggers = screen
        .getAllByRole('button', { name: /Resync/i })
        .filter((b) => b.textContent?.includes('Resyncing…'));
      expect(triggers.length).toBeGreaterThan(0);
    });
    const triggerBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('Resyncing…')) as HTMLButtonElement;
    expect(triggerBtn.disabled).toBe(true);
    // Let the promise settle so the test harness doesn't hang.
    await act(async () => {
      resolve(envelope({ merchantCount: 0, loadedAt: '2026-01-01T00:00:00Z', triggered: true }));
    });
  });

  // A2-509 / A2-1107: dialog-cancelled (Cancel button) → no-op, no
  // mutation fires.
  it('A2-509: does nothing when the reason dialog is cancelled', async () => {
    renderButton();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Resync catalog/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    });
    expect(adminMock.resyncMerchants).not.toHaveBeenCalled();
  });

  it('A2-509: rejects a too-short reason without firing the mutation', async () => {
    renderButton();
    // ReasonDialog ignores leading/trailing whitespace, so a single
    // non-blank char trips the 2-char floor.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Resync catalog/i }));
    });
    const textarea = await screen.findByRole('textbox');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'x' } });
    });
    const form = textarea.closest('form');
    if (form === null) throw new Error('reason dialog form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(adminMock.resyncMerchants).not.toHaveBeenCalled();
    // ReasonDialog renders its own validation message inside the dialog
    // form. The dialog already shows the static "2–500 characters"
    // helper text, so match the specific error sentence the component
    // emits when validation fails.
    expect(screen.getByText(/Reason must be 2–500 characters/)).toBeDefined();
  });
});
