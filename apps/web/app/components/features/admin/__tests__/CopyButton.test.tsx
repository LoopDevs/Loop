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

  it('silently no-ops when clipboard access fails', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<CopyButton text="abc" label="Copy" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    // No "Copied" flash should appear because the writeText rejected.
    expect(screen.queryByText(/Copied/)).toBeNull();
  });
});
