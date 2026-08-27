// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

const mockCopy = vi.fn<(text: string) => Promise<boolean>>();
const mockShare =
  vi.fn<
    (opts: {
      title: string;
      text: string;
      imageUrl?: string;
      imageFilename?: string;
    }) => Promise<boolean>
  >();
const mockHaptic = vi.fn<(type: 'success' | 'warning' | 'error') => Promise<void>>();

vi.mock('~/native/clipboard', () => ({
  copyToClipboard: (t: string) => mockCopy(t),
  // PurchaseComplete copies the gift-card code/PIN via `copySensitive`
  // (FE-05 auto-clear); the auto-clear itself is unit-tested in
  // native/__tests__/clipboard-sensitive.test.ts, so here we just proxy
  // the write assertion through the same mock.
  copySensitive: (t: string) => mockCopy(t),
}));
vi.mock('~/native/share', () => ({
  nativeShare: (o: { title: string; text: string; imageUrl?: string; imageFilename?: string }) =>
    mockShare(o),
}));
vi.mock('~/native/haptics', () => ({
  triggerHapticNotification: (t: 'success' | 'warning' | 'error') => mockHaptic(t),
}));
// jsbarcode is dynamically imported inside the component; the test env has
// no canvas, so mock the module to a harmless no-op.
vi.mock('jsbarcode', () => ({ default: () => undefined }));
// ADR 050: the barcode image arrives as an authed blob fetch by order id.
const mockFetchBarcode = vi.fn<(id: string) => Promise<Blob>>();
vi.mock('~/services/orders', () => ({
  fetchOrderBarcodeImage: (id: string) => mockFetchBarcode(id),
}));

import { PurchaseComplete } from '../PurchaseComplete';

beforeEach(() => {
  mockCopy.mockResolvedValue(true);
  mockShare.mockResolvedValue(true);
  mockHaptic.mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PurchaseComplete', () => {
  it('renders the gift card code prominently', () => {
    render(<PurchaseComplete merchantName="Target" code="GC-ABCD-1234" />);
    // The redesigned card puts the merchant name in the header band
    // and the code in a pill-shaped CodeField row.
    expect(screen.getByText('GC-ABCD-1234')).toBeDefined();
    expect(screen.getByText('Target')).toBeDefined();
  });

  it('renders the PIN only when provided', () => {
    const { rerender } = render(<PurchaseComplete merchantName="Target" code="CODE" />);
    // PIN section is a CodeField labelled "PIN" — absent when no
    // pin is passed, present when provided.
    expect(screen.queryByText('PIN')).toBeNull();
    rerender(<PurchaseComplete merchantName="Target" code="CODE" pin="9876" />);
    expect(screen.getByText('PIN')).toBeDefined();
    expect(screen.getByText('9876')).toBeDefined();
  });

  it('fires a success haptic on mount', () => {
    render(<PurchaseComplete merchantName="Target" code="CODE" />);
    expect(mockHaptic).toHaveBeenCalledWith('success');
  });

  it('copies the code when the copy button is clicked', async () => {
    render(<PurchaseComplete merchantName="Target" code="GC-CODE" />);
    await act(async () => {
      // Per-field copy buttons are labelled "Copy code" / "Copy pin"
      // via aria-label; querying by accessible name picks them up.
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(mockCopy).toHaveBeenCalledWith('GC-CODE');
  });

  it('shows "Copied" confirmation after a successful copy', async () => {
    render(<PurchaseComplete merchantName="Target" code="CODE" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    // Confirmation swaps the button text from "Copy" to "Copied"
    // (no exclamation — the redesign uses a quieter voice).
    expect(screen.getByText('Copied')).toBeDefined();
  });

  it('does not show "Copied" when the copy fails', async () => {
    mockCopy.mockResolvedValueOnce(false);
    render(<PurchaseComplete merchantName="Target" code="CODE" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('invokes nativeShare with merchant + code + PIN + barcode attachment', async () => {
    render(<PurchaseComplete merchantName="Target" code="CODE" pin="PIN" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    });
    // Share now also carries the barcode image — client-side canvas
    // snapshot when no CTX imageUrl is supplied. Match loosely on
    // imageUrl so the test doesn't break on any canvas toDataURL
    // implementation detail, but still asserts the field is
    // populated as a PNG data URL.
    expect(mockShare).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Target Gift Card',
        text: 'Gift card code: CODE\nPIN: PIN',
        imageFilename: 'target-gift-card.png',
      }),
    );
  });

  it('omits the PIN line from the shared text when there is no PIN', async () => {
    render(<PurchaseComplete merchantName="Target" code="CODE" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    });
    expect(mockShare).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Target Gift Card',
        text: 'Gift card code: CODE',
      }),
    );
  });

  it('renders an aria-labelled canvas for the barcode', () => {
    const { container } = render(<PurchaseComplete merchantName="Target" code="CODE-ABC" />);
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas!.getAttribute('aria-label')).toBe('Barcode for gift card code CODE-ABC');
  });

  it('fetches the upstream barcode through the authed proxy and renders the blob', async () => {
    mockFetchBarcode.mockResolvedValue(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    const createObjectURL = vi.fn(() => 'blob:mock-barcode');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    try {
      render(<PurchaseComplete merchantName="Target" code="CODE-ABC" barcodeOrderId="order-1" />);
      const image = await screen.findByRole('img', {
        name: 'Barcode for gift card code CODE-ABC',
      });
      expect(mockFetchBarcode).toHaveBeenCalledWith('order-1');
      expect(image.getAttribute('src')).toBe('blob:mock-barcode');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the canvas barcode when the authed fetch fails', async () => {
    mockFetchBarcode.mockRejectedValue(new Error('401'));
    render(<PurchaseComplete merchantName="Target" code="CODE-ABC" barcodeOrderId="order-1" />);
    // The canvas fallback carries the same aria-label.
    await vi.waitFor(() => {
      expect(
        document.querySelector('canvas[aria-label="Barcode for gift card code CODE-ABC"]'),
      ).not.toBeNull();
    });
  });
});

// WUM-10 (2026-06-30 cold audit): CF-35's aria-live copy-confirmation
// pattern rolled out from PaymentStep to PurchaseComplete's CodeField —
// the redemption-value surface (gift-card code/PIN).
describe('PurchaseComplete — aria-live copy confirmation (WUM-10)', () => {
  it('announces the code copy to assistive tech', async () => {
    render(<PurchaseComplete merchantName="Target" code="GC-CODE" pin="9876" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(screen.getByText('Code copied to clipboard.')).toBeDefined();
  });

  it('announces the PIN copy distinctly from the code', async () => {
    render(<PurchaseComplete merchantName="Target" code="GC-CODE" pin="9876" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy pin' }));
    });
    expect(screen.getByText('PIN copied to clipboard.')).toBeDefined();
    expect(screen.queryByText('Code copied to clipboard.')).toBeNull();
  });

  it('resets the announcement after the flash window', async () => {
    vi.useFakeTimers();
    render(<PurchaseComplete merchantName="Target" code="GC-CODE" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await vi.waitFor(() => {
      expect(screen.getByText('Code copied to clipboard.')).toBeDefined();
    });
    vi.advanceTimersByTime(2_000);
    await vi.waitFor(() => {
      expect(screen.queryByText('Code copied to clipboard.')).toBeNull();
    });
    vi.useRealTimers();
  });

  it('does not announce when the copy fails', async () => {
    mockCopy.mockResolvedValueOnce(false);
    render(<PurchaseComplete merchantName="Target" code="GC-CODE" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(screen.queryByText('Code copied to clipboard.')).toBeNull();
  });
});
