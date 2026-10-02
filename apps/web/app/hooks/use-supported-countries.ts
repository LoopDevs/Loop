import { useMemo } from 'react';
import { COUNTRIES, type Country } from '@loop/shared';
import { useAppConfig } from '~/hooks/use-app-config';

export function supportedCountries(operatorCountries: readonly string[]): Country[] {
  if (operatorCountries.length === 0) return [...COUNTRIES];
  const enabled = new Set(operatorCountries.map((code) => code.toUpperCase()));
  return COUNTRIES.filter((country) => enabled.has(country.code.toUpperCase()));
}

export function useSupportedCountries(): Country[] {
  const { config } = useAppConfig();
  const operatorCountries = config.countries;
  return useMemo(() => supportedCountries(operatorCountries ?? []), [operatorCountries]);
}
