// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';
import { useFocusTrap } from '../use-focus-trap';

afterEach(cleanup);

function Dialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  useFocusTrap({ active: true, containerRef: ref, onClose, initialFocusRef: firstRef });
  return (
    <div ref={ref} role="dialog">
      <button ref={firstRef}>first</button>
      <button>middle</button>
      <button>last</button>
    </div>
  );
}

function Harness(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-testid="trigger" onClick={() => setOpen(true)}>
        open
      </button>
      {open ? <Dialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

describe('useFocusTrap', () => {
  it('moves focus to the initial element on open', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('trigger'));
    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    const ref = { current: document.createElement('div') };
    function Probe(): React.JSX.Element {
      const r = useRef<HTMLDivElement>(null);
      useFocusTrap({ active: true, containerRef: r, onClose });
      return (
        <div ref={r} role="dialog">
          <button>x</button>
        </div>
      );
    }
    render(<Probe />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    void ref;
  });

  it('Tab from the last focusable wraps to the first', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('trigger'));
    const last = screen.getByText('last');
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('Shift+Tab from the first focusable wraps to the last', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('trigger'));
    const first = screen.getByText('first');
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('last'));
  });

  it('restores focus to the trigger on close', () => {
    render(<Harness />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    fireEvent.click(trigger);
    // Dialog is open + focus moved in.
    expect(document.activeElement).toBe(screen.getByText('first'));
    // Close via Escape — focus returns to the trigger.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });
});
