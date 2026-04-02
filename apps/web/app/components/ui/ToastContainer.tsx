import { useUiStore } from '~/stores/ui.store';

const TYPE_STYLES = {
  success: 'bg-green-600 text-white',
  error: 'bg-red-600 text-white',
  info: 'bg-gray-800 text-white dark:bg-gray-700',
} as const;

/** Renders floating toast notifications from the UI store. */
export function ToastContainer(): React.JSX.Element | null {
  const toasts = useUiStore((s) => s.toasts);
  const removeToast = useUiStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm native-safe-top"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`px-4 py-3 rounded-lg shadow-lg text-sm font-medium animate-slide-in ${TYPE_STYLES[toast.type]}`}
        >
          <div className="flex items-center justify-between gap-3">
            <span>{toast.message}</span>
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              className="text-white/70 hover:text-white text-lg leading-none"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
