/**
 * Document shapes for every persisted collection.
 *
 * This replaces the old Drizzle/Postgres schema: the database is now a
 * plain document store (see `store.ts`) with two drivers — MongoDB and
 * an in-memory store hydrated from a JSON file. Constraints that used
 * to live in SQL (CHECKs, partial unique indexes) are enforced at the
 * application layer plus the unique specs in `COLLECTION_SPECS`.
 *
 * Conventions:
 *   - Every doc carries its own app-generated id field (uuid or a
 *     natural key) — we never rely on Mongo's `_id` for identity.
 *   - Timestamps are `Date` objects in memory; the JSON driver
 *     serialises them with a `{"$date": iso}` marker and revives on
 *     load, Mongo stores them natively.
 *   - Money amounts are integer minor units held as `number` (the old
 *     bigint columns never approached 2^53 at Loop's scale).
 *   - Nullable fields are explicit `null`, never omitted.
 */
import type { HomeCurrency, OrderState } from '@loop/shared';

export type { HomeCurrency, OrderState };

/** Social-login providers (ADR 014). */
export const SOCIAL_PROVIDERS = ['google', 'apple'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/** Loop users. Loop-native rows have `ctxUserId: null` until CTX provisioning maps one. */
export interface UserDoc {
  id: string;
  ctxUserId: string | null;
  email: string;
  /**
   * NS-09 access-token revocation counter — embedded as the `tv` claim
   * in every minted access token and compared on each authenticated
   * request; bumped on logout / sign-out-all / refresh-reuse so all
   * prior access tokens die at once.
   */
  tokenVersion: number;
  homeCurrency: HomeCurrency;
  createdAt: Date;
  updatedAt: Date;
}

/** Social-login links (ADR 014). One (provider, providerSub) pair maps to exactly one user. */
export interface UserIdentityDoc {
  id: string;
  userId: string;
  provider: SocialProvider;
  providerSub: string;
  emailAtLink: string;
  createdAt: Date;
}

/**
 * One-time passcodes (ADR 013). Stored as SHA-256 of the 6-digit code;
 * `consumedAt` flips exactly once (atomic CAS) so replays are rejected.
 */
export interface OtpDoc {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  createdAt: Date;
}

/**
 * Per-email failed-verify counter (hardening B5) — the authoritative
 * OTP brute-force ceiling, decoupled from individual OTP rows so
 * rotating `request-otp` can't dodge it.
 */
export interface OtpAttemptCounterDoc {
  email: string;
  failedAttempts: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
  updatedAt: Date;
}

/**
 * Active refresh tokens (ADR 013). Revoked on rotation (with
 * `replacedByJti`) or explicit sign-out; `tokenHash` is SHA-256 of the
 * full signed token as defence-in-depth beyond the jti lookup.
 */
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

/**
 * A2-566 social-login id-token replay guard: insert-once by token
 * hash; a second presentation of the same verified id_token trips the
 * unique spec and the handler rejects.
 */
export interface SocialIdTokenUseDoc {
  tokenHash: string;
  provider: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Loop orders (ADR 052) — a local mirror of a CTX gift card plus the
 * per-order economics. CTX is the payment processor: the customer pays
 * CTX directly and the ws maintainer / mirror sweep move `state` in
 * lock-step with CTX's displayStatus (plus the Loop-local `expired`).
 *
 *   unpaid → paid → fulfilled
 *      └────▶ rejected | refunded | expired
 *
 * `redeemCode` / `redeemPin` stay AES-256-GCM envelope-encrypted at
 * the application layer (orders/redeem-crypto.ts, `enc:v1:` prefix).
 */
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
  /** Client-supplied Idempotency-Key; (userId, idempotencyKey) is unique when set. */
  idempotencyKey: string | null;
  createdAt: Date;
  fulfilledAt: Date | null;
  failedAt: Date | null;
}

/** Per-user merchant favourites. Natural key (userId, merchantId). */
export interface UserFavoriteMerchantDoc {
  userId: string;
  merchantId: string;
  createdAt: Date;
}

/**
 * Per-merchant user-cashback share (ADR 052): the share of Loop's CTX
 * margin handed to the customer, pushed to CTX as its native checkout
 * discount by the catalog sweep / merchant-links reconcile.
 */
export interface MerchantCashbackConfigDoc {
  merchantId: string;
  userCashbackPct: number;
  active: boolean;
  updatedBy: string;
  updatedAt: Date;
}

/**
 * Last-good CTX catalog snapshots (R3-3): startup hydrates the
 * in-memory merchant/location stores from these before trying CTX, so
 * a boot during a CTX outage doesn't start empty.
 */
export interface CtxCatalogSnapshotDoc {
  name: 'merchants' | 'locations';
  payload: unknown[];
  itemCount: number;
  loadedAt: Date;
  updatedAt: Date;
}

/** Collection name → document type. The single registry both drivers key off. */
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
}

export type CollectionName = keyof CollectionDocs;

/**
 * Per-collection unique-key specs, enforced by both drivers (Mongo via
 * unique indexes at init, the memory driver via a scan on insert).
 * A tuple is skipped for docs where any of its fields is null — this
 * mirrors the old partial unique indexes (e.g. orders idempotency).
 */
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
};
