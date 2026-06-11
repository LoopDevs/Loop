#!/usr/bin/env node
/**
 * Domain-review UI for merchants with NO authoritative supplier URL
 * (~397). Each row: merchant + an editable domain pre-filled with a
 * best guess, a favicon preview, and an "open" link to verify it's the
 * right brand. ✓ confirms, ✗ marks "no good". Saves to
 * /tmp/ctx-domain-review.json → feeds the correct-domain re-scrape.
 *
 *   node scripts/domain-review-server.mjs   # → http://localhost:7655
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PORT = 7655;
const QUEUE = '/tmp/ctx-domain-guesses.json';
const DECISIONS = '/tmp/ctx-domain-review.json';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Domain review</title>
<style>
  *{box-sizing:border-box}
  body{font:14px/1.4 -apple-system,Inter,system-ui,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
  header{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid #e5e7eb;padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  header h1{font-size:16px;margin:0;font-weight:600}
  .counts{color:#64748b}
  .filters button{border:1px solid #e5e7eb;background:#fff;border-radius:4px;padding:5px 10px;cursor:pointer;font:inherit;margin-left:6px}
  .filters button.active{background:#1a56db;color:#fff;border-color:#1a56db}
  main{padding:12px 20px;display:flex;flex-direction:column;gap:6px;max-width:980px}
  .row{display:flex;gap:10px;align-items:center;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:8px 10px}
  .row.ok{border-color:#16a34a;background:#f0fdf4}
  .row.no{border-color:#dc2626;background:#fef2f2;opacity:.7}
  .fav{width:28px;height:28px;border:1px solid #e5e7eb;border-radius:4px;background:#f1f5f9;flex:0 0 auto;object-fit:contain}
  .nm{flex:0 0 230px;min-width:0}
  .nm .n{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .nm .c{font-size:11px;color:#94a3b8}
  input.dom{flex:1;min-width:120px;border:1px solid #cbd5e1;border-radius:4px;padding:6px 8px;font:inherit}
  a.open{font-size:12px;color:#1a56db;text-decoration:none;white-space:nowrap}
  .v{display:flex;gap:4px}
  .v button{width:30px;height:28px;border:1px solid #e5e7eb;background:#fff;border-radius:4px;cursor:pointer;font-size:13px}
  .v button.yes.on{background:#16a34a;border-color:#16a34a;color:#fff}
  .v button.no.on{background:#dc2626;border-color:#dc2626;color:#fff}
  .save{font-size:12px;color:#64748b;margin-left:auto}
</style></head><body>
<header>
  <h1>Domain review</h1><span class="counts" id="counts"></span>
  <span class="filters" id="filters">
    <button data-f="pending" class="active">Pending</button>
    <button data-f="ok">Confirmed</button><button data-f="no">No good</button><button data-f="all">All</button>
  </span>
  <span class="save" id="save"></span>
</header>
<main id="list"></main>
<script>
let rows=[],dec={},filter="pending",t=null;
const $=s=>document.querySelector(s);
async function boot(){rows=await(await fetch("/data")).json();dec=await(await fetch("/decisions")).json();render();}
function st(id){return dec[id]?.status||"pending";}
function render(){
  const L=$("#list");L.innerHTML="";let ok=0,no=0,pend=0;
  for(const r of rows){const s=st(r.id);if(s==="ok")ok++;else if(s==="no")no++;else pend++;
    if(filter!=="all"&&filter!==s)continue;L.appendChild(row(r));}
  $("#counts").innerHTML="<b>"+rows.length+"</b> · "+ok+" confirmed · "+no+" no-good · "+pend+" pending";
}
function row(r){
  const d=dec[r.id]||(dec[r.id]={domain:r.guess||"",status:"pending"});
  const el=document.createElement("div");el.className="row"+(d.status==="ok"?" ok":d.status==="no"?" no":"");
  el.innerHTML=
    '<img class="fav" src="/favicon?d='+encodeURIComponent(d.domain||"")+'">'+
    '<div class="nm"><div class="n">'+esc(r.name)+'</div><div class="c">'+esc(r.country)+' · '+esc((r.providers||[]).join(","))+'</div></div>'+
    '<input class="dom" value="'+esc(d.domain||"")+'" placeholder="brand.com">'+
    '<a class="open" target="_blank" href="https://'+esc(d.domain||"")+'">open &#8599;</a>'+
    '<div class="v"><button class="yes'+(d.status==="ok"?" on":"")+'">&#10003;</button><button class="no'+(d.status==="no"?" on":"")+'">&#10007;</button></div>';
  const inp=el.querySelector("input"),fav=el.querySelector(".fav"),link=el.querySelector("a.open");
  inp.oninput=()=>{d.domain=inp.value.trim();link.href="https://"+d.domain;fav.src="/favicon?d="+encodeURIComponent(d.domain);save();};
  el.querySelector(".yes").onclick=()=>{d.status=d.status==="ok"?"pending":"ok";save();render();};
  el.querySelector(".no").onclick=()=>{d.status=d.status==="no"?"pending":"no";save();render();};
  return el;
}
function save(){$("#save").textContent="saving…";clearTimeout(t);t=setTimeout(async()=>{await fetch("/save",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(dec)});$("#save").textContent="saved ✓";},300);}
$("#filters").onclick=e=>{if(e.target.dataset.f){filter=e.target.dataset.f;document.querySelectorAll("#filters button").forEach(b=>b.classList.toggle("active",b===e.target));render();}};
function esc(s){return(s||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));}
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
    return res.end(readFileSync(QUEUE));
  }
  if (url.pathname === '/decisions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(existsSync(DECISIONS) ? readFileSync(DECISIONS) : '{}');
  }
  if (url.pathname === '/save' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        writeFileSync(DECISIONS, b);
        res.writeHead(200);
        res.end('ok');
      } catch {
        res.writeHead(500);
        res.end('e');
      }
    });
    return;
  }
  if (url.pathname === '/favicon') {
    const d = url.searchParams.get('d');
    if (!d) {
      res.writeHead(204);
      return res.end();
    }
    try {
      const r = await fetch(`https://icons.duckduckgo.com/ip3/${d}.ico`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000),
      });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !ct.startsWith('image/')) {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(200, { 'content-type': ct, 'cache-control': 'max-age=3600' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.writeHead(204);
      return res.end();
    }
  }
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, () => console.log(`Domain review → http://localhost:${PORT}`));
