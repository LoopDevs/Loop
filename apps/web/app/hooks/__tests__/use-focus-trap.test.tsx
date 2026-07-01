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

  // CF2 WUI-01 regression guard: a roving-tabindex radiogroup (most
  // options tabindex="-1", one tabindex="0") must not have its inactive
  // options counted as tab stops — they used to match `button:not([disabled])`
  // regardless of tabindex, computing the wrong last/first element and
  // letting Tab escape the trap.
  function RovingTabindexDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
    const ref = useRef<HTMLDivElement>(null);
    const firstRef = useRef<HTMLButtonElement>(null);
    useFocusTrap({ active: true, containerRef: ref, onClose, initialFocusRef: firstRef });
    return (
      <div ref={ref} role="dialog">
        <button ref={firstRef}>first</button>
        <div role="radiogroup">
          <button role="radio" tabIndex={0} aria-checked="true">
            option-active
          </button>
          <button role="radio" tabIndex={-1} aria-checked="false">
            option-inactive-1
          </button>
          <button role="radio" tabIndex={-1} aria-checked="false">
            option-inactive-2
          </button>
        </div>
        <button>last</button>
      </div>
    );
  }

  it('excludes tabindex=-1 roving-tabindex options from the tab cycle', () => {
    function Harness2(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-testid="trigger" onClick={() => setOpen(true)}>
            open
          </button>
          {open ? <RovingTabindexDialog onClose={() => setOpen(false)} /> : null}
        </>
      );
    }
    render(<Harness2 />);
    fireEvent.click(screen.getByTestId('trigger'));
    // Tab from "last" must wrap to "first" — not to one of the
    // tabindex=-1 radio options, which would prove they were (wrongly)
    // still counted as tab stops.
    const last = screen.getByText('last');
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('first'));
    // Shift+Tab from "first" must wrap to "last" directly, skipping the
    // radiogroup's inactive options.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
