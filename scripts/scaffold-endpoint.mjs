#!/usr/bin/env node
/**
 * Endpoint scaffold generator (hardening D3).
 *
 * Adding one backend endpoint touches ≥5 places — a handler, the route
 * mount, the OpenAPI registration (with the RIGHT status codes: 429 if
 * rate-limited, 404-not-403 on /api/admin), a test, and often a web
 * client + shared type. `app.ts` and `services/admin.ts` are the repo's
 * top churn hotspots precisely because that fan-out is manual and easy
 * to get partially wrong (a missing OpenAPI registration is caught by
 * `check-openapi-parity`, but only after the fact).
 *
 * This generator turns the fan-out into one command. It WRITES the
 * new-file boilerplate (handler + test) in the correct shape for the
 * chosen tier, and PRINTS exact paste-snippets + a checklist for the
 * hand-edited join points (route mount, OpenAPI, web client) — it does
 * not auto-edit shared files, because a bad automated edit to `app.ts`
 * is worse than a checklist. Pairs with the `/add-endpoint` skill,
 * which is the human-judgment companion.
 *
 * Usage:
 *   node scripts/scaffold-endpoint.mjs \
 *     --method GET --path /api/example/:id --name getExample \
 *     --tier authed --domain example [--rate 60] [--dry-run]
 *
 * Tiers: public | authed | admin | support
 *   public  — no auth middleware
 *   authed  — requireAuth
 *   admin   — requireStaff('admin')  (OpenAPI: 404 not 403 for non-staff)
 *   support — requireStaff('support')
 *
 * --dry-run prints everything it WOULD do without writing files (used
 * by the generator's own test).
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(REPO_ROOT, 'apps/backend/src');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function fail(msg) {
  console.error(`scaffold-endpoint: ${msg}`);
  process.exit(1);
}

/** kebab-case a camelCase / PascalCase name. */
function kebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

/** Build the plan (pure — the test asserts on this). */
export function buildPlan(rawArgs) {
  const method = String(rawArgs.method ?? '').toUpperCase();
  const path = String(rawArgs.path ?? '');
  const name = String(rawArgs.name ?? '');
  const tier = String(rawArgs.tier ?? 'authed');
  const domain = String(rawArgs.domain ?? '');
  const rate = rawArgs.rate !== undefined ? Number(rawArgs.rate) : undefined;

  const errors = [];
  if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method))
    errors.push('--method must be one of GET|POST|PUT|DELETE|PATCH');
  if (!path.startsWith('/api/')) errors.push('--path must start with /api/');
  if (!/^[a-z][A-Za-z0-9]*$/.test(name))
    errors.push('--name must be a camelCase identifier (e.g. getExample)');
  if (!['public', 'authed', 'admin', 'support'].includes(tier))
    errors.push('--tier must be one of public|authed|admin|support');
  if (!/^[a-z][a-z0-9-]*$/.test(domain))
    errors.push('--domain must be a kebab/lowercase module name (e.g. example)');
  if (errors.length > 0) return { errors };

  const handlerFile = `apps/backend/src/${domain}/${kebab(name)}-handler.ts`;
  const testFile = `apps/backend/src/${domain}/__tests__/${kebab(name)}-handler.test.ts`;
  const routeFile = `apps/backend/src/routes/${domain}.ts`;
  const openapiFile = `apps/backend/src/openapi/${domain}.ts`;

  const isAdminTier = tier === 'admin' || tier === 'support';
  // OpenAPI status codes the handler CAN return, per the repo convention
  // (AGENTS.md doc-update table): 429 if rate-limited; on /api/admin the
  // gate masks non-staff as 404, never 403.
  const statuses = ['200'];
  if (method !== 'GET') statuses.push('400');
  if (tier !== 'public') statuses.push('401');
  if (isAdminTier) statuses.push('404'); // requireStaff masks non-staff/wrong-tier as 404
  if (rate !== undefined) statuses.push('429');
  statuses.push('500');

  const tierMiddleware = {
    public: null,
    authed: 'requireAuth',
    admin: "requireStaff('admin')",
    support: "requireStaff('support')",
  }[tier];

  return {
    errors: [],
    method,
    path,
    name,
    tier,
    domain,
    rate,
    handlerFile,
    testFile,
    routeFile,
    openapiFile,
    isAdminTier,
    statuses,
    tierMiddleware,
    honoMethod: method.toLowerCase(),
    rateLimitId: `${method} ${path}`,
  };
}

function handlerSource(plan) {
  const auth =
    plan.tier === 'authed'
      ? `  const auth = c.get('auth') as { userId: string } | undefined;\n  if (auth === undefined) {\n    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);\n  }\n`
      : '';
  return `/**
 * ${plan.method} ${plan.path} — TODO(describe): one-line purpose.
 *
 * Tier: ${plan.tier}${plan.rate !== undefined ? ` · rate ${plan.rate}/min` : ''}. Generated by scripts/scaffold-endpoint.mjs (D3).
 * Fill in the body, then run \`npm run verify\`. The route mount +
 * OpenAPI registration snippets were printed by the generator — paste
 * them (see the /add-endpoint skill for the full checklist).
 */
import type { Context } from 'hono';
import { logger } from '../logger.js';

const log = logger.child({ handler: '${plan.name}' });

export async function ${plan.name}Handler(c: Context): Promise<Response> {
${auth}  // TODO: implement. Every upstream/DB result must be validated before
  // returning; declare every status code you return in the OpenAPI
  // registration (${plan.statuses.join(', ')}).
  try {
    log.debug('${plan.name} called');
    return c.json({ ok: true });
  } catch (err) {
    log.error({ err }, '${plan.name} failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Request failed' }, 500);
  }
}
`;
}

function testSource(plan) {
  return `import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { ${plan.name}Handler } from '../${kebab(plan.name)}-handler.js';

function makeCtx(opts: { auth?: { userId: string }; param?: Record<string, string> } = {}): Context {
  const store = new Map<string, unknown>();
  if (opts.auth) store.set('auth', opts.auth);
  return {
    req: { param: (k: string) => opts.param?.[k] },
    get: (k: string) => store.get(k),
    json: (b: unknown, s?: number) => new Response(JSON.stringify(b), { status: s ?? 200 }),
  } as unknown as Context;
}

describe('${plan.name}Handler', () => {
${
  plan.tier === 'authed'
    ? `  it('401s without an auth context', async () => {
    const res = await ${plan.name}Handler(makeCtx({}));
    expect(res.status).toBe(401);
  });

  it('200s for an authenticated caller (TODO: assert real behaviour)', async () => {
    const res = await ${plan.name}Handler(makeCtx({ auth: { userId: 'u-1' } }));
    expect(res.status).toBe(200);
  });`
    : `  it('200s (TODO: assert real behaviour)', async () => {
    const res = await ${plan.name}Handler(makeCtx({}));
    expect(res.status).toBe(200);
  });`
}
});
`;
}

function mountSnippet(plan) {
  const mw = [];
  if (plan.rate !== undefined) mw.push(`rateLimit('${plan.rateLimitId}', ${plan.rate}, 60_000)`);
  if (plan.tierMiddleware) mw.push(plan.tierMiddleware);
  mw.push(`${plan.name}Handler`);
  return `  // ${plan.method} ${plan.path}
  app.${plan.honoMethod}(\n    '${plan.path.replace(/:([A-Za-z0-9_]+)/g, ':$1')}',\n${mw
    .map((m) => `    ${m},`)
    .join('\n')}\n  );`;
}

function openapiSnippet(plan) {
  const responses = plan.statuses
    .map((s) => {
      const desc = {
        200: 'Success',
        400: 'Validation error',
        401: 'Missing or invalid bearer',
        404: plan.isAdminTier
          ? 'Not found (requireStaff masks non-staff/wrong-tier as 404, never 403)'
          : 'Not found',
        429: `Rate limit exceeded (${plan.rate}/min per IP)`,
        500: 'Internal error (`INTERNAL_ERROR`)',
      }[s];
      const schema = s === '200' ? 'z.object({ ok: z.boolean() })' : 'errorResponse';
      return `      ${s}: {\n        description: '${desc}',\n        content: { 'application/json': { schema: ${schema} } },\n      },`;
    })
    .join('\n');
  return `  registry.registerPath({
    method: '${plan.honoMethod}',
    path: '${plan.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}',
    summary: 'TODO: one-line summary.',
    tags: ['${plan.isAdminTier ? 'Admin' : 'TODO'}'],
${plan.tier !== 'public' ? '    security: [{ bearerAuth: [] }],\n' : ''}    responses: {
${responses}
    },
  });`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildPlan(args);
  if (plan.errors.length > 0) {
    for (const e of plan.errors) console.error(`  ✗ ${e}`);
    fail('invalid arguments (see --help / the header comment)');
  }

  const dryRun = args['dry-run'] === true;
  const write = (rel, contents) => {
    const abs = join(REPO_ROOT, rel);
    if (dryRun) {
      console.log(`  would write ${rel} (${contents.split('\n').length} lines)`);
      return;
    }
    if (existsSync(abs)) fail(`${rel} already exists — refusing to overwrite`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
    console.log(`  ✓ wrote ${rel}`);
  };

  console.log(`\nScaffolding ${plan.method} ${plan.path} (${plan.tier})\n`);
  write(plan.handlerFile, handlerSource(plan));
  write(plan.testFile, testSource(plan));

  console.log(`\n── Paste into ${plan.routeFile} (mountX routes fn) ──\n`);
  console.log(mountSnippet(plan));
  console.log(
    `\n  import { ${plan.name}Handler } from '../${plan.domain}/${kebab(plan.name)}-handler.js';`,
  );
  if (plan.rate !== undefined)
    console.log(`  // rateLimit is imported from '../middleware/rate-limit.js'`);
  if (plan.tierMiddleware?.startsWith('requireStaff'))
    console.log(`  // requireStaff is imported from '../auth/require-staff.js'`);
  if (plan.tier === 'authed') console.log(`  // requireAuth is imported from '../auth/handler.js'`);

  console.log(`\n── Paste into ${plan.openapiFile} (registerX fn) ──\n`);
  console.log(openapiSnippet(plan));

  console.log(`\n── Checklist (see /add-endpoint skill) ──`);
  console.log(
    `  [ ] mount the route (snippet above) — check-openapi-parity will FAIL until registered`,
  );
  console.log(`  [ ] register OpenAPI with statuses: ${plan.statuses.join(', ')}`);
  if (plan.isAdminTier)
    console.log(
      `  [ ] admin tier → OpenAPI declares 404 (not 403); add to staff-route-gating.test.ts inventory`,
    );
  console.log(`  [ ] if it returns a new shape → add the shared type in packages/shared`);
  console.log(`  [ ] if the web app calls it → add a service fn (never fetch() in a component)`);
  console.log(`  [ ] add the route to docs/architecture.md (lint-docs enforces this)`);
  console.log(`  [ ] fill in the handler + test, then: npm run verify\n`);
}

// Only run main() when invoked directly (not when imported by the test).
if (process.argv[1] && process.argv[1].endsWith('scaffold-endpoint.mjs')) {
  main();
}
