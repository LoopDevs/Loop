// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { AppleSignInButton } from '../AppleSignInButton';

/**
 * CF-27 / audit M-01 — Sign in with Apple button.
 *
 * The Apple JS SDK is loaded via a `<script>` tag. We stub
 * `window.AppleID` directly and drive the `script.onload` callback so
 * the component's lazy-loader resolves without a real network fetch.
 */

interface AppleStub {
  init: ReturnType<typeof vi.fn>;
  signIn: ReturnType<typeof vi.fn>;
}

function installAppleStub(signInImpl: () => Promise<unknown>): AppleStub {
  const stub: AppleStub = {
    init: vi.fn(),
    signIn: vi.fn(signInImpl),
  };
  (window as unknown as { AppleID?: unknown }).AppleID = { auth: stub };
  return stub;
}

beforeEach(() => {
  // Each test mounts a fresh component; the module-level load promise is
  // short-circuited because `window.AppleID` is already present.
  delete (window as unknown as { AppleID?: unknown }).AppleID;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { AppleID?: unknown }).AppleID;
});

describe('AppleSignInButton', () => {
  it('renders an accessible button and initialises the SDK with the service id', async () => {
    const stub = installAppleStub(() => Promise.resolve({ authorization: {} }));
    render(<AppleSignInButton serviceId="io.loopfinance.app" onCredential={vi.fn()} />);

    const btn = screen.getByRole('button', { name: 'Sign in with Apple' });
    expect(btn).toBeDefined();
    await waitFor(() => expect(stub.init).toHaveBeenCalledTimes(1));
    expect(stub.init.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'io.loopfinance.app',
      usePopup: true,
    });
  });

  it('hands the id_token to onCredential on a successful sign-in', async () => {
    const stub = installAppleStub(() =>
      Promise.resolve({ authorization: { id_token: 'apple-id-token-xyz' } }),
    );
    const onCredential = vi.fn();
    render(<AppleSignInButton serviceId="io.loopfinance.app" onCredential={onCredential} />);

    const btn = screen.getByRole('button', { name: 'Sign in with Apple' });
    await waitFor(() => expect(stub.init).toHaveBeenCalled());
    fireEvent.click(btn);
    await waitFor(() => expect(onCredential).toHaveBeenCalledWith('apple-id-token-xyz'));
  });

  it('swallows a user-cancelled popup without calling onError', async () => {
    const stub = installAppleStub(() => Promise.reject({ error: 'popup_closed_by_user' }));
    const onCredential = vi.fn();
    const onError = vi.fn();
    render(
      <AppleSignInButton
        serviceId="io.loopfinance.app"
        onCredential={onCredential}
        onError={onError}
      />,
    );

    const btn = screen.getByRole('button', { name: 'Sign in with Apple' });
    await waitFor(() => expect(stub.init).toHaveBeenCalled());
    fireEvent.click(btn);
    await waitFor(() => expect(stub.signIn).toHaveBeenCalled());
    // Give the rejected promise a couple of ticks to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(onCredential).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('surfaces a real sign-in failure via onError', async () => {
    const stub = installAppleStub(() => Promise.reject(new Error('boom')));
    const onError = vi.fn();
    render(
      <AppleSignInButton serviceId="io.loopfinance.app" onCredential={vi.fn()} onError={onError} />,
    );

    const btn = screen.getByRole('button', { name: 'Sign in with Apple' });
    await waitFor(() => expect(stub.init).toHaveBeenCalled());
    fireEvent.click(btn);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
