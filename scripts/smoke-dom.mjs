// 在 jsdom 里模拟 SillyTavern 宿主,真实加载 dist/index.js,确认 boot() 不抛异常、
// 设置面板与楼层按钮确实被挂上。用法: node scripts/smoke-dom.mjs
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

// ---- 模拟 ST 宿主 ----
const listeners = {};
const chat = [
  { name: 'You', is_user: true, is_system: false, mes: '你好' },
  { name: 'AI', is_user: false, is_system: false, mes: '她站在雨里，抬头看着霓虹灯。', swipe_id: 0 },
];
window.SillyTavern = {
  getContext: () => ({
    chat,
    chatMetadata: {},
    name1: 'You',
    name2: 'AI',
    getCurrentChatId: () => 'test-chat',
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'x' }),
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
    extensionSettings: {},
    eventSource: {
      on: (event, handler) => {
        (listeners[event] ??= []).push(handler);
      },
    },
    eventTypes: {
      GENERATION_STARTED: 'generation_started',
      GENERATION_STOPPED: 'generation_stopped',
      CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
      CHAT_CHANGED: 'chat_changed',
      MESSAGE_EDITED: 'message_edited',
    },
  }),
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
// 把 jsdom 的 window/document 装到 Node 的 globalThis 上,再用 Node 的模块加载器
// 加载真实文件。等价于「浏览器里裸 `document` 解析到 window.document」:
// 模块里任何裸全局引用都会命中 jsdom,而不是 Node 的空全局。
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
check('启动日志出现版本号', logs.some((l) => l.includes('已加载')));
// 模块在 Node 侧求值,globalThis 即 Node 的 global;浏览器里两者本就是同一个对象。
check('全局入口 htjZhongZhuan 存在', typeof globalThis.htjZhongZhuan === 'object' && !!globalThis.htjZhongZhuan?.generate);

// ---- 悬浮球 ----
const orb = window.document.getElementById('htj-zz-orb');
check('悬浮球已挂载', !!orb);
check('悬浮球有可点击语义', orb?.getAttribute('role') === 'button' && orb?.getAttribute('tabindex') === '0');
check('悬浮球默认可视(fixed 定位)', orb?.style.position === '' && getComputedStyleSafe(orb, 'position') !== 'none');

// ---- 面板:点击悬浮球 → 打开 ----
if (orb) {
  orb.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  orb.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }));
}
await new Promise((r) => setTimeout(r, 50));
const mask = window.document.getElementById('htj-zz-panel-mask');
check('点击悬浮球打开面板', !!mask && mask.style.display !== 'none');
check('面板有三个页签', (mask?.querySelectorAll('.htj-zz-tab').length ?? 0) === 3);
check('出图页可见', !!mask?.querySelector('.htj-zz-page[data-page="render"], .htj-zz-page'));
check('面板打开时悬浮球被隐藏', orb?.style.display === 'none');

// 页签切换
const tabs = [...(mask?.querySelectorAll('.htj-zz-tab') ?? [])];
const channelTab = tabs.find((t) => t.dataset.tab === 'channel');
channelTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 30));
check('切到渠道页:出现 ComfyUI 地址输入', !!channelTab?.classList.contains('is-active'));
check('渠道页有工作流文本框', !!window.document.querySelector('.htj-zz-textarea'));

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
