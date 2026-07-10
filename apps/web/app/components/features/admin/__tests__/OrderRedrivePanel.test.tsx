// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException, type AdminOrderRedriveResult } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import { useAuthStore } from '~/stores/auth.store';
import { OrderRedrivePanel } from '../OrderRedrivePanel';

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

const { adminMock, staffRoleMock, stepUpMock } = vi.hoisted(() => ({
  adminMock: { redriveOrder: vi.fn() },
  staffRoleMock: {
    value: {
      staffRole: 'admin' as 'admin' | 'support' | null,
      isAdminRole: true,
      isStaff: true,
      isPending: false,
    },
  },
  stepUpMock: { requestOtp: vi.fn(), mintAdminStepUp: vi.fn() },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    redriveOrder: (args: unknown) => adminMock.redriveOrder(args),
  };
});

// Bypasses the getMe/useAuth resolution chain — this is a focused
// panel test, not a route integration test (see
// admin.orders.$orderId.test.tsx for the full-page wiring).
vi.mock('~/hooks/use-staff-role', () => ({
  useStaffRole: () => staffRoleMock.value,
}));

vi.mock('~/services/auth', () => ({
  requestOtp: (email: string) => stepUpMock.requestOtp(email),
}));
vi.mock('~/services/admin-step-up', () => ({
  mintAdminStepUp: (otp: string) => stepUpMock.mintAdminStepUp(otp),
}));

beforeEach(() => {
  adminMock.redriveOrder.mockReset();
  stepUpMock.requestOtp.mockReset();
  stepUpMock.mintAdminStepUp.mockReset();
  staffRoleMock.value = {
    staffRole: 'admin',
    isAdminRole: true,
    isStaff: true,
    isPending: false,
  };
  useUiStore.setState({ toasts: [] });
  useAuthStore.setState({ email: 'admin@loop.test' });

  // jsdom doesn't ship a complete <dialog> implementation.
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

function envelope(
  result: AdminOrderRedriveResult,
  replayed = false,
): { result: AdminOrderRedriveResult; audit: Record<string, unknown> } {
  return {
    result,
    audit: {
      actorUserId: 'admin-1',
      actorEmail: 'admin@loop.test',
      idempotencyKey: 'k'.repeat(32),
      appliedAt: '2026-07-09T10:00:00.000Z',
      replayed,
    },
  };
}

function renderPanel(orderState = 'paid'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <OrderRedrivePanel orderId="ord-1" orderState={orderState} />
    </QueryClientProvider>,
  );
}

/** Click the redrive button, type a reason, submit the dialog form. */
async function redriveWithReason(reason = 'stuck for 20min, worker looks dead'): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Re-drive order/i }));
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

describe('<OrderRedrivePanel /> — gating', () => {
  it('self-hides for non-redrivable states (fulfilled)', () => {
    renderPanel('fulfilled');
    expect(screen.queryByText(/Re-drive \(A5-1\)/i)).toBeNull();
  });

  it('self-hides for a procuring order (paid-only scope — the sweep owns procuring)', () => {
    renderPanel('procuring');
    expect(screen.queryByText(/Re-drive \(A5-1\)/i)).toBeNull();
  });

  it('self-hides for non-admin staff even on a paid order (support-tier)', () => {
    staffRoleMock.value = {
      staffRole: 'support',
      isAdminRole: false,
      isStaff: true,
      isPending: false,
    };
    renderPanel('paid');
    expect(screen.queryByText(/Re-drive \(A5-1\)/i)).toBeNull();
  });

  it('renders for an admin on a paid order', () => {
    renderPanel('paid');
    expect(screen.getByText(/Re-drive \(A5-1\)/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Re-drive order/i })).toBeDefined();
  });
});

describe('<OrderRedrivePanel /> — redrive flow', () => {
  it('redrive → reason dialog → service called with orderId + reason → success toast', async () => {
    adminMock.redriveOrder.mockResolvedValue(
      envelope({ orderId: 'ord-1', outcome: 'fulfilled', state: 'fulfilled' }),
    );
    renderPanel('paid');
    await redriveWithReason('stuck for 20min, worker looks dead');
    await waitFor(() => {
      expect(adminMock.redriveOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'ord-1',
          reason: 'stuck for 20min, worker looks dead',
        }),
      );
    });
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'success' && /fulfilled/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('outcome=skipped surfaces as a success toast naming the live state', async () => {
    adminMock.redriveOrder.mockResolvedValue(
      envelope({ orderId: 'ord-1', outcome: 'skipped', state: 'procuring' }),
    );
    renderPanel('paid');
    await redriveWithReason();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'success' && /already being handled/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('outcome=failed surfaces as an error toast', async () => {
    adminMock.redriveOrder.mockResolvedValue(
      envelope({ orderId: 'ord-1', outcome: 'failed', state: 'failed' }),
    );
    renderPanel('paid');
    await redriveWithReason();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /failed again/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('cancelling the reason dialog does not call the service', async () => {
    renderPanel('paid');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Re-drive order/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(adminMock.redriveOrder).not.toHaveBeenCalled();
  });

  it('a 409 guard rejection lands as an error toast', async () => {
    // A paid order can still race into `procuring` between the page
    // load and the click; the backend then refuses with
    // ORDER_REDRIVE_IN_PROGRESS, which the panel surfaces as a toast.
    adminMock.redriveOrder.mockRejectedValue(
      new ApiException(409, {
        code: 'ORDER_REDRIVE_IN_PROGRESS',
        message: 'Order is currently procuring. A stuck procuring order is auto-recovered.',
      }),
    );
    renderPanel('paid');
    await redriveWithReason();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /auto-recovered/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('401 STEP_UP_REQUIRED opens the StepUpModal instead of dead-ending', async () => {
    adminMock.redriveOrder.mockRejectedValue(
      new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'Step-up required' }),
    );
    renderPanel('paid');
    await redriveWithReason();
    await waitFor(() => {
      expect(screen.getByText(/Confirm with your verification code/)).toBeDefined();
    });
  });

  it('reuses the same Idempotency-Key across the step-up retry (CF-09) — no double-redrive risk', async () => {
    // First call rejects with step-up, second (post-mint) resolves.
    adminMock.redriveOrder
      .mockRejectedValueOnce(
        new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'Step-up required' }),
      )
      .mockResolvedValueOnce(
        envelope({ orderId: 'ord-1', outcome: 'fulfilled', state: 'fulfilled' }),
      );
    stepUpMock.requestOtp.mockResolvedValue(undefined);
    stepUpMock.mintAdminStepUp.mockResolvedValue({
      stepUpToken: 'tok',
      expiresAt: '2026-07-09T10:10:00.000Z',
    });

    renderPanel('paid');
    await redriveWithReason('stuck for 20min, worker looks dead');

    // Modal opens; send + confirm the code.
    const sendBtn = await screen.findByRole('button', { name: /Send code/ });
    await act(async () => {
      fireEvent.click(sendBtn);
    });
    const otpInput = await screen.findByLabelText(/Verification code/);
    await act(async () => {
      fireEvent.change(otpInput, { target: { value: '123456' } });
    });
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(adminMock.redriveOrder).toHaveBeenCalledTimes(2);
    });
    const firstArgs = adminMock.redriveOrder.mock.calls[0]?.[0] as
      | { idempotencyKey?: string }
      | undefined;
    const secondArgs = adminMock.redriveOrder.mock.calls[1]?.[0] as
      | { idempotencyKey?: string }
      | undefined;
    expect(firstArgs?.idempotencyKey).toBeDefined();
    // The retry must re-send the SAME key so ADR-017 dedup collapses it
    // into the original request rather than re-driving the order twice.
    expect(secondArgs?.idempotencyKey).toBe(firstArgs?.idempotencyKey);
  });

  it('cancelling the step-up modal does not retry the write', async () => {
    adminMock.redriveOrder.mockRejectedValue(
      new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'Step-up required' }),
    );
    renderPanel('paid');
    await redriveWithReason();
    await waitFor(() => {
      expect(screen.getByText(/Confirm with your verification code/)).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /redrive failed/i.test(t.message)),
      ).toBe(true);
    });
    // Exactly the one rejected call — the cancelled step-up must not
    // produce a second (retried) call to the service.
    expect(adminMock.redriveOrder).toHaveBeenCalledTimes(1);
  });
});
