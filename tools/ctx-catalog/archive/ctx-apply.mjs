#!/usr/bin/env node
/**
 * Apply merchant fixes to the CTX database (spend.ctx.com) — country
 * renames + scraped logos/covers. Reads the admin bearer token from
 * the CTX_TOKEN env var (never hard-coded / persisted).
 *
 * Write path (mirrors the admin panel exactly):
 *   image:  download → POST /files (multipart, targetType=merchant,
 *           targetId=<id>) → response.url (S3) → PUT /merchants/:id
 *   rename: PUT /merchants/:id { id, name }
 * Every request carries `Authorization: Bearer` + `x-client-id: ctx_admin`.
 *
 * Safe by default: --dry-run prints intended writes without sending.
 * Idempotent: skips a rename already applied and an image field already
 * populated in CTX (so re-runs never overwrite existing art).
 *
 *   CTX_TOKEN=… node scripts/ctx-apply.mjs --verify <id>
 *   CTX_TOKEN=… node scripts/ctx-apply.mjs --renames --dry-run
 *   CTX_TOKEN=… node scripts/ctx-apply.mjs --renames --limit 1
 *   CTX_TOKEN=… node scripts/ctx-apply.mjs --images /tmp/ctx-images.json --test <id>
 *   CTX_TOKEN=… node scripts/ctx-apply.mjs --images /tmp/ctx-images.json --limit 1
 */
const BASE = 'https://spend.ctx.com';
const TOKEN = process.env.CTX_TOKEN;
if (!TOKEN) {
  console.error('CTX_TOKEN env var required');
  process.exit(1);
}
const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'x-client-id': 'ctx_admin' };
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : undefined);
const DRY = has('--dry-run');
const FORCE = has('--force');
const LIMIT = val('--limit') ? Number(val('--limit')) : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THROTTLE = val('--throttle') ? Number(val('--throttle')) : 700; // ms between writes

/** fetch wrapper that backs off + retries on 429 (CTX rate limit). */
async function ctxFetch(url, opts, attempt = 0) {
  const r = await fetch(url, opts);
  if (r.status === 429 && attempt < 6) {
    const wait = Number(r.headers.get('retry-after')) * 1000 || 2000 * (attempt + 1);
    await sleep(wait);
    return ctxFetch(url, opts, attempt + 1);
  }
  return r;
}

async function getMerchant(id) {
  const r = await ctxFetch(`${BASE}/merchants/${id}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`GET ${id} → ${r.status}`);
  return r.json();
}

async function putMerchant(id, fields) {
  const body = JSON.stringify({ id, ...fields });
  const r = await ctxFetch(`${BASE}/merchants/${id}`, {
    method: 'PUT',
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`PUT ${id} → ${r.status}: ${text.slice(0, 200)}`);
  return text;
}

// Unwrap a weserv proxy URL back to its inner source (so sharp fetches the
// original, not a weserv-processed copy — and we never hit weserv at all).
function unwrapWeserv(url) {
  const m = url && url.match(/images\.weserv\.nl\/\?url=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : url;
}

/**
 * Download a source image, optimize it LOCALLY with sharp (libvips — no
 * external proxy, no rate limits), and upload to CTX → returns the S3 url.
 *   kind 'logo' → ≤256px, fit-inside, PNG (keeps transparency), no upscale
 *   kind 'card' → 1280×720 cover-crop, JPEG q80 (mozjpeg)
 *   kind 'pin'  → ≤64px, fit-inside, PNG
 */
async function optimizeAndUpload(merchantId, srcUrl, kind) {
  const sharp = require('sharp');
  const src = unwrapWeserv(srcUrl);
  const dl = await fetch(src, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(25000),
  });
  if (!dl.ok) throw new Error(`download ${dl.status}`);
  const inCt = dl.headers.get('content-type') || '';
  if (inCt && !inCt.startsWith('image/')) throw new Error(`not an image (${inCt})`);
  const inBuf = Buffer.from(await dl.arrayBuffer());
  if (inBuf.length < 300) throw new Error(`too small (${inBuf.length}b)`);
  let pipe = sharp(inBuf, { failOn: 'none', animated: false }).rotate(); // honor EXIF orientation
  let ext, ct;
  if (kind === 'card') {
    pipe = pipe
      .resize(1280, 720, { fit: 'cover', withoutEnlargement: true, position: 'attention' })
      .jpeg({ quality: 80, mozjpeg: true });
    ext = 'jpg';
    ct = 'image/jpeg';
  } else {
    const px = kind === 'pin' ? 64 : 256;
    pipe = pipe
      .resize(px, px, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 });
    ext = 'png';
    ct = 'image/png';
  }
  const out = await pipe.toBuffer();
  const form = new FormData();
  form.append('file', new Blob([out], { type: ct }), `image.${ext}`);
  form.append('targetType', 'merchant');
  form.append('targetId', merchantId);
  const r = await ctxFetch(`${BASE}/files`, { method: 'POST', headers: HEADERS, body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(`upload → ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return { url: j.url, bytes: out.length };
}

async function runRenames() {
  const renames = JSON.parse(require('node:fs').readFileSync('/tmp/ctx-renames.json', 'utf8'));
  const list = renames.slice(0, LIMIT === Infinity ? renames.length : LIMIT);
  console.log(`Renames: ${list.length}${DRY ? ' (dry-run)' : ''}\n`);
  let done = 0;
  for (const r of list) {
    if (DRY) {
      console.log(`  [dry] ${r.old} → ${r.new}`);
      continue;
    }
    const current = await getMerchant(r.id);
    if (current.name === r.new) {
      console.log(`  = already "${r.new}"`);
      done++;
      continue;
    }
    if (current.name !== r.old) {
      console.log(`  ! skip ${r.id}: CTX name "${current.name}" ≠ expected "${r.old}"`);
      continue;
    }
    await putMerchant(r.id, { name: r.new });
    console.log(`  ✓ ${r.old} → ${r.new}`);
    done++;
    await sleep(THROTTLE);
  }
  console.log(`\nRenamed ${done}/${list.length}.`);
}

async function runImages() {
  const fs = require('node:fs');
  const map = JSON.parse(fs.readFileSync(val('--images'), 'utf8'));
  const testId = val('--test');
  // Optional human-review gate: only apply images marked ✓ approved.
  const decFile = val('--decisions');
  const dec = decFile ? JSON.parse(fs.readFileSync(decFile, 'utf8')) : null;
  let entries = Object.entries(map).map(([id, v]) => ({ id, ...v }));
  if (dec) {
    entries = entries.map((e) => ({
      ...e,
      logoUrl: dec[e.id]?.logo === 'yes' ? e.logoUrl : null,
      cardImageUrl: dec[e.id]?.cover === 'yes' ? e.cardImageUrl : null,
    }));
  }
  if (testId) entries = entries.filter((e) => e.id === testId);
  entries = entries
    .filter((e) => e.logoUrl || e.cardImageUrl)
    .slice(0, LIMIT === Infinity ? entries.length : LIMIT);
  console.log(`Image updates: ${entries.length}${DRY ? ' (dry-run)' : ''}\n`);
  let logoSet = 0;
  let coverSet = 0;
  let pinSet = 0;
  for (const e of entries) {
    try {
      const current = await getMerchant(e.id);
      const fields = {};
      // Additive by default — never overwrite art CTX already has.
      // Each image is optimized via weserv before upload to S3.
      if (e.logoUrl && (FORCE || !current.logoUrl)) {
        if (DRY) console.log(`  [dry] logo  ${e.name} ← ${e.logoUrl.slice(0, 60)}`);
        else fields.logoUrl = (await optimizeAndUpload(e.id, e.logoUrl, 'logo')).url;
      }
      if (e.cardImageUrl && (FORCE || !current.cardImageUrl)) {
        if (DRY) console.log(`  [dry] card  ${e.name} ← ${e.cardImageUrl.slice(0, 60)}`);
        else fields.cardImageUrl = (await optimizeAndUpload(e.id, e.cardImageUrl, 'card')).url;
      }
      // Map pin = 64×64 of the logo.
      if (e.logoUrl && (FORCE || !current.mapPinUrl)) {
        if (DRY) console.log(`  [dry] pin   ${e.name} (64×64 logo)`);
        else fields.mapPinUrl = (await optimizeAndUpload(e.id, e.logoUrl, 'pin')).url;
      }
      if (!DRY && Object.keys(fields).length) {
        await putMerchant(e.id, fields);
        if (fields.logoUrl) logoSet++;
        if (fields.cardImageUrl) coverSet++;
        if (fields.mapPinUrl) pinSet++;
        console.log(
          `  ✓ ${e.name.padEnd(28)} ${fields.logoUrl ? 'logo ' : ''}${fields.cardImageUrl ? 'card ' : ''}${fields.mapPinUrl ? 'pin' : ''}`,
        );
      } else if (!DRY) {
        console.log(`  = ${e.name.padEnd(28)} already populated`);
      }
    } catch (err) {
      console.log(`  ✗ ${e.name.padEnd(28)} ${err.message}`);
    }
    if (!DRY) await sleep(THROTTLE);
  }
  console.log(`\nSet ${logoSet} logos, ${coverSet} cards, ${pinSet} map-pins.`);
}

async function runDenoms() {
  const fs = require('node:fs');
  const map = JSON.parse(fs.readFileSync(val('--denoms'), 'utf8'));
  let entries = Object.entries(map).map(([id, v]) => ({ id, ...v }));
  if (val('--test')) entries = entries.filter((e) => e.id === val('--test'));
  entries = entries.slice(0, LIMIT === Infinity ? entries.length : LIMIT);
  console.log(`Denomination fixes: ${entries.length}${DRY ? ' (dry-run)' : ''}\n`);
  let done = 0;
  for (const e of entries) {
    try {
      const cur = await getMerchant(e.id);
      if (cur.denominations) {
        console.log(`  = ${e.name.padEnd(30)} already has denominations`);
        continue;
      }
      if (DRY) {
        console.log(`  [dry] ${e.name.padEnd(30)} ${e.denominationType} [${e.denominationValues}]`);
        continue;
      }
      await putMerchant(e.id, {
        denominationType: e.denominationType,
        denominationValues: e.denominationValues,
      });
      console.log(`  ✓ ${e.name.padEnd(30)} ${e.denominationType} [${e.denominationValues}]`);
      done++;
      await sleep(THROTTLE);
    } catch (err) {
      console.log(`  ✗ ${e.name.padEnd(30)} ${err.message}`);
    }
  }
  console.log(`\nFixed denominations on ${done}.`);
}

async function runMergeDiscounts() {
  const fs = require('node:fs');
  const map = JSON.parse(fs.readFileSync(val('--merge-discounts'), 'utf8'));
  const entries = Object.entries(map).map(([id, v]) => ({ id, ...v }));
  console.log(
    `Merge provider mappings onto keepers: ${entries.length}${DRY ? ' (dry-run)' : ''}\n`,
  );
  for (const e of entries) {
    try {
      const cur = await getMerchant(e.id);
      const have = new Set((cur.discounts || []).map((d) => `${d.provider}:${d.providerId}`));
      const want = e.discounts.map((d) => `${d.provider}:${d.providerId}`);
      const missing = want.filter((w) => !have.has(w));
      if (!missing.length) {
        console.log(`  = ${e.name.padEnd(28)} already has [${want.join(', ')}]`);
        continue;
      }
      if (DRY) {
        console.log(`  [dry] ${e.name.padEnd(28)} + [${missing.join(', ')}]`);
        continue;
      }
      // Send the full union; the endpoint re-syncs each discount from its provider.
      await putMerchant(e.id, { discounts: e.discounts });
      const after = await getMerchant(e.id);
      const got = (after.discounts || []).map((d) => `${d.provider}:${d.providerId}`);
      console.log(`  ✓ ${e.name.padEnd(28)} now [${got.join(', ')}]`);
      await sleep(THROTTLE);
    } catch (err) {
      console.log(`  ✗ ${e.name.padEnd(28)} ${err.message}`);
    }
  }
}

async function runDisable() {
  const fs = require('node:fs');
  const map = JSON.parse(fs.readFileSync(val('--disable'), 'utf8'));
  const entries = Object.entries(map).map(([id, v]) => ({ id, ...v }));
  console.log(`Disable: ${entries.length}${DRY ? ' (dry-run)' : ''}\n`);
  for (const e of entries) {
    try {
      const cur = await getMerchant(e.id);
      if (cur.status === 'disabled') {
        console.log(`  = ${e.name} already disabled`);
        continue;
      }
      if (DRY) {
        console.log(`  [dry] disable ${e.name} (${e.reason})`);
        continue;
      }
      await putMerchant(e.id, { status: 'disabled', statusReason: e.reason, statusNote: e.note });
      console.log(`  ✓ disabled ${e.name}`);
      await sleep(THROTTLE);
    } catch (err) {
      console.log(`  ✗ ${e.name} ${err.message}`);
    }
  }
}

async function runRenameFile() {
  const fs = require('node:fs');
  const map = JSON.parse(fs.readFileSync(val('--rename'), 'utf8'));
  const entries = Object.entries(map).map(([id, v]) => ({ id, ...v }));
  console.log(`Renames: ${entries.length}${DRY ? ' (dry-run)' : ''}\n`);
  for (const e of entries) {
    try {
      const cur = await getMerchant(e.id);
      if (cur.name === e.new) {
        console.log(`  = already "${e.new}"`);
        continue;
      }
      if (DRY) {
        console.log(`  [dry] "${e.old}" → "${e.new}"`);
        continue;
      }
      await putMerchant(e.id, { name: e.new });
      console.log(`  ✓ "${e.old}" → "${e.new}"`);
      await sleep(THROTTLE);
    } catch (err) {
      console.log(`  ✗ ${e.old} ${err.message}`);
    }
  }
}

async function runInfo() {
  const fs = require('node:fs');
  const map = JSON.parse(fs.readFileSync(val('--info'), 'utf8'));
  let entries = Object.entries(map).map(([id, v]) => ({ id, ...v }));
  if (val('--test')) entries = entries.filter((e) => e.id === val('--test'));
  entries = entries.slice(0, LIMIT === Infinity ? entries.length : LIMIT);
  console.log(
    `Info (intro/description/instructions/terms): ${entries.length}${DRY ? ' (dry-run)' : ''}\n`,
  );
  let done = 0;
  for (const e of entries) {
    try {
      const cur = await getMerchant(e.id);
      const ci = cur.info || {};
      if (!FORCE && ci.description && ci.instructions) {
        console.log(`  = ${e.name || e.id} already has info`);
        continue;
      }
      if (DRY) {
        console.log(
          `  [dry] ${(e.name || e.id).padEnd(28)} intro:"${(e.intro || '').slice(0, 40)}"`,
        );
        continue;
      }
      await putMerchant(e.id, {
        info: {
          intro: e.intro || '',
          description: e.description || '',
          instructions: e.instructions || '',
          terms: e.terms || '',
        },
      });
      console.log(`  ✓ ${e.name || e.id}`);
      done++;
      await sleep(THROTTLE);
    } catch (err) {
      console.log(`  ✗ ${e.name || e.id} ${err.message}`);
    }
  }
  console.log(`\nSet info on ${done}.`);
}

async function main() {
  if (has('--info')) return runInfo();
  if (has('--merge-discounts')) return runMergeDiscounts();
  if (has('--denoms')) return runDenoms();
  if (has('--disable')) return runDisable();
  if (has('--rename')) return runRenameFile();
  if (has('--verify')) {
    const m = await getMerchant(val('--verify'));
    console.log(
      JSON.stringify(
        {
          id: m.id,
          name: m.name,
          country: m.country,
          logoUrl: m.logoUrl,
          cardImageUrl: m.cardImageUrl,
          status: m.status,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (has('--renames')) return runRenames();
  if (has('--images')) return runImages();
  console.log('specify --verify <id> | --renames | --images <file>');
}

import('node:module').then(({ createRequire }) => {
  globalThis.require = createRequire(import.meta.url);
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
});
