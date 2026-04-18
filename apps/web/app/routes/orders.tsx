import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/orders';
import type { Order } from '@loop/shared';
import { ApiException } from '@loop/shared';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useAuth } from '~/hooks/use-auth';
import { useOrders } from '~/hooks/use-orders';
import { Navbar } from '~/components/features/Navbar';
import { OrderRowSkeleton } from '~/components/ui/Skeleton';
import { Button } from '~/components/ui/Button';
import { friendlyError } from '~/utils/error-messages';
import { formatMoney } from '~/utils/money';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Orders — Loop' }];
}

export function ErrorBoundary(): React.JSX.Element {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
          Something went wrong
        </h1>
        <a href="/orders" className="text-blue-600 underline">
          Try again
        </a>
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: {
    label: 'Pending',
    color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  },
  completed: {
    label: 'Completed',
    color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  },
  failed: {
    label: 'Failed',
    color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  },
  expired: {
    label: 'Expired',
    color: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300',
  },
};

function OrderRow({ order }: { order: Order }): React.JSX.Element {
  const status = STATUS_LABELS[order.status] ?? STATUS_LABELS['pending']!;
  // A malformed upstream createdAt would otherwise render "Invalid Date" in
  // the UI. Fall back to the raw string so the row is still informative.
  const parsed = new Date(order.createdAt);
  const date = Number.isNaN(parsed.getTime())
    ? order.createdAt
    : parsed.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

  return (
    <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 dark:text-white truncate">{order.merchantName}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400">{date}</p>
      </div>
      <div className="flex items-center gap-3 ml-4">
        <span className="text-sm font-semibold text-gray-900 dark:text-white">
          {formatMoney(order.amount, order.currency)}
        </span>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${status.color}`}>
          {status.label}
        </span>
      </div>
    </div>
  );
}

function errorMessage(err: Error | null): string | null {
  if (err === null) return null;
  // 401 is the only status with list-specific copy — every other class of
  // error (offline / 429 / 503 / 502 / 504 / timeout) has a better generic
  // message in friendlyError than our old "Failed to load orders." string.
  if (err instanceof ApiException && err.status === 401) {
    return 'Please sign in to view your orders.';
  }
  return friendlyError(err, 'Failed to load orders.');
}

export default function OrdersRoute(): React.JSX.Element {
  const { isNative } = useNativePlatform();
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);

  const { orders, hasNext, hasPrev, isLoading, error } = useOrders(page, isAuthenticated);
  const errorText = errorMessage(error);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {!isNative && <Navbar />}

      <main className="max-w-2xl mx-auto px-4 py-8 pt-20">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Your orders</h1>

        {!isAuthenticated && (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400 mb-4">
              Sign in to view your order history.
            </p>
            <Button
              onClick={() => {
                void navigate('/auth');
              }}
            >
              Sign in
            </Button>
          </div>
        )}

        {isAuthenticated && isLoading && (
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
            {Array.from({ length: 5 }).map((_, i) => (
              <OrderRowSkeleton key={i} />
            ))}
          </div>
        )}

        {errorText !== null && (
          <div className="text-center py-12">
            <p className="text-red-500 mb-4">{errorText}</p>
            <Button variant="secondary" onClick={() => setPage(1)}>
              Retry
            </Button>
          </div>
        )}

        {isAuthenticated && !isLoading && errorText === null && orders.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400 mb-4">No orders yet.</p>
            <Button
              onClick={() => {
                void navigate('/');
              }}
            >
              Browse gift cards
            </Button>
          </div>
        )}

        {orders.length > 0 && (
          <>
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
              {orders.map((order) => (
                <OrderRow key={order.id} order={order} />
              ))}
            </div>

            <div className="flex justify-between mt-4">
              <Button
                variant="secondary"
                disabled={!hasPrev || isLoading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={!hasNext || isLoading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
