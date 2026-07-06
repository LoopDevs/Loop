#!/usr/bin/env node
/**
 * ai-extract.mjs — the Claude semantic-extraction pass (the "best AI pass").
 *
 * brand-brief.mjs already did the DETERMINISTIC layer: unioned the raw
 * multi-supplier data and anchored the domain from supplier-provided URLs. This
 * layer handles what regex can't — reading all the supplier text and deciding:
 *   - redeemableAt: every brand the card can be redeemed at, INCLUSIONS ONLY
 *     (a Gap Inc card → Gap / Old Navy / Banana Republic / Athleta; never a
 *     brand the text EXCLUDES). This is what drives the merchant splits/links.
 *   - category, and a semantic confidence + a supporting quote (evidence).
 *
 * Plain fetch to the Anthropic Messages API (ANTHROPIC_API_KEY) — matches how
 * the pipeline calls Tavily/logo.dev, so no SDK dependency. Model is
 * configurable (AI_EXTRACT_MODEL); defaults to a balanced one. The deterministic
 * supplier-anchored domain always wins over the model's — the model never
 * overrides a high-trust anchor, it only fills the semantic gaps.
 *
 * API:
 *   buildExtractionPrompt(brief, textBlob) → { system, user }
 *   parseExtraction(responseText)          → { domain, redeemableAt, category, confidence, evidence } | null
 *   extractBrief(brief, opts?)             → brief enriched with the semantic fields (async, needs a key)
 *
 * CLI:
 *   node ai-extract.mjs --self-test            # deterministic (prompt + parse), no API call
 *   node ai-extract.mjs --brief brief.json     # live extract (needs ANTHROPIC_API_KEY)
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { aggregateSuppliers } from './brand-brief.mjs';

const DEFAULT_MODEL = process.env.AI_EXTRACT_MODEL || 'claude-sonnet-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

export function buildExtractionPrompt(brief, textBlob) {
  const system =
    'You extract structured gift-card catalog facts from raw supplier data. ' +
    'Ground EVERY field in the provided text — never invent a brand or URL. ' +
    'Return ONLY strict JSON, no prose, no markdown.';
  const user = [
    `Merchant: ${brief.name}${brief.country ? ` (${brief.country})` : ''}`,
    brief.domain
      ? `Domain already resolved from a supplier URL (authoritative): ${brief.domain}`
      : '',
    '',
    'Supplier data (verbatim; may be merged from multiple suppliers):',
    '"""',
    (textBlob || '').slice(0, 12000),
    '"""',
    '',
    'Return exactly this JSON shape:',
    '{',
    '  "domain": "the brand\'s own storefront domain from a URL in the text, else null",',
    '  "redeemableAt": ["every brand this card CAN be redeemed at — INCLUSIONS ONLY.',
    "                    NEVER include a brand the text excludes ('not valid at X', 'excludes Y').",
    '                    Include the merchant itself plus any sibling/parent brands named as redeemable."],',
    '  "category": "one short retail category (apparel, dining, electronics, grocery, ...)",',
    '  "confidence": 0.0 to 1.0 — how sure you are the identity + redeemableAt are correct,',
    '  "evidence": "a short verbatim quote from the text that supports redeemableAt"',
    '}',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return { system, user };
}

/** Pull the JSON object out of a model response (tolerant of stray prose/fences)
 *  and validate/coerce it to the extraction shape. Returns null on garbage. */
export function parseExtraction(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
  return {
    domain: typeof obj.domain === 'string' && obj.domain ? obj.domain : null,
    redeemableAt: Array.isArray(obj.redeemableAt)
      ? [
          ...new Set(
            obj.redeemableAt.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()),
          ),
        ]
      : [],
    category: typeof obj.category === 'string' && obj.category ? obj.category : null,
    confidence: num(obj.confidence),
    evidence: typeof obj.evidence === 'string' ? obj.evidence : null,
  };
}

async function callClaude({ system, user, model, apiKey, maxTokens = 1024 }) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

/** Enrich a brief with the semantic fields. The deterministic supplier-anchored
 *  domain WINS — the model only fills domain when the anchor is missing. */
export async function extractBrief(
  brief,
  { apiKey = process.env.ANTHROPIC_API_KEY, model = DEFAULT_MODEL } = {},
) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const { textBlob } = aggregateSuppliers(brief.raw || {});
  const { system, user } = buildExtractionPrompt(brief, textBlob);
  const ext = parseExtraction(await callClaude({ system, user, model, apiKey }));
  return {
    ...brief,
    domain: brief.domain || ext?.domain || null, // deterministic anchor wins
    redeemableAt: ext?.redeemableAt?.length ? ext.redeemableAt : brief.redeemableAt,
    category: brief.category || ext?.category || null,
    semanticConfidence: ext?.confidence ?? null,
    evidence: ext?.evidence ?? null,
  };
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  // Deterministic: prove the prompt assembly + response parsing. No API call.
  const brief = {
    name: 'Aerie',
    country: 'US',
    domain: 'ae.com',
    raw: {
      tillo: { websiteUrl: 'https://ae.com' },
      svs: { terms: 'Valid at Aerie and American Eagle stores. Not valid at Todd Snyder.' },
    },
  };
  const { textBlob } = aggregateSuppliers(brief.raw);
  const { system, user } = buildExtractionPrompt(brief, textBlob);
  const fenced =
    '```json\n{"domain":"ae.com","redeemableAt":["Aerie","American Eagle","Aerie"],"category":"apparel","confidence":0.9,"evidence":"Valid at Aerie and American Eagle stores"}\n```';
  const parsed = parseExtraction(fenced);
  const checks = {
    'prompt carries the merchant + supplier text':
      user.includes('Aerie') && user.includes('American Eagle'),
    'prompt instructs inclusions-only + exclusion guard':
      /INCLUSIONS ONLY/i.test(user) && /NEVER include/i.test(user),
    'prompt passes the anchored domain through':
      user.includes('authoritative') && system.length > 0,
    'parses JSON out of a fenced response': parsed?.domain === 'ae.com',
    'dedupes redeemableAt': parsed.redeemableAt.length === 2,
    'clamps out-of-range confidence': parseExtraction('{"confidence":5}').confidence === 1,
    'rejects a non-JSON response': parseExtraction('sorry, no data') === null,
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain && process.argv.includes('--brief')) {
  const path = process.argv[process.argv.indexOf('--brief') + 1];
  const brief = JSON.parse(readFileSync(path, 'utf8'));
  console.log(JSON.stringify(await extractBrief(brief), null, 2));
} else if (isMain) {
  console.log(
    'usage: ai-extract.mjs --self-test | --brief <brief.json>  (live needs ANTHROPIC_API_KEY)',
  );
}
