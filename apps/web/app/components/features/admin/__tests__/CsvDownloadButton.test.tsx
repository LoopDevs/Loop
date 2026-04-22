// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type * as AdminModule from '~/services/admin';
import { CsvDownloadButton } from '../CsvDownloadButton';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    downloadAdminCsv: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    downloadAdminCsv: (path: string, filename: string) =>
      adminMock.downloadAdminCsv(path, filename),
  };
});

describe('<CsvDownloadButton />', () => {
  it('renders the default label', () => {
    adminMock.downloadAdminCsv.mockResolvedValue(undefined);
    render(<CsvDownloadButton path="/api/admin/x.csv" filename="x.csv" />);
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDefined();
  });

  it('renders a custom label when provided', () => {
    adminMock.downloadAdminCsv.mockResolvedValue(undefined);
    render(<CsvDownloadButton path="/a" filename="a" label="Export" />);
    expect(screen.getByRole('button', { name: /Export/ })).toBeDefined();
  });

  it('calls the download helper with path + filename on click', async () => {
    adminMock.downloadAdminCsv.mockResolvedValue(undefined);
    render(<CsvDownloadButton path="/api/admin/orders.csv" filename="loop-orders.csv" />);
    fireEvent.click(screen.getByRole('button', { name: /Download CSV/ }));
    await waitFor(() => {
      expect(adminMock.downloadAdminCsv).toHaveBeenCalledWith(
        '/api/admin/orders.csv',
        'loop-orders.csv',
      );
    });
  });

  it('surfaces an inline error message when the download fails', async () => {
    adminMock.downloadAdminCsv.mockRejectedValue(new Error('403 forbidden'));
    render(<CsvDownloadButton path="/a" filename="a" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(screen.getByText(/403 forbidden/)).toBeDefined();
    });
  });
});
