/**
 * `GET /api/me/vault-apy` registration (ADR 031 §Detailed design D8,
 * V5b).
 *
 * Past-30-day / past-90-day realised APY for the three LOOP-branded
 * yield assets. Wire shape canonical in `@loop/shared/vault-apy`
 * (`VaultApyResponse`). ⚠️ No yield-source/strategy disclosure (ADR
 * 031 §User-facing display) — the schema below carries only asset
 * codes, numbers, and a disclaimer key; keep it that way on any edit.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export function registerUsersVaultApyOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const VaultApyAssetCode = z.enum(['LOOPUSD', 'LOOPEUR', 'GBPLOOP']).openapi({
    description:
      'The three LOOP-branded yield assets (ADR 031 §Decision), current naming — distinct from the pre-rename LoopAssetCode enum used elsewhere.',
  });

  const VaultApyRange = z
    .object({
      minApy: z.number().openapi({ description: 'Decimal fraction, e.g. 0.028 = 2.8%.' }),
      maxApy: z.number().openapi({ description: 'Decimal fraction, e.g. 0.035 = 3.5%.' }),
    })
    .nullable();

  const VaultApyAsset = registry.register(
    'VaultApyAsset',
    z.object({
      assetCode: VaultApyAssetCode,
      past30dApy: z.number().nullable().openapi({
        description:
          'Past-30-day realised APY as a decimal fraction (0.0312 = 3.12%). Null when there is not yet at least 30 days of history for this asset — never a fabricated or divide-by-zero number.',
      }),
      past90dRange: VaultApyRange.openapi({
        description:
          'Min/max of the realised APY observed over the past 90 days. Null under the same insufficient-history rule as past30dApy.',
      }),
    }),
  );

  const VaultApyResponse = registry.register(
    'VaultApyResponse',
    z.object({
      assets: z.array(VaultApyAsset).openapi({
        description:
          'One entry per asset this deployment can currently pay APY on (an active vault for LOOPUSD/LOOPEUR; a configured on-chain-mint-eligible GBPLOOP issuer). Empty when the vault subsystem is disabled and no on-chain GBPLOOP interest path is configured.',
      }),
      disclaimerKey: z.string().openapi({
        description:
          'i18n lookup key for the always-visible "past performance doesn\'t guarantee future returns" disclaimer (ADR 031 §User-facing display) — never the disclaimer text itself.',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/me/vault-apy',
    summary: 'Past-30-day / past-90-day APY per LOOP-branded yield asset (ADR 031 §D8).',
    description:
      'Returns realised APY for LOOPUSD/LOOPEUR (from vault share-price history) and GBPLOOP (from nightly on-chain interest-mint history). Never discloses the underlying yield mechanism — numbers and a disclaimer key only.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Per-asset APY snapshot',
        content: { 'application/json': { schema: VaultApyResponse } },
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
        description:
          'Database unavailable while resolving the caller or computing APY (`SERVICE_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
