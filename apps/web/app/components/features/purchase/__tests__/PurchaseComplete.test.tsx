// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

const mockCopy = vi.fn<(text: string) => Promise<boolean>>();
const mockShare = vi.fn<(opts: { title: string; text: string }) => Promise<boolean>>();
const mockHaptic = vi.fn<(type: 'success' | 'warning' | 'error') => Promise<void>>();
const mockScreenshotGuard = vi.fn(() => () => undefined);

vi.mock('~/native/clipboard', () => ({
  copyToClipboard: (t: string) => mockCopy(t),
}));
vi.mock('~/native/share', () => ({
  nativeShare: (o: { title: string; text: string }) => mockShare(o),
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
    render(<PurchaseComplete merchantName="Target" code="GC-ABCD-1234" onDone={vi.fn()} />);
    expect(screen.getByText('GC-ABCD-1234')).toBeDefined();
    expect(screen.getByText(/Your Target gift card code/)).toBeDefined();
  });

  it('renders the PIN only when provided', () => {
    const { rerender } = render(
      <PurchaseComplete merchantName="Target" code="CODE" onDone={vi.fn()} />,
    );
    expect(screen.queryByText(/PIN:/)).toBeNull();
    rerender(<PurchaseComplete merchantName="Target" code="CODE" pin="9876" onDone={vi.fn()} />);
    expect(screen.getByText(/PIN:/)).toBeDefined();
    expect(screen.getByText('9876')).toBeDefined();
  });

  it('fires a success haptic on mount', () => {
    render(<PurchaseComplete merchantName="Target" code="CODE" onDone={vi.fn()} />);
    expect(mockHaptic).toHaveBeenCalledWith('success');
  });

  it('enables the screenshot guard on mount', () => {
    render(<PurchaseComplete merchantName="Target" code="CODE" onDone={vi.fn()} />);
    expect(mockScreenshotGuard).toHaveBeenCalledTimes(1);
  });

  it('disables the screenshot guard on unmount', () => {
    const cleanupFn = vi.fn();
    mockScreenshotGuard.mockReturnValueOnce(cleanupFn);
    const { unmount } = render(
      <PurchaseComplete merchantName="Target" code="CODE" onDone={vi.fn()} />,
    );
    unmount();
    expect(cleanupFn).toHaveBeenCalled();
  });

  it('copies the code when the copy button is clicked', async () => {
    render(<PurchaseComplete merchantName="Target" code="GC-CODE" onDone={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(mockCopy).toHaveBeenCalledWith('GC-CODE');
  });

  it('shows "Copied!" confirmation after a successful copy', async () => {
    render(<PurchaseComplete merchantName="Target" code="CODE" onDone={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeDefined();
  });

  it('does not show "Copied!" when the copy fails', async () => {
    mockCopy.mockResolvedValueOnce(false);
    render(<PurchaseComplete merchantName="Target" code="CODE" onDone={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
  });

  it('invokes nativeShare with merchant + code + PIN', async () => {
    render(<PurchaseComplete merchantName="Target" code="CODE" pin="PIN" onDone={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    });
    expect(mockShare).toHaveBeenCalledWith({
      title: 'Target Gift Card',
      text: 'Gift card code: CODE\nPIN: PIN',
    });
  });

  it('omits the PIN line from the shared text when there is no PIN', async () => {
    render(<PurchaseComplete merchantName="Target" code="CODE" onDone={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    });
    expect(mockShare).toHaveBeenCalledWith({
      title: 'Target Gift Card',
      text: 'Gift card code: CODE',
    });
  });

  it('calls onDone when the Done button is clicked', () => {
    const onDone = vi.fn();
    render(<PurchaseComplete merchantName="Target" code="CODE" onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('renders an aria-labelled canvas for the barcode', () => {
    const { container } = render(
      <PurchaseComplete merchantName="Target" code="CODE-ABC" onDone={vi.fn()} />,
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas!.getAttribute('aria-label')).toBe('Barcode for gift card code CODE-ABC');
  });
});
