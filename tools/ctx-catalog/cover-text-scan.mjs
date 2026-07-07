#!/usr/bin/env node
/**
 * cover-text-scan.mjs — text-in-cover detection (media v2 plan Q2, ADR 041).
 *
 * Covers are supposed to be storefront / scene photos. A cover that is really a
 * promo card, a logo-on-a-plate, or a watermarked stock image carries baked-in
 * TEXT — those should auto-reject before a human ever sees them. This runs
 * Tesseract (WASM, offline, free) over each cover and classifies on:
 *   - text-area coverage  (Σ word bbox area / image area)
 *   - confident word count
 *   - stock-watermark tokens (shutterstock / getty / © …)
 *
 * NEVER run this on logos — wordmarks are text by design. Covers only.
 * The semantic "is this cover a real scene vs a text card" edge cases go to the
 * Claude-vision tier (v2 plan V1); this is the cheap deterministic first pass.
 *
 * API:
 *   classifyCoverText({ wordCount, coverage, watermark }) → { verdict, reasons }
 *   scanCover(buf, worker) → { verdict, reasons, metrics }
 *
 * CLI:
 *   node cover-text-scan.mjs --self-test                 # prove classify + OCR
 *   node cover-text-scan.mjs --url <img>
 *   node cover-text-scan.mjs --manifest <file> [--field headerUrl] [--limit N]
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createWorker } from 'tesseract.js';
import { withLogodevKey } from './paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sharp = createRequire(resolve(here, '../../apps/backend/') + '/')('sharp');

const WATERMARK = /shutterstock|getty|alamy|istock|dreamstime|depositphotos|123rf|®|©|copyright/i;
const MIN_CONF = 60; // Tesseract per-word confidence to count a word as "real"
const OCR_W = 1000; // preprocess width — bbox coords are relative to this

const T = {
  coverageReject: 0.08, // >8% of the frame is text → a promo/logo/text card
  coveragePass: 0.03, // <3% → incidental (a storefront sign) → fine
  wordsReject: 5, // ≥5 confident words → dense baked text
};

/**
 * Pure classification from OCR metrics — the testable core, independent of the
 * OCR engine. reject = clearly a text/promo/watermark card; flag = ambiguous
 * band (escalate to vision); pass = a clean scene.
 */
export function classifyCoverText({ wordCount, coverage, watermark }) {
  const reasons = [];
  if (watermark) reasons.push('watermark');
  if (coverage > T.coverageReject) reasons.push(`text-area:${(coverage * 100).toFixed(1)}%`);
  if (wordCount >= T.wordsReject) reasons.push(`words:${wordCount}`);
  if (reasons.length) return { verdict: 'reject', reasons };
  if (coverage < T.coveragePass && wordCount <= 1) return { verdict: 'pass', reasons: [] };
  return {
    verdict: 'flag',
    reasons: [`some-text:words=${wordCount},area=${(coverage * 100).toFixed(1)}%`],
  };
}

/** Flatten Tesseract output to words regardless of v5/v6/v7 shape. */
function extractWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const words = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node.words)) words.push(...node.words);
    for (const key of ['blocks', 'paragraphs', 'lines'])
      if (Array.isArray(node[key])) node[key].forEach(walk);
  };
  (data.blocks || []).forEach(walk);
  return words;
}

/** OCR + metrics + classify for a single cover buffer. */
export async function scanCover(buf, worker) {
  const pre = await sharp(buf, { failOn: 'none' })
    .resize(OCR_W, OCR_W, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#fff' })
    .greyscale()
    .normalize()
    .png()
    .toBuffer({ resolveWithObject: true });
  const area = (pre.info.width || OCR_W) * (pre.info.height || OCR_W);
  const { data } = await worker.recognize(pre.data, {}, { blocks: true, text: true });
  const words = extractWords(data).filter(
    (w) => (w.confidence ?? 0) >= MIN_CONF && (w.text || '').trim().length >= 2,
  );
  let textArea = 0;
  for (const w of words) {
    const b = w.bbox || {};
    if (b.x1 > b.x0 && b.y1 > b.y0) textArea += (b.x1 - b.x0) * (b.y1 - b.y0);
  }
  const coverage = area ? textArea / area : 0;
  const watermark =
    WATERMARK.test(data.text || '') || words.some((w) => WATERMARK.test(w.text || ''));
  const metrics = { wordCount: words.length, coverage: Number(coverage.toFixed(4)), watermark };
  return { ...classifyCoverText(metrics), metrics };
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const svgText = (words) =>
  Buffer.from(
    `<svg width="1000" height="562" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="562" fill="#fff"/>` +
      words
        .map(
          (w, i) =>
            `<text x="60" y="${90 + i * 90}" font-size="64" font-family="sans-serif" fill="#000">${w}</text>`,
        )
        .join('') +
      `</svg>`,
  );

// Pure classify-logic checks (deterministic, no OCR) — shared by --self-test and
// the network-free --self-test-logic (the latter runs in CI, where Tesseract's
// traineddata download would add a network dependency to the check).
const classifyCases = [
  [{ wordCount: 20, coverage: 0.2, watermark: false }, 'reject'],
  [{ wordCount: 0, coverage: 0.01, watermark: false }, 'pass'],
  [{ wordCount: 3, coverage: 0.05, watermark: false }, 'flag'],
  [{ wordCount: 0, coverage: 0.0, watermark: true }, 'reject'],
];
const runClassifyChecks = () => {
  classifyCases.forEach(([m, want]) =>
    console.log(`  classify ${JSON.stringify(m)} → ${classifyCoverText(m).verdict} (want ${want})`),
  );
  return classifyCases.every(([m, want]) => classifyCoverText(m).verdict === want);
};

if (isMain && argv.includes('--self-test-logic')) {
  const ok = runClassifyChecks();
  console.log(ok ? '\nSELF-TEST(logic) PASS ✓' : '\nSELF-TEST(logic) FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain && argv.includes('--self-test')) {
  // 1) pure classify logic (deterministic, no OCR)
  const logicOk = runClassifyChecks();

  // 2) real OCR end-to-end: a text-heavy card vs a clean scene
  console.log('\n  booting Tesseract…');
  const worker = await createWorker('eng');
  const textCard = await sharp(
    svgText(['GIFT CARD', 'SALE 50% OFF', 'PROMO CODE', 'REDEEM NOW', 'LIMITED TIME']),
  )
    .png()
    .toBuffer();
  const cleanScene = await sharp({
    create: { width: 1000, height: 562, channels: 3, background: { r: 90, g: 130, b: 90 } },
  })
    .png()
    .toBuffer();
  const t = await scanCover(textCard, worker);
  const c = await scanCover(cleanScene, worker);
  await worker.terminate();
  console.log(`  text-card  → ${t.verdict} ${JSON.stringify(t.metrics)}`);
  console.log(`  clean-scene→ ${c.verdict} ${JSON.stringify(c.metrics)}`);

  const ok =
    logicOk &&
    t.verdict === 'reject' &&
    t.metrics.wordCount >= 3 &&
    c.verdict !== 'reject' &&
    c.metrics.wordCount <= 1;
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain && (arg('--url') || arg('--manifest'))) {
  const worker = await createWorker('eng');
  try {
    if (arg('--url')) {
      const res = await scanCover(await fetchBuf(arg('--url')), worker);
      console.log(JSON.stringify({ url: arg('--url'), ...res }, null, 2));
    } else {
      const field = arg('--field') || 'headerUrl';
      const limit = Number(arg('--limit') || '0');
      const m = JSON.parse(readFileSync(arg('--manifest'), 'utf8'));
      const rows = Object.entries(m).filter(([, v]) => v && typeof v[field] === 'string');
      const counts = { pass: 0, flag: 0, reject: 0, error: 0 };
      for (const [id, v] of limit ? rows.slice(0, limit) : rows) {
        try {
          const res = await scanCover(await fetchBuf(withLogodevKey(v[field])), worker);
          counts[res.verdict]++;
          if (res.verdict !== 'pass')
            console.log(`${res.verdict}\t${v.name || id}\t${res.reasons.join(',')}`);
        } catch {
          counts.error++;
        }
      }
      console.log(`\n${JSON.stringify(counts)}`);
    }
  } finally {
    await worker.terminate();
  }
} else if (isMain) {
  console.log(
    'usage: cover-text-scan.mjs --self-test | --url <img> | --manifest <file> [--field headerUrl] [--limit N]',
  );
}
