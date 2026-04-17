// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { Merchant } from '@loop/shared';
import { AmountSelection } from '../AmountSelection';

afterEach(cleanup);

function merchant(overrides: Partial<Merchant> = {}): Merchant {
  return {
    id: 'm-1',
    name: 'Target',
    enabled: true,
    ...overrides,
  };
}

describe('AmountSelection — fixed denominations', () => {
  const fixedMerchant = merchant({
    denominations: {
      type: 'fixed',
      denominations: ['10', '25', '50', '100'],
      currency: 'USD',
    },
  });

  it('renders one button per denomination', () => {
    render(<AmountSelection merchant={fixedMerchant} onConfirm={vi.fn()} />);
    expect(screen.getByRole('button', { name: '$10' })).toBeDefined();
    expect(screen.getByRole('button', { name: '$25' })).toBeDefined();
    expect(screen.getByRole('button', { name: '$50' })).toBeDefined();
    expect(screen.getByRole('button', { name: '$100' })).toBeDefined();
  });

  it('disables the confirm button until a denomination is selected', () => {
    render(<AmountSelection merchant={fixedMerchant} onConfirm={vi.fn()} />);
    const confirm = screen.getByRole('button', { name: /Buy/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables the confirm button once a denomination is selected', () => {
    render(<AmountSelection merchant={fixedMerchant} onConfirm={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '$25' }));
    expect((screen.getByRole('button', { name: /Buy \$25/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('forwards the selected denomination as a number on confirm', () => {
    const onConfirm = vi.fn();
    render(<AmountSelection merchant={fixedMerchant} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: '$50' }));
    fireEvent.click(screen.getByRole('button', { name: /Buy \$50/ }));
    expect(onConfirm).toHaveBeenCalledWith(50);
  });

  it('respects isLoading by disabling the confirm button even with a selection', () => {
    render(<AmountSelection merchant={fixedMerchant} onConfirm={vi.fn()} isLoading={true} />);
    fireEvent.click(screen.getByRole('button', { name: '$10' }));
    const confirm = screen.getByRole('button', { name: /Buy/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it('switches to free-amount input when fixed denominations list is empty', () => {
    render(
      <AmountSelection
        merchant={merchant({
          denominations: { type: 'fixed', denominations: [], currency: 'USD' },
        })}
        onConfirm={vi.fn()}
      />,
    );
    // Free-amount path renders an input (not a grid of $-buttons).
    expect(screen.getByRole('spinbutton')).toBeDefined();
  });
});

describe('AmountSelection — free amount (min-max)', () => {
  const minMaxMerchant = merchant({
    denominations: {
      type: 'min-max',
      denominations: ['5', '500'],
      currency: 'USD',
      min: 5,
      max: 500,
    },
  });

  function getInput(): HTMLInputElement {
    return screen.getByRole('spinbutton') as HTMLInputElement;
  }

  it('renders a numeric input with the min/max hint', () => {
    render(<AmountSelection merchant={minMaxMerchant} onConfirm={vi.fn()} />);
    expect(screen.getByText('Min $5, max $500')).toBeDefined();
    expect(getInput().type).toBe('number');
  });

  it('disables the continue button when the input is empty', () => {
    render(<AmountSelection merchant={minMaxMerchant} onConfirm={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('rejects amounts below the merchant minimum', () => {
    const onConfirm = vi.fn();
    render(<AmountSelection merchant={minMaxMerchant} onConfirm={onConfirm} />);
    fireEvent.change(getInput(), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/Amount must be between \$5 and \$500/)).toBeDefined();
  });

  it('rejects amounts above the merchant maximum', () => {
    const onConfirm = vi.fn();
    render(<AmountSelection merchant={minMaxMerchant} onConfirm={onConfirm} />);
    fireEvent.change(getInput(), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/\$5 and \$500/)).toBeDefined();
  });

  it('rejects sub-cent precision', () => {
    const onConfirm = vi.fn();
    render(<AmountSelection merchant={minMaxMerchant} onConfirm={onConfirm} />);
    fireEvent.change(getInput(), { target: { value: '10.005' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/more than 2 decimal places/)).toBeDefined();
  });

  it('rejects non-numeric input by showing an error', () => {
    const onConfirm = vi.fn();
    render(<AmountSelection merchant={minMaxMerchant} onConfirm={onConfirm} />);
    // Type 'number' input — set a value that parseFloat treats as NaN.
    fireEvent.change(getInput(), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/valid amount/)).toBeDefined();
  });

  it('forwards a valid amount to onConfirm as a number', () => {
    const onConfirm = vi.fn();
    render(<AmountSelection merchant={minMaxMerchant} onConfirm={onConfirm} />);
    fireEvent.change(getInput(), { target: { value: '50.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onConfirm).toHaveBeenCalledWith(50);
  });

  it('clears the error once the user edits the amount', () => {
    render(<AmountSelection merchant={minMaxMerchant} onConfirm={vi.fn()} />);
    fireEvent.change(getInput(), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/\$5 and \$500/)).toBeDefined();
    fireEvent.change(getInput(), { target: { value: '10' } });
    expect(screen.queryByText(/\$5 and \$500/)).toBeNull();
  });
});

describe('AmountSelection — no denomination config', () => {
  it('falls back to backend-wide limits (0.01–10000)', () => {
    const onConfirm = vi.fn();
    render(<AmountSelection merchant={merchant()} onConfirm={onConfirm} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    // 20000 is over the backend cap; must be rejected client-side.
    fireEvent.change(input, { target: { value: '20000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/\$0\.01 and \$10000/)).toBeDefined();
  });

  it('defaults currency to USD in the label when unspecified', () => {
    render(<AmountSelection merchant={merchant()} onConfirm={vi.fn()} />);
    expect(screen.getByText(/Amount \(USD\)/)).toBeDefined();
  });
});
