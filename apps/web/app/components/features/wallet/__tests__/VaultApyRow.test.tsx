// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { VaultApyResponse } from '~/services/vault-apy';
import { VaultApyRow, fmtApyPercent } from '../VaultApyRow';

afterEach(cleanup);

const { vaultApyMock } = vi.hoisted(() => ({
  vaultApyMock: {
    vaultApy: undefined as VaultApyResponse | undefined,
    isLoading: false,
    isError: false,
  },
}));

vi.mock('~/hooks/use-vault-apy', () => ({
  useVaultApy: () => vaultApyMock,
}));

beforeEach(() => {
  vaultApyMock.vaultApy = undefined;
  vaultApyMock.isLoading = false;
  vaultApyMock.isError = false;
});

function withData(overrides: Partial<VaultApyResponse> = {}): void {
  vaultApyMock.vaultApy = {
    assets: [
      {
        assetCode: 'GBPLOOP',
        past30dApy: 0.0312,
        past90dRange: { minApy: 0.028, maxApy: 0.035 },
      },
    ],
    disclaimerKey: 'wallet.apyDisclaimer',
    ...overrides,
  };
}

describe('fmtApyPercent', () => {
  it('converts a decimal fraction to a trimmed percent string', () => {
    expect(fmtApyPercent(0.0312)).toBe('3.12');
    expect(fmtApyPercent(0.03)).toBe('3');
  });
});

describe('<VaultApyRow />', () => {
  it('renders the headline APY + the always-visible disclaimer', () => {
    withData();
    render(<VaultApyRow assetCode="GBPLOOP" />);
    expect(screen.getByText(/Past 30 days: 3\.12% APY/)).toBeDefined();
    expect(screen.getByText(/Past performance doesn't guarantee future returns/)).toBeDefined();
  });

  it('maps legacy wallet asset codes (USDLOOP/EURLOOP) to the vault-APY naming (LOOPUSD/LOOPEUR)', () => {
    withData({
      assets: [{ assetCode: 'LOOPUSD', past30dApy: 0.03, past90dRange: null }],
    });
    render(<VaultApyRow assetCode="USDLOOP" />);
    expect(screen.getByText(/Past 30 days: 3% APY/)).toBeDefined();
  });

  it('reveals the mid-level detail (variable-yield explanation + 90d range + withdraw copy) on tap', () => {
    withData();
    render(<VaultApyRow assetCode="GBPLOOP" />);
    expect(screen.queryByText(/Range over past 90 days/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show details/i }));
    expect(screen.getByText(/Range over past 90 days: 2\.8% – 3\.5%/)).toBeDefined();
    expect(screen.getByText(/Withdraw anytime, funds settle in seconds/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /hide details/i }));
    expect(screen.queryByText(/Range over past 90 days/)).toBeNull();
  });

  it('omits the 90d range sentence (but still shows the detail) when past90dRange is null', () => {
    withData({ assets: [{ assetCode: 'GBPLOOP', past30dApy: 0.0312, past90dRange: null }] });
    render(<VaultApyRow assetCode="GBPLOOP" />);
    fireEvent.click(screen.getByRole('button', { name: /show details/i }));
    expect(screen.getByText(/Withdraw anytime, funds settle in seconds/)).toBeDefined();
    expect(screen.queryByText(/Range over past 90 days/)).toBeNull();
  });

  it('renders nothing when past30dApy is null — never a fabricated figure', () => {
    withData({ assets: [{ assetCode: 'GBPLOOP', past30dApy: null, past90dRange: null }] });
    const { container } = render(<VaultApyRow assetCode="GBPLOOP" />);
    expect(container.textContent).toBe('');
    expect(container.textContent).not.toMatch(/0%/);
  });

  it('renders nothing when this deployment has no matching APY entry for the asset', () => {
    withData({ assets: [] });
    const { container } = render(<VaultApyRow assetCode="EURLOOP" />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing while loading', () => {
    vaultApyMock.isLoading = true;
    const { container } = render(<VaultApyRow assetCode="GBPLOOP" />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing on error', () => {
    vaultApyMock.isError = true;
    const { container } = render(<VaultApyRow assetCode="GBPLOOP" />);
    expect(container.textContent).toBe('');
  });

  it('never renders the yield source/mechanism, regardless of state', () => {
    withData();
    const { container } = render(<VaultApyRow assetCode="GBPLOOP" />);
    fireEvent.click(screen.getByRole('button', { name: /show details/i }));
    expect(container.textContent).not.toMatch(/defindex|blend|soroban|strategy|vault/i);
  });
});
