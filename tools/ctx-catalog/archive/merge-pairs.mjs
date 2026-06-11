// Merge duplicate merchant pairs: pool BOTH listings' supplier products onto the
// survivor, then disable the dupe. Per the user's review notes.
import { readFileSync } from 'node:fs';
const T = process.env.CTX_TOKEN;
const H = {
  Authorization: `Bearer ${T}`,
  'x-client-id': 'ctx_admin',
  'Content-Type': 'application/json',
};
const fresh = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const byName = Object.fromEntries(fresh.map((m) => [m.name, m]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (id) =>
  (await fetch(`https://spend.ctx.com/merchants/${id}`, { headers: H })).json();

const giftGold = byName['Gift to you Gold'];
const razer = giftGold
  ? fresh.find((m) => /^Razer Gold/.test(m.name) && m.country === giftGold.country) ||
    byName['Razer Gold US']
  : null;

const PAIRS = [
  ["Dunkin' Donuts", "Dunkin'"],
  ['Gap Options Canada', 'Gap Canada'],
  ['Gap Options US', 'Gap US'],
  ['GetGo Cafe + Market', 'GetGo'],
  ['Gift to you Gold', razer ? razer.name : null],
];

for (const [dupeN, survN] of PAIRS) {
  const dupe = byName[dupeN],
    surv = survN ? byName[survN] : null;
  if (!dupe) {
    console.log('? dupe not found:', dupeN);
    continue;
  }
  if (!surv) {
    console.log('? survivor not found for:', dupeN);
    continue;
  }
  const dD = await get(dupe.id),
    sD = await get(surv.id);
  const union = [...(sD.discounts || [])];
  const seen = new Set(union.map((d) => d.provider + ':' + d.providerId));
  for (const d of dD.discounts || [])
    if (!seen.has(d.provider + ':' + d.providerId)) {
      union.push(d);
      seen.add(d.provider + ':' + d.providerId);
    }
  const body = {
    id: surv.id,
    discounts: union.map((d) => ({ provider: d.provider, providerId: d.providerId })),
    denominationType: sD.denominationType,
    denominationValues: (sD.denominationValues || []).join(','),
    userDiscount: String(sD.userDiscount),
    status: 'enabled',
  };
  const r1 = await fetch(`https://spend.ctx.com/merchants/${surv.id}`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify(body),
  });
  const r2 = await fetch(`https://spend.ctx.com/merchants/${dupe.id}`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({
      id: dupe.id,
      discounts: (dD.discounts || []).map((d) => ({
        provider: d.provider,
        providerId: d.providerId,
      })),
      status: 'disabled',
      statusReason: 'no_longer_available',
    }),
  });
  console.log(
    `${r1.ok && r2.ok ? '✓' : '✗'} merged "${dupeN}" → "${survN}"  [${union.map((d) => d.provider + ':' + d.providerId).join(',')}]  surv:${r1.status} dupe:${r2.status}`,
  );
  await sleep(300);
}
