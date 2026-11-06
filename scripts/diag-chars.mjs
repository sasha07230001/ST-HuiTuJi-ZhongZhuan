// 验证角色档案全链路:面板 UI → 导入 → 档案生效 → 拼进出图提示词
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://100.81.244.73:8000/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({ executablePath: EDGE, headless: false });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));

await page.goto(URL + '?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(16000);

// 切到角色档案页
await page.evaluate(() => globalThis.htjZhongZhuan.openPanel('chars'));
await page.waitForSelector('#htj-zz-panel-mask', { timeout: 10000 });
await page.waitForTimeout(500);

const tabCheck = await page.evaluate(() => {
  const mask = document.getElementById('htj-zz-panel-mask');
  const tabs = [...mask.querySelectorAll('.htj-zz-tab')].map((t) => t.textContent);
  const charsPage = mask.querySelector('.htj-zz-page[data-page="chars"]');
  return {
    tabs,
    charsPageVisible: !!charsPage && !charsPage.classList.contains('htj-zz-hide'),
    hasImportBtn: !!(charsPage && [...charsPage.querySelectorAll('button')].some((b) => b.textContent.includes('从酒馆导入'))),
    hasNewBtn: !!(charsPage && [...charsPage.querySelectorAll('button')].some((b) => b.textContent.includes('新建角色'))),
  };
});
console.log('=== 角色档案页 ===');
console.log(JSON.stringify(tabCheck, null, 2));

// 扫描导入源
const scanned = await page.evaluate(async () => {
  const mask = document.getElementById('htj-zz-panel-mask');
  const pageEl = mask.querySelector('.htj-zz-page[data-page="chars"]');
  const btn = [...pageEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '扫描');
  if (!btn) return { ok: false, reason: 'no scan button' };
  btn.click();
  const start = Date.now();
  while (Date.now() - start < 20000) {
    await new Promise((r) => setTimeout(r, 500));
    if ([...pageEl.querySelectorAll('.htj-zz-importrow')].length > 0) break;
  }
  const rows = [...pageEl.querySelectorAll('.htj-zz-importrow')].map((r) => r.textContent.trim().slice(0, 90));
  return { ok: true, count: rows.length, rows };
});
console.log('\n=== 导入扫描 ===');
console.log(JSON.stringify(scanned, null, 2).slice(0, 1200));

// 导入一个角色,再验证它进了库
const imported = await page.evaluate(() => {
  const mask = document.getElementById('htj-zz-panel-mask');
  const pageEl = mask.querySelector('.htj-zz-page[data-page="chars"]');
  const confirm = [...pageEl.querySelectorAll('button')].find((b) => b.textContent.includes('导入选中'));
  if (!confirm) return { ok: false, reason: 'no confirm button' };
  confirm.click();
  const lib = window.SillyTavern.getContext().extensionSettings.htjZhongZhuan.chars?.entries || [];
  return { ok: true, count: lib.length, names: lib.map((e) => e.name), sample: lib[0] && { name: lib[0].name, rawLen: (lib[0].raw || '').length } };
});
console.log('\n=== 导入结果 ===');
console.log(JSON.stringify(imported, null, 2).slice(0, 900));

// 验证拼进提示词:拦截发往 ComfyUI 的工作流
const merged = await page.evaluate(async (charName) => {
  const ctx = window.SillyTavern.getContext();
  const lib = ctx.extensionSettings.htjZhongZhuan.chars.entries || [];
  const entry = lib.find((e) => e.name === charName) || lib[0];
  if (!entry) return { ok: false, reason: 'library empty' };

  const captured = [];
  const origFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (/chat-completions\/generate/.test(url) && init?.body) {
      try {
        const body = JSON.parse(init.body);
        captured.push({ kind: 'relay', text: (body.messages || []).map((m) => m.content).join('\n') });
      } catch { /* ignore */ }
      return new Response(JSON.stringify({ choices: [{ message: { content: '1girl, rain, neon city' } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (/\/prompt$/.test(url) && init?.body) {
      try {
        const body = JSON.parse(init.body);
        captured.push({ kind: 'comfy', text: JSON.stringify(body) });
      } catch { /* ignore */ }
      return new Response(JSON.stringify({ prompt_id: 'fake-id' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (/\/history\//.test(url)) {
      return new Response(JSON.stringify({ 'fake-id': { status: { completed: true }, outputs: { 9: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (/\/view\?/.test(url)) {
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    return origFetch(input, init);
  };

  try {
    await globalThis.htjZhongZhuan.generateWithStory(`她站在雨里,${entry.name}抬头看着霓虹灯。`);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    window.fetch = origFetch;
  }

  const comfy = captured.filter((c) => c.kind === 'comfy').map((c) => c.text).join('\n');
  const sample = (entry.raw || '').split(',')[0]?.trim() || entry.fields?.hair || '';
  return {
    ok: true,
    charName: entry.name,
    sampleTag: sample,
    comfyHasCharTag: sample ? comfy.includes(sample) : null,
    comfyLen: comfy.length,
  };
}, imported.names?.[0] || '');

console.log('\n=== 角色外貌是否拼进出图提示词 ===');
console.log(JSON.stringify(merged, null, 2).slice(0, 900));

console.log('\n=== 插件日志 ===');
for (const l of logs.filter((x) => /绘图姬|角色|档案/.test(x)).slice(-8)) console.log(l.slice(0, 180));

await page.screenshot({ path: 'diag-chars.png' });
await browser.close();

const pass = tabCheck.charsPageVisible && imported.ok && (imported.count > 0) && (merged.ok && merged.comfyHasCharTag !== false);
console.log(`\n${pass ? 'ALL PASS' : 'FAILURES'}`);
process.exit(pass ? 0 : 1);
