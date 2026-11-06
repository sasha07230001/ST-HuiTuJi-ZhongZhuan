// 在真实浏览器里跑一次「楼层出图」,抓出图前后 DOM/聊天数据的变化,
// 定位「ComfyUI 返图后不自动插入图片」到底断在哪一步。
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://100.81.244.73:8000/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({ executablePath: EDGE, headless: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + (e?.message || e)));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);

const before = await page.evaluate(() => {
  const ctx = window.SillyTavern?.getContext?.();
  const st = ctx?.extensionSettings?.htjZhongZhuan;
  return {
    chatLen: ctx?.chat?.length ?? 0,
    settings: st ? { relayUrl: st.relay?.url, model: st.relay?.model, hasKey: !!st.relay?.key, comfyUrl: st.comfy?.url, hasWorkflow: !!st.comfy?.workflow } : null,
    lastMesTail: (ctx?.chat?.[ctx.chat.length - 1]?.mes || '').slice(-160),
    hasApi: typeof globalThis.htjZhongZhuan,
  };
});
console.log('=== 出图前 ===');
console.log(JSON.stringify(before, null, 2));

if (!before.hasApi) {
  console.log('扩展未就绪,停止');
  await browser.close();
  process.exit(1);
}

// 跑最后一楼的出图
const floor = before.chatLen - 1;
console.log(`\n=== 对第 ${floor} 楼触发 generate() ===`);
const result = await page.evaluate(async (f) => {
  try {
    const rec = await globalThis.htjZhongZhuan.generate(f);
    return {
      ok: true,
      state: rec?.state,
      status: rec?.status,
      positive: (rec?.positive || '').slice(0, 160),
      hasImage: !!rec?.imageUrl,
      imagePrefix: (rec?.imageUrl || '').slice(0, 40),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}, floor);
console.log(JSON.stringify(result, null, 2));

await page.waitForTimeout(3000);

const after = await page.evaluate((f) => {
  const ctx = window.SillyTavern?.getContext?.();
  const mesNode = document.querySelector(`#chat .mes[mesid="${f}"]`);
  const mesText = mesNode?.querySelector('.mes_text');
  return {
    chatMesTail: (ctx?.chat?.[f]?.mes || '').slice(-200),
    hasPlaceholderInData: /<htj-zz-card/i.test(ctx?.chat?.[f]?.mes || ''),
    mesNodeFound: !!mesNode,
    cardInDom: !!mesNode?.querySelector('.htj-zz-card'),
    imgInCard: !!mesNode?.querySelector('.htj-zz-card img'),
    cardHtmlLen: mesNode?.querySelector('.htj-zz-card')?.innerHTML.length ?? 0,
    mesTextHasPlaceholder: /<htj-zz-card/i.test(mesText?.innerHTML || ''),
    mesTextTail: (mesText?.innerHTML || '').slice(-300),
  };
}, floor);
console.log('\n=== 出图后 ===');
console.log(JSON.stringify(after, null, 2));

console.log('\n=== 本插件相关日志 ===');
for (const l of logs) if (/htj|绘图姬|中转站|ComfyUI/i.test(l)) console.log(l.slice(0, 300));

await page.screenshot({ path: 'diag-3-after-gen.png', fullPage: false });
console.log('\n截图: diag-3-after-gen.png');
await browser.close();
