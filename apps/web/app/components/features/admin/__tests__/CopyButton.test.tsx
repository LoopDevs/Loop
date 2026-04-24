// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { CopyButton } from '../CopyButton';

afterEach(cleanup);

describe('<CopyButton />', () => {
  it('renders with the provided aria label', () => {
    render(<CopyButton text="abc" label="Copy order id" />);
    expect(screen.getByRole('button', { name: 'Copy order id' })).toBeDefined();
  });

  it('calls navigator.clipboard.writeText on click', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<CopyButton text="abc-123" label="Copy" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('abc-123');
    });
  });

  it('flashes "Copied" then reverts', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<CopyButton text="abc" label="Copy" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    // Let the async click promise settle.
    await vi.waitFor(() => {
      expect(screen.getByText(/Copied/)).toBeDefined();
    });
    // Advance past the flash window.
    vi.advanceTimersByTime(2_000);
    await vi.waitFor(() => {
      expect(screen.queryByText(/Copied/)).toBeNull();
    });
    vi.useRealTimers();
  });

  it('A2-1158: falls back to document.execCommand when clipboard API rejects', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    // Stub execCommand to succeed on the fallback path.
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(<CopyButton text="abc-123" label="Copy" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalledWith('copy');
    });
    // The fallback succeeded → the "Copied" flash must render.
    await waitFor(() => {
      expect(screen.getByText(/Copied/)).toBeDefined();
    });
  });

  it('A2-1158: uses execCommand when navigator.clipboard is absent entirely (older Safari)', async () => {
    // No clipboard property at all — what insecure-origin Safari looks like.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(<CopyButton text="xyz" label="Copy" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith('copy');
    });
    await waitFor(() => {
      expect(screen.getByText(/Copied/)).toBeDefined();
    });
  });

  it('silently no-ops when BOTH clipboard paths fail', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(<CopyButton text="abc" label="Copy" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalled();
    });
    // Both paths failed → no flash; user still has the value
    // visible next to the button for manual select + Ctrl-C.
    expect(screen.queryByText(/Copied/)).toBeNull();
  });
});
