#!/usr/bin/env node
/**
 * Build contact-sheet montages of fetched logos for AI vision-QC: each sheet is a
 * 5×6 grid of 30 numbered, name-labelled logo tiles → /tmp/logo-montages/sheet-N.png,
 * with /tmp/logo-montage-map.json mapping (sheet, cellNo) → merchant id/name. A
 * vision agent reads each sheet and flags cells that are a monogram/placeholder,
 * the wrong brand, or junk.
 *   node scripts/build-logo-montages.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import sharp from 'sharp';

const M = new Map(
  JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'))
    .filter((m) => m.status === 'enabled')
    .map((m) => [m.id, m]),
);
const Q = JSON.parse(readFileSync('/tmp/logo-fetch.json', 'utf8'));
mkdirSync('/tmp/logo-montages', { recursive: true });

// One representative logo per BRAND (ADR-aligned: brands share media). brand-media.json
// gives the chosen logoId per brand; vision-QC reviews brands, not every country tile.
const BM = JSON.parse(readFileSync('/tmp/brand-media.json', 'utf8'));
const ids = Object.values(BM)
  .map((b) => b.logoId)
  .filter((id) => id && existsSync(`/tmp/logos/${id}.png`) && M.has(id));
const COLS = 5,
  ROWS = 6,
  PER = COLS * ROWS,
  TW = 240,
  TH = 210,
  LOGO_W = 220,
  LOGO_H = 150;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

async function tile(id, cellNo) {
  const name = (M.get(id).name || '').slice(0, 30);
  let logo;
  try {
    logo = await sharp(`/tmp/logos/${id}.png`)
      .resize(LOGO_W, LOGO_H, { fit: 'contain', background: '#ffffff' })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
  } catch {
    logo = await sharp({
      create: { width: LOGO_W, height: LOGO_H, channels: 3, background: '#dddddd' },
    })
      .png()
      .toBuffer();
  }
  const label = Buffer.from(
    `<svg width="${TW}" height="${TH - LOGO_H}"><rect width="100%" height="100%" fill="#eef"/><text x="6" y="20" font-family="sans-serif" font-size="13" fill="#003"><tspan font-weight="bold">${cellNo}.</tspan> ${esc(name)}</text></svg>`,
  );
  return sharp({ create: { width: TW, height: TH, channels: 3, background: '#ffffff' } })
    .composite([
      { input: logo, left: (TW - LOGO_W) / 2, top: 4 },
      { input: label, left: 0, top: LOGO_H + 6 },
    ])
    .png()
    .toBuffer();
}

const map = [];
let sheet = 0;
for (let i = 0; i < ids.length; i += PER) {
  const batch = ids.slice(i, i + PER);
  const tiles = await Promise.all(batch.map((id, k) => tile(id, k + 1)));
  const composites = tiles.map((input, k) => ({
    input,
    left: (k % COLS) * TW,
    top: Math.floor(k / COLS) * TH,
  }));
  await sharp({
    create: { width: COLS * TW, height: ROWS * TH, channels: 3, background: '#ffffff' },
  })
    .composite(composites)
    .png()
    .toFile(`/tmp/logo-montages/sheet-${sheet}.png`);
  map.push({ sheet, cells: batch.map((id, k) => ({ cell: k + 1, id, name: M.get(id).name })) });
  sheet++;
  if (sheet % 20 === 0) process.stdout.write(`\r  ${sheet} sheets`);
}
writeFileSync('/tmp/logo-montage-map.json', JSON.stringify(map));
console.log(`\nBuilt ${sheet} montage sheets (${ids.length} logos) → /tmp/logo-montages/`);
