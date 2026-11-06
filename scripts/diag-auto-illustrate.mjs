// 验证自动插图:模拟一次完整的生成事件序列,看是否自动出图并挂到楼层。
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://100.81.244.73:8000/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({ executablePath: EDGE, headless: false });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));

await page.goto(URL + '?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(15000);

// 通过面板勾上「每生成一楼自动插图」
await page.evaluate(() => globalThis.htjZhongZhuan.openPanel('prompt'));
await page.waitForSelector('#htj-zz-panel-mask');
await page.waitForTimeout(400);

const toggled = await page.evaluate(() => {
  const mask = document.getElementById('htj-zz-panel-mask');
  const labels = [...mask.querySelectorAll('label.checkbox_label')];
  const target = labels.find((l) => (l.textContent || '').includes('自动插图'));
  const box = target?.querySelector('input[type=checkbox]');
  if (!box) return { ok: false };
  if (!box.checked) {
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { ok: true, autoRun: box.checked };
});
console.log('=== 勾选自动插图 ===');
console.log(JSON.stringify(toggled));

// 关面板,清掉目标楼的上次卡片,再模拟一次生成
const floor = await page.evaluate(() => window.SillyTavern.getContext().chat.length - 1);
await page.evaluate(() => {
  const mask = document.getElementById('htj-zz-panel-mask');
  if (mask) mask.remove();
});

const result = await page.evaluate(async (f) => {
  const ctx = window.SillyTavern.getContext();
  const ev = ctx.eventTypes;
  const node = document.querySelector(`#chat .mes[mesid="${f}"]`);
  // 清掉旧卡片,确保看到的是这一次的结果
  node?.querySelectorAll('.htj-zz-card').forEach((n) => n.remove());

  ctx.eventSource.emit(ev.GENERATION_STARTED, 'normal', {}, false);
  ctx.eventSource.emit(ev.CHARACTER_MESSAGE_RENDERED, f, 'normal');

  const started = Date.now();
  let card = false;
  let img = false;
  while (Date.now() - started < 90000) {
    await new Promise((r) => setTimeout(r, 1000));
    card = !!node?.querySelector('.htj-zz-card');
    img = !!node?.querySelector('.htj-zz-card img');
    if (img) break;
  }
  return {
    floor: f,
    cardAppeared: card,
    imageInserted: img,
    waitedSec: Math.round((Date.now() - started) / 1000),
    mesLength: (ctx.chat[f].mes || '').length,
  };
}, floor);

console.log('\n=== 自动插图结果 ===');
console.log(JSON.stringify(result, null, 2));

console.log('\n=== 自动插图日志 ===');
for (const l of logs.filter((x) => /HTJ-ZZ/.test(x)).slice(-8)) console.log(l.slice(0, 180));

await page.screenshot({ path: 'diag-auto-illustrate.png' });

const ok = result.imageInserted;
console.log(`\n${ok ? 'PASS' : 'FAIL'}  自动插图:生成后图片自动挂到楼层`);
await browser.close();
process.exit(ok ? 0 : 1);
