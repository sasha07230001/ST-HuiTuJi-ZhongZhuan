// 在真实浏览器里验证两项新功能:
// 1. 剧情范围:配了标签后,送进中转站的只有标签里的内容
// 2. 自动插图:生成事件 → 自动出图 → 图挂到楼层
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://100.81.244.73:8000/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({ executablePath: EDGE, headless: false });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));

await page.goto(URL + '?v=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(15000);

// ---- 1. 剧情范围 ----
const scopeCheck = await page.evaluate(async () => {
  const ctx = window.SillyTavern.getContext();
  const story = [
    '<thought>这里是很长的思维链,不应该被当成画面内容</thought>',
    '<content>她站在雨里,长发被淋湿,霓虹灯在湿漉漉的地面映出倒影。</content>',
    '<StatusPlaceHolderImpl/>',
  ].join('\n');

  // 直接验证模块行为:设置范围后编译请求里应只出现 content 里的字
  const before = ctx.extensionSettings.htjZhongZhuan;
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
    // 不真发请求,直接给个假回复,专测「送进去的正文是什么」
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '1girl, silver hair, rain, neon city' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    // 配好范围
    ctx.extensionSettings.htjZhongZhuan.storyScope.tags = ['content'];
    ctx.extensionSettings.htjZhongZhuan.storyScope.pick = 'last';
    // 用一个不存在于聊天里的 floor,靠 story 参数直接喂正文
    await window.htjZhongZhuan.generateWithStory(story);
  } catch (e) {
    return { error: String(e?.message || e) };
  } finally {
    window.fetch = origFetch;
    ctx.extensionSettings.htjZhongZhuan = before;
  }

  const sent = captured.join('\n');
  return {
    captured: captured.length,
    sentHasStoryBlock: sent.includes('她站在雨里'),
    sentHasThought: sent.includes('思维链'),
    sentHasStatusTag: sent.includes('StatusPlaceHolderImpl'),
    sampleLen: sent.length,
  };
});

console.log('=== 剧情范围 ===');
console.log(JSON.stringify(scopeCheck, null, 2));

// ---- 2. 自动插图 ----
const autoCheck = await page.evaluate(async () => {
  const ctx = window.SillyTavern.getContext();
  const before = ctx.extensionSettings.htjZhongZhuan;
  ctx.extensionSettings.htjZhongZhuan.autoRun = true;

  const floor = ctx.chat.length - 1;
  const ev = ctx.eventTypes;
  // 模拟一次真实生成的完整事件序列
  ctx.eventSource.emit(ev.GENERATION_STARTED, 'normal', {}, false);
  ctx.eventSource.emit(ev.CHARACTER_MESSAGE_RENDERED, floor, 'normal');

  await new Promise((r) => setTimeout(r, 25000));

  const node = document.querySelector(`#chat .mes[mesid="${floor}"]`);
  const result = {
    floor,
    autoRunEnabled: true,
    cardInDom: !!node?.querySelector('.htj-zz-card'),
    imgInCard: !!node?.querySelector('.htj-zz-card img'),
    bodyStillIntact: (ctx.chat[floor].mes || '').length,
  };
  ctx.extensionSettings.htjZhongZhuan = before;
  return result;
});

console.log('\n=== 自动插图 ===');
console.log(JSON.stringify(autoCheck, null, 2));

console.log('\n=== 自动插图日志 ===');
for (const l of logs.filter((x) => /HTJ-ZZ|剧情范围/.test(x)).slice(-12)) console.log(l.slice(0, 200));

await page.screenshot({ path: 'diag-auto.png' });
await browser.close();
