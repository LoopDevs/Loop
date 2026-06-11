/**
 * Well-known section of the OpenAPI spec — schema + path
 * registration for `GET /.well-known/jwks.json` (ADR 030 Phase A):
 * the public JWKS document external verifiers (wallet provider
 * custom auth, or any RFC 7517 consumer) use to verify Loop-minted
 * RS256 JWTs.
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components, used by the 429.
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
}
