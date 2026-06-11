#!/usr/bin/env node
/**
 * Fetch logos from logo.dev's image endpoint by verified domain, for every enabled
 * merchant that has a domain but no logo yet. Saves PNGs to /tmp/logos/<id>.png and
 * records a sharp-based QC (dims + transparent/blank ratio) to /tmp/logo-fetch.json
 * for the opacity/vision passes. logo.dev returns a generic monogram when it has no
 * real mark, so the vision-QC pass (later) still has to reject those.
 *   node scripts/fetch-logos.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import sharp from 'sharp';

const PK = readFileSync('/tmp/logodev-pk.txt', 'utf8').trim();
const M = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).filter(
  (m) => m.status === 'enabled',
);
const V = JSON.parse(readFileSync('/tmp/ctx-domains-verified.json', 'utf8'));
mkdirSync('/tmp/logos', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = M.filter((m) => {
  const v = V[m.id];
  return v && v.domain && !m.logoUrl;
});
console.log(`${targets.length} merchants with a domain + no logo`);
const out = {};
let done = 0,
  ok = 0,
  blank = 0,
  fail = 0;
const queue = [...targets];
async function worker() {
  while (queue.length) {
    const m = queue.shift();
    const domain = V[m.id].domain;
    const path = `/tmp/logos/${m.id}.png`;
    try {
      const url = `https://img.logo.dev/${encodeURIComponent(domain)}?token=${PK}&size=400&format=png&retina=true`;
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) {
        fail++;
        out[m.id] = { domain, ok: false, reason: 'http ' + r.status };
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 200) {
          fail++;
          out[m.id] = { domain, ok: false, reason: 'empty' };
        } else {
          writeFileSync(path, buf);
          // sharp QC: dims + transparent/near-white ratio
          const img = sharp(buf);
          const meta = await img.metadata();
          const { data, info } = await img
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          let opaque = 0,
            light = 0,
            n = info.width * info.height;
          for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a > 16) {
              opaque++;
              if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) light++;
            }
          }
          const opaqueRatio = opaque / n;
          const lightRatio = opaque ? light / opaque : 0;
          const isBlank = opaqueRatio < 0.02 || lightRatio > 0.97;
          out[m.id] = {
            domain,
            ok: true,
            w: meta.width,
            h: meta.height,
            opaqueRatio: +opaqueRatio.toFixed(3),
            blank: isBlank,
          };
          if (isBlank) blank++;
          else ok++;
        }
      }
    } catch (e) {
      fail++;
      out[m.id] = { domain, ok: false, reason: String(e.message).slice(0, 40) };
    }
    if (++done % 150 === 0)
      process.stdout.write(
        `\r  ${done}/${targets.length} (ok ${ok}, blank ${blank}, fail ${fail})`,
      );
  }
}
await Promise.all(Array.from({ length: 10 }, worker));
writeFileSync('/tmp/logo-fetch.json', JSON.stringify(out));
console.log(
  `\nDone. fetched-good ${ok}, blank/monogram ${blank}, fail ${fail} → /tmp/logos/, /tmp/logo-fetch.json`,
);
