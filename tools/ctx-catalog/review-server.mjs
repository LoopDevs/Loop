#!/usr/bin/env node
/**
 * Local human-review UI for scraped merchant images, before anything is
 * written to CTX. Shows every merchant with a scraped logo / cover, a
 * ✓ / ✗ per image; decisions persist to /tmp/review-decisions.json.
 *
 * Approved (✓) images get pushed to CTX (ctx-apply.mjs --images, fed the
 * approved subset). Rejected (✗) images get re-sourced.
 *
 *   node scripts/review-server.mjs          # → http://localhost:7654
 *
 * Reads /tmp/ctx-images.json (scraped) + /tmp/ctx-all.json (names/country).
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const IMG_CACHE = '/tmp/review-img-cache';
try {
  mkdirSync(IMG_CACHE, { recursive: true });
} catch {}

const PORT = 7654;
const IMAGES = '/tmp/ctx-media-final.json';
const INFO = '/tmp/ctx-info.json';
const CTXALL = '/tmp/ctx-all.json';
const DECISIONS = '/tmp/review-decisions.json';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function loadData() {
  const scraped = JSON.parse(readFileSync(IMAGES, 'utf8'));
  const info = existsSync(INFO) ? JSON.parse(readFileSync(INFO, 'utf8')) : {};
  // Current CTX state is the authoritative source for names/country — the
  // media snapshot pre-dates the renames, so always prefer the live name.
  const FRESH = '/tmp/ctx-fresh.json';
  const ctx = existsSync(FRESH)
    ? JSON.parse(readFileSync(FRESH, 'utf8'))
    : existsSync(CTXALL)
      ? JSON.parse(readFileSync(CTXALL, 'utf8'))
      : [];
  const cur = {};
  // Keep existing CTX images the user already sourced — only fill empties with our new media (matches the additive apply).
  for (const m of ctx)
    cur[m.id] = {
      name: m.name,
      country: m.country,
      status: m.status,
      logoUrl: (m.logoUrl || '').trim() || null,
      cardImageUrl: (m.cardImageUrl || '').trim() || null,
    };
  const disabled = new Set(ctx.filter((m) => m.status === 'disabled').map((m) => m.id));
  // union of ids that have media OR info, so the page covers everything
  const ids = new Set([...Object.keys(scraped), ...Object.keys(info)]);
  const rows = [...ids]
    .map((id) => {
      const v = scraped[id] || {};
      const i = info[id] || {};
      const c = cur[id] || {};
      return {
        id,
        name: c.name || v.name || i.name || id,
        country: c.country || '',
        domain: v.domain || '',
        logoUrl: c.logoUrl || v.logoUrl || null,
        cardImageUrl: c.cardImageUrl || v.headerUrl || null,
        logoSource: c.logoUrl ? 'existing-ctx' : v.logoSource || '',
        coverSource: c.cardImageUrl ? 'existing-ctx' : v.headerSource || '',
        intro: i.intro || '',
        description: i.description || '',
        instructions: i.instructions || '',
        terms: i.terms || '',
      };
    })
    .filter((r) => !disabled.has(r.id) && (r.logoUrl || r.cardImageUrl || r.description))
    .sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Merchant image review</title>
<style>
  :root{--blue:#1a56db;--green:#16a34a;--red:#dc2626;--line:#e5e7eb;--ink:#0f172a;--muted:#64748b}
  *{box-sizing:border-box}
  body{font:14px/1.4 -apple-system,Inter,system-ui,sans-serif;margin:0;background:#f8fafc;color:var(--ink)}
  header{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid var(--line);padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  header h1{font-size:16px;margin:0;font-weight:600}
  .counts{color:var(--muted);font-size:13px}
  .counts b{color:var(--ink)}
  .filters button,.bulk button{border:1px solid var(--line);background:#fff;border-radius:4px;padding:5px 10px;cursor:pointer;font:inherit;margin-left:6px}
  .filters button.active{background:var(--blue);color:#fff;border-color:var(--blue)}
  main{padding:14px 20px;display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .card{background:#fff;border:1px solid var(--line);border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:10px}
  .imgs{display:flex;flex-direction:row;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .name{min-width:0}
  .name .n{font-weight:600}
  .name .d{color:var(--muted);font-size:12px}
  .copy{margin-top:6px;font-size:12.5px;line-height:1.45;color:var(--ink)}
  .copy .intro{font-weight:600;color:var(--blue);margin-bottom:4px}
  .copy .cp{margin-top:4px;color:#334155}
  .copy .cp b{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.03em;display:block;margin-bottom:1px}
  .copy .tm{color:var(--muted);font-size:11px}
  .fv{float:right;display:inline-flex;gap:3px;margin-left:6px}
  .fv button{width:20px;height:16px;border:1px solid var(--line);background:#fff;border-radius:3px;cursor:pointer;font-size:10px;line-height:1;padding:0}
  .fv button.yes.on{background:var(--green);border-color:var(--green);color:#fff}
  .fv button.no.on{background:var(--red);border-color:var(--red);color:#fff}
  .note{width:100%;box-sizing:border-box;margin-top:8px;min-height:38px;font:12px system-ui;border:1px solid var(--line);border-radius:4px;padding:6px;resize:vertical}
  .note:focus{outline:2px solid var(--blue);border-color:var(--blue)}
  .card{overflow:visible}
  .nrow{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .acceptM{flex:0 0 auto;background:var(--green);color:#fff;border:none;border-radius:5px;padding:6px 12px;font:600 12px system-ui;cursor:pointer;white-space:nowrap}
  .acceptM:hover{filter:brightness(.95)}
  .asset{text-align:center}
  .asset .lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
  .thumb{border:1px solid var(--line);border-radius:4px;background:#f1f5f9 url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke="%23cbd5e1" stroke-width="1.5"><path d="M3 16l5-5 4 4 3-3 6 6"/><circle cx="8.5" cy="7.5" r="1.5"/></svg>') center/22px no-repeat;object-fit:contain}
  .logo .thumb{width:128px;height:128px}
  .cover .thumb{width:640px;height:360px}
  .vote{display:flex;gap:4px;justify-content:center;margin-top:5px}
  .vote button{width:26px;height:24px;border:1px solid var(--line);background:#fff;border-radius:4px;cursor:pointer;font-size:13px;line-height:1;padding:0}
  .vote button.yes.on{background:var(--green);border-color:var(--green);color:#fff}
  .vote button.no.on{background:var(--red);border-color:var(--red);color:#fff}
  .badge{font-size:9px;text-transform:uppercase;letter-spacing:.03em;margin-top:3px;font-weight:600}
  .card.none{opacity:.45}
  .save{font-size:12px;color:var(--muted)}
</style></head><body>
<header>
  <h1>Merchant image review</h1>
  <span class="counts" id="counts"></span>
  <span class="filters" id="filters">
    <button data-f="all" class="active">All</button>
    <button data-f="pending">Pending</button>
    <button data-f="approved">Approved</button>
    <button data-f="rejected">Rejected</button>
  </span>
  <span class="bulk"><button id="approveAll">✓ Approve all visible</button></span>
  <span class="save" id="save"></span>
</header>
<main id="grid"></main>
<script>
let rows=[], dec={}, filter='all', saveTimer=null;
const $=s=>document.querySelector(s);
async function boot(){
  rows=await (await fetch('/data')).json();
  dec=await (await fetch('/decisions')).json();
  render();
}
function stateOf(id){ const d=dec[id]||{}; const v=[d.logo,d.cover].filter(Boolean);
  if(!v.length) return 'pending';
  if(v.includes('no')&&!v.includes('yes')) return 'rejected';
  if(v.includes('yes')&&!v.includes('no')) return 'approved';
  return 'mixed'; }
function render(){
  const g=$('#grid'); g.innerHTML='';
  let app=0,rej=0,pend=0;
  for(const r of rows){
    const st=stateOf(r.id);
    if(st==='approved'||st==='mixed')app++; else if(st==='rejected')rej++; else pend++;
    if(filter==='approved'&&!(st==='approved'||st==='mixed'))continue;
    if(filter==='rejected'&&st!=='rejected')continue;
    if(filter==='pending'&&st!=='pending')continue;
    g.appendChild(card(r));
  }
  $('#counts').innerHTML='<b>'+rows.length+'</b> merchants · <b>'+app+'</b> approved · <b>'+rej+'</b> rejected · <b>'+pend+'</b> pending';
}
function fv(k,cur){ // inline ✓/✗ for a text field
  return '<span class="fv"><button class="yes'+(cur==='yes'?' on':'')+'" data-k="'+k+'" data-v="yes">✓</button>'+
    '<button class="no'+(cur==='no'?' on':'')+'" data-k="'+k+'" data-v="no">✗</button></span>';
}
function card(r){
  const d=dec[r.id]||(dec[r.id]={});
  const el=document.createElement('div'); el.className='card';
  const txt='<div class="copy">'+
      (r.intro?'<div class="intro">'+esc(r.intro)+'</div>':'')+
      (r.description?'<div class="cp"><b>Description '+fv('desc',d.desc)+'</b> '+esc(r.description)+'</div>':'')+
      (r.instructions?'<div class="cp"><b>How to use '+fv('instr',d.instr)+'</b> '+esc(r.instructions)+'</div>':'')+
      (r.terms?'<div class="cp tm"><b>Terms '+fv('terms',d.terms)+'</b> '+esc(r.terms)+'</div>':'')+
    '</div>'+
    '<textarea class="note" placeholder="Rejection note — why is a logo / cover / description / how-to-use / terms wrong?">'+esc(d.note||'')+'</textarea>';
  el.innerHTML=
    '<div class="imgs">'+
      asset('logo','Logo',r.logoUrl,d.logo,r.logoSource)+
      asset('cover','Cover',r.cardImageUrl,d.cover,r.coverSource)+
    '</div>'+
    '<div class="name"><div class="nrow"><div class="n">'+esc(r.name)+'</div><button class="acceptM">✓ Accept all</button></div><div class="d">'+esc(r.country)+(r.domain?' · '+esc(r.domain):'')+'</div>'+txt+'</div>';
  el.querySelectorAll('.vote button,.fv button').forEach(b=>b.onclick=()=>{
    const k=b.dataset.k, v=b.dataset.v;
    dec[r.id][k]=dec[r.id][k]===v?null:v;
    save(); render();
  });
  el.querySelector('.acceptM').onclick=()=>{ const dd=dec[r.id]; if(r.logoUrl)dd.logo='yes'; if(r.cardImageUrl)dd.cover='yes'; if(r.description)dd.desc='yes'; if(r.instructions)dd.instr='yes'; if(r.terms)dd.terms='yes'; save(); render(); };
  const note=el.querySelector('.note'); if(note){ const sv=()=>{ dec[r.id].note=note.value; save(); }; note.oninput=sv; note.onblur=sv; }
  return el;
}
function srcBadge(s){
  if(!s) return '';
  const real=(s==='scrape'); const fb=(s==='favicon'||s==='category');
  const color=real?'#16a34a':fb?'#d97706':'#94a3b8';
  return '<div class="badge" style="color:'+color+'">'+s+'</div>';
}
function asset(k,lbl,url,cur,src){
  if(!url) return '<div class="asset '+k+'"><div class="lbl">'+lbl+'</div><div class="thumb"></div><div class="vote" style="visibility:hidden"></div></div>';
  return '<div class="asset '+k+'"><div class="lbl">'+lbl+'</div>'+
    '<img class="thumb" loading="lazy" src="/img?u='+encodeURIComponent(url)+'">'+
    srcBadge(src)+
    '<div class="vote"><button class="yes'+(cur==='yes'?' on':'')+'" data-k="'+k+'" data-v="yes">✓</button>'+
    '<button class="no'+(cur==='no'?' on':'')+'" data-k="'+k+'" data-v="no">✗</button></div></div>';
}
function save(){
  $('#save').textContent='saving…';
  clearTimeout(saveTimer);
  saveTimer=setTimeout(async()=>{ await fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(dec)}); $('#save').textContent='saved ✓'; },350);
}
$('#filters').onclick=e=>{ if(e.target.dataset.f){filter=e.target.dataset.f; document.querySelectorAll('#filters button').forEach(b=>b.classList.toggle('active',b===e.target)); render(); } };
$('#approveAll').onclick=()=>{ for(const r of rows){ const st=stateOf(r.id); if(filter==='approved'&&!(st==='approved'||st==='mixed'))continue; if(filter==='rejected'&&st!=='rejected')continue; if(filter==='pending'&&st!=='pending')continue; dec[r.id]=dec[r.id]||{}; if(r.logoUrl)dec[r.id].logo='yes'; if(r.cardImageUrl)dec[r.id].cover='yes'; } save(); render(); };
function esc(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
boot();
</script></body></html>`;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(PAGE);
  }
  if (url.pathname === '/data') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(loadData()));
  }
  if (url.pathname === '/decisions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(existsSync(DECISIONS) ? readFileSync(DECISIONS) : '{}');
  }
  if (url.pathname === '/save' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        writeFileSync(DECISIONS, body);
        res.writeHead(200);
        res.end('ok');
      } catch {
        res.writeHead(500);
        res.end('err');
      }
    });
    return;
  }
  if (url.pathname === '/img') {
    const u = url.searchParams.get('u');
    if (!u) {
      res.writeHead(204);
      return res.end();
    }
    // disk cache: each external image is fetched once, then served locally
    // (stops logo.dev / CDNs from rate-limiting the proxy on repeated loads)
    const key = createHash('sha1').update(u).digest('hex');
    const fp = `${IMG_CACHE}/${key}`;
    if (existsSync(fp) && existsSync(fp + '.ct')) {
      res.writeHead(200, {
        'content-type': readFileSync(fp + '.ct', 'utf8'),
        'cache-control': 'max-age=86400',
      });
      return res.end(readFileSync(fp));
    }
    try {
      const origin = new URL(u).origin;
      const r = await fetch(u, {
        headers: { 'User-Agent': UA, Referer: origin, Accept: 'image/*,*/*' },
        signal: AbortSignal.timeout(12000),
      });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !ct.startsWith('image/')) {
        res.writeHead(204); // not a real image → blank, shows placeholder
        return res.end();
      }
      const buf = Buffer.from(await r.arrayBuffer());
      try {
        writeFileSync(fp, buf);
        writeFileSync(fp + '.ct', ct);
      } catch {}
      res.writeHead(200, { 'content-type': ct, 'cache-control': 'max-age=86400' });
      return res.end(buf);
    } catch {
      res.writeHead(204);
      return res.end();
    }
  }
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, () => console.log(`Review UI → http://localhost:${PORT}`));
