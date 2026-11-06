// 通过**面板 UI**验证剧情范围与自动插图(而不是直接改内部对象)。
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://100.81.244.73:8000/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({ executablePath: EDGE, headless: false });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));

await page.goto(URL + '?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(15000);

// 打开面板 → 提示词页(openPanel 会同步构建 DOM,给一帧稳定)
await page.evaluate(() => globalThis.htjZhongZhuan.openPanel('prompt'));
await page.waitForSelector('#htj-zz-panel-mask', { timeout: 10000 });
await page.waitForTimeout(400);

// 面板里剧情范围输入框存在吗
const hasScopeUI = await page.evaluate(() => {
  const mask = document.getElementById('htj-zz-panel-mask');
  const text = mask?.textContent || '';
  const labels = [...(mask?.querySelectorAll('.htj-zz-label') || [])].map((n) => n.textContent);
  return { hasScopeSection: text.includes('剧情范围'), labels: labels.filter((l) => /范围|块/.test(l)) };
});
console.log('=== 面板剧情范围 UI ===');
console.log(JSON.stringify(hasScopeUI, null, 2));

// 通过 UI 写入范围标签
const wrote = await page.evaluate(() => {
  const mask = document.getElementById('htj-zz-panel-mask');
  const fields = [...mask.querySelectorAll('.htj-zz-field')];
  const target = fields.find((f) => (f.textContent || '').includes('范围标签'));
  const input = target?.querySelector('input');
  if (!input) return { ok: false };
  input.value = 'content';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const s = window.SillyTavern.getContext().extensionSettings.htjZhongZhuan;
  return { ok: true, saved: s.storyScope || null };
});
console.log('\n=== 通过 UI 写入范围标签 ===');
console.log(JSON.stringify(wrote, null, 2));

// 范围是否生效:拦截发往中转站的请求
const scopeEffect = await page.evaluate(async () => {
  const story = [
    '<thought>很长的思维链,不应进画面</thought>',
    '<content>她站在雨里,长发湿透,霓虹映在积水里。</content>',
    '<StatusPlaceHolderImpl/>',
  ].join('\n');

  const captured = [];
  const origFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (url.includes('chat-completions/generate') && init?.body) {
      try {
        const body = JSON.parse(init.body);
        captured.push((body.messages || []).map((m) => m.content).join('\n'));
      } catch { /* ignore */ }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '1girl, rain, neon city' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await globalThis.htjZhongZhuan.generateWithStory(story);
  } finally {
    window.fetch = origFetch;
  }
  const sent = captured.join('\n');
  return {
    calls: captured.length,
    hasStory: sent.includes('她站在雨里'),
    hasThought: sent.includes('思维链'),
    hasStatusTag: sent.includes('StatusPlaceHolderImpl'),
  };
});
console.log('\n=== 剧情范围是否生效(看实际发给中转站的正文)===');
console.log(JSON.stringify(scopeEffect, null, 2));

await browser.close();
