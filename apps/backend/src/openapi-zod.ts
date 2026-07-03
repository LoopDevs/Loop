/**
 * OpenAPI-extended Zod (hardening D1).
 *
 * `@asteasolutions/zod-to-openapi`'s `extendZodWithOpenApi` adds
 * `.openapi()` to Zod schemas — but it must run BEFORE any schema the
 * OpenAPI registry consumes is *created*. Inline schemas in
 * `openapi/*.ts` are fine (created inside the register functions, after
 * `openapi.ts` extends z), but a handler's own request/response schema
 * module (e.g. `auth/request-schemas.ts`) creates its schemas at import
 * time — before that.
 *
 * D1 derives the spec FROM those handler schemas instead of
 * re-declaring them, so the fix is a single shared extended `z`:
 * any schema module that the spec derives from imports `z` from HERE
 * (not `'zod'`), guaranteeing `extendZodWithOpenApi` has run before its
 * schemas exist. `extendZodWithOpenApi` is idempotent, so importing
 * this alongside `openapi.ts`'s own extension is safe.
 *
 * Runtime cost: the library is already a prod dependency (the
 * `/openapi.json` route needs it at boot), so importing it on a handler
 * path adds no new dependency — just an already-loaded module.
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export { z };
