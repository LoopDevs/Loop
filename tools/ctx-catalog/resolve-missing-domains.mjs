#!/usr/bin/env node
/**
 * Gather domain candidates for enabled merchants that still lack a verified domain.
 * Sources: tillo website_url (by linked providerId), logo.dev Search (top 2). The
 * live <title>/status is NOT fetched here (kept fast); the AI-verify subagent uses
 * the candidate list + its own web check. Writes /tmp/missing-domain-candidates.json.
 *   node scripts/resolve-missing-domains.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SK = readFileSync('/tmp/logodev-key.txt', 'utf8').trim();
const M = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).filter(
  (m) => m.status === 'enabled',
);
const V = JSON.parse(readFileSync('/tmp/ctx-domains-verified.json', 'utf8'));
const tillo = JSON.parse(readFileSync('/tmp/tillo-brands.json', 'utf8'));
const tilloBySlug = new Map(tillo.map((b) => [b.slug, b]));
const has = (id) => {
  const v = V[id];
  return v && v.domain;
};
const cleanDomain = (u) => {
  try {
    return new URL(u.startsWith('http') ? u : 'https://' + u).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logodevSearch(name) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://api.logo.dev/search?q=${encodeURIComponent(name)}`, {
        headers: { Authorization: `Bearer ${SK}` },
        signal: AbortSignal.timeout(12000),
      });
      if (r.status === 429) {
        await sleep(1500 * (i + 1));
        continue;
      }
      if (!r.ok) return [];
      const a = await r.json();
      return (a || [])
        .slice(0, 2)
        .map((x) => cleanDomain(x.domain))
        .filter(Boolean);
    } catch {
      if (i === 2) return [];
      await sleep(1000);
    }
  }
  return [];
}

const targets = M.filter((m) => !has(m.id));
console.log(`${targets.length} enabled merchants missing a domain`);
const out = {};
let done = 0;
const queue = [...targets];
async function worker() {
  while (queue.length) {
    const m = queue.shift();
    const cands = [];
    // supplier website_url (tillo)
    for (const d of m.discounts || []) {
      if (d.provider === 'tillo') {
        const b = tilloBySlug.get(d.providerId);
        const dom = b && b.website_url && cleanDomain(b.website_url);
        if (dom) cands.push({ domain: dom, source: 'tillo' });
      }
    }
    // logo.dev search by brand (strip a trailing country word for a cleaner query)
    const q = m.name
      .replace(
        /\s+(France|Germany|Spain|Italy|Belgium|Netherlands|Ireland|Austria|Portugal|Finland|Greece|Canada|US|UK|UAE|Australia|India|Mexico|Turkey)$/i,
        '',
      )
      .trim();
    for (const dom of await logodevSearch(q)) cands.push({ domain: dom, source: 'logodev' });
    // dedupe
    const seen = new Set();
    const uniq = cands.filter((c) => c.domain && !seen.has(c.domain) && seen.add(c.domain));
    out[m.id] = { name: m.name, country: m.country, candidates: uniq };
    if (++done % 100 === 0) process.stdout.write(`\r  ${done}/${targets.length}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
writeFileSync('/tmp/missing-domain-candidates.json', JSON.stringify(out));
const withCand = Object.values(out).filter((o) => o.candidates.length).length;
console.log(`\nwrote ${Object.keys(out).length} targets, ${withCand} have ≥1 candidate`);
