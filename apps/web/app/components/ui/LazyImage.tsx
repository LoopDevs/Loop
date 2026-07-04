import { useState } from 'react';

interface LazyImageProps {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  className?: string;
  /** Eagerly load (above the fold). Default: lazy. */
  eager?: boolean;
  /**
   * Rendered on load ERROR instead of the neutral grey placeholder. Pass the
   * same fallback the caller shows when `src` is absent (e.g. a letter
   * monogram) so a present-but-broken URL — a logo.dev 404, a dead CDN link —
   * degrades to the intended fallback rather than a permanent grey box, which
   * looked worse than having no image at all.
   */
  fallback?: React.ReactNode;
}

/**
 * Image with shimmer placeholder and fade-in on load.
 * Shows a pulse animation while loading, fades in when ready.
 * On error, renders `fallback` if given, else the neutral grey placeholder.
 */
export function LazyImage({
  src,
  alt,
  width,
  height,
  className = '',
  eager = false,
  fallback,
}: LazyImageProps): React.JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* Shimmer placeholder */}
      {!loaded && !error && (
        <div className="absolute inset-0 bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 dark:from-gray-700 dark:via-gray-600 dark:to-gray-700 animate-pulse" />
      )}

      {/* Error fallback — the caller's fallback (e.g. a monogram) if provided,
          else a neutral grey box. */}
      {error &&
        (fallback !== undefined ? (
          <div className="absolute inset-0 flex items-center justify-center">{fallback}</div>
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-800" />
        ))}

      {/* Actual image */}
      {!error && (
        <img
          src={src}
          alt={alt}
          width={width}
          height={height}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </div>
  );
}
