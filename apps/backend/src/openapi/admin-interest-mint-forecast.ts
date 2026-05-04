/**
 * Admin interest forward-mint forecast OpenAPI registration
 * (ADR 009 / 015).
 *
 * Sibling to `./admin-asset-drift-state.ts` and
 * `./admin-asset-circulation.ts` — same admin treasury surface,
 * focused on the interest-pool ops side rather than circulation
 * drift.
 *
 * Path:
 *   - GET /api/admin/interest/mint-forecast
 *
 * Locally-scoped schemas:
 *   - `InterestMintForecastRow`
 *   - `InterestMintForecastResponse`
 *
 * `loopAssetCode` is registered upstream and threaded in so every
 * consumer references the same enum instance.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export function registerAdminInterestMintForecastOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: z.ZodTypeAny,
): void {
  const LoopAssetCode = loopAssetCode;

  const InterestMintForecastRow = registry.register(
    'InterestMintForecastRow',
    z.object({
      assetCode: LoopAssetCode,
      currency: z.enum(['USD', 'GBP', 'EUR']),
      cohortBalanceMinor: z.string().openapi({
        description: 'Sum of user_credits.balance_minor for this currency. BigInt as string.',
      }),
      dailyInterestStroops: z.string().openapi({
        description:
          'Forecast daily interest for the cohort, expressed in LOOP-asset stroops (7-decimal). BigInt as string.',
      }),
      forecastDays: z.number().int(),
      forecastInterestStroops: z.string().openapi({
        description: 'dailyInterestStroops × forecastDays. BigInt as string.',
      }),
      poolStroops: z.string().openapi({
        description: 'On-chain balance of the forward-mint pool account, in stroops.',
      }),
      daysOfCover: z.number().nullable().openapi({
        description:
          'poolStroops / dailyInterestStroops. Null when daily interest is 0 (cohort empty).',
      }),
      minDaysOfCover: z.number().int().openapi({
        description: 'Operator alert threshold (LOOP_INTEREST_POOL_MIN_DAYS_COVER, default 7).',
      }),
      recommendedMintStroops: z.string().openapi({
        description:
          'Suggested next mint amount in stroops: max(0, forecastInterestStroops − poolStroops). Operator submits a Stellar payment from the issuer to the pool for this amount.',
      }),
    }),
  );

  const InterestMintForecastResponse = registry.register(
    'InterestMintForecastResponse',
    z.object({
      apyBasisPoints: z.number().int(),
      forecastDays: z.number().int(),
      poolAccount: z.string().nullable().openapi({
        description:
          'Stellar address of the forward-mint pool. Null when neither LOOP_INTEREST_POOL_ACCOUNT nor LOOP_STELLAR_OPERATOR_SECRET is configured.',
      }),
      asOfMs: z.number().int(),
      rows: z.array(InterestMintForecastRow).nullable().openapi({
        description:
          'Per-currency forecast rows. Null when interest is feature-off (INTEREST_APY_BASIS_POINTS=0) — clients render "interest not enabled."',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/interest/mint-forecast',
    summary: 'Forward-mint forecast for the interest pool (ADR 009 / 015).',
    description:
      'Returns per-currency: cohort balance, daily forecast interest, current pool balance, days of cover, recommended next-mint amount. Operator submits the actual mint transaction with their cold-stored issuer secret out-of-band — backend never holds that key.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        forecastDays: z.coerce.number().int().min(1).max(365).optional().openapi({
          description: 'Forecast window in days. Defaults to 35 (one month + buffer).',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Forecast snapshot',
        content: { 'application/json': { schema: InterestMintForecastResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      403: {
        description: 'Not an admin',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (30/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Horizon unreachable for pool-balance read',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
