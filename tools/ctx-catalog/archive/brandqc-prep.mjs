#!/usr/bin/env node
// Enrich the brand-QC batches with objective image metrics:
//  - logo:  sharpness (Laplacian variance) — low = soft/upscaled (Shell/Skype/Entertainer)
//  - cover: sharpness + width + aspect — low-res (Popcorn), portrait (Boathouse)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const sharp = createRequire('/Users/ash/code/loop-app/apps/backend/')('sharp');

const LAP = [0, 1, 0, 1, -4, 1, 0, 1, 0];
const rows = JSON.parse(readFileSync('/tmp/brandqc-input.json', 'utf8'));

async function metrics(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    const meta = await sharp(b, { failOn: 'none' }).metadata();
    const { data } = await sharp(b, { failOn: 'none' })
      .resize(256, 256, { fit: 'inside' })
      .flatten({ background: '#fff' })
      .greyscale()
      .convolve({ width: 3, height: 3, kernel: LAP })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let s = 0,
      s2 = 0;
    for (const p of data) {
      s += p;
      s2 += p * p;
    }
    const mean = s / data.length;
    return {
      w: meta.width || 0,
      h: meta.height || 0,
      score: Math.round(s2 / data.length - mean * mean),
    };
  } catch {
    return null;
  }
}

let idx = 0,
  done = 0;
async function worker() {
  while (idx < rows.length) {
    const m = rows[idx++];
    if (m.logoUrl && m.sharpness == null) {
      const r = await metrics(m.logoUrl);
      if (r) m.sharpness = r.score;
    }
    if (m.coverUrl) {
      const r = await metrics(m.coverUrl);
      if (r) {
        m.coverW = r.w;
        m.coverH = r.h;
        m.coverSharp = r.score;
        m.coverAspect = r.h ? +(r.w / r.h).toFixed(2) : 0;
      }
    }
    if (++done % 100 === 0) console.log(`  ${done}/${rows.length}`);
  }
}
await Promise.all(Array.from({ length: 12 }, worker));

const softLogo = rows.filter((m) => m.sharpness != null && m.sharpness < 150).length;
const portrait = rows.filter((m) => m.coverAspect && m.coverAspect < 1.05).length;
const lowresCover = rows.filter((m) => m.coverW && m.coverW < 600).length;
const B = Math.ceil(rows.length / 15);
for (let k = 0; k < B; k++) {
  const s = rows.slice(k * 15, (k + 1) * 15);
  if (s.length) writeFileSync(`/tmp/brandqc-batch-${k}.json`, JSON.stringify(s));
}
writeFileSync('/tmp/brandqc-input.json', JSON.stringify(rows, null, 2));
console.log(
  `\nenriched ${rows.length} rows → ${B} batches | soft logos:${softLogo} | portrait covers:${portrait} | low-res covers(<600w):${lowresCover}`,
);
