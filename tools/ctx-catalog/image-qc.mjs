#!/usr/bin/env node
/**
 * image-qc.mjs — deterministic image quality gate for the media pipeline.
 * Sharp-only: no network model, no new dependency (see IMPROVEMENT-PLAN Q1).
 *
 * Per image it measures:
 *  - BLUR — Laplacian variance (low = soft / out of focus). Promoted out of
 *    archive/brandqc-prep.mjs.
 *  - UPSCALE / low-quality-at-correct-resolution — the key detector the owner
 *    asked for. A downscale→upscale ROUND-TRIP RESIDUAL: a genuinely detailed
 *    image loses real high-frequency detail when halved and re-enlarged (high
 *    residual); an image that is e.g. 128px blown up to 512px is nearly
 *    identical to its own round-trip (low residual → it's fake resolution and
 *    looks mushy even though the pixel count is "right").
 *  - DIMENSIONS — too small.
 *  - NEAR-UNIFORM — solid-colour / broken / placeholder (near-zero variance).
 *  - dHash — a 64-bit perceptual hash for cross-merchant near-duplicate
 *    detection (catches the ui-avatars / logo.dev generic-monogram fallbacks
 *    that collapse to a handful of clusters).
 *
 * Text-in-cover detection is Q2 (needs OCR / a vision tier) — NOT here.
 *
 * API:
 *   scoreLogo(buf)  / scoreCover(buf)  → { verdict:'pass'|'flag'|'reject', reasons:[], metrics:{} }
 *   dhash(buf)      → 16-char hex; hamming(a,b) → bit distance
 *
 * CLI:
 *   node image-qc.mjs --url <img> [--kind logo|cover]   # score one image
 *   node image-qc.mjs --self-test                        # synthesise images, prove the detectors
 *   node image-qc.mjs --manifest <file> [--field logoUrl|headerUrl] [--kind logo|cover] [--limit N]
 *
 * Thresholds are grounded on the recovered data/brandqc-input.json percentiles
 * (logo blur p25≈155, cover blur p10≈353/p25≈565, cover width p10≈1000).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
// sharp is a prod dep of apps/backend; resolve it relative to this file (no
// hardcoded absolute path, unlike the older scripts).
const req = createRequire(resolve(here, '../../apps/backend/') + '/');
const sharp = req('sharp');

const LAP = [0, 1, 0, 1, -4, 1, 0, 1, 0]; // 3×3 Laplacian
const WORK = 384; // normalise to this max edge for stable, bounded metrics

// ── thresholds ──────────────────────────────────────────────────────────────
// Blur thresholds are grounded on data/brandqc-input.json percentiles. The
// upscaleResidual thresholds are PROVISIONAL — the metric demonstrably
// discriminates (see --self-test), but the absolute reject/flag cut-points must
// be CALIBRATED on real merchant images: run `--manifest data/ctx-media-final.json`
// (covers via --field headerUrl) to print the residual distribution, then set
// the reject cut near the p5–p10 of visually-good images. Higher residual = more
// genuine detail; lower = upscaled / low-quality.
const T = {
  logo: { minEdge: 96, blurFlag: 150, uniform: 6, upscaleReject: 6, upscaleFlag: 14 },
  cover: {
    minW: 640,
    minWFlag: 1000,
    blurReject: 300,
    blurFlag: 500,
    uniform: 8,
    upscaleReject: 6,
    upscaleFlag: 14,
    aspectLo: 1.2,
    aspectHi: 2.6,
  },
};

const meanAbs = (a, b) => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
};
const variance = (data) => {
  let s = 0,
    s2 = 0;
  for (const p of data) {
    s += p;
    s2 += p * p;
  }
  const m = s / data.length;
  return s2 / data.length - m * m;
};

/** Normalised greyscale raw ({data,info}) capped at WORK px on the long edge. */
async function greyRaw(buf) {
  return sharp(buf, { failOn: 'none' })
    .resize(WORK, WORK, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#fff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

/** Laplacian-variance sharpness of a normalised grey image. Low = soft. */
async function blur(buf) {
  const { data } = await sharp(buf, { failOn: 'none' })
    .resize(WORK, WORK, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#fff' })
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: LAP })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Math.round(variance(data));
}

/**
 * Downscale→upscale round-trip residual. Halve the (already-normalised) grey
 * image and cubic-upscale it back; compare to the original. Near-zero means the
 * image carried no detail beyond half its pixels — i.e. it was upscaled from a
 * smaller source ("fake" resolution). High means real high-frequency detail.
 */
async function upscaleResidual(buf) {
  const a = await greyRaw(buf);
  const w = a.info.width,
    h = a.info.height;
  const halfW = Math.max(2, Math.round(w / 2));
  const halfH = Math.max(2, Math.round(h / 2));
  // Two SEPARATE sharp passes — chaining .resize().resize() on one pipeline
  // silently keeps only the last resize, so the downscale must be materialised
  // before the upscale.
  const down = await sharp(a.data, { raw: { width: w, height: h, channels: 1 } })
    .resize(halfW, halfH)
    .raw()
    .toBuffer();
  const recon = await sharp(down, { raw: { width: halfW, height: halfH, channels: 1 } })
    .resize(w, h, { kernel: 'cubic' })
    .raw()
    .toBuffer();
  return Number(meanAbs(a.data, recon).toFixed(2));
}

/** 64-bit dHash (row gradient of a 9×8 grey) as 16-char hex. */
async function dhash(buf) {
  const { data } = await sharp(buf, { failOn: 'none' })
    .resize(9, 8, { fit: 'fill' })
    .flatten({ background: '#fff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

async function baseMetrics(buf) {
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const { data } = await sharp(buf, { failOn: 'none' })
    .resize(64, 64, { fit: 'inside' })
    .flatten({ background: '#fff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    w: meta.width || 0,
    h: meta.height || 0,
    format: meta.format,
    uniformStd: Math.round(Math.sqrt(variance(data))), // low = solid colour / broken
  };
}

/** Score a LOGO buffer. Never reject on blur alone (minimalist wordmarks are
 *  legitimately low-energy) — combine blur with the upscale residual. */
export async function scoreLogo(buf) {
  const reasons = [];
  const base = await baseMetrics(buf);
  const shortEdge = Math.min(base.w, base.h);
  const [b, up] = await Promise.all([blur(buf), upscaleResidual(buf)]);
  const metrics = { ...base, blur: b, upscaleResidual: up };
  let verdict = 'pass';
  const rej = (r) => {
    reasons.push(r);
    verdict = 'reject';
  };
  const flag = (r) => {
    reasons.push(r);
    if (verdict !== 'reject') verdict = 'flag';
  };
  if (shortEdge > 0 && shortEdge < T.logo.minEdge) rej(`tiny:${shortEdge}px`);
  if (base.uniformStd < T.logo.uniform) rej(`near-uniform:${base.uniformStd}`);
  if (up < T.logo.upscaleReject) rej(`upscaled:residual=${up}`);
  else if (up < T.logo.upscaleFlag && b < T.logo.blurFlag)
    flag(`soft+low-detail:blur=${b},res=${up}`);
  return { verdict, reasons, metrics };
}

/** Score a COVER buffer. Covers are photos → absolute blur is a clean signal. */
export async function scoreCover(buf) {
  const reasons = [];
  const base = await baseMetrics(buf);
  const [b, up] = await Promise.all([blur(buf), upscaleResidual(buf)]);
  const aspect = base.h ? Number((base.w / base.h).toFixed(2)) : 0;
  const metrics = { ...base, blur: b, upscaleResidual: up, aspect };
  let verdict = 'pass';
  const rej = (r) => {
    reasons.push(r);
    verdict = 'reject';
  };
  const flag = (r) => {
    reasons.push(r);
    if (verdict !== 'reject') verdict = 'flag';
  };
  if (base.w && base.w < T.cover.minW) rej(`narrow:${base.w}px`);
  else if (base.w < T.cover.minWFlag) flag(`sub-hd:${base.w}px`);
  if (base.uniformStd < T.cover.uniform) rej(`near-uniform:${base.uniformStd}`);
  if (aspect && (aspect < T.cover.aspectLo || aspect > T.cover.aspectHi)) flag(`aspect:${aspect}`);
  if (up < T.cover.upscaleReject) rej(`upscaled:residual=${up}`);
  else if (up < T.cover.upscaleFlag) flag(`low-detail:residual=${up}`);
  if (b < T.cover.blurReject) rej(`blurry:${b}`);
  else if (b < T.cover.blurFlag) flag(`soft:${b}`);
  return { verdict, reasons, metrics };
}

export { dhash, hamming };

// ── CLI ───────────────────────────────────────────────────────────────────
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

if (argv.includes('--self-test')) {
  // Synthesise three cover-sized images and prove the detectors discriminate
  // them, no network. "detailed" = a fine grid + text (real high-frequency
  // detail, non-uniform at every scale); "upscaled" = that base downscaled to a
  // thumbnail and cubic-enlarged back (a genuine fake-resolution image);
  // "blurred" = the base, gaussian-blurred.
  const W = 1200,
    H = 675; // 16:9, above the sub-hd flag width so quality signals are isolated
  const L = [];
  for (let i = 0; i * 16 < W; i++)
    L.push(`<line x1="${i * 16}" y1="0" x2="${i * 16}" y2="${H}" stroke="#111"/>`);
  for (let i = 0; i * 16 < H; i++)
    L.push(`<line x1="0" y1="${i * 16}" x2="${W}" y2="${i * 16}" stroke="#111"/>`);
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#fff"/>${L.join('')}<text x="24" y="80" font-size="40" fill="#000">Detailed QC pattern 1234567890</text></svg>`;
  const detailed = await sharp(Buffer.from(svg)).png().toBuffer();
  const thumb = await sharp(detailed).resize(120, 67).png().toBuffer(); // materialise, THEN enlarge
  const upscaled = await sharp(thumb).resize(W, H, { kernel: 'cubic' }).png().toBuffer();
  const blurred = await sharp(detailed).blur(5).png().toBuffer();

  const d = await scoreCover(detailed);
  const u = await scoreCover(upscaled);
  const bl = await scoreCover(blurred);
  console.log('detailed:', d.verdict, JSON.stringify(d.metrics));
  console.log('upscaled:', u.verdict, u.reasons.join(',') || '-', JSON.stringify(u.metrics));
  console.log('blurred :', bl.verdict, bl.reasons.join(',') || '-', JSON.stringify(bl.metrics));
  const dh1 = await dhash(detailed),
    dh2 = await dhash(upscaled);
  console.log(`dhash detailed=${dh1} upscaled=${dh2} hamming=${hamming(dh1, dh2)}`);

  const checks = {
    'detailed passes clean': d.verdict === 'pass',
    'upscale metric discriminates (upscaled residual < 0.6× detailed)':
      u.metrics.upscaleResidual < d.metrics.upscaleResidual * 0.6,
    'upscaled is not passed clean': u.verdict !== 'pass',
    'blur metric discriminates (blurred blur < 0.2× detailed)':
      bl.metrics.blur < d.metrics.blur * 0.2,
    'blurred is not passed clean': bl.verdict !== 'pass',
  };
  console.log('');
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (arg('--url')) {
  const kind = arg('--kind') || 'cover';
  const buf = await fetchBuf(arg('--url'));
  const res = kind === 'logo' ? await scoreLogo(buf) : await scoreCover(buf);
  console.log(
    JSON.stringify({ url: arg('--url'), kind, ...res, dhash: await dhash(buf) }, null, 2),
  );
} else if (arg('--manifest')) {
  const field = arg('--field') || 'logoUrl';
  const kind = arg('--kind') || (field === 'logoUrl' ? 'logo' : 'cover');
  const limit = Number(arg('--limit') || '0');
  const m = JSON.parse(readFileSync(arg('--manifest'), 'utf8'));
  const entries = Object.entries(m).filter(
    ([, v]) => v && typeof v[field] === 'string' && v[field].length,
  );
  const rows = limit ? entries.slice(0, limit) : entries;
  const counts = { pass: 0, flag: 0, reject: 0, error: 0 };
  const hashes = new Map();
  for (const [id, v] of rows) {
    let url = v[field];
    if (url.includes('LOGODEV_KEY_REDACTED') && process.env.LOGODEV_KEY)
      url = url.replace('LOGODEV_KEY_REDACTED', process.env.LOGODEV_KEY);
    try {
      const buf = await fetchBuf(url);
      const res = kind === 'logo' ? await scoreLogo(buf) : await scoreCover(buf);
      const dh = await dhash(buf);
      hashes.set(id, dh);
      counts[res.verdict]++;
      if (res.verdict !== 'pass')
        console.log(`${res.verdict}\t${v.name || id}\t${res.reasons.join(',')}`);
    } catch (e) {
      counts.error++;
    }
  }
  // near-duplicate clusters (hamming ≤ 6 across different merchants)
  const arr = [...hashes.entries()];
  let dups = 0;
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++) if (hamming(arr[i][1], arr[j][1]) <= 6) dups++;
  console.log(`\nscanned ${rows.length} | ${JSON.stringify(counts)} | near-dup pairs: ${dups}`);
} else {
  console.log(
    'usage: image-qc.mjs --self-test | --url <img> [--kind logo|cover] | --manifest <file> [--field logoUrl|headerUrl] [--kind …] [--limit N]',
  );
}
