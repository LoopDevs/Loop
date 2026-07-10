// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException, type AdminOrderRefundResult } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import { useAuthStore } from '~/stores/auth.store';
import { RefundOrderPanel } from '../RefundOrderPanel';

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
  adminMock: { refundOrder: vi.fn() },
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
    refundOrder: (args: unknown) => adminMock.refundOrder(args),
  };
});

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
  adminMock.refundOrder.mockReset();
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
  result: AdminOrderRefundResult,
  replayed = false,
): { result: AdminOrderRefundResult; audit: Record<string, unknown> } {
  return {
    result,
    audit: {
      actorUserId: 'admin-1',
      actorEmail: 'admin@loop.test',
      idempotencyKey: 'k'.repeat(32),
      appliedAt: '2026-07-10T10:00:00.000Z',
      replayed,
    },
  };
}

function onChainResult(over?: Partial<AdminOrderRefundResult>): AdminOrderRefundResult {
  return {
    orderId: 'ord-1',
    paymentMethod: 'xlm',
    refundMethod: 'onchain_deposit_refund',
    amountMinor: '500',
    currency: 'USD',
    orderState: 'failed',
    attested: false,
    onChain: { txHash: 'tx-1' },
    mirrorCredit: null,
    ...over,
  };
}

function renderPanel(orderState = 'paid'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RefundOrderPanel orderId="ord-1" orderState={orderState} />
    </QueryClientProvider>,
  );
}

async function openDialog(): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Refund order/i }));
  });
  return waitFor(() => {
    const d = document.querySelector('dialog[open]');
    if (!(d instanceof HTMLElement)) throw new Error('no open dialog');
    return d;
  });
}

async function typeReason(dialog: HTMLElement, reason: string): Promise<void> {
  const textarea = within(dialog).getAllByRole('textbox')[0];
  if (textarea === undefined) throw new Error('no reason textarea');
  await act(async () => {
    fireEvent.change(textarea, { target: { value: reason } });
  });
}

async function submit(dialog: HTMLElement): Promise<void> {
  const form = dialog.querySelector('form');
  if (form === null) throw new Error('no dialog form');
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe('<RefundOrderPanel /> — gating', () => {
  it.each(['pending_payment', 'expired'])('self-hides for non-refundable state %s', (badState) => {
    renderPanel(badState);
    expect(screen.queryByText(/Refund order \(A5-4\)/i)).toBeNull();
  });

  it('self-hides for non-admin staff even on a refundable order', () => {
    staffRoleMock.value = {
      staffRole: 'support',
      isAdminRole: false,
      isStaff: true,
      isPending: false,
    };
    renderPanel('paid');
    expect(screen.queryByText(/Refund order \(A5-4\)/i)).toBeNull();
  });

  it.each(['paid', 'procuring', 'failed', 'fulfilled'])(
    'renders for an admin on a refundable order (%s)',
    (state) => {
      renderPanel(state);
      expect(screen.getByText(/Refund order \(A5-4\)/i)).toBeDefined();
    },
  );
});

describe('<RefundOrderPanel /> — pre-fulfilment refund (no attestation)', () => {
  it('paid order: reason → service called WITHOUT an attestation → on-chain success toast', async () => {
    adminMock.refundOrder.mockResolvedValue(envelope(onChainResult()));
    renderPanel('paid');
    const dialog = await openDialog();
    // No attestation fields on a non-fulfilled order.
    expect(within(dialog).queryByText(/This order is fulfilled/i)).toBeNull();
    await typeReason(dialog, 'customer changed their mind, worker stuck');
    await submit(dialog);
    await waitFor(() => {
      expect(adminMock.refundOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'ord-1',
          reason: 'customer changed their mind, worker stuck',
        }),
      );
    });
    const args = adminMock.refundOrder.mock.calls[0]?.[0] as { attestation?: unknown };
    expect(args.attestation).toBeUndefined();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'success' && /on-chain/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('credit order refund reports the mirror-credit success copy', async () => {
    adminMock.refundOrder.mockResolvedValue(
      envelope(
        onChainResult({
          paymentMethod: 'credit',
          refundMethod: 'mirror_credit',
          onChain: null,
          mirrorCredit: { newBalanceMinor: '500' },
        }),
      ),
    );
    renderPanel('failed');
    const dialog = await openDialog();
    await typeReason(dialog, 'refunding the credit-funded order');
    await submit(dialog);
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'success' && /credit balance/i.test(t.message)),
      ).toBe(true);
    });
  });
});

describe('<RefundOrderPanel /> — fulfilled order requires the attestation', () => {
  it('shows the double-spend warning + requires the checkbox to enable submit', async () => {
    renderPanel('fulfilled');
    const dialog = await openDialog();
    expect(within(dialog).getByText(/This order is fulfilled/i)).toBeDefined();
    expect(within(dialog).getByText(/may have already used/i)).toBeDefined();

    await typeReason(dialog, 'redemption never delivered, refunding per R3-4');
    const refundBtn = within(dialog).getByRole('button', { name: 'Refund' }) as HTMLButtonElement;
    // Reason alone is not enough on a fulfilled order — the attestation
    // checkbox must be ticked.
    expect(refundBtn.disabled).toBe(true);

    const checkbox = within(dialog).getByRole('checkbox');
    await act(async () => {
      fireEvent.click(checkbox);
    });
    // Note is still empty → still disabled.
    expect(refundBtn.disabled).toBe(true);

    const noteBox = within(dialog).getAllByRole('textbox')[1];
    if (noteBox === undefined) throw new Error('no note textbox');
    await act(async () => {
      fireEvent.change(noteBox, { target: { value: 'no redeem fields ever populated' } });
    });
    expect(refundBtn.disabled).toBe(false);
  });

  it('submits the attestation object when checkbox + note are provided', async () => {
    adminMock.refundOrder.mockResolvedValue(
      envelope(onChainResult({ orderState: 'fulfilled', attested: true })),
    );
    renderPanel('fulfilled');
    const dialog = await openDialog();
    await typeReason(dialog, 'redemption never delivered, refunding per R3-4');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('checkbox'));
    });
    const noteBox = within(dialog).getAllByRole('textbox')[1];
    if (noteBox === undefined) throw new Error('no note textbox');
    await act(async () => {
      fireEvent.change(noteBox, { target: { value: 'confirmed unused with CTX support' } });
    });
    await submit(dialog);
    await waitFor(() => {
      expect(adminMock.refundOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'ord-1',
          reason: 'redemption never delivered, refunding per R3-4',
          attestation: { codeUnused: true, attestationNote: 'confirmed unused with CTX support' },
        }),
      );
    });
  });

  it('never calls the service if submit is forced without the attestation (defence-in-depth)', async () => {
    renderPanel('fulfilled');
    const dialog = await openDialog();
    await typeReason(dialog, 'trying to refund without attesting');
    // Submit the form directly (bypassing the disabled button) — the
    // dialog's own submit() guard must still refuse.
    await submit(dialog);
    expect(adminMock.refundOrder).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/must confirm the delivered code/i)).toBeDefined();
  });
});

describe('<RefundOrderPanel /> — errors + step-up', () => {
  it('a 409 ORDER_ALREADY_REFUNDED lands as an error toast', async () => {
    adminMock.refundOrder.mockRejectedValue(
      new ApiException(409, {
        code: 'ORDER_ALREADY_REFUNDED',
        message: 'A refund has already been issued for order ord-1',
      }),
    );
    renderPanel('failed');
    const dialog = await openDialog();
    await typeReason(dialog, 'attempting a duplicate refund');
    await submit(dialog);
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /already been issued/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('401 STEP_UP_REQUIRED opens the StepUpModal instead of dead-ending', async () => {
    adminMock.refundOrder.mockRejectedValue(
      new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'Step-up required' }),
    );
    renderPanel('paid');
    const dialog = await openDialog();
    await typeReason(dialog, 'refund a stuck paid order');
    await submit(dialog);
    await waitFor(() => {
      expect(screen.getByText(/Confirm with your verification code/)).toBeDefined();
    });
  });

  it('reuses the same Idempotency-Key across the step-up retry (no double-refund)', async () => {
    adminMock.refundOrder
      .mockRejectedValueOnce(
        new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'Step-up required' }),
      )
      .mockResolvedValueOnce(envelope(onChainResult()));
    stepUpMock.requestOtp.mockResolvedValue(undefined);
    stepUpMock.mintAdminStepUp.mockResolvedValue({
      stepUpToken: 'tok',
      expiresAt: '2026-07-10T10:10:00.000Z',
    });

    renderPanel('paid');
    const dialog = await openDialog();
    await typeReason(dialog, 'refund a stuck paid order');
    await submit(dialog);

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
      expect(adminMock.refundOrder).toHaveBeenCalledTimes(2);
    });
    const firstArgs = adminMock.refundOrder.mock.calls[0]?.[0] as { idempotencyKey?: string };
    const secondArgs = adminMock.refundOrder.mock.calls[1]?.[0] as { idempotencyKey?: string };
    expect(firstArgs.idempotencyKey).toBeDefined();
    expect(secondArgs.idempotencyKey).toBe(firstArgs.idempotencyKey);
  });

  it('cancelling the dialog does not call the service', async () => {
    renderPanel('paid');
    const dialog = await openDialog();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    });
    expect(adminMock.refundOrder).not.toHaveBeenCalled();
  });
});
