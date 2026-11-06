// 验证「出图不再破坏正则面板」:
// 1. 出图前记录楼层 DOM 里正则产物的形态
// 2. 触发 generate()
// 3. 出图后再看同样的产物是否还在(而不是变成源码文本)
// 并检查 message.mes 没被写脏。
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://100.81.244.73:8000/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({ executablePath: EDGE, headless: false });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(15000);

const snapshot = () =>
  page.evaluate(() => {
    const ctx = window.SillyTavern?.getContext?.();
    const floor =
      [...(ctx?.chat || [])].map((m, i) => ({ m, i })).filter(({ m }) => m && !m.is_user).pop()?.i ?? -1;
    const node = document.querySelector(`#chat .mes[mesid="${floor}"]`);
    const text = node?.querySelector('.mes_text');
    const html = text?.innerHTML || '';
    const raw = ctx?.chat?.[floor]?.mes || '';
    return {
      floor,
      mesHasPlaceholder: /<htj-zz-card/i.test(raw),
      mesLength: raw.length,
      domHasIframe: (node?.querySelectorAll('iframe').length ?? 0),
      domHasCard: !!node?.querySelector('.htj-zz-card'),
      domHasCardImg: !!node?.querySelector('.htj-zz-card img'),
      // 正则产物:美化面板通常渲染成 iframe 或带样式的容器
      domHasStyledPanel: /\b(scene|panel|status|choices)\b/i.test(html) && html.length > 2000,
      // 退化成源码的特征:正文里出现 <sumUp>/<choices> 之类原始标签文本
      showsRawTags: /&lt;sumUp&gt;|&lt;choices&gt;|<sumUp>|<choices>/i.test(html),
      textTail: html.slice(-220).replace(/\s+/g, ' '),
    };
  });

const before = await snapshot();
console.log('=== 出图前 ===');
console.log(JSON.stringify(before, null, 2));

const result = await page.evaluate(async (f) => {
  try {
    const rec = await globalThis.htjZhongZhuan.generate(f);
    return { ok: true, state: rec?.state, hasImage: !!rec?.imageUrl, status: rec?.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}, before.floor);
console.log('\n=== 生成结果 ===');
console.log(JSON.stringify(result, null, 2));

await page.waitForTimeout(2500);
const after = await snapshot();
console.log('\n=== 出图后 ===');
console.log(JSON.stringify(after, null, 2));

const checks = [
  ['正文未被写入占位符', after.mesHasPlaceholder === false],
  ['正文长度未变(未被改写)', after.mesLength === before.mesLength],
  ['没退化成源码标签', after.showsRawTags === false],
  ['图片已插入楼层', after.domHasCardImg === true],
];
console.log('\n=== 判定 ===');
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
console.log(bad === 0 ? '\nALL PASS' : `\nFAILURES: ${bad}`);

await page.screenshot({ path: 'diag-render-check.png' });
await browser.close();
process.exit(bad === 0 ? 0 : 1);
