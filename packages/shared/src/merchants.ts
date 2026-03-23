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
  category?: string | undefined;
  logoUrl?: string | undefined;
  cardImageUrl?: string | undefined;
  savingsPercentage?: number | undefined;
  /** Savings as raw upstream percentage value (e.g. 10 means 10%). See savingsPercentage for the decimal form. */
  savingsBips?: number | undefined;
  denominations?: MerchantDenominations | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  terms?: string | undefined;
  enabled: boolean;
  locationCount?: number | undefined;
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
