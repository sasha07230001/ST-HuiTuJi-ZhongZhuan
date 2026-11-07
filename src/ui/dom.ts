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

/**
 * 把「恒定画风词 / 恒定负面词」写进工作流模板。
 *
 * 为什么需要它:用户的工作流往往把提示词写死在自己那份 JSON 里(比如
 * `"text": "masterpiece, 1girl, %prompt%"`),而恒定词以前只在运行时拼到
 * 提示词前面——切到 ComfyUI 原生界面看,工作流里根本没有这两个词。
 * 这个函数直接改**模板本身**(写进设置里的 comfy.workflow),让 ComfyUI 里
 * 看到的也是同一份前置词。
 *
 * 规则(与运行时合成顺序保持一致):
 * - 模板里有 %prompt% → 写成「画风词, %prompt%」(幂等:上次写过的同一串不会再叠一层);
 * - 没有 `%prompt%`(定位式) → 找 CLIP 节点:第一个非空的当正向,其余当负面;
 * - 负面同理,用 `%negative_prompt%` 或其余 CLIP 节点。
 *
 * 只动 CLIP 文本,模型/采样器/LoRA 一个字节都不碰。
 */
export function applyConstantWordsToWorkflow(
  template: string,
  positiveHead: string,
  negativeHead: string,
): { ok: boolean; changed: boolean; message: string; template: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(template) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      changed: false,
      template,
      message: `工作流不是合法 JSON:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    return { ok: false, changed: false, template, message: '工作流是空的,先在「渠道」页粘一份 Save (API Format) 导出' };
  }

  const head = String(positiveHead ?? '').trim();
  const negHead = String(negativeHead ?? '').trim();

  /** 恒定词永远排在模板最前面;上次写过的同一串不再叠一层。 */
  const withHead = (value: string, words: string): string => {
    if (!words) return value;
    if (value.trim().toLowerCase().startsWith(words.toLowerCase())) return value;
    return `${words}, ${value}`;
  };

  let changed = false;
  const clipNodes: Array<{ id: string; text: string; filled: boolean }> = [];

  for (const [id, node] of Object.entries(parsed)) {
    if (!node || typeof node !== 'object') continue;
    const n = node as { class_type?: unknown; inputs?: Record<string, unknown> };
    if (!n.inputs || typeof n.inputs !== 'object') continue;
    if (typeof n.class_type !== 'string' || !/clip(text)?encode|textencod/i.test(n.class_type)) continue;
    const text = n.inputs.text;
    if (typeof text !== 'string') continue;
    clipNodes.push({ id, text, filled: !!text.trim() });
  }

  // 1) 占位符式:直接改模板里带 %prompt% / %negative_prompt% 的那几个节点
  for (const name of ['prompt', 'negative_prompt'] as const) {
    const marker = `%${name}%`;
    let hit = false;
    for (const [id, node] of Object.entries(parsed)) {
      if (!node || typeof node !== 'object') continue;
      const n = node as { inputs?: Record<string, unknown> };
      if (!n.inputs || typeof n.inputs !== 'object') continue;
      const text = n.inputs.text;
      if (typeof text !== 'string' || !text.includes(marker)) continue;
      const next = withHead(text, name === 'prompt' ? head : negHead);
      if (next !== text) {
        n.inputs.text = next;
        changed = true;
      }
      hit = true;
    }
    if (hit) continue;
    // 2) 定位式:没有该占位符时,按「第一个非空 = 正向,其余 = 负面」落进去
    if (name === 'prompt') {
      const target = clipNodes.find(x => x.filled) ?? clipNodes[0];
      if (target) {
        const current = (parsed[target.id] as { inputs: Record<string, unknown> }).inputs.text as string;
        const next = current.trim() ? `${head}, ${current}` : head;
        if (next !== current) {
          (parsed[target.id] as { inputs: Record<string, unknown> }).inputs.text = next;
          changed = true;
        }
      }
    } else if (clipNodes.length > 1) {
      for (const node of clipNodes.slice(1)) {
        const current = (parsed[node.id] as { inputs: Record<string, unknown> }).inputs.text as string;
        const next = current.trim() ? `${negHead}, ${current}` : negHead;
        if (next !== current) {
          (parsed[node.id] as { inputs: Record<string, unknown> }).inputs.text = next;
          changed = true;
        }
      }
    }
  }

  if (!clipNodes.length && !/%prompt%/.test(template)) {
    return {
      ok: false,
      changed: false,
      template,
      message: '工作流里既没有 %prompt% 也没有 CLIPTextEncode,不知道该把恒定词写到哪里',
    };
  }

  if (!changed) return { ok: true, changed: false, template, message: '工作流里已经是这两个恒定词了,无需改动' };
  return {
    ok: true,
    changed: true,
    template: JSON.stringify(parsed, null, 2),
    message: '恒定词已前置写入工作流的 CLIP 文本',
  };
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
.htj-zz-btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.htj-zz-btns .menu_button { white-space: nowrap; flex: 0 0 auto; }
.htj-zz-charrow .htj-zz-btns { flex-wrap: nowrap; }
.htj-zz-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(124,92,255,.25); }
.htj-zz-charlist { display: flex; flex-direction: column; gap: 8px; }
.htj-zz-charrow {
  display: flex; gap: 10px; align-items: flex-start; justify-content: space-between;
  padding: 10px;
  border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.1));
  border-radius: 8px;
  background: rgba(255,255,255,.02);
}
.htj-zz-charrow-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 auto; }
.htj-zz-charrow-main .htj-zz-hint { word-break: break-word; }
.htj-zz-charrow-main .htj-zz-hint:first-of-type {
  /* 外貌摘要可能是一大段 tag,截到几行了事,点开编辑再看全 */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.htj-zz-chareditor {
  border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.14));
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 14px;
  background: rgba(124,92,255,.06);
}
.htj-zz-chareditor h5 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
/* 临时档案行:用左侧色条区分「此刻状态」与固定档案 */
.htj-zz-transient-chipline {
  color: #ffb0d0;
  opacity: .9;
  border-left: 2px solid #ff5c9d;
  padding-left: 6px;
}
.htj-zz-charlist + .htj-zz-btns { margin-top: 10px; }
.htj-zz-importrow { display: flex; align-items: baseline; gap: 6px; padding: 4px 0; }

/* ---- 分段预览 ---- */
.htj-zz-segments { display: flex; flex-direction: column; gap: 6px; }
.htj-zz-segment-row {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  padding: 6px 8px;
  border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.1));
  border-left: 3px solid rgba(124,92,255,.65);
  border-radius: 8px;
  background: rgba(255,255,255,.02);
}
.htj-zz-segment-text { flex: 1 1 240px; min-width: 0; word-break: break-word; }
.htj-zz-subhead { margin: 14px 0 6px; font-size: 13px; font-weight: 600; }
.htj-zz-prompt-preview { display: flex; flex-direction: column; gap: 4px; margin: 8px 0 10px; word-break: break-word; }
.htj-zz-prompt-preview div:first-child { color: #c9b6ff; }
.htj-zz-field-narrow { flex: 0 0 96px; }

/* ---- 图库 ---- */
.htj-zz-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
  margin-top: 10px;
}
.htj-zz-gallery-card {
  display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.12));
  border-radius: 10px;
  padding: 8px;
  background: rgba(255,255,255,.02);
  min-width: 0;
}
.htj-zz-gallery-thumb { display: block; }
.htj-zz-gallery-thumb img {
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  border-radius: 8px;
  display: block;
}
.htj-zz-gallery-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.htj-zz-gallery-body .htj-zz-hint { word-break: break-word; }
.htj-zz-gallery-body .htj-zz-btns { gap: 4px; }
.htj-zz-gallery-body .menu_button { font-size: 12px; padding: 4px 8px; }
.htj-zz-gallery-prompt {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.htj-zz-warn {
  grid-column: 1 / -1;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 176, 32, .55);
  background: rgba(255, 176, 32, .12);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}

/* ---- 楼层被「插回正文」定位到时闪一下 ---- */
@keyframes htj-zz-flash { 0%,100% { background-color: transparent; } 30% { background-color: rgba(124,92,255,.18); } }
.htj-zz-flash { animation: htj-zz-flash 1.1s ease-out 1; border-radius: 10px; }

/* ---- 恒定词横幅(出图页顶部,证明当前生效的是哪一串) ---- */
.htj-zz-constbar {
  display: flex; flex-direction: column; gap: 4px;
  padding: 8px 10px;
  border-radius: 10px;
  border-left: 3px solid rgba(124,92,255,.7);
  background: rgba(124,92,255,.08);
  font-size: 11px;
  line-height: 1.5;
  word-break: break-word;
  margin-bottom: 10px;
}
.htj-zz-constbar b { font-weight: 600; opacity: .85; }

/* ---- 移动端 ----
 * 三条硬约束(不满足就是「手机上没法用」):
 * 1. 面板必须满屏 + 用 dvh:移动浏览器的地址栏会伸缩,100vh 会漏掉一截,
 *    底部按钮被顶到屏幕外。
 * 2. 输入框字号 ≥16px:iOS Safari 对 <16px 的输入框会自动放大整个页面。
 * 3. 触摸目标 ≥44px:手指比鼠标粗得多,原本 8px 内边距的按钮点不准。
 */
@media (max-width: 720px) {
  .htj-zz-panel-mask {
    padding: 0;
    align-items: stretch;
    justify-content: stretch;
  }
  .htj-zz-panel {
    width: 100%;
    height: 100dvh;
    max-height: 100dvh;
    border-radius: 0;
    border: none;
    font-size: 15px;
  }
  .htj-zz-panel-head {
    padding: calc(8px + env(safe-area-inset-top)) 12px 8px;
    gap: 8px;
    position: sticky;
    top: 0;
    z-index: 2;
  }
  .htj-zz-panel-sub { display: none; }
  .htj-zz-tabs {
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding: 6px 8px 0;
    gap: 2px;
  }
  .htj-zz-tabs::-webkit-scrollbar { display: none; }
  .htj-zz-tab {
    flex: 0 0 auto;
    min-height: 40px;
    padding: 8px 12px;
    font-size: 14px;
    white-space: nowrap;
  }
  .htj-zz-panel-body {
    padding: 12px 12px calc(16px + env(safe-area-inset-bottom));
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }
  .htj-zz-panel-foot {
    padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
  }
  .htj-zz-panel input.text_pole,
  .htj-zz-panel select.text_pole,
  .htj-zz-panel textarea.text_pole {
    font-size: 16px;   /* 低于 16px 时 iOS 会自动放大整页 */
    min-height: 42px;
  }
  .htj-zz-panel textarea.htj-zz-textarea { min-height: 120px; }
  .htj-zz-panel .menu_button {
    min-height: 42px;
    padding: 8px 14px;
    font-size: 14px;
    touch-action: manipulation;
  }
  .htj-zz-btns { gap: 8px; }
  .htj-zz-btns .menu_button { flex: 1 1 auto; }
  .htj-zz-field { flex: 1 1 100%; }
  .htj-zz-field-narrow { flex: 1 1 calc(50% - 5px); }
  .htj-zz-grid2 { grid-template-columns: 1fr; }
  .htj-zz-canvas { min-height: 160px; padding: 8px; }
  .htj-zz-canvas img { max-height: 45dvh; }
  .htj-zz-gallery { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .htj-zz-orb { touch-action: none; }
  /* 图库卡片在手机上按钮会挤:改成 2 列自然换行、按钮铺满一行 */
  .htj-zz-gallery-body .htj-zz-btns .menu_button { flex: 1 1 40%; font-size: 13px; min-height: 40px; }
  .htj-zz-segment-row { align-items: flex-start; }
  .htj-zz-segment-text { flex: 1 1 100%; }
  .htj-zz-constbar { font-size: 12px; }
  .htj-zz-warn { font-size: 13px; }
}

/* 触摸屏(平板也包括,不一定 <720px):输入框 16px 防 iOS 缩放、按钮给足高度 */
@media (pointer: coarse) {
  .htj-zz-panel input.text_pole,
  .htj-zz-panel select.text_pole,
  .htj-zz-panel textarea.text_pole {
    font-size: 16px;
    min-height: 42px;
  }
  .htj-zz-panel .menu_button {
    min-height: 42px;
    padding: 8px 14px;
    touch-action: manipulation;
  }
  .htj-zz-panel input,
  .htj-zz-panel textarea,
  .htj-zz-panel select {
    /* 关掉双击缩放带来的 300ms 延迟;双击悬浮球回默认位置照样工作 */
    touch-action: manipulation;
  }
  .htj-zz-orb {
    /* 触摸设备上球体本身再放大一点,免得指甲盖盖住半个 */
    min-width: 44px;
    min-height: 44px;
  }
}

/* iOS 安全区:面板贴底时底栏被手势条挡住 */
@supports (padding: env(safe-area-inset-bottom)) {
  .htj-zz-panel-foot { padding-bottom: calc(8px + env(safe-area-inset-bottom)); }
}

@media (max-width: 420px) {
  .htj-zz-panel-title { font-size: 14px; }
  .htj-zz-gallery { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
}

/* 触摸设备没有 hover:贴边半隐会让球永远只露一半,手指很难点 —— 一律整颗显示 */
@media (hover: none) {
  .htj-zz-orb { opacity: 1 !important; }
}

/* 横屏矮屏:标题和页脚都很挤,优先把高度让给内容 */
@media (max-height: 520px) and (orientation: landscape) {
  .htj-zz-panel { height: 100dvh; border-radius: 0; }
  .htj-zz-panel-head { padding-top: 6px; padding-bottom: 6px; }
  .htj-zz-panel-foot { display: none; }
}
`;
