// Pre-warm the review /img disk cache: fetch every displayed logo + cover once
// (throttled) so the review UI loads from local cache instead of re-hitting
// logo.dev / CDNs (which rate-limit and cause logos to "not load").
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const CACHE = '/tmp/review-img-cache';
try {
  mkdirSync(CACHE, { recursive: true });
} catch {}
const fresh = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).filter(
  (m) => m.status === 'enabled',
);
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));

const urls = new Set();
for (const m of fresh) {
  const logo = (m.logoUrl && m.logoUrl.trim()) || media[m.id]?.logoUrl;
  const cover = (m.cardImageUrl && m.cardImageUrl.trim()) || media[m.id]?.headerUrl;
  if (logo) urls.add(logo);
  if (cover) urls.add(cover);
}
const list = [...urls];
let idx = 0,
  fetched = 0,
  cached = 0,
  failed = 0;
async function one(u) {
  const fp = `${CACHE}/${createHash('sha1').update(u).digest('hex')}`;
  if (existsSync(fp) && existsSync(fp + '.ct')) {
    cached++;
    return;
  }
  try {
    const origin = new URL(u).origin;
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, Referer: origin, Accept: 'image/*,*/*' },
      signal: AbortSignal.timeout(12000),
    });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.startsWith('image/')) {
      failed++;
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(fp, buf);
    writeFileSync(fp + '.ct', ct);
    fetched++;
  } catch {
    failed++;
  }
}
async function worker() {
  while (idx < list.length) {
    await one(list[idx++]);
    if ((fetched + cached + failed) % 200 === 0)
      console.log(
        `  ${fetched + cached + failed}/${list.length} (fetched ${fetched}, cached ${cached}, failed ${failed})`,
      );
  }
}
console.log(`warming cache for ${list.length} image URLs…`);
await Promise.all(Array.from({ length: 5 }, worker));
console.log(`\nDone. fetched:${fetched} already-cached:${cached} failed:${failed}`);
