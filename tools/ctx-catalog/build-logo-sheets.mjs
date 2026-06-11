#!/usr/bin/env node
/**
 * Render every merchant logo into labeled contact-sheet PNGs for a visual
 * QC pass. Vision subagents then look at each sheet and flag bad logos
 * (generic icons, multi-brand sprites, wrong brand, broken/blank).
 *
 * Writes /tmp/logo-sheet-<k>.png + /tmp/logo-sheet-<k>.names.json (the
 * ordered {pos,id,name,source} in that sheet, for mapping flags back).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PER = 48; // tiles per sheet (6 cols × 8 rows)
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const rows = Object.entries(media)
  .filter(([, v]) => v.logoUrl)
  .map(([id, v]) => ({
    id,
    name: v.name || id,
    logoSource: v.logoSource || '',
    logoUrl: v.logoUrl,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const sheets = [];
for (let i = 0; i < rows.length; i += PER) sheets.push(rows.slice(i, i + PER));

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 900, height: 1280 },
  deviceScaleFactor: 2,
});
for (let k = 0; k < sheets.length; k++) {
  const cells = sheets[k]
    .map(
      (v, i) =>
        `<figure><div class=t><img src="${v.logoUrl}" loading="eager"></div><figcaption><b>${i + 1}.</b> ${(v.name || '').replace(/</g, '').slice(0, 24)}</figcaption></figure>`,
    )
    .join('');
  const html = `<!doctype html><meta charset=utf8><body style="margin:0;font:11px system-ui;background:#fff"><div style="display:grid;grid-template-columns:repeat(6,1fr);gap:5px;padding:8px">${cells}</div><style>figure{margin:0;text-align:center}.t{height:84px;display:flex;align-items:center;justify-content:center;border:1px solid #e2e8f0;border-radius:4px;background:#fff;padding:5px}img{max-width:100%;max-height:72px;object-fit:contain}figcaption{padding:2px 0;line-height:1.2}b{color:#2563eb}</style>`;
  writeFileSync(`/tmp/logo-sheet-${k}.html`, html);
  await page.goto(`file:///tmp/logo-sheet-${k}.html`);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `/tmp/logo-sheet-${k}.png`, fullPage: true });
  writeFileSync(
    `/tmp/logo-sheet-${k}.names.json`,
    JSON.stringify(
      sheets[k].map((v, i) => ({ pos: i + 1, id: v.id, name: v.name, source: v.logoSource })),
      null,
      2,
    ),
  );
  console.log(`sheet ${k}: ${sheets[k].length} logos`);
}
await browser.close();
console.log(`\nBuilt ${sheets.length} sheets for ${rows.length} logos.`);
