// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException, type AdminRefetchRedemptionResult } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import { OrderDeliveryPanel } from '../OrderDeliveryPanel';

afterEach(cleanup);

// ui.store resolves the initial theme via window.matchMedia at module
// import time — jsdom doesn't implement it, so stub it before any
// import pulls the store in (vi.hoisted runs pre-import).
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    refetchOrderRedemption: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    refetchOrderRedemption: (args: unknown) => adminMock.refetchOrderRedemption(args),
  };
});

beforeEach(() => {
  adminMock.refetchOrderRedemption.mockReset();
  useUiStore.setState({ toasts: [] });

  // jsdom doesn't ship a complete <dialog> implementation: showModal
  // and close are missing on HTMLDialogElement. Polyfill the minimum
  // surface ReasonDialog.tsx exercises.
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

/** ADR-017 {result, audit} envelope helper — matches the backend. */
function envelope<T>(result: T, replayed = false): { result: T; audit: Record<string, unknown> } {
  return {
    result,
    audit: {
      actorUserId: 'admin-1',
      actorEmail: 'admin@loop.test',
      idempotencyKey: 'k'.repeat(32),
      appliedAt: '2026-06-12T10:00:00.000Z',
      replayed,
    },
  };
}

function renderPanel(orderState = 'fulfilled'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <OrderDeliveryPanel orderId="ord-1" orderState={orderState} />
    </QueryClientProvider>,
  );
}

/** Click the refetch button, type a reason, submit the dialog form. */
async function refetchWithReason(reason = 'customer ticket OPS-9'): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Refetch redemption/i }));
  });
  const openDialog = await waitFor(() => {
    const d = document.querySelector('dialog[open]');
    if (!(d instanceof HTMLElement)) throw new Error('no open dialog');
    return d;
  });
  const textarea = within(openDialog).getByRole('textbox');
  await act(async () => {
    fireEvent.change(textarea, { target: { value: reason } });
  });
  const form = textarea.closest('form');
  if (form === null) throw new Error('reason dialog form not found');
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe('<OrderDeliveryPanel />', () => {
  it('self-hides for non-fulfilled orders', () => {
    renderPanel('procuring');
    expect(screen.queryByText(/Delivery \/ redemption/i)).toBeNull();
  });

  it('starts with the "not checked" status pill', () => {
    renderPanel();
    expect(screen.getByText(/redemption not checked/i)).toBeDefined();
  });

  it('refetch → reason dialog → service called → success toast + "present" pill', async () => {
    adminMock.refetchOrderRedemption.mockResolvedValue(
      envelope({
        orderId: 'ord-1',
        recovered: true,
        hasCode: true,
        hasPin: false,
        hasUrl: true,
        attempts: 4,
      } satisfies AdminRefetchRedemptionResult),
    );
    renderPanel();
    await refetchWithReason();
    await waitFor(() => {
      expect(adminMock.refetchOrderRedemption).toHaveBeenCalledWith({
        orderId: 'ord-1',
        reason: 'customer ticket OPS-9',
      });
    });
    await waitFor(() => {
      expect(screen.getByText(/redemption present/i)).toBeDefined();
    });
    // Field-presence detail (codes themselves are never echoed).
    expect(screen.getByText(/code present · PIN absent · URL present/i)).toBeDefined();
    expect(
      useUiStore
        .getState()
        .toasts.some((t) => t.type === 'success' && /customer can redeem now/i.test(t.message)),
    ).toBe(true);
  });

  it('cancelling the reason dialog does not call the service', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refetch redemption/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(adminMock.refetchOrderRedemption).not.toHaveBeenCalled();
  });

  it('already-present material lands as a 409 error toast (REDEMPTION_NOT_REFETCHABLE)', async () => {
    adminMock.refetchOrderRedemption.mockRejectedValue(
      new ApiException(409, {
        code: 'REDEMPTION_NOT_REFETCHABLE',
        message: 'Order already has a redemption payload — nothing to re-fetch',
      }),
    );
    renderPanel();
    await refetchWithReason();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /already has a redemption/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('still-missing redemption lands as an error toast + "missing" pill', async () => {
    adminMock.refetchOrderRedemption.mockResolvedValue(
      envelope({
        orderId: 'ord-1',
        recovered: false,
        hasCode: false,
        hasPin: false,
        hasUrl: false,
        attempts: 5,
      } satisfies AdminRefetchRedemptionResult),
    );
    renderPanel();
    await refetchWithReason();
    await waitFor(() => {
      expect(screen.getByText(/redemption missing/i)).toBeDefined();
    });
    expect(
      useUiStore
        .getState()
        .toasts.some((t) => t.type === 'error' && /still missing/i.test(t.message)),
    ).toBe(true);
  });

  it('surfaces a transport failure as an error toast and keeps "not checked"', async () => {
    adminMock.refetchOrderRedemption.mockRejectedValue(
      new ApiException(503, {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Operator pool unavailable — retry once CTX recovers',
      }),
    );
    renderPanel();
    await refetchWithReason();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /Operator pool unavailable/.test(t.message)),
      ).toBe(true);
    });
    expect(screen.getByText(/redemption not checked/i)).toBeDefined();
  });
});
