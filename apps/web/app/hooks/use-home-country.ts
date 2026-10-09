import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { UserMeView } from '@loop/shared';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { getMe } from '~/services/user';
import { readCountryCookie } from '~/i18n/locale';

export function useHomeCountry(): string | null {
  const location = useLocation();
  const { isAuthenticated } = useAuth();
  const me = useQuery<UserMeView, Error>({
    queryKey: ['me'],
    queryFn: getMe,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 60_000,
  });
  const [cookieCountry, setCookieCountry] = useState<string | null>(null);

  useEffect(() => {
    setCookieCountry(readCountryCookie());
  }, [location]);

  const accountCountry = isAuthenticated ? (me.data?.country?.toLowerCase() ?? null) : null;
  return accountCountry ?? cookieCountry;
}
