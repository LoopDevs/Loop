#!/usr/bin/env node
/**
 * Image dimension gate for logos. Fetches an image and parses its real
 * pixel dimensions (PNG / ICO / JPEG / GIF / WebP; SVG = vector → pass)
 * with NO dependencies. Used to reject sub-128×128 favicons that are
 * too low-res to use as merchant logos.
 *
 * Exports imageDimensions(url) → {w,h} | null, and bigEnough(url,min).
 */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** Parse width/height from raw image bytes for the common formats. */
export function parseDimensions(buf, contentType = '') {
  if (!buf || buf.length < 24) return null;
  // SVG (vector) — treat as large enough
  if (/svg/i.test(contentType) || buf.slice(0, 256).toString('utf8').includes('<svg'))
    return { w: 9999, h: 9999, svg: true };
  // PNG: signature 89 50 4E 47, IHDR width@16 height@20 (big-endian)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  // GIF: 'GIF8', width@6 height@8 (little-endian)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  // ICO: 00 00 01 00, count@4; dir entries from offset 6 (byte0=w,byte1=h, 0=256) — take largest
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) {
    const n = buf.readUInt16LE(4);
    let best = { w: 0, h: 0 };
    for (let i = 0; i < n; i++) {
      const o = 6 + i * 16;
      if (o + 1 >= buf.length) break;
      const w = buf[o] === 0 ? 256 : buf[o];
      const h = buf[o + 1] === 0 ? 256 : buf[o + 1];
      if (w * h > best.w * best.h) best = { w, h };
    }
    return best.w ? best : null;
  }
  // WebP: 'RIFF'....'WEBP'
  if (
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    const f = buf.slice(12, 16).toString('ascii');
    try {
      if (f === 'VP8 ')
        return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (f === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
      if (f === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
    } catch {
      return null;
    }
  }
  // JPEG: scan SOF markers
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length - 9) {
      if (buf[o] !== 0xff) {
        o++;
        continue;
      }
      const m = buf[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

export async function imageDimensions(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: new URL(url).origin },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    return parseDimensions(buf, ct);
  } catch {
    return null;
  }
}

export async function bigEnough(url, min = 128) {
  const d = await imageDimensions(url);
  if (!d) return false;
  return d.svg || (d.w >= min && d.h >= min);
}

// CLI self-test
if (import.meta.url === `file://${process.argv[1]}`) {
  const urls = process.argv.slice(2);
  for (const u of urls) console.log(JSON.stringify(await imageDimensions(u)), u);
}
