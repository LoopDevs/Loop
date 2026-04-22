import { useState } from 'react';
import { downloadAdminCsv } from '~/services/admin';

interface Props {
  path: string;
  filename: string;
  label?: string;
}

/**
 * Reusable "Download CSV" button for admin list pages. Wraps
 * downloadAdminCsv with a busy state and inline error — the
 * handler auth flow can take a second on large exports, and
 * silent failure is worse than a visible hint when ops tries to
 * pull a month-end finance file and nothing happens.
 */
export function CsvDownloadButton({
  path,
  filename,
  label = 'Download CSV',
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await downloadAdminCsv(path, filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={busy}
        className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        {busy ? 'Downloading…' : label}
      </button>
      {error !== null ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}
