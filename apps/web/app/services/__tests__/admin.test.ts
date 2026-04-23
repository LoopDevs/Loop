// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import type * as ApiModule from '../api-client';
import { downloadAdminOrdersCsv } from '../admin';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    authenticatedRequest: vi.fn(),
  },
}));

vi.mock('../api-client', async (importActual) => {
  const actual = (await importActual()) as typeof ApiModule;
  return {
    ...actual,
    authenticatedRequest: (path: string, opts?: unknown) =>
      apiMock.authenticatedRequest(path, opts),
  };
});

afterEach(() => {
  apiMock.authenticatedRequest.mockReset();
});

function stubBlobApis(): { createObjectURL: ReturnType<typeof vi.fn> } {
  const createObjectURL = vi.fn(() => 'blob:test/orders-csv');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
  return { createObjectURL };
}

describe('downloadAdminOrdersCsv', () => {
  it('hits /api/admin/orders.csv without a query string by default', async () => {
    apiMock.authenticatedRequest.mockResolvedValue(new ArrayBuffer(0));
    stubBlobApis();
    await downloadAdminOrdersCsv();
    expect(apiMock.authenticatedRequest).toHaveBeenCalledWith(
      '/api/admin/orders.csv',
      expect.objectContaining({ binary: true, headers: { Accept: 'text/csv' } }),
    );
  });

  it('appends ?state= when a filter is supplied', async () => {
    apiMock.authenticatedRequest.mockResolvedValue(new ArrayBuffer(0));
    stubBlobApis();
    await downloadAdminOrdersCsv({ state: 'failed' });
    expect(apiMock.authenticatedRequest).toHaveBeenCalledWith(
      '/api/admin/orders.csv?state=failed',
      expect.objectContaining({ binary: true }),
    );
  });

  it('triggers an anchor download with the state-reflective filename', async () => {
    apiMock.authenticatedRequest.mockResolvedValue(new ArrayBuffer(0));
    const { createObjectURL } = stubBlobApis();

    const realCreate = document.createElement.bind(document);
    const clickSpy = vi.fn();
    const anchors: HTMLAnchorElement[] = [];
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = clickSpy;
        anchors.push(el as HTMLAnchorElement);
      }
      return el;
    });

    await downloadAdminOrdersCsv({ state: 'fulfilled' });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = anchors[0]!;
    expect(anchor.getAttribute('download')).toBe('loop-admin-orders-fulfilled.csv');
    createSpy.mockRestore();
  });

  it('uses the unfiltered filename when no state is passed', async () => {
    apiMock.authenticatedRequest.mockResolvedValue(new ArrayBuffer(0));
    stubBlobApis();
    const realCreate = document.createElement.bind(document);
    const anchors: HTMLAnchorElement[] = [];
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = vi.fn();
        anchors.push(el as HTMLAnchorElement);
      }
      return el;
    });
    await downloadAdminOrdersCsv();
    expect(anchors[0]!.getAttribute('download')).toBe('loop-admin-orders.csv');
    createSpy.mockRestore();
  });

  it('is a no-op in a non-browser environment (SSR guard)', async () => {
    apiMock.authenticatedRequest.mockResolvedValue(new ArrayBuffer(0));
    const originalDocument = globalThis.document;
    // @ts-expect-error — simulating a non-DOM environment
    delete (globalThis as { document?: unknown }).document;
    try {
      await expect(downloadAdminOrdersCsv({ state: 'failed' })).resolves.toBeUndefined();
    } finally {
      (globalThis as { document: typeof originalDocument }).document = originalDocument;
    }
  });
});
