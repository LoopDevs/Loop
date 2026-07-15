// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { Dialog } from '../Dialog';

afterEach(cleanup);

beforeEach(() => {
  // jsdom ships no <dialog> showModal/close — polyfill the minimum the
  // primitive exercises (attribute reflects to the `open` property).
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
  };
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

function flushRaf(): Promise<void> {
  return act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

function getDialog(): HTMLDialogElement {
  const el = document.querySelector('dialog');
  if (el === null) throw new Error('no <dialog> rendered');
  return el as HTMLDialogElement;
}

describe('<Dialog /> primitive (FE-33)', () => {
  it('opens when `open` is true and closes when it flips false', () => {
    const { rerender } = render(
      <Dialog open onClose={() => {}} labelledBy="t">
        <p id="t">hi</p>
      </Dialog>,
    );
    expect(getDialog().open).toBe(true);
    rerender(
      <Dialog open={false} onClose={() => {}} labelledBy="t">
        <p id="t">hi</p>
      </Dialog>,
    );
    expect(getDialog().open).toBe(false);
  });

  it('Esc (cancel) is prevent-defaulted and routed to onClose', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} labelledBy="t">
        <p id="t">hi</p>
      </Dialog>,
    );
    const evt = new Event('cancel', { cancelable: true });
    fireEvent(getDialog(), evt);
    // preventDefault keeps React state the source of truth for open/close.
    expect(evt.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose on a native close ONLY while open (guards the self-close)', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open onClose={onClose} labelledBy="t">
        <p id="t">hi</p>
      </Dialog>,
    );
    fireEvent(getDialog(), new Event('close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    // While closed, a close event (e.g. the programmatic close() the effect
    // triggers) must NOT re-fire onClose.
    rerender(
      <Dialog open={false} onClose={onClose} labelledBy="t">
        <p id="t">hi</p>
      </Dialog>,
    );
    fireEvent(getDialog(), new Event('close'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves focus to initialFocusRef after opening, and calls onOpen on the open transition', async () => {
    const onOpen = vi.fn();
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      const btnRef = useRef<HTMLButtonElement | null>(null);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            trigger
          </button>
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            onOpen={onOpen}
            initialFocusRef={btnRef}
            labelledBy="t"
          >
            <div>
              <h2 id="t">Title</h2>
              <button ref={btnRef} type="button">
                focus-me
              </button>
            </div>
          </Dialog>
        </div>
      );
    }
    render(<Harness />);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
    // onOpen runs on the closed→open transition (before focus).
    expect(onOpen).toHaveBeenCalledTimes(1);
    await flushRaf();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'focus-me' }));
  });

  it('wires aria-labelledby / aria-describedby and applies the size class', () => {
    render(
      <Dialog open onClose={() => {}} labelledBy="lbl" describedBy="desc" size="lg">
        <div>
          <h2 id="lbl">L</h2>
          <p id="desc">D</p>
        </div>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe('lbl');
    expect(dialog.getAttribute('aria-describedby')).toBe('desc');
    expect(dialog.className).toContain('max-w-lg');
    expect(dialog.className).not.toContain('max-w-md');
  });

  it('omits aria-describedby when not provided (defaults to md)', () => {
    render(
      <Dialog open onClose={() => {}} labelledBy="lbl">
        <h2 id="lbl">L</h2>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.hasAttribute('aria-describedby')).toBe(false);
    expect(dialog.className).toContain('max-w-md');
  });
});
