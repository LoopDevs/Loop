import { readFileSync, writeFileSync } from 'node:fs';
import { dataPath } from './paths.mjs';
const T = process.env.CTX_TOKEN;
const H = { Authorization: `Bearer ${T}`, 'x-client-id': 'ctx_admin' };
let p = 1,
  pg = 1,
  all = [];
while (p <= pg) {
  const d = await (
    await fetch(`https://spend.ctx.com/merchants?page=${p}&perPage=200`, { headers: H })
  ).json();
  pg = d.pagination.pages;
  all.push(...d.result);
  p++;
}
writeFileSync(dataPath('ctx-fresh.json'), JSON.stringify(all));
const en = all.filter((m) => m.status === 'enabled');
writeFileSync(dataPath('catalog-names.json'), JSON.stringify(en.map((m) => m.name).sort()));
const media = JSON.parse(readFileSync(dataPath('ctx-media-final.json'), 'utf8'));
const info = JSON.parse(readFileSync(dataPath('ctx-info.json'), 'utf8'));
const noMedia = en.filter((m) => !media[m.id] && !(m.logoUrl && m.logoUrl.trim()));
const noInfo = en.filter((m) => !info[m.id] || !info[m.id].description);
console.log('catalog:', all.length, '| enabled:', en.length);
console.log('enabled merchants with NO logo/cover (need media):', noMedia.length);
console.log('enabled merchants with NO description (need info):', noInfo.length);
writeFileSync(
  dataPath('new-merchants-need-media.json'),
  JSON.stringify(
    noMedia.map((m) => ({ id: m.id, name: m.name, country: m.country })),
    null,
    2,
  ),
);
