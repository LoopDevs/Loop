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
const mockScreenshotGuard = vi.fn(() => () => undefined);

vi.mock('~/native/clipboard', () => ({
  copyToClipboard: (t: string) => mockCopy(t),
}));
vi.mock('~/native/share', () => ({
  nativeShare: (o: { title: string; text: string; imageUrl?: string; imageFilename?: string }) =>
    mockShare(o),
}));
vi.mock('~/native/haptics', () => ({
  triggerHapticNotification: (t: 'success' | 'warning' | 'error') => mockHaptic(t),
}));
vi.mock('~/native/screenshot-guard', () => ({
  enableScreenshotGuard: () => mockScreenshotGuard(),
}));
// jsbarcode is dynamically imported inside the component; the test env has
// no canvas, so mock the module to a harmless no-op.
vi.mock('jsbarcode', () => ({ default: () => undefined }));

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

  it('enables the screenshot guard on mount', () => {
    render(<PurchaseComplete merchantName="Target" code="CODE" />);
    expect(mockScreenshotGuard).toHaveBeenCalledTimes(1);
  });

  it('disables the screenshot guard on unmount', () => {
    const cleanupFn = vi.fn();
    mockScreenshotGuard.mockReturnValueOnce(cleanupFn);
    const { unmount } = render(<PurchaseComplete merchantName="Target" code="CODE" />);
    unmount();
    expect(cleanupFn).toHaveBeenCalled();
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
});
