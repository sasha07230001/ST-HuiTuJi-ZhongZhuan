// 真实浏览器诊断:打开 ST,抓控制台报错,点悬浮球开面板,截图 aria 快照。
// 用法: node scripts/diag-browser.mjs [url]
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://100.81.244.73:8000/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({ executablePath: EDGE, headless: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const logs = [];
const errors = [];
page.on('console', (msg) => {
  const text = msg.text();
  logs.push(`[${msg.type()}] ${text}`);
  if (msg.type() === 'error') errors.push(text);
});
page.on('pageerror', (err) => errors.push('PAGEERROR: ' + (err?.message || err)));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
// ST 启动较慢,等扩展初始化
await page.waitForTimeout(12000);

const state = await page.evaluate(() => {
  const orb = document.getElementById('htj-zz-orb');
  return {
    orbPresent: !!orb,
    orbRect: orb ? orb.getBoundingClientRect().toJSON() : null,
    settingsPanel: !!document.getElementById('htj-zz-settings'),
    floorButtons: document.querySelectorAll('.htj-zz-floor-btn').length,
    topbar: !!document.getElementById('htj-zz-topbar'),
    globalApi: typeof globalThis.htjZhongZhuan,
    chatFloors: document.querySelectorAll('#chat .mes').length,
    extensionScripts: [...document.querySelectorAll('script[src*="third-party"]')]
      .map((s) => s.src.split('/third-party/')[1])
      .filter(Boolean),
  };
});

console.log('=== 页面状态 ===');
console.log(JSON.stringify(state, null, 2));

console.log('\n=== 控制台里跟本插件有关的日志 ===');
for (const line of logs) {
  if (/htj|绘图姬|中转站/i.test(line)) console.log(line);
}

console.log('\n=== 错误 ===');
for (const e of errors.slice(0, 25)) console.log(e);

await page.screenshot({ path: 'diag-1-initial.png', fullPage: false });

// 点悬浮球(若存在),看面板
if (state.orbPresent) {
  await page.click('#htj-zz-orb');
  await page.waitForTimeout(800);
  const panelState = await page.evaluate(() => {
    const mask = document.getElementById('htj-zz-panel-mask');
    return {
      maskPresent: !!mask,
      maskDisplay: mask ? mask.style.display : null,
      panelHtmlLength: mask ? mask.innerHTML.length : 0,
      tabs: mask ? [...mask.querySelectorAll('.htj-zz-tab')].map((t) => t.textContent) : [],
      pages: mask ? [...mask.querySelectorAll('.htj-zz-page')].map((p) => ({
        tab: p.dataset.page,
        hidden: p.classList.contains('htj-zz-hide'),
        children: p.children.length,
        textLen: (p.textContent || '').trim().length,
      })) : [],
      firstPageText: mask ? (mask.querySelector('.htj-zz-page')?.textContent || '').trim().slice(0, 200) : '',
    };
  });
  console.log('\n=== 面板状态 ===');
  console.log(JSON.stringify(panelState, null, 2));
  await page.screenshot({ path: 'diag-2-panel.png', fullPage: false });
}

console.log('\n截图: diag-1-initial.png, diag-2-panel.png');
await browser.close();
