#!/usr/bin/env node
/**
 * Fold Tavily-sourced covers into the final media set. For every merchant
 * currently on a placeholder cover (unsplash-category / generic-unsplash),
 * swap in the Tavily cover if one was found. Tavily misses are left as-is
 * (reported) so we can decide a faceplate fallback for the residue.
 *
 *   node scripts/merge-tavily-covers.mjs [--apply]   (omit --apply for a dry summary)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const tav = JSON.parse(readFileSync('/tmp/ctx-images-tavily.json', 'utf8'));

let swapped = 0,
  stillPlaceholder = 0;
const residue = [];
for (const [id, v] of Object.entries(media)) {
  const isPlaceholder = /unsplash|generic|flagged-removed|none/i.test(v.headerSource || '');
  if (!isPlaceholder) continue;
  const t = tav[id];
  if (t && t.headerUrl) {
    // Store the ORIGINAL source URL, not the weserv-crop URL — sharp crops to
    // 16:9 at apply, and the review page crops visually via CSS. No weserv.
    v.headerUrl = (t.candidates && t.candidates[0] && t.candidates[0].url) || t.headerUrl;
    v.headerSource = t.headerSource || 'tavily';
    swapped++;
  } else {
    stillPlaceholder++;
    residue.push(v.name);
  }
}

if (APPLY) writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(media, null, 2));
const dist = {};
for (const v of Object.values(media))
  dist[v.headerSource || '?'] = (dist[v.headerSource || '?'] || 0) + 1;
console.log(
  `${APPLY ? 'APPLIED' : 'DRY'} — Tavily covers swapped in: ${swapped} | still placeholder: ${stillPlaceholder}`,
);
console.log('new cover distribution:');
for (const [k, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
if (residue.length)
  console.log(
    `\nresidue (no Tavily cover) — ${residue.length}: ${residue.slice(0, 25).join(', ')}${residue.length > 25 ? '…' : ''}`,
  );
