/**
 * `GET /api/me/wallet` registration (ADR 030 Phase C4).
 *
 * Embedded-wallet balance surface: address + provisioning state +
 * on-chain LOOP balances (the authoritative balance under ADR 036)
 * + interest APY. Wire shape canonical in
 * `@loop/shared/users-wallet` (`UserWalletResponse`).
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export function registerUsersWalletOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: z.ZodTypeAny,
): void {
  const UserWalletBalance = registry.register(
    'UserWalletBalance',
    z.object({
      assetCode: loopAssetCode,
      balance: z.string().openapi({
        description:
          'Horizon-style 7-decimal amount string (e.g. `"5.0000000"` = 5 GBPLOOP). On-chain balance is the authoritative user balance (ADR 036).',
        example: '5.0000000',
      }),
    }),
  );

  const UserWalletResponse = registry.register(
    'UserWalletResponse',
    z.object({
      address: z.string().nullable().openapi({
        description:
          'Embedded-wallet Stellar address (G…). Null until a provider wallet has been provisioned.',
      }),
      provisioning: z.enum(['none', 'wallet_created', 'activated']).openapi({
        description:
          'Wallet-provisioning lifecycle (migration 0040): none → wallet_created (provider wallet exists) → activated (sponsored Stellar account live with LOOP trustlines).',
      }),
      balances: z.array(UserWalletBalance).openapi({
        description:
          'On-chain LOOP-asset balances. Empty until the wallet is activated; only configured LOOP assets appear.',
      }),
      interestApyBps: z.number().int().openapi({
        description:
          'On-chain interest APY in basis points (ADR 031 nightly mints). Non-zero only when LOOP_INTEREST_ONCHAIN_ENABLED is set with a non-zero APY — the legacy off-chain accrual never moves the on-chain balance and is not advertised here. 0 = no rate chip.',
      }),
      stale: z.boolean().openapi({
        description:
          'True when Horizon was unreachable and `balances` is a last-known-good snapshot (never-500 fallback).',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/me/wallet',
    summary: 'Embedded-wallet balance surface (ADR 030 Phase C4).',
    description:
      "Returns the caller's embedded-wallet address, provisioning state, on-chain LOOP-asset balances (authoritative per ADR 036 — the off-chain mirror is not exposed here), and the interest APY. Never-500: a Horizon outage serves the last-known-good balances with `stale: true` instead of failing.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Wallet snapshot',
        content: { 'application/json': { schema: UserWalletResponse } },
      },
      401: {
        description: 'Missing or invalid bearer (Loop-native auth required)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Database unavailable while resolving the caller (`SERVICE_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
