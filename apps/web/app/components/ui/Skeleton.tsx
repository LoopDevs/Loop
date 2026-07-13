interface SkeletonProps {
  className?: string;
}

/**
 * Animated placeholder shape for loading content.
 *
 * Decorative by itself — like Spinner's SVG, a lone pulsing bar carries
 * no standalone meaning, so it is `aria-hidden` and AT skips it. The
 * composite skeletons below own the polite `role="status"` announcement
 * that tells screen-reader users content is loading.
 */
export function Skeleton({ className = '' }: SkeletonProps): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-lg bg-gray-200 dark:bg-gray-800 ${className}`}
    />
  );
}

/** Skeleton shaped like a merchant card. */
export function MerchantCardSkeleton(): React.JSX.Element {
  // Mirrors the real MerchantCard layout exactly (aspect-video banner,
  // overlapping logo well, title + denomination lines) so swapping
  // skeleton → card causes no vertical reflow.
  //
  // `role="status"` + an sr-only label mirror Spinner: the polite live
  // region announces "Loading" to AT while the decorative shapes stay
  // `aria-hidden`. The `sr-only` span is position:absolute, so it adds
  // no visual reflow.
  return (
    <div role="status" className="overflow-hidden rounded-lg border border-line bg-surface">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="p-4">
        <div
          aria-hidden="true"
          className="w-16 h-16 sm:w-20 sm:h-20 -mt-12 sm:-mt-16 mb-3 relative z-10 rounded-lg border border-line ring-4 ring-white bg-gray-100"
        />
        <Skeleton className="h-4 sm:h-5 w-3/4 mb-2" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}

/** Skeleton shaped like an order row. */
export function OrderRowSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800"
    >
      <div className="space-y-2 flex-1">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="flex items-center gap-3 ml-4">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
