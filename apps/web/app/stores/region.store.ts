import { create } from 'zustand';

import { DEFAULT_REGION, regionByCode, regionForCountry, type RegionCode } from '@loop/shared';

import { fetchGeo } from '~/services/geo';

const STORAGE_KEY = 'loop_region';

interface RegionState {
  /** The active region driving the merchant filter + price-display currency. */
  region: RegionCode;
  /** True once the client-side first-guess has run (avoids re-guessing / SSR mismatch). */
  hydrated: boolean;
  /** The user's explicit pick — persisted to localStorage so it sticks across visits. */
  setRegion: (code: RegionCode) => void;
  /** First-guess: saved choice → IP geo → browser locale → US. Runs once, client-only. */
  hydrate: () => Promise<void>;
}

/**
 * Region selector state. Initialises to {@link DEFAULT_REGION} so SSR and the first client
 * render agree; {@link RegionState.hydrate} then applies the saved choice / first-guess on
 * the client. Only an explicit {@link RegionState.setRegion} persists — a first-guess does
 * not, so a returning visitor keeps their choice while a new one is re-guessed each session.
 */
export const useRegionStore = create<RegionState>((set, get) => ({
  region: DEFAULT_REGION,
  hydrated: false,

  setRegion: (code) => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(STORAGE_KEY, code);
      } catch {
        // storage can be blocked (private mode) — non-fatal, selection still applies in-memory
      }
    }
    set({ region: code });
  },

  hydrate: async () => {
    if (get().hydrated || typeof window === 'undefined') return;
    set({ hydrated: true });

    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored) {
      set({ region: regionByCode(stored).code });
      return;
    }

    // No saved choice — guess from the browser locale immediately, then upgrade to the
    // server's IP-geolocation result when it arrives.
    const localeCountry = (window.navigator.language || '').split('-')[1] ?? '';
    set({ region: regionForCountry(localeCountry) });
    try {
      const geo = await fetchGeo();
      if (geo.countryCode) set({ region: geo.region });
    } catch {
      // keep the locale guess
    }
  },
}));
