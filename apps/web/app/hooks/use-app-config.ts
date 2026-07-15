/**
 * `useAppConfig` — feature flags from the backend, cached in
 * react-query. Called from anywhere in the tree that needs to
 * branch on a server-side flag (e.g. PurchaseContainer picking
 * between the legacy CTX-proxy flow and the Loop-native flow).
 *
 * Defaults while loading / on error to all-false — a missing flag
 * should keep the legacy path, never unlock a new one.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAppConfig, type AppConfig } from '~/services/config';

/**
 * FE-22 — deploy-aware SSR / first-paint default for the Phase-1 launch
 * gate (`Phase2Gate`).
 *
 * `useAppConfig` resolves `/api/config` only AFTER hydration, so SSR —
 * and therefore the HTML a crawler consumes — always renders with the
 * fallback below, never the backend's live value. Hard-coding
 * `phase1Only: true` while the backend defaults `LOOP_PHASE_1_ONLY` to
 * `false` made a crawler index the "Coming soon" gate while a real
 * runtime hydrated to the live Phase-2 page: a crawler/runtime mismatch
 * on every deployment whose backend serves `phase1Only:false`
 * (staging/preview/local, and prod the moment Phase 2 launches).
 *
 * Source the fallback from a build-time flag that mirrors the backend's
 * `LOOP_PHASE_1_ONLY` for the same deployment (set in lockstep at deploy
 * time). SSR (crawler) and runtime then compute the same gate from the
 * same answer instead of disagreeing. Only an explicit `'false'` opens
 * the gate — unset stays `true` (the safe Phase-1 reality, matching prod
 * today), so a missing flag never unlocks Phase 2. Bracket access keeps
 * the read at runtime (stubbable in tests) rather than statically inlined.
 */
export function defaultPhase1Only(): boolean {
  return import.meta.env['VITE_PHASE_1_ONLY'] !== 'false';
}

const DEFAULT_CONFIG: AppConfig = {
  loopAuthNativeEnabled: false,
  loopOrdersEnabled: false,
  // Base value only — `useAppConfig` overrides `phase1Only` with the
  // deploy-aware `defaultPhase1Only()` at call time so SSR/first-paint
  // tracks the deployment. Kept `true` here as the safe fallback for any
  // reader that consumes DEFAULT_CONFIG directly. `phase1Only` only
  // governs UI visibility — the cashback flow itself is independently
  // gated on `loopOrdersEnabled` / `loopAuthNativeEnabled`, so this
  // unlocks nothing live; it only hides Phase-2 surfaces until config
  // confirms they're on.
  phase1Only: true,
  // Default all LOOP assets to unavailable — matches a deployment that
  // hasn't yet configured Stellar issuers. Components that branch on
  // `loopAssets.*.available` see "coming soon" until the real config
  // resolves (ADR 015).
  loopAssets: {
    USDLOOP: { issuer: null, available: false },
    GBPLOOP: { issuer: null, available: false },
    EURLOOP: { issuer: null, available: false },
  },
  social: {
    googleClientIdWeb: null,
    googleClientIdIos: null,
    googleClientIdAndroid: null,
    appleServiceId: null,
  },
  // P2-14: default to no gate. A missing / erroring config must never
  // fabricate a version floor that would lock users out of a working
  // build — fail open, same principle as every other flag here.
  minSupportedVersion: { ios: null, android: null },
};

export function useAppConfig(): { config: AppConfig; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['app-config'],
    queryFn: fetchAppConfig,
    // 10 minutes — matches the backend's Cache-Control. Prevents
    // every tab + every component from re-fetching on mount.
    staleTime: 10 * 60 * 1000,
    // Never retry config — if the backend can't serve it we fall
    // back to the safe defaults.
    retry: false,
  });
  // FE-22: the fallback carries the deploy-aware `phase1Only` so the
  // gate SSR (crawler) renders matches the one a real runtime hydrates
  // to. `useMemo` keeps a stable reference across renders (matching the
  // old module-const behaviour) — consumers using `config` in effect
  // deps don't loop — while still reading the flag at mount so tests can
  // stub the env before render.
  const fallback = useMemo<AppConfig>(
    () => ({ ...DEFAULT_CONFIG, phase1Only: defaultPhase1Only() }),
    [],
  );
  return {
    config: query.data ?? fallback,
    isLoading: query.isLoading,
  };
}
