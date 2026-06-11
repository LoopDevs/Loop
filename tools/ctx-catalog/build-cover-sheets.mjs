import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const PER = 30; // 5 cols x 6 rows
const SRC = new RegExp(process.argv[2] || 'tavily', 'i'); // headerSource pattern
const PREFIX = process.argv[3] || 'cover-sheet';
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const rows = Object.entries(media)
  .filter(
    ([, v]) =>
      v.headerUrl &&
      (process.argv[2] === 'reqc'
        ? v._reqc
        : process.argv[2] === 'reqc3'
          ? v._reqc3
          : SRC.test(v.headerSource || '')),
  )
  .map(([id, v]) => ({ id, name: v.name || id, src: v.headerSource, url: v.headerUrl }))
  .sort((a, b) => a.name.localeCompare(b.name));
const sheets = [];
for (let i = 0; i < rows.length; i += PER) sheets.push(rows.slice(i, i + PER));
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1000, height: 1320 },
  deviceScaleFactor: 2,
});
for (let k = 0; k < sheets.length; k++) {
  const cells = sheets[k]
    .map(
      (v, i) =>
        `<figure><div class=t><img src="${v.url}" loading="eager"></div><figcaption><b>${i + 1}.</b> ${(v.name || '').replace(/</g, '').slice(0, 26)}</figcaption></figure>`,
    )
    .join('');
  writeFileSync(
    `/tmp/${PREFIX}-${k}.html`,
    `<!doctype html><meta charset=utf8><body style="margin:0;font:11px system-ui;background:#fff"><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:5px;padding:8px">${cells}</div><style>figure{margin:0}.t{height:104px;border:1px solid #e2e8f0;border-radius:4px;overflow:hidden;background:#f1f5f9}img{width:100%;height:100%;object-fit:cover}figcaption{padding:2px 0;line-height:1.2}b{color:#2563eb}</style>`,
  );
  try {
    await page.goto(`file:///tmp/${PREFIX}-${k}.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
  } catch {
    /* */
  }
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.stop()).catch(() => {}); // halt pending image loads so screenshot stabilizes
  try {
    await page.screenshot({
      path: `/tmp/${PREFIX}-${k}.png`,
      fullPage: true,
      animations: 'disabled',
      timeout: 60000,
    });
  } catch (e) {
    console.log(`  screenshot ${k} failed: ${e.message.slice(0, 40)}`);
  }
  writeFileSync(
    `/tmp/${PREFIX}-${k}.names.json`,
    JSON.stringify(
      sheets[k].map((v, i) => ({ pos: i + 1, id: v.id, name: v.name, src: v.src })),
      null,
      2,
    ),
  );
  console.log(`cover sheet ${k}: ${sheets[k].length}`);
}
await browser.close();
console.log(`Built ${sheets.length} cover sheets for ${rows.length} Tavily covers.`);
