import type { HomeCurrency } from './loop-asset.js';

export type WalletChain = 'XLM';
export type WalletLinkStatus = 'active' | 'removed';
/** Mirrors CTX's payout lifecycle, including the approval and hold states. */
export type PayoutStatus =
  | 'pending-approval'
  | 'approved'
  | 'held'
  | 'pending'
  | 'submitted'
  | 'queued'
  | 'complete'
  | 'failed'
  | 'rejected'
  | 'cancelled';
export type SavingsOperationType = 'deposit' | 'withdraw';
export type SavingsOperationStatus = 'pending' | 'processing' | 'complete' | 'failed';
/** Where a customer's cashback lands once credited: the account balance (paid out when a wallet is linked) or the savings pot. */
export type CashbackDestination = 'account' | 'savings';
export const CASHBACK_DESTINATIONS: readonly CashbackDestination[] = ['account', 'savings'];

export interface AccountBalanceView {
  currency: string;
  amount: string;
}

export interface SavingsPositionView {
  potId: string | null;
  currency: string;
  provider: string;
  principal: string;
  value: string;
  earnt: string;
  /** Part of `value` still inside the lock period. */
  locked: string;
  /** What a withdrawal may take right now. */
  available: string;
  unlocksAt: string | null;
  /** Annualised rate estimated from the pool's unit price growth; null until observed long enough. */
  estimatedApr: number | null;
  projectedYearlyEarnings: string | null;
}

export interface SavingsOperationView {
  id: string;
  type: SavingsOperationType;
  potId: string | null;
  status: SavingsOperationStatus;
  currency: string;
  amount: string;
  created: string;
  finalisedAt: string | null;
  error: string | null;
}

export interface SavingsMoveRequest {
  currency: string;
  /** Decimal string in major units, e.g. "1.25". */
  amount: string;
}

export interface SetCashbackDestinationRequest {
  destination: CashbackDestination;
}

export interface WalletLinkView {
  id: string;
  chain: WalletChain;
  address: string;
  autoPayout: boolean;
  status: WalletLinkStatus;
  created: string;
  removed: string | null;
}

export interface PayoutView {
  id: string;
  status: PayoutStatus;
  chain: WalletChain;
  address: string;
  currency: string;
  amount: string;
  giftCardId: string | null;
  txHash: string | null;
  transferId: string | null;
  error: string | null;
  created: string;
  finalised: string | null;
}

export interface UserAccountView {
  id: string;
  userId: string;
  wallet: AccountBalanceView[];
  savings: SavingsPositionView[];
  savingsPrincipal: AccountBalanceView[];
  pendingOperations: SavingsOperationView[];
  linkedWallets: WalletLinkView[];
  payouts: PayoutView[];
  created: string;
  updated: string;
}

export interface LinkWalletRequest {
  chain: WalletChain;
  address: string;
  autoPayout?: boolean;
}

export interface UpdateWalletRequest {
  autoPayout: boolean;
}

export const HELD_STABLE_FOR_CURRENCY: Record<HomeCurrency, string> = {
  GBP: 'XLM.GBPLOOP',
  USD: 'XLM.USDC',
  EUR: 'XLM.EURC',
};

export function heldStableForCurrency(currency: HomeCurrency): string {
  return HELD_STABLE_FOR_CURRENCY[currency];
}

export function fiatForHeldStable(currency: string): HomeCurrency | null {
  for (const [fiat, stable] of Object.entries(HELD_STABLE_FOR_CURRENCY)) {
    if (stable === currency) return fiat as HomeCurrency;
  }
  return null;
}

export function displayCurrencyCode(currency: string): string {
  const dot = currency.indexOf('.');
  return dot === -1 ? currency : currency.slice(dot + 1);
}

export function activeWalletLink(
  links: readonly WalletLinkView[],
  chain: WalletChain = 'XLM',
): WalletLinkView | null {
  return links.find((l) => l.chain === chain && l.status === 'active') ?? null;
}

export function hasPositiveAccountBalance(balances: readonly AccountBalanceView[]): boolean {
  return balances.some((b) => {
    const n = Number(b.amount);
    return Number.isFinite(n) && n > 0;
  });
}
