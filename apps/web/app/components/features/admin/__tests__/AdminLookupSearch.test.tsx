// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { ApiException, type AdminLookupResponse } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { AdminLookupSearch } from '../AdminLookupSearch';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    adminLookup: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    adminLookup: (q: string) => adminMock.adminLookup(q),
  };
});

beforeEach(() => {
  adminMock.adminLookup.mockReset();
});

/** Echoes the current location so navigation targets are assertable. */
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderSearch(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <AdminLookupSearch />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function submit(q: string): Promise<void> {
  const input = screen.getByRole('textbox', {
    name: /Email, order id, payment memo, or Stellar address/i,
  });
  await act(async () => {
    fireEvent.change(input, { target: { value: q } });
  });
  await act(async () => {
    fireEvent.submit(screen.getByRole('search'));
  });
}

describe('<AdminLookupSearch />', () => {
  it('routes email queries to the existing /admin/users?q= directory search', async () => {
    renderSearch();
    await submit('alice@example.com');
    expect(screen.getByTestId('location').textContent).toBe('/admin/users?q=alice%40example.com');
    expect(adminMock.adminLookup).not.toHaveBeenCalled();
  });

  it('navigates to the order drill when the lookup resolves kind=order', async () => {
    adminMock.adminLookup.mockResolvedValue({
      kind: 'order',
      orderId: 'ord-123',
      userId: 'u-1',
    } satisfies AdminLookupResponse);
    renderSearch();
    await submit('ord-123');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/admin/orders/ord-123');
    });
    expect(adminMock.adminLookup).toHaveBeenCalledWith('ord-123');
  });

  it('navigates to the user 360 when a payment memo resolves to a user', async () => {
    adminMock.adminLookup.mockResolvedValue({
      kind: 'payment_memo',
      userId: 'u-42',
      orderId: 'ord-42',
    } satisfies AdminLookupResponse);
    renderSearch();
    await submit('LOOPMEMO42');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/admin/users/u-42');
    });
  });

  it('navigates to the user 360 when a Stellar address resolves to a user', async () => {
    adminMock.adminLookup.mockResolvedValue({
      kind: 'stellar_address',
      userId: 'u-77',
    } satisfies AdminLookupResponse);
    renderSearch();
    await submit('GABCDEFstellar');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/admin/users/u-77');
    });
  });

  it('shows the no-match hint on a 404 without navigating', async () => {
    // The backend has no `kind: 'none'` sentinel — a well-formed
    // identifier with no match is the uniform admin 404.
    adminMock.adminLookup.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'No order with that id' }),
    );
    renderSearch();
    await submit('garbage-id');
    await waitFor(() => {
      expect(screen.getByText(/No order, memo, or address matched/i)).toBeDefined();
    });
    expect(screen.getByTestId('location').textContent).toBe('/admin');
  });

  it('surfaces a lookup error inline', async () => {
    adminMock.adminLookup.mockRejectedValue(
      new ApiException(503, { code: 'CIRCUIT_OPEN', message: 'Lookup unavailable' }),
    );
    renderSearch();
    await submit('something');
    await waitFor(() => {
      expect(screen.getByText(/Lookup unavailable/i)).toBeDefined();
    });
  });
});
