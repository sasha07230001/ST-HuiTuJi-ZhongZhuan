// 定位:到底是「调 updateMessageBlock」还是别的步骤让正则 iframe 消失。
import { chromium } from 'playwright';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({ executablePath: EDGE, headless: false });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://100.81.244.73:8000/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15000);

const r = await page.evaluate(() => {
  const ctx = window.SillyTavern.getContext();
  const msgs = ctx.chat.map((m, i) => ({
    i,
    isUser: m.is_user,
    len: (m.mes || '').length,
    hasTag: /<htj-zz-card/i.test(m.mes || ''),
  }));
  const target = msgs.filter((m) => !m.isUser).pop();
  const sel = '#chat .mes[mesid="' + target.i + '"]';
  const node = document.querySelector(sel);
  const count = () => node?.querySelectorAll('iframe').length ?? 0;

  const before = count();
  ctx.updateMessageBlock(target.i, ctx.chat[target.i]);
  const afterUpdate = count();

  return { messages: msgs, floor: target.i, before, afterUpdate, mesHasLegacyTag: target.hasTag };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
