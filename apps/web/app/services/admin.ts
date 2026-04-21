import { authenticatedRequest } from './api-client';

export interface MerchantCashbackConfig {
  merchantId: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface MerchantCashbackConfigHistoryEntry {
  id: string;
  merchantId: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  changedBy: string;
  changedAt: string;
}

/** GET /api/admin/merchant-cashback-configs */
export async function listCashbackConfigs(): Promise<{ configs: MerchantCashbackConfig[] }> {
  return authenticatedRequest<{ configs: MerchantCashbackConfig[] }>(
    '/api/admin/merchant-cashback-configs',
  );
}

/** PUT /api/admin/merchant-cashback-configs/:merchantId */
export async function upsertCashbackConfig(
  merchantId: string,
  body: {
    wholesalePct: number;
    userCashbackPct: number;
    loopMarginPct: number;
    active?: boolean;
  },
): Promise<{ config: MerchantCashbackConfig }> {
  return authenticatedRequest<{ config: MerchantCashbackConfig }>(
    `/api/admin/merchant-cashback-configs/${encodeURIComponent(merchantId)}`,
    { method: 'PUT', body },
  );
}

/** GET /api/admin/merchant-cashback-configs/:merchantId/history */
export async function cashbackConfigHistory(
  merchantId: string,
): Promise<{ history: MerchantCashbackConfigHistoryEntry[] }> {
  return authenticatedRequest<{ history: MerchantCashbackConfigHistoryEntry[] }>(
    `/api/admin/merchant-cashback-configs/${encodeURIComponent(merchantId)}/history`,
  );
}

export interface TreasurySnapshot {
  /** Outstanding credit (what Loop owes users), keyed by currency. Minor units, string. */
  outstanding: Record<string, string>;
  /** Ledger-by-type totals, keyed [currency][type]. Minor units, string. */
  totals: Record<string, Record<string, string>>;
  /** CTX operator pool snapshot — ADR 013. */
  operatorPool: {
    size: number;
    operators: Array<{ id: string; state: string }>;
  };
}

/** GET /api/admin/treasury */
export async function getTreasurySnapshot(): Promise<TreasurySnapshot> {
  return authenticatedRequest<TreasurySnapshot>('/api/admin/treasury');
}
