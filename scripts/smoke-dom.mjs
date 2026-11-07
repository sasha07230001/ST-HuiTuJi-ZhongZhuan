// 在 jsdom 里模拟 SillyTavern 宿主,真实加载 dist/index.js,确认 boot() 不抛异常、
// 设置面板 / 楼层按钮 / 悬浮球 / 面板 / 自动插图 都真的工作。
// 用法: node scripts/smoke-dom.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = fs.readFileSync(path.join(ROOT, 'dist/index.js'), 'utf8');

const dom = new JSDOM(
  `<!DOCTYPE html><html><head></head><body>
     <div id="chat">
       <div class="mes" mesid="0"><div class="mes_text">用户：你好</div><div class="mes_buttons"></div></div>
       <div class="mes" mesid="1"><div class="mes_text">她站在雨里，抬头看着霓虹灯。</div><div class="mes_buttons"></div></div>
     </div>
     <div id="extensions_settings2"></div>
     <div id="extensionsMenu"></div>
   </body></html>`,
  { url: 'http://127.0.0.1:8000/', runScripts: 'outside-only', pretendToBeVisual: true },
);

const { window } = dom;

// ---- 模拟 ST 宿主(必须是同一个对象:getSettings 每次读实时值) ----
const listeners = {};
const chat = [
  { name: 'You', is_user: true, is_system: false, mes: '你好' },
  { name: 'AI', is_user: false, is_system: false, mes: '她站在雨里，抬头看着霓虹灯。', swipe_id: 0 },
];

const extensionSettings = {
  htjZhongZhuan: {
    // 预置一条固定档案 + 一条临时档案:角色档案页要能把两层都显示出来
    chars: {
      entries: [
        {
          name: '苏白粥',
          raw: '1girl, silver hair, white dress',
          fields: {},
          nl: '',
          source: 'manual',
          enabled: true,
          note: '',
          updatedAt: Date.now(),
        },
      ],
      transients: [
        {
          name: '苏白粥',
          raw: 'black lace bra, black lace panties',
          fields: {},
          chatId: 'test-chat',
          floor: 1,
          replace: true,
          frozen: false,
          sig: '',
          updatedAt: Date.now(),
        },
      ],
    },
  },
};

const ctxObject = {
  chat,
  chatMetadata: {},
  name1: 'You',
  name2: 'AI',
  getCurrentChatId: () => 'test-chat',
  getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'x' }),
  saveChat: async () => {},
  saveSettingsDebounced: () => {},
  extensionSettings,
  eventSource: {
    on: (event, handler) => {
      (listeners[event] ??= []).push(handler);
    },
  },
  eventTypes: {
    GENERATION_STARTED: 'generation_started',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_ENDED: 'generation_ended',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    CHAT_CHANGED: 'chat_changed',
    MESSAGE_EDITED: 'message_edited',
  },
};

window.SillyTavern = { getContext: () => ctxObject };

const emit = (event, ...args) => {
  for (const handler of listeners[event] ?? []) handler(...args);
};

// 刻意**不提供** window.$ / window.jQuery —— 用来验证扩展不依赖 jQuery 的加载顺序。
window.toastr = { info: () => {}, success: () => {}, warning: () => {}, error: () => {} };

// 记录 console 输出与未捕获错误
const logs = [];
const errors = [];
const origLog = console.log;
const origErr = console.error;

/** Node 自身的运行时提示(与插件无关)不算失败。 */
const isNoise = (text) =>
  /ExperimentalWarning|--localstorage-file|--trace-warnings|trace-deprecation/i.test(text);

console.log = (...a) => { logs.push(a.join(' ')); origLog(...a); };
console.info = (...a) => { const line = a.join(' '); logs.push(line); origLog(line); };
console.error = (...a) => {
  const line = a.join(' ');
  if (!isNoise(line)) errors.push(line);
  origErr(...a);
};
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + e.reason));
process.on('warning', (w) => {
  if (!isNoise(String(w?.name || w?.message))) errors.push('process.warning: ' + (w?.message || w));
});

// ---- 真实执行 bundle(作为 ES module) ----
const tmpModule = path.join(ROOT, '.smoke-bundle.mjs');
fs.writeFileSync(tmpModule, bundle, 'utf8');

for (const key of [
  'window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'HTMLButtonElement', 'Node', 'Element', 'CustomEvent', 'Event',
  'MutationObserver', 'DOMException', 'AbortController', 'AbortSignal', 'URL', 'URLSearchParams',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
]) {
  if (key in window && !(key in globalThis)) {
    globalThis[key] = window[key];
  }
}
globalThis.window = window;
globalThis.document = window.document;

try {
  await import(pathToFileURL(tmpModule).href);
} catch (error) {
  errors.push('bundle 加载失败: ' + (error?.message || error));
}

// 等 boot() 里的 waitForContext + 各 setTimeout(60ms/200ms)落地
await new Promise((r) => setTimeout(r, 800));

// ---- 断言 ----
const results = [];
const check = (label, ok) => results.push({ label, ok });
check('设置面板已挂载', !!window.document.getElementById('htj-zz-settings'));
check('顶栏菜单按钮已注入', !!window.document.getElementById('htj-zz-topbar'));
const floorBtnCount = window.document.querySelectorAll('.htj-zz-floor-btn').length;
check(`楼层绘图按钮已注入(${floorBtnCount} 个)`, floorBtnCount > 0);
check('已绑定 ST 渲染事件', (listeners['character_message_rendered'] ?? []).length > 0);
check('已绑定生成结束事件(自动插图兜底)', (listeners['generation_ended'] ?? []).length > 0);
check('启动日志出现版本号', logs.some((l) => l.includes('已加载')));
check('全局入口 htjZhongZhuan 存在', typeof globalThis.htjZhongZhuan === 'object' && !!globalThis.htjZhongZhuan?.generate);

// ---- 移动端适配:样式里必须真的有满屏 + dvh + 大触摸目标 ----
const styleText = [...window.document.querySelectorAll('style')].map((n) => n.textContent).join('\n');
check('样式含移动端断点', styleText.includes('max-width: 720px'));
check('面板高度用 dvh(地址栏伸缩不漏底)', styleText.includes('100dvh'));
check('移动端输入框 16px(防 iOS 自动放大)', /font-size:\s*16px/.test(styleText));
check('安全区内边距', styleText.includes('safe-area-inset-bottom'));
check('触摸设备放大悬浮球', styleText.includes('(hover: none)'));

// ---- 悬浮球 ----
const orb = window.document.getElementById('htj-zz-orb');
check('悬浮球已挂载', !!orb);
check('悬浮球有可点击语义', orb?.getAttribute('role') === 'button' && orb?.getAttribute('tabindex') === '0');

// ---- 面板:点击悬浮球 → 打开,且不被同一次点击的兼容鼠标事件关掉 ----
if (orb) {
  orb.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  orb.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }));
}
await new Promise((r) => setTimeout(r, 50));
const mask = window.document.getElementById('htj-zz-panel-mask');
check('点击悬浮球打开面板', !!mask && mask.style.display !== 'none');

// 回归:触摸设备在 pointerup 后会补发一套兼容鼠标事件,目标是刚铺满屏幕的遮罩。
if (mask) {
  mask.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  mask.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
}
await new Promise((r) => setTimeout(r, 30));
check('刚打开时的兼容鼠标事件不会把面板关掉', !!window.document.getElementById('htj-zz-panel-mask'));

const tabCount = mask?.querySelectorAll('.htj-zz-tab').length ?? 0;
check(`面板有五个页签(出图/图库/渠道/角色档案/提示词),实得 ${tabCount}`, tabCount === 5);
check('出图页可见', !!mask?.querySelector('.htj-zz-page[data-page="render"]'));

// 出图页:张数 / 分段标记 / 分段预览
const renderPage = window.document.querySelector('.htj-zz-page[data-page="render"]');
check('出图页有「出几张」输入', !!renderPage?.querySelector('input[type=number][max]'));
check('出图页有分段预览', (renderPage?.querySelectorAll('.htj-zz-segment-row').length ?? 0) > 0);

// 页签切换
const tabs = [...(mask?.querySelectorAll('.htj-zz-tab') ?? [])];
const channelTab = tabs.find((t) => t.dataset.tab === 'channel');
channelTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 30));
check('切到渠道页', !!channelTab?.classList.contains('is-active'));
check('渠道页有工作流文本框', !!window.document.querySelector('.htj-zz-textarea'));

// 图库页
const galleryTab = tabs.find((t) => t.dataset.tab === 'gallery');
galleryTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
check('图库页已切换', !!galleryTab?.classList.contains('is-active'));
check('图库页有容器', !!window.document.querySelector('.htj-zz-page[data-page="gallery"] .htj-zz-gallery'));

// 提示词页:恒定词保存按钮
const promptTab = tabs.find((t) => t.dataset.tab === 'prompt');
promptTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 30));
const promptPage = window.document.querySelector('.htj-zz-page[data-page="prompt"]');
const promptText = promptPage?.textContent ?? '';
check('恒定画风词有保存按钮', promptText.includes('保存恒定画风词'));
check('恒定负面词有保存按钮', promptText.includes('保存恒定负面词'));
check('标出「前置」', promptText.includes('正向前置'));
check('有最终提示词示例(证明前置生效)', promptText.includes('最终正向示例'));
const expectHead = extensionSettings.htjZhongZhuan?.prompt?.styleSuffix;
check('画风词确实排在最终正向最前面', (() => {
  const example = [...(promptPage?.querySelectorAll('.htj-zz-prompt-preview div') ?? [])][0]?.textContent ?? '';
  const body = example.replace('最终正向示例:', '').trim();
  // 默认画风词的第一段应该是整串开头
  return body.startsWith('masterpiece') || (!!expectHead && body.startsWith(String(expectHead).split(',')[0].trim()));
})());

// 角色档案页(靠预置 extensionSettings 渲染)
const charsTab = tabs.find((t) => t.dataset.tab === 'chars');
charsTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
check('角色档案页已切换', !!charsTab?.classList.contains('is-active'));
const charsPage = window.document.querySelector('.htj-zz-page[data-page="chars"]');
const charsText = charsPage?.textContent ?? '';
check('角色档案页有「临时档案(此刻的状态)」区块', charsText.includes('临时档案(此刻的状态)'));
check('临时档案有「全部清空」入口', charsText.includes('全部清空'));
check('临时档案条目显示在列表里', charsText.includes('black lace bra, black lace panties'));

// ---- 自动插图:生成开始 → 最终渲染 → 必须真的把任务排进去 ----
extensionSettings.htjZhongZhuan.autoRun = true;
const before = logs.length;
emit('generation_started', 'normal', {}, false);
emit('character_message_rendered', 1, 'normal');
await new Promise((r) => setTimeout(r, 120));
const autoLogs = logs.slice(before).join('\n');
check('自动插图收到生成事件并排了任务', autoLogs.includes('[HTJ-ZZ][auto] schedule'));
check(
  '自动插图识别出「配置不齐」而不是静默什么都不做',
  autoLogs.includes('not-configured') || autoLogs.includes('配置不齐'),
);

// 生成结束兜底:即使渲染事件没带 type,也要能补跑
const before2 = logs.length;
emit('generation_started', 'normal', {}, false);
emit('generation_ended', 1);
await new Promise((r) => setTimeout(r, 120));
check('生成结束时能兜底排任务', logs.slice(before2).join('\n').includes('generation-ended'));

// 渲染事件完全不带 type(实测踩到的那个版本):以前会被判成「不是这次生成」
const before3 = logs.length;
emit('generation_started', 'normal', {}, false);
emit('character_message_rendered', 1, undefined);
await new Promise((r) => setTimeout(r, 120));
check('渲染事件不带 type 也照样开跑', logs.slice(before3).join('\n').includes('why":"rendered'));

// 渲染事件压根不发:靠聊天变长观察兜底
const before4 = logs.length;
emit('generation_started', 'normal', {}, false);
chat.push({ name: 'AI', is_user: false, is_system: false, mes: '她抬手擦去脸上的雨水，霓虹在瞳孔里碎成一整片。', swipe_id: 0 });
await new Promise((r) => setTimeout(r, 1600));
check('渲染事件不发时靠聊天变长兜底', logs.slice(before4).join('\n').includes('content-grew'));

// 自动插图从未真的跑起来(配置不齐) → 面板的恒定词横幅要说明「事件已绑定」
const constBarText = window.document.querySelector('.htj-zz-constbar')?.textContent ?? '';
check('出图页有恒定词横幅', constBarText.includes('正向最前'));
check('横幅显示自动插图绑定状态', constBarText.includes('事件已绑定'));
check('全局 autoState 可查绑定/失败原因', (() => {
  const st = globalThis.htjZhongZhuan?.autoState?.();
  return !!st && st.bound === true && typeof st.lastError === 'string';
})());

// Esc 关闭
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await new Promise((r) => setTimeout(r, 30));
check('Esc 关闭面板', !window.document.getElementById('htj-zz-panel-mask'));
check('关闭后悬浮球恢复显示', orb?.style.display !== 'none');

function getComputedStyleSafe(node, prop) {
  try {
    return node ? window.getComputedStyle(node)[prop] : '';
  } catch {
    return '';
  }
}

if (window.__htjLoadError) errors.push('bundle 加载失败: ' + window.__htjLoadError);

origLog('\n=== 冒烟测试结果 ===');
for (const r of results) origLog(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}`);

if (errors.length) {
  origLog('\n=== 捕获到的错误 ===');
  for (const e of errors.slice(0, 10)) origLog(e);
}

const failed = results.filter((r) => !r.ok).length + errors.length;
fs.rmSync(tmpModule, { force: true });
origLog(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failed}`);
process.exit(failed === 0 ? 0 : 1);
