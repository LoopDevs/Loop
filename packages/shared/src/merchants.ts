/** Denomination configuration for a merchant's gift cards. */
export interface MerchantDenominations {
  type: 'fixed' | 'min-max';
  /** Fixed denomination values (e.g. ["10", "25", "50"]). Present when type is "fixed". */
  denominations: string[];
  currency: string;
  min?: number | undefined;
  max?: number | undefined;
}

/** Core merchant record returned by the backend. */
export interface Merchant {
  id: string;
  name: string;
  /**
   * CTX-provided brand-country slug (e.g. `adidas-ca`). The single source
   * of truth for a merchant's URL slug — `merchantSlug()` prefers it over a
   * derived value so Loop URLs match CTX's own slug. Optional: older CTX
   * records (and the legacy mocked fixtures) omit it, in which case
   * `merchantSlug()` derives `brand-country` from `name` + `country`.
   */
  slug?: string | undefined;
  logoUrl?: string | undefined;
  cardImageUrl?: string | undefined;
  /** Savings as a percentage for display (e.g. 4.0 means 4% off). */
  savingsPercentage?: number | undefined;
  denominations?: MerchantDenominations | undefined;
  /** Short tagline (≤8 words) shown under the name. Sourced for 100% of
   *  enriched merchants but was dropped by both sync mappers before this. */
  intro?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  terms?: string | undefined;
  enabled: boolean;
  locationCount?: number | undefined;
  /** ISO 3166-1 alpha-2 country code, used by the region filter (e.g. 'US', 'GB', 'CA', 'DE'). */
  country?: string | undefined;
}

/** Paginated response for the merchant list endpoint. */
export interface MerchantListResponse {
  merchants: Merchant[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

/** Single merchant detail response. */
export interface MerchantDetailResponse {
  merchant: Merchant;
}

/**
 * Full catalog response for `GET /api/merchants/all`. Used by UI surfaces
 * that need every merchant in one shot (home directory, map popups, navbar
 * search) without paginating. Total reflects the array length at fetch
 * time — intentionally no `pagination` envelope, since /all returns the
 * entire cached slice.
 */
export interface MerchantAllResponse {
  merchants: Merchant[];
  total: number;
}

/** Query params for GET /api/merchants. */
export interface MerchantListParams {
  page?: number | undefined;
  limit?: number | undefined;
  q?: string | undefined;
}

/** Geographic location point for a single merchant location. */
export interface LocationPoint {
  type: 'Feature';
  properties: {
    cluster: false;
    merchantId: string;
    mapPinUrl: string;
  };
  geometry: {
    type: 'Point';
    coordinates: {
      longitude: number;
      latitude: number;
    };
  };
}

/** Aggregated cluster of nearby merchant locations. */
export interface ClusterPoint {
  type: 'Feature';
  id: number;
  properties: {
    cluster: true;
    pointCount: number;
  };
  geometry: {
    type: 'Point';
    coordinates: {
      longitude: number;
      latitude: number;
    };
  };
}

/** Response from GET /api/clusters. */
export interface ClusterResponse {
  locationPoints: LocationPoint[];
  clusterPoints: ClusterPoint[];
  total: number;
  zoom: number;
  loadedAt: number;
  bounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
}

/** Query params for GET /api/clusters. */
export interface ClusterParams {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
}

/** `GET /api/merchants/:id/cashback-rate` response (ADR 011 / 015). */
export interface MerchantCashbackRateResponse {
  merchantId: string;
  /**
   * Numeric(5,2) as a string (e.g. `"2.50"`). Null when the merchant
   * has no active cashback config — the UI should hide the badge
   * rather than render "0% cashback".
   */
  userCashbackPct: string | null;
}

/**
 * `GET /api/merchants/cashback-rates` response — bulk map for
 * catalog / list views (ADR 011 / 015). Only merchants with an active
 * config are present; treat a missing key as "no cashback".
 */
export interface MerchantsCashbackRatesResponse {
  /**
   * `merchantId` → `numeric(5,2)` pct string (e.g. `"2.50"`). Only
   * merchants with an active config are present.
   */
  rates: Record<string, string>;
}
