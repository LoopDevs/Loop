#!/usr/bin/env node
/**
 * Stage 1 — domain resolution candidate-gathering (for the AI-verify gate).
 *
 * For each target merchant, gather candidate domains from every source we have
 * (supplier website_url, logo.dev Search, Tavily), then fetch each candidate's
 * LIVE status + <title> so a review subagent can pick the right one (or reject
 * all). Auto-resolvers are unreliable on ambiguous/sub-brand names (Aerie →
 * ae.com, Free Fire → freefirepro.com), so we never trust a single source.
 *
 * Reads  /tmp/ctx-supplier-harvest.json (name, country, supplier domain)
 * Writes /tmp/ctx-domain-candidates.json
 *   { id: { name, country, candidates: [{domain, source, status, title}] } }
 *
 *   node scripts/ctx-domain-resolve.mjs [--limit N] [--ids id,id,…] [--sample N]
 * Env: TAVILY_API_KEY, logo.dev sk in /tmp/logodev-key.txt
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TAVILY = (process.env.TAVILY_API_KEY || '').trim();
const SK = readFileSync('/tmp/logodev-key.txt', 'utf8').trim();
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
const args = process.argv.slice(2);
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const harvest = JSON.parse(readFileSync('/tmp/ctx-supplier-harvest.json', 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanDomain = (u) => {
  try {
    return new URL(u.startsWith('http') ? u : 'https://' + u).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

async function logodevSearch(name) {
  try {
    const r = await fetch(`https://api.logo.dev/search?q=${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${SK}` },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return [];
    const a = await r.json();
    return (a || []).slice(0, 3).map((x) => ({ domain: cleanDomain(x.domain), source: 'logodev' }));
  } catch {
    return [];
  }
}

async function tavilyDomain(name, country) {
  if (!TAVILY) return [];
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY,
        query: `${name} official website ${country || ''}`.trim(),
        max_results: 3,
        search_depth: 'basic',
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || [])
      .slice(0, 3)
      .map((x) => ({ domain: cleanDomain(x.url), source: 'tavily' }));
  } catch {
    return [];
  }
}

async function liveMeta(domain) {
  for (const scheme of ['https://', 'http://']) {
    try {
      const r = await fetch(scheme + domain, {
        headers: UA,
        redirect: 'follow',
        signal: AbortSignal.timeout(9000),
      });
      const html = await r.text();
      const title = (html.match(/<title[^>]*>([^<]{0,90})/i) || [])[1] || '';
      const ogSite =
        (html.match(/property=["']og:site_name["'][^>]*content=["']([^"']{0,60})/i) || [])[1] || '';
      return { status: r.status, title: (title || ogSite).trim().replace(/\s+/g, ' ') };
    } catch (e) {
      if (scheme === 'http://')
        return { status: 'ERR', title: String(e.message || '').slice(0, 30) };
    }
  }
  return { status: 'ERR', title: '' };
}

let targets = Object.entries(harvest).filter(([, r]) => r.needLogo || r.needCover);
if (val('--ids')) {
  const set = new Set(val('--ids').split(','));
  targets = Object.entries(harvest).filter(([id]) => set.has(id));
} else if (val('--sample')) {
  const n = Number(val('--sample'));
  const step = Math.max(1, Math.floor(targets.length / n));
  targets = targets.filter((_, i) => i % step === 0).slice(0, n);
}
if (val('--limit')) targets = targets.slice(0, Number(val('--limit')));

console.log(`resolving domains for ${targets.length} merchants…`);
const out = {};
let done = 0;
const queue = [...targets];
async function worker() {
  while (queue.length) {
    const [id, r] = queue.shift();
    const cand = new Map();
    if (r.domain?.url) {
      const d = cleanDomain(r.domain.url);
      if (d) cand.set(d, 'supplier');
    }
    for (const c of await logodevSearch(r.name))
      if (c.domain && !cand.has(c.domain)) cand.set(c.domain, c.source);
    // Tavily for domains returns gift-card-reseller noise (eneba/kinguin/g2a) — skip
    // it by default; logo.dev + supplier give the real candidates and the AI-review
    // gate supplies any missing official domain from knowledge. --tavily to re-enable.
    if (args.includes('--tavily'))
      for (const c of await tavilyDomain(r.name, r.country))
        if (c.domain && !cand.has(c.domain)) cand.set(c.domain, c.source);
    const candidates = [];
    for (const [domain, source] of cand) {
      const meta = await liveMeta(domain);
      candidates.push({ domain, source, ...meta });
    }
    out[id] = { name: r.name, country: r.country, candidates };
    if (++done % 10 === 0) process.stdout.write(`\r  ${done}/${targets.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
writeFileSync('/tmp/ctx-domain-candidates.json', JSON.stringify(out));
console.log(`\nwrote /tmp/ctx-domain-candidates.json (${Object.keys(out).length} merchants)`);
