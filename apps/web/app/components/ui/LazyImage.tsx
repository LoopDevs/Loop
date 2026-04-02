import { useState } from 'react';

interface LazyImageProps {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  className?: string;
  /** Eagerly load (above the fold). Default: lazy. */
  eager?: boolean;
}

/**
 * Image with shimmer placeholder and fade-in on load.
 * Shows a pulse animation while loading, fades in when ready.
 * On error, stays on the placeholder (no broken image icon).
 */
export function LazyImage({
  src,
  alt,
  width,
  height,
  className = '',
  eager = false,
}: LazyImageProps): React.JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* Shimmer placeholder */}
      {!loaded && !error && (
        <div className="absolute inset-0 bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 dark:from-gray-700 dark:via-gray-600 dark:to-gray-700 animate-pulse" />
      )}

      {/* Error fallback */}
      {error && (
        <div className="absolute inset-0 bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-800" />
      )}

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
