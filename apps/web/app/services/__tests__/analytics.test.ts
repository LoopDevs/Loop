import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api-client', () => ({
  apiRequest: vi.fn(),
}));

import { sendRumEvent } from '../analytics';
import { apiRequest } from '../api-client';

const mockApiRequest = vi.mocked(apiRequest);

beforeEach(() => {
  mockApiRequest.mockReset();
});

/**
 * ADR 048 — `sendRumEvent` is a thin, best-effort `POST /api/public/rum`
 * wrapper. Fire-and-forget by design: analytics must never throw into
 * the caller, so the network-failure case is asserted explicitly.
 */
describe('sendRumEvent', () => {
  it('POSTs a vital event to /api/public/rum', async () => {
    mockApiRequest.mockResolvedValue({ ok: true });
    await sendRumEvent({ type: 'vital', name: 'LCP', value: 1800 });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/public/rum', {
      method: 'POST',
      body: { type: 'vital', name: 'LCP', value: 1800 },
      timeoutMs: 5000,
    });
  });

  it('POSTs a page-view event to /api/public/rum', async () => {
    mockApiRequest.mockResolvedValue({ ok: true });
    await sendRumEvent({ type: 'pageview' });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/public/rum', {
      method: 'POST',
      body: { type: 'pageview' },
      timeoutMs: 5000,
    });
  });

  it('never throws when the request fails', async () => {
    mockApiRequest.mockRejectedValue(new Error('network error'));
    await expect(sendRumEvent({ type: 'pageview' })).resolves.toBeUndefined();
  });
});
