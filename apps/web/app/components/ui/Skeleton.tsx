interface SkeletonProps {
  className?: string;
}

/** Animated placeholder for loading content. */
export function Skeleton({ className = '' }: SkeletonProps): React.JSX.Element {
  return <div className={`animate-pulse rounded-lg bg-gray-200 dark:bg-gray-800 ${className}`} />;
}

/** Skeleton shaped like a merchant card. */
export function MerchantCardSkeleton(): React.JSX.Element {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <Skeleton className="h-32 w-full rounded-none" />
      <div className="p-3 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

/** Skeleton shaped like an order row. */
export function OrderRowSkeleton(): React.JSX.Element {
  return (
    <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800">
      <div className="space-y-2 flex-1">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="flex items-center gap-3 ml-4">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
    </div>
  );
}
