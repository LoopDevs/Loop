// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import type * as ApiModule from '../api-client';
import { downloadCashbackHistoryCsv } from '../user';

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

describe('downloadCashbackHistoryCsv', () => {
  it('requests the csv endpoint with binary: true + Accept: text/csv', async () => {
    apiMock.authenticatedRequest.mockResolvedValue(new ArrayBuffer(0));
    // Stub the URL + document methods jsdom doesn't ship.
    const createObjectURL = vi.fn(() => 'blob:test/abc');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    await downloadCashbackHistoryCsv();
    expect(apiMock.authenticatedRequest).toHaveBeenCalledWith(
      '/api/users/me/cashback-history.csv',
      expect.objectContaining({
        binary: true,
        headers: { Accept: 'text/csv' },
      }),
    );
  });

  it('triggers a browser download with the expected filename', async () => {
    const encoder = new TextEncoder();
    apiMock.authenticatedRequest.mockResolvedValue(encoder.encode('header\r\nrow').buffer);

    const createObjectURL = vi.fn(() => 'blob:test/file');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });

    // Intercept the anchor to inspect what `.click()` receives.
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

    await downloadCashbackHistoryCsv();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = anchors[0]!;
    expect(anchor.getAttribute('download')).toBe('loop-cashback-history.csv');
    expect(anchor.getAttribute('href')).toBe('blob:test/file');

    createSpy.mockRestore();
  });

  it('is a no-op in a non-browser environment (SSR guard)', async () => {
    apiMock.authenticatedRequest.mockResolvedValue(new ArrayBuffer(0));
    // Temporarily remove `document` so the function's SSR branch hits.
    const originalDocument = globalThis.document;
    // @ts-expect-error — simulating a non-DOM environment
    delete (globalThis as { document?: unknown }).document;
    try {
      await expect(downloadCashbackHistoryCsv()).resolves.toBeUndefined();
    } finally {
      (globalThis as { document: typeof originalDocument }).document = originalDocument;
    }
  });
});
