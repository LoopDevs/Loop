#!/usr/bin/env node
/**
 * ai-info.mjs — codified merchant info generation (media v2 plan S4).
 *
 * The clean intro/description/instructions/terms in ctx-info.json were produced
 * by ad-hoc, off-repo "brand-research agent" runs — the prompt lived nowhere in
 * the repo, so the copy can't be reproduced consistently for the ~2,300 newer
 * merchants. This commits the prompt + a style contract + a validator, so every
 * merchant's copy is uniform, grounded, and re-generatable.
 *
 * Style contract (enforced by validateInfo):
 *   - intro:        ≤ 8-word tagline, no trailing period
 *   - description:  40–70 words, present tense, what they sell + who it's for
 *   - instructions: how to redeem (online at <domain> / in store / enter code+PIN)
 *   - terms:        ≤ 60 words, factual T&Cs only
 *   - NO prices, discount %, expiry promises, or marketing hyperbole; ground
 *     everything in the supplier text — invent nothing.
 *
 * Plain fetch to the Anthropic Messages API (ANTHROPIC_API_KEY), no SDK dep —
 * matches ai-extract / vision-qc. Model via AI_INFO_MODEL.
 *
 * API:
 *   buildInfoPrompt(brief, textBlob) → { system, user }
 *   validateInfo(info, brief?)       → { valid, issues, info }
 *   generateInfo(brief, opts?)       → validated info (async, needs a key)
 *
 * CLI:
 *   node ai-info.mjs --self-test           # deterministic (prompt + validation)
 *   node ai-info.mjs --brief brief.json    # live (needs ANTHROPIC_API_KEY)
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { aggregateSuppliers } from './brand-brief.mjs';

const DEFAULT_MODEL = process.env.AI_INFO_MODEL || 'claude-sonnet-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

// Claims copy must never make — prices, discount %, or expiry promises.
const FORBIDDEN = /\$\s?\d|\b\d+\s?%|\bnever\s+expires?\b|\bno\s+expir|\bfree\b.*\bwith\b/i;
const wordCount = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;

export function buildInfoPrompt(brief, textBlob) {
  const system =
    'You write factual, uniform gift-card catalog copy. Ground every claim in the ' +
    'supplier text and the brand — invent nothing. No prices, no discount %, no ' +
    'expiry promises, no marketing hyperbole. Return ONLY strict JSON.';
  const user = [
    `Brand: ${brief.name}${brief.country ? ` (${brief.country})` : ''}`,
    brief.category ? `Category: ${brief.category}` : '',
    brief.domain ? `Domain: ${brief.domain}` : '',
    '',
    'Supplier data (verbatim; ground the copy in this):',
    '"""',
    (textBlob || '').slice(0, 12000),
    '"""',
    '',
    'Return exactly this JSON:',
    '{',
    '  "intro": "≤8-word tagline, no trailing period",',
    '  "description": "40-70 words, present tense — what they sell and who it\'s for",',
    '  "instructions": "how to redeem: online at the domain / in store / enter code+PIN at checkout; note balance/expiry only if stated",',
    '  "terms": "≤60 words, factual T&Cs only"',
    '}',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return { system, user };
}

/** Validate copy against the style contract. Returns issues (empty = clean). */
export function validateInfo(info, brief = {}) {
  const issues = [];
  const i = info || {};
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  for (const f of ['intro', 'description', 'instructions', 'terms']) {
    if (!s(i[f])) issues.push(`${f}: missing`);
  }
  if (s(i.intro)) {
    if (wordCount(i.intro) > 8) issues.push(`intro: >8 words (${wordCount(i.intro)})`);
    if (/[.]\s*$/.test(s(i.intro))) issues.push('intro: has a trailing period');
  }
  if (s(i.description)) {
    const w = wordCount(i.description);
    if (w < 40 || w > 70) issues.push(`description: ${w} words (want 40-70)`);
  }
  if (s(i.terms) && wordCount(i.terms) > 60)
    issues.push(`terms: >60 words (${wordCount(i.terms)})`);
  for (const f of ['intro', 'description', 'instructions', 'terms']) {
    if (FORBIDDEN.test(s(i[f]))) issues.push(`${f}: contains a price/discount/expiry claim`);
  }
  return { valid: issues.length === 0, issues, info: i };
}

async function callClaude({ system, user, model, apiKey, maxTokens = 900 }) {
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

function parseInfo(text) {
  const m = (text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export async function generateInfo(
  brief,
  { apiKey = process.env.ANTHROPIC_API_KEY, model = DEFAULT_MODEL } = {},
) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const { textBlob } = aggregateSuppliers(brief.raw || {});
  const { system, user } = buildInfoPrompt(brief, textBlob);
  const info = parseInfo(await callClaude({ system, user, model, apiKey }));
  return validateInfo(info, brief);
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  const brief = {
    name: 'Aerie',
    country: 'US',
    category: 'apparel',
    domain: 'ae.com',
    raw: { tillo: { desc: 'Aerie sells intimates and apparel.' } },
  };
  const { system, user } = buildInfoPrompt(brief, aggregateSuppliers(brief.raw).textBlob);
  const good = {
    intro: 'Soft, comfy essentials',
    description:
      'Aerie is an American lifestyle brand offering bras, undies, activewear, swim, and loungewear designed for real, everyday comfort. It celebrates body positivity and inclusive sizing, making it a favourite for shoppers who want relaxed, quality apparel and intimates that feel as good as they look every single day.',
    instructions:
      'Redeem online at ae.com or in any Aerie store — enter your gift card number and PIN at checkout.',
    terms:
      'Not redeemable for cash except where required by law. Treat this card like cash; Loop is not responsible for lost or stolen cards.',
  };
  const checks = {
    'prompt states the no-price/no-hype contract':
      /no prices/i.test(system) && /invent nothing/i.test(system),
    'prompt requests all four fields':
      /intro/.test(user) &&
      /description/.test(user) &&
      /instructions/.test(user) &&
      /terms/.test(user),
    'validate: clean copy passes': validateInfo(good, brief).valid === true,
    'validate: >8-word intro flagged': validateInfo(
      { ...good, intro: 'one two three four five six seven eight nine' },
      brief,
    ).issues.some((x) => x.startsWith('intro')),
    'validate: short description flagged': validateInfo(
      { ...good, description: 'Too short.' },
      brief,
    ).issues.some((x) => x.startsWith('description')),
    'validate: a price claim flagged': validateInfo(
      { ...good, terms: 'Save 20% on your first order.' },
      brief,
    ).issues.some((x) => /price\/discount/.test(x)),
    'validate: missing field flagged': validateInfo({ intro: 'x' }, brief).issues.some((x) =>
      x.includes('missing'),
    ),
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain && process.argv.includes('--brief')) {
  const brief = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--brief') + 1], 'utf8'));
  console.log(JSON.stringify(await generateInfo(brief), null, 2));
} else if (isMain) {
  console.log(
    'usage: ai-info.mjs --self-test | --brief <brief.json>  (live needs ANTHROPIC_API_KEY)',
  );
}
