#!/usr/bin/env node
/**
 * vision-qc.mjs — the Claude VISION QC pass (V1). The visual counterpart to
 * ai-extract: the semantic pass reads text, this one looks at the actual image.
 *
 * The deterministic image-qc.mjs (sharp) catches blur/upscale/dedup and
 * cover-text-scan.mjs (OCR) catches baked-in text — but neither can answer the
 * one question that most protects the brand: "is this logo actually the RIGHT
 * brand?" A logo.dev result or a scraped image can be a clean, sharp logo for
 * the WRONG company (a same-name collision). Only vision catches that. This
 * sends the image to a vision-capable Claude model and returns a structured
 * verdict — the human only reviews what it can't decide.
 *
 * Plain fetch to the Anthropic Messages API (ANTHROPIC_API_KEY) — no SDK dep,
 * matches ai-extract. Model configurable via AI_VISION_MODEL.
 *
 * API:
 *   imageBlock(buf, mediaType?)             → an Anthropic base64 image content block
 *   buildVisionPrompt(brand, kind)          → { system, user }
 *   parseVerdict(responseText)              → { verdict, reason } | null
 *   checkImage(buf, { brand, kind, ... })   → verdict (async, needs a key)
 *
 * CLI:
 *   node vision-qc.mjs --self-test                          # deterministic, no API call
 *   node vision-qc.mjs --url <img> --brand "<name>" [--kind logo|cover]   # live
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sharp = createRequire(resolve(here, '../../apps/backend/') + '/')('sharp');

const DEFAULT_MODEL = process.env.AI_VISION_MODEL || 'claude-sonnet-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERDICTS = ['ok', 'wrong_brand', 'low_quality', 'has_text', 'placeholder'];

export function imageBlock(buf, mediaType = 'image/png') {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') },
  };
}

export function buildVisionPrompt(brand, kind = 'logo') {
  const system = 'You are a strict brand-asset QC reviewer. Reply with ONLY JSON, no prose.';
  // has_text is a COVER-only verdict — a logo is a wordmark, so text is expected.
  const enumStr =
    kind === 'cover'
      ? 'ok|wrong_brand|low_quality|has_text|placeholder'
      : 'ok|wrong_brand|low_quality|placeholder';
  const user =
    `The attached image is supposed to be the ${kind} for the brand "${brand}". Judge it.\n` +
    `Return exactly: {"verdict":"${enumStr}","reason":"short"}\n` +
    `- wrong_brand: the ${kind} clearly belongs to a DIFFERENT brand, or is a generic monogram/initial, not "${brand}".\n` +
    `- low_quality: blurry, pixelated, or obviously upscaled.\n` +
    (kind === 'cover'
      ? `- has_text: the image is mostly baked-in promo/gift-card text rather than a real scene.\n`
      : ``) +
    `- placeholder: a generic placeholder, a broken/404 image, or a solid colour.\n` +
    `- ok: a clean, correct ${kind} that represents "${brand}".`;
  return { system, user };
}

/** Parse + normalise a vision verdict; unknown verdicts collapse to "unknown". */
export function parseVerdict(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return null;
  }
  return {
    verdict: VERDICTS.includes(o.verdict) ? o.verdict : 'unknown',
    reason: typeof o.reason === 'string' ? o.reason : '',
  };
}

/** Send the image to Claude vision and return a structured verdict. */
export async function checkImage(
  buf,
  {
    brand,
    kind = 'logo',
    apiKey = process.env.ANTHROPIC_API_KEY,
    model = DEFAULT_MODEL,
    mediaType = 'image/png',
  } = {},
) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const { system, user } = buildVisionPrompt(brand, kind);
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      system,
      messages: [
        { role: 'user', content: [imageBlock(buf, mediaType), { type: 'text', text: user }] },
      ],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return parseVerdict(
    (j.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join(''),
  );
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (isMain && argv.includes('--self-test')) {
  // Deterministic: image encoding, prompt assembly, verdict parsing. No API call.
  const img = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  const block = imageBlock(img);
  const { system, user } = buildVisionPrompt('Aerie', 'logo');
  const cover = buildVisionPrompt('Aerie', 'cover');
  const checks = {
    'imageBlock is a base64 image block':
      block.type === 'image' && block.source.type === 'base64' && block.source.data.length > 100,
    'prompt names the brand + asset kind': user.includes('Aerie') && user.includes('logo'),
    'prompt enumerates verdicts incl. wrong_brand':
      /wrong_brand/.test(user) && /low_quality/.test(user),
    'has_text guidance only on covers':
      !user.includes('has_text') && cover.user.includes('has_text'),
    'system forces JSON-only': /ONLY JSON/i.test(system),
    'parses a fenced verdict':
      parseVerdict('```json\n{"verdict":"wrong_brand","reason":"shows Nike swoosh"}\n```')
        .verdict === 'wrong_brand',
    'unknown verdict → normalised': parseVerdict('{"verdict":"banana"}').verdict === 'unknown',
    'rejects a non-JSON reply': parseVerdict('cannot tell') === null,
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain && arg('--url') && arg('--brand')) {
  const r = await fetch(arg('--url'));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mediaType = r.headers.get('content-type')?.split(';')[0] || 'image/png';
  const res = await checkImage(buf, {
    brand: arg('--brand'),
    kind: arg('--kind') || 'logo',
    mediaType,
  });
  console.log(JSON.stringify(res, null, 2));
} else if (isMain) {
  console.log(
    'usage: vision-qc.mjs --self-test | --url <img> --brand "<name>" [--kind logo|cover]  (live needs ANTHROPIC_API_KEY)',
  );
}
