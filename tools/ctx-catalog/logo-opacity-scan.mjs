#!/usr/bin/env node
// Scan every displayed logo for the opacity/visibility problem: logos that are
// white / near-transparent / very faint vanish on a white background (e.g. Aera).
// Metric = "ink coverage": fraction of pixels that are meaningfully darker than
// white after flattening transparency onto white. Near-zero ink = invisible logo.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const sharp = createRequire('/Users/ash/code/loop-app/apps/backend/')('sharp');

const UA = {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
};
const fresh = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).filter(
  (m) => m.status === 'enabled',
);
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
// displayed logo = existing CTX logo if present, else our sourced one
const rows = fresh
  .map((m) => ({
    id: m.id,
    name: m.name,
    url: (m.logoUrl && m.logoUrl.trim()) || media[m.id]?.logoUrl || null,
  }))
  .filter((r) => r.url);

async function ink(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const r = await fetch(url, { ...UA, signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return { bad: true };
    const b = Buffer.from(await r.arrayBuffer());
    const { data } = await sharp(b, { failOn: 'none' })
      .resize(128, 128, { fit: 'inside' })
      .flatten({ background: '#ffffff' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let inkPx = 0;
    for (const p of data) if (p < 235) inkPx++;
    return { frac: inkPx / data.length };
  } catch {
    return { bad: true };
  }
}

let idx = 0,
  done = 0;
const faint = [],
  blank = [],
  unreachable = [];
async function worker() {
  while (idx < rows.length) {
    const r = rows[idx++];
    const res = await ink(r.url);
    if (res.bad) unreachable.push(r.name);
    else if (res.frac < 0.008) blank.push({ ...r, frac: +res.frac.toFixed(4) });
    else if (res.frac < 0.02) faint.push({ ...r, frac: +res.frac.toFixed(4) });
    if (++done % 200 === 0) console.log(`  ${done}/${rows.length}`);
  }
}
await Promise.all(Array.from({ length: 12 }, worker));
writeFileSync('/tmp/logo-opacity-flags.json', JSON.stringify({ blank, faint }, null, 2));
console.log(`\nscanned ${rows.length} logos`);
console.log(`BLANK/white (ink<0.8%, invisible): ${blank.length}`);
console.log(
  `  ${blank
    .slice(0, 30)
    .map((b) => b.name)
    .join(', ')}`,
);
console.log(`FAINT (ink 0.8-2%, hard to see): ${faint.length}`);
console.log(
  `  ${faint
    .slice(0, 30)
    .map((b) => b.name)
    .join(', ')}`,
);
console.log(`unreachable: ${unreachable.length}`);
