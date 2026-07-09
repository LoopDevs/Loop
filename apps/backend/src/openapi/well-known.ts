/**
 * Well-known section of the OpenAPI spec — schema + path registration
 * for:
 *
 * - `GET /.well-known/jwks.json` (ADR 030 Phase A): the public JWKS
 *   document external verifiers (wallet provider custom auth, or any
 *   RFC 7517 consumer) use to verify Loop-minted RS256 JWTs.
 * - `GET /.well-known/apple-app-site-association` +
 *   `GET /.well-known/assetlinks.json` (M-3 deep linking): the iOS
 *   Universal Links / Android App Links domain-verification files.
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components, used by the 404s and 429s.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the well-known endpoints + their associated schemas on
 * the supplied registry. Called once from openapi.ts during module
 * init.
 */
export function registerWellKnownOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const LoopJwksResponse = registry.register(
    'LoopJwksResponse',
    z
      .object({
        keys: z.array(
          z.object({
            kty: z.literal('RSA'),
            n: z.string().openapi({ description: 'RSA modulus, base64url (RFC 7518 §6.3.1.1).' }),
            e: z
              .string()
              .openapi({ description: 'RSA public exponent, base64url (RFC 7518 §6.3.1.2).' }),
            alg: z.literal('RS256'),
            use: z.literal('sig'),
            kid: z.string().openapi({
              description:
                'RFC 7638 SHA-256 JWK thumbprint (base64url). Matches the `kid` header of Loop-minted RS256 JWTs.',
            }),
          }),
        ),
      })
      .openapi({
        description:
          'Standard JWKS (RFC 7517) carrying the public halves of Loop’s RS256 JWT signing keys — current key first, previous key second during a rotation window. Empty `keys` array (still a valid JWKS) when the deployment has not cut over to RS256 yet. Public-key members only; never private material.',
      }),
  );

  registry.registerPath({
    method: 'get',
    path: '/.well-known/jwks.json',
    summary: 'Public JWKS for Loop-minted RS256 JWTs (ADR 030 Phase A).',
    description:
      'Unauthenticated, no PII. Lets an external wallet provider (or any JWKS consumer) verify Loop-signed access tokens without Loop sharing a secret. Responses carry `Cache-Control: public, max-age=3600`; the key-rotation runbook keeps the previous key published well beyond that window so cached key sets never miss a kid for a live token.',
    tags: ['Auth'],
    responses: {
      200: {
        description: 'JWKS document (current + previous RSA public keys)',
        content: { 'application/json': { schema: LoopJwksResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const AppleAppSiteAssociationResponse = registry.register(
    'AppleAppSiteAssociationResponse',
    z
      .object({
        applinks: z.object({
          apps: z
            .array(z.string())
            .openapi({ description: 'Always empty — legacy field required by the AASA schema.' }),
          details: z.array(
            z.object({
              appID: z.string().openapi({ description: '<APPLE_TEAM_ID>.io.loopfinance.app' }),
              paths: z
                .array(z.string())
                .openapi({ description: "['*'] — every path is a candidate Universal Link." }),
            }),
          ),
        }),
      })
      .openapi({
        description:
          'iOS Universal Links domain-verification file (M-3). Served only when `APPLE_TEAM_ID` is configured.',
      }),
  );

  registry.registerPath({
    method: 'get',
    path: '/.well-known/apple-app-site-association',
    summary: 'iOS Universal Links domain-verification file (M-3 deep linking).',
    description:
      "Unauthenticated, no PII, `Cache-Control: public, max-age=300`. Apple fetches this once per install to confirm loopfinance.io / www / beta may open the app instead of the browser. 404 `WELL_KNOWN_NOT_CONFIGURED` until the operator sets `APPLE_TEAM_ID` (go-live-plan L1-4) — deliberately a real 404 (file does not exist yet), not a 503, matching how Apple's verifier itself interprets a missing file.",
    tags: ['Auth'],
    responses: {
      200: {
        description: 'Universal Links association document',
        content: { 'application/json': { schema: AppleAppSiteAssociationResponse } },
      },
      404: {
        description: 'APPLE_TEAM_ID is not configured on this deployment',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const AssetlinksResponse = registry.register(
    'AssetlinksResponse',
    z
      .array(
        z.object({
          relation: z.array(z.string()),
          target: z.object({
            namespace: z.literal('android_app'),
            package_name: z.string().openapi({ description: 'io.loopfinance.app' }),
            sha256_cert_fingerprints: z
              .array(z.string())
              .openapi({ description: 'From ANDROID_CERT_SHA256, comma-split and trimmed.' }),
          }),
        }),
      )
      .openapi({
        description:
          'Android App Links domain-verification file (M-3). Served only when `ANDROID_CERT_SHA256` is configured.',
      }),
  );

  registry.registerPath({
    method: 'get',
    path: '/.well-known/assetlinks.json',
    summary: 'Android App Links domain-verification file (M-3 deep linking).',
    description:
      'Unauthenticated, no PII, `Cache-Control: public, max-age=300`. Android fetches this to confirm loopfinance.io / www / beta may open the app instead of the browser. 404 `WELL_KNOWN_NOT_CONFIGURED` until the operator sets `ANDROID_CERT_SHA256` (go-live-plan L1-5) — deliberately a real 404, matching how the Digital Asset Links verifier interprets a missing file.',
    tags: ['Auth'],
    responses: {
      200: {
        description: 'Digital Asset Links statement list',
        content: { 'application/json': { schema: AssetlinksResponse } },
      },
      404: {
        description: 'ANDROID_CERT_SHA256 is not configured on this deployment',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
