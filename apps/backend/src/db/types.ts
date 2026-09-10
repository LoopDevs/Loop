// document shapes for persisted collections — ADR 013, 014, 017, 037, 052, NS-03, NS-09, A2-566, R3-3, SEC-02
import type { HomeCurrency, OrderState, StaffRole } from '@loop/shared';

export type { HomeCurrency, OrderState };

export const SOCIAL_PROVIDERS = ['google', 'apple'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export interface UserDoc {
  id: string;
  ctxUserId: string | null;
  email: string;
  // NS-09 — bumped on logout/sign-out-all/refresh-reuse to invalidate prior access tokens
  tokenVersion: number;
  homeCurrency: HomeCurrency;
  // ADR 037 — recomputed from allowlist on upsert; `requireStaff` prefers `staff_roles` row
  isAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserIdentityDoc {
  id: string;
  userId: string;
  provider: SocialProvider;
  providerSub: string;
  emailAtLink: string;
  createdAt: Date;
}

export interface OtpDoc {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  createdAt: Date;
}

// B5 — decoupled from individual OTP rows so rotating `request-otp` can't dodge the ceiling
export interface OtpAttemptCounterDoc {
  email: string;
  failedAttempts: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
  updatedAt: Date;
}

export interface RefreshTokenDoc {
  jti: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByJti: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

// A2-566 — insert-once by token hash; second presentation trips unique spec
export interface SocialIdTokenUseDoc {
  tokenHash: string;
  provider: string;
  expiresAt: Date;
  createdAt: Date;
}

// ADR 052 — CTX is payment processor; `state` mirrors CTX displayStatus plus Loop-local `expired`
export interface OrderDoc {
  id: string;
  userId: string;
  merchantId: string;
  faceValueMinor: number;
  currency: string;
  chargeMinor: number;
  chargeCurrency: string;
  userCashbackMinor: number;
  expectedCommissionMinor: number | null;
  ctxOrderId: string | null;
  ctxPaymentId: string | null;
  paymentCryptoCurrency: string | null;
  redeemCode: string | null;
  redeemPin: string | null;
  redeemUrl: string | null;
  redemptionBackfillAttempts: number;
  redemptionBackfillLastAttemptAt: Date | null;
  state: OrderState;
  failureReason: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  fulfilledAt: Date | null;
  failedAt: Date | null;
}

export interface UserFavoriteMerchantDoc {
  userId: string;
  merchantId: string;
  createdAt: Date;
}

// ADR 052 — pushed to CTX as native checkout discount by catalog sweep / merchant-links reconcile
export interface MerchantCashbackConfigDoc {
  merchantId: string;
  userCashbackPct: number;
  active: boolean;
  updatedBy: string;
  updatedAt: Date;
}

// R3-3 — startup hydrates in-memory stores from these before trying CTX
export interface CtxCatalogSnapshotDoc {
  name: 'merchants' | 'locations';
  payload: unknown[];
  itemCount: number;
  loadedAt: Date;
  updatedAt: Date;
}

// ADR 037 — absence means "not staff"; `users.isAdmin` allowlist shim is the only other way
export interface StaffRoleDoc {
  userId: string;
  role: StaffRole;
  grantedAt: Date;
  grantedByUserId: string | null;
  reason: string | null;
}

// ADR 017 / NS-03 — doubles as durable audit trail; retention governed by `admin.auditRetentionDays`
export interface AdminIdempotencyKeyDoc {
  adminUserId: string;
  key: string;
  method: string;
  path: string;
  status: number;
  responseBody: string;
  createdAt: Date;
}

// SEC-02 — insert makes token single-use; replay collides on `jti`
export interface AdminStepUpConsumptionDoc {
  jti: string;
  sub: string;
  scope: string;
  expiresAt: Date;
  consumedAt: Date;
}

// ADR 011 / 018 — written by admin upsert before touching live row; doc store has no triggers
export interface MerchantCashbackConfigHistoryDoc {
  id: string;
  merchantId: string;
  priorUserCashbackPct: number | null;
  priorActive: boolean | null;
  newUserCashbackPct: number;
  newActive: boolean;
  changedByUserId: string;
  changedByEmail: string;
  reason: string;
  changedAt: Date;
}

export interface CollectionDocs {
  users: UserDoc;
  user_identities: UserIdentityDoc;
  otps: OtpDoc;
  otp_attempt_counters: OtpAttemptCounterDoc;
  refresh_tokens: RefreshTokenDoc;
  social_id_token_uses: SocialIdTokenUseDoc;
  orders: OrderDoc;
  user_favorite_merchants: UserFavoriteMerchantDoc;
  merchant_cashback_configs: MerchantCashbackConfigDoc;
  ctx_catalog_snapshots: CtxCatalogSnapshotDoc;
  merchant_cashback_config_history: MerchantCashbackConfigHistoryDoc;
  staff_roles: StaffRoleDoc;
  admin_idempotency_keys: AdminIdempotencyKeyDoc;
  admin_step_up_consumptions: AdminStepUpConsumptionDoc;
}

export type CollectionName = keyof CollectionDocs;

// tuples skipped if any field is null — mirrors old partial unique indexes
export const COLLECTION_SPECS: {
  [K in CollectionName]: { uniques: ReadonlyArray<readonly string[]> };
} = {
  users: { uniques: [['id']] },
  user_identities: { uniques: [['id'], ['provider', 'providerSub']] },
  otps: { uniques: [['id']] },
  otp_attempt_counters: { uniques: [['email']] },
  refresh_tokens: { uniques: [['jti']] },
  social_id_token_uses: { uniques: [['tokenHash']] },
  orders: { uniques: [['id'], ['userId', 'idempotencyKey']] },
  user_favorite_merchants: { uniques: [['userId', 'merchantId']] },
  merchant_cashback_configs: { uniques: [['merchantId']] },
  ctx_catalog_snapshots: { uniques: [['name']] },
  merchant_cashback_config_history: { uniques: [['id']] },
  staff_roles: { uniques: [['userId']] },
  admin_idempotency_keys: { uniques: [['adminUserId', 'key']] },
  admin_step_up_consumptions: { uniques: [['jti']] },
};
