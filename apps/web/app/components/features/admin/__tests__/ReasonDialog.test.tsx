// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ReasonDialog } from '../ReasonDialog';

afterEach(cleanup);

beforeEach(() => {
  // jsdom doesn't ship a complete <dialog> implementation: showModal
  // and close are missing on HTMLDialogElement. Polyfill the minimum
  // surface ReasonDialog.tsx exercises (same shim as the StepUpModal /
  // MerchantResyncButton tests).
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

describe('<ReasonDialog /> — a11y (FE-14)', () => {
  // A too-short reason must be announced to AT (assertive live region)
  // and return focus to the field so the admin lands on the input they
  // have to fix — the submit click otherwise strands focus on the
  // Confirm button.
  it('announces a validation error via role="alert" and returns focus to the field', () => {
    render(<ReasonDialog open title="Reason for retrying this payout?" onResolve={() => {}} />);

    // A real submit click leaves focus on the Confirm button; move focus
    // off the field first so the focus-return assertion is non-vacuous
    // (fireEvent.click does not move focus on its own).
    const confirm = screen.getByRole('button', { name: /^confirm$/i });
    confirm.focus();
    // Submit with an empty reason → fails the 2–500 char rule.
    fireEvent.click(confirm);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/must be 2.500 characters/i);

    const textarea = screen.getByRole('textbox');
    expect(document.activeElement).toBe(textarea);
  });
});
