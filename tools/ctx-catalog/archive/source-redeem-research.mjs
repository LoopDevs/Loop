#!/usr/bin/env node
/**
 * Research real "how to redeem" instructions for the no-source merchants
 * (no supplier redemption note or terms) via Tavily search with an LLM
 * answer. Grounds the how-to-use in actual web info instead of a guess.
 *
 * Reads /tmp/ctx-redeem-targets.json [{id,name,domain,methods}]
 * Writes /tmp/ctx-redeem-research.json { id:{name,methods,answer,sources:[{title,url}]} }
 * Needs TAVILY_API_KEY. Resumable, throttled.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.TAVILY_API_KEY;
const outPath = '/tmp/ctx-redeem-research.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function research(brand, domain) {
  const q = `How do I redeem a ${brand} gift card? Where and how is it used (online at ${domain || 'their website'}, in-store, enter code/PIN at checkout)?`;
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: KEY,
      query: q,
      include_answer: 'advanced',
      max_results: 3,
      search_depth: 'basic',
    }),
  });
  if (!r.ok) throw new Error(`tavily ${r.status}`);
  const j = await r.json();
  return {
    answer: j.answer || '',
    sources: (j.results || []).slice(0, 3).map((x) => ({ title: x.title, url: x.url })),
  };
}

async function main() {
  if (!KEY) {
    console.error('TAVILY_API_KEY not set');
    process.exit(2);
  }
  const targets = JSON.parse(readFileSync('/tmp/ctx-redeem-targets.json', 'utf8'));
  let out = {};
  try {
    out = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {}
  const todo = targets.filter((m) => !(m.id in out));
  console.log(`Redemption research: ${targets.length} targets, ${todo.length} to do\n`);
  let done = 0;
  for (const m of todo) {
    const brand = m.name.replace(/\s+(US|USA|UK|GB|Canada|CA|Europe)$/i, '');
    try {
      const r = await research(brand, m.domain);
      out[m.id] = { name: m.name, methods: m.methods, answer: r.answer, sources: r.sources };
      console.log(
        `${r.answer ? '✓' : '○'} ${m.name.slice(0, 30).padEnd(30)} ${r.answer ? r.answer.slice(0, 70).replace(/\n/g, ' ') : 'no answer'}`,
      );
    } catch (e) {
      out[m.id] = { name: m.name, methods: m.methods, answer: '', error: e.message };
      console.log(`✗ ${m.name} ${e.message}`);
    }
    done++;
    if (done % 15 === 0) writeFileSync(outPath, JSON.stringify(out, null, 2));
    await sleep(350);
  }
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(
    `\nDone. answers found: ${Object.values(out).filter((r) => r.answer).length}/${Object.keys(out).length}. Wrote ${outPath}`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
