/**
 * UI 基础设施:原生 DOM 元素工厂 + 组件样式。
 *
 * 整个扩展不引前端框架——一个面板 + 一个球用不着 Vue 运行时。
 * 所有 DOM 构建都走这里的 el(),方便统一处理 class / text / 属性 / 子节点。
 */

type Attrs = Record<string, string | number | boolean | null | undefined>;

/** 创建元素。`text` 走 textContent(不解析 HTML),其余走 setAttribute。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** 只在第一次调用时把样式注入到 <head>。 */
const injected = new Set<string>();
export function ensureStyle(id: string, css: string): void {
  if (injected.has(id) || document.getElementById(id)) {
    injected.add(id);
    return;
  }
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.append(style);
  injected.add(id);
}

/** toastr 存在就用它,否则退回 console。 */
export function toast(message: string, kind: 'info' | 'success' | 'warning' | 'error' = 'info', title = '绘图姬·中转站'): void {
  const t = (window as unknown as { toastr?: Record<string, (msg: string, title: string) => void> }).toastr;
  const fn = t?.[kind] ?? t?.info;
  if (fn) fn.call(t, message, title);
  else console.log(`[${title}] ${message}`);
}

/** 面板/球共用样式:品牌色、卡片、按钮、排版,尽量复用 ST 的 CSS 变量以便跟随主题。 */
export const UI_CSS = `
.htj-zz-orb {
  position: fixed;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  cursor: grab;
  touch-action: none;
  user-select: none;
  color: #fff;
  background: linear-gradient(140deg, #7c5cff 0%, #ff5c9d 100%);
  box-shadow: 0 6px 18px rgba(124, 92, 255, .42), inset 0 1px 0 rgba(255, 255, 255, .35);
  transition: transform .18s ease, opacity .18s ease, box-shadow .18s ease;
  font-size: 0;
  pointer-events: auto;
}
.htj-zz-orb:hover,
.htj-zz-orb:focus-visible,
.htj-zz-orb.is-dragging {
  opacity: 1 !important;
  box-shadow: 0 8px 26px rgba(124, 92, 255, .6), inset 0 1px 0 rgba(255, 255, 255, .45);
}
.htj-zz-orb:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.htj-zz-orb:active { cursor: grabbing; }
.htj-zz-orb svg { width: 55%; height: 55%; pointer-events: none; }
.htj-zz-orb-badge {
  position: absolute;
  top: -2px; right: -2px;
  width: 10px; height: 10px;
  border-radius: 999px;
  background: #38d17a;
  border: 2px solid rgba(0,0,0,.35);
  pointer-events: none;
}
.htj-zz-orb.is-running .htj-zz-orb-badge { background: #ffb020; animation: htj-zz-pulse 1s ease-in-out infinite; }
@keyframes htj-zz-pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.35); opacity: .6; } }

.htj-zz-panel-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483001;
  background: rgba(8, 8, 14, .55);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.htj-zz-panel {
  width: min(920px, 100%);
  height: min(720px, 100%);
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  overflow: hidden;
  background: var(--SmartThemeBlurTintColor, #1b1b22);
  color: var(--SmartThemeBodyColor, #e8e8f0);
  border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.14));
  box-shadow: 0 24px 60px rgba(0,0,0,.55);
  font-size: 14px;
}
.htj-zz-panel-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.12));
  background: linear-gradient(90deg, rgba(124,92,255,.22), rgba(255,92,157,.14));
}
.htj-zz-panel-title { font-weight: 700; font-size: 15px; }
.htj-zz-panel-sub { opacity: .65; font-size: 12px; }
.htj-zz-panel-spacer { flex: 1; }
.htj-zz-tabs { display: flex; gap: 4px; padding: 8px 12px 0; border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.1)); }
.htj-zz-tab {
  border: none;
  background: transparent;
  color: inherit;
  opacity: .65;
  padding: 8px 14px;
  border-radius: 8px 8px 0 0;
  cursor: pointer;
  font-size: 13px;
}
.htj-zz-tab:hover { opacity: .9; background: rgba(255,255,255,.05); }
.htj-zz-tab.is-active { opacity: 1; background: rgba(124,92,255,.2); box-shadow: inset 0 -2px 0 #7c5cff; }
.htj-zz-panel-body { flex: 1; overflow-y: auto; padding: 16px; }
.htj-zz-panel-foot {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.12));
  font-size: 12px; opacity: .8;
}
.htj-zz-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.htj-zz-field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 180px; margin-bottom: 10px; }
.htj-zz-label { font-size: 12px; opacity: .75; }
.htj-zz-hint { font-size: 11px; opacity: .55; line-height: 1.5; }
.htj-zz-hide { display: none !important; }
.htj-zz-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.htj-zz-cardbox {
  border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.12));
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 14px;
  background: rgba(255,255,255,.03);
}
.htj-zz-cardbox h4 { margin: 0 0 10px; font-size: 13px; font-weight: 600; opacity: .9; }
.htj-zz-textarea { min-height: 150px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre; }
.htj-zz-canvas {
  display: flex; align-items: center; justify-content: center;
  min-height: 260px;
  border: 1px dashed var(--SmartThemeBorderColor, rgba(255,255,255,.18));
  border-radius: 12px;
  margin-bottom: 12px;
  padding: 12px;
  overflow: hidden;
}
.htj-zz-canvas img { max-width: 100%; max-height: 460px; border-radius: 10px; display: block; }
.htj-zz-canvas-empty { opacity: .45; font-size: 13px; text-align: center; line-height: 1.7; }
.htj-zz-promptbox { display: flex; flex-direction: column; gap: 8px; }
.htj-zz-promptbox textarea { min-height: 84px; font-size: 12px; }
.htj-zz-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.htj-zz-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(124,92,255,.25); }
@media (max-width: 640px) {
  .htj-zz-panel-mask { padding: 0; }
  .htj-zz-panel { width: 100%; height: 100%; border-radius: 0; }
  .htj-zz-grid2 { grid-template-columns: 1fr; }
}
`;
