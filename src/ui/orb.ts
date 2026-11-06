/**
 * 悬浮球 —— 伸进酒馆页面的入口。
 *
 * 行为与绘图🐔二号一致:
 * - 自由拖动,拖到哪停哪;
 * - 只在接近左/右边缘时吸附贴边,贴边时半隐,悬停/聚焦/拖动才整条滑出;
 * - 位移小于阈值视为「点击」→ 打开面板。
 *
 * 位置存 localStorage(纯视觉态,各设备屏幕尺寸不同,同步反而会跑到屏幕外);
 * 显隐/尺寸/透明度走 extension_settings,跨设备同步。
 */

import { getSettings } from '@/state/settings';
import { UI_CSS, el, ensureStyle } from '@/ui/dom';
import { togglePanel } from '@/ui/panel';

const POS_KEY = 'htjzz.orb.pos.v1';
const SNAP_ZONE = 56;
const CLICK_SLOP = 6;
const ORB_ID = 'htj-zz-orb';

type Dock = 'left' | 'right' | 'none';

interface OrbPos {
  dock: Dock;
  x: number;
  y: number;
}

/** 默认位置:右侧贴边、纵向偏下。 */
function defaultPos(): OrbPos {
  return { dock: 'right', x: 0, y: Math.round((viewport()?.innerHeight || 800) * 0.6) };
}

/**
 * 读位置并**修掉不一致的存档**。
 *
 * 实测踩到的坑:存档里 `dock: 'none'`(自由状态)但坐标恰好落在屏幕右缘外,
 * 贴边模式下会把它夹回视口,自由模式下却按原坐标渲染 —— 结果球一半在屏幕外。
 * 读出来先按当前视口归一化,再判断该贴边还是自由。
 */
function loadPos(): OrbPos {
  const vw = viewport()?.innerWidth || 0;
  const s = size();
  let pos = defaultPos();
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OrbPos>;
      if (p && (p.dock === 'left' || p.dock === 'right' || p.dock === 'none')) {
        pos = { dock: p.dock, x: Number(p.x) || 0, y: Number(p.y) || 0 };
      }
    }
  } catch {
    /* 无 localStorage 时用默认值 */
  }

  // 自由态的坐标夹进可视区;夹完仍贴边就转成贴边态,免得浮出一半。
  if (pos.dock === 'none' && vw > 0) {
    pos.x = Math.min(Math.max(0, pos.x), Math.max(0, vw - s));
    if (pos.x + s >= vw - SNAP_ZONE) pos = { ...pos, dock: 'right' };
    else if (pos.x <= SNAP_ZONE) pos = { ...pos, dock: 'left' };
  }
  return pos;
}

function savePos(pos: OrbPos): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

/** 面板入口用的画笔/调色板图标(内联 SVG,不依赖 FontAwesome)。 */
const ORB_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1 .8-1.9 1.9-1.9H16a5 5 0 0 0 5-5c0-3.6-4-7.5-9-7.5Z"/>
  <circle cx="7.5" cy="10.5" r="1.1" fill="currentColor" stroke="none"/>
  <circle cx="11" cy="7" r="1.1" fill="currentColor" stroke="none"/>
  <circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"/>
</svg>`;

let orbEl: HTMLDivElement | null = null;
let pos: OrbPos = { dock: 'right', x: 0, y: 0 };
let dragging = false;
let awake = false;
let activePointer: number | null = null;
let startX = 0;
let startY = 0;
let grabDX = 0;
let grabDY = 0;
let moved = 0;

/**
 * 视口事件源。浏览器里就是 window;但模块可能在无 window 的环境求值,
 * 直接写 globalThis.addEventListener 会炸(已实测踩到),所以统一走这个取用点。
 */
function viewport(): Window | null {
  return typeof window !== 'undefined' ? window : null;
}

function size(): number {
  return Math.max(28, Math.min(96, Number(getSettings().orb.size) || 48));
}

function clampToViewport(): void {
  const s = size();
  pos.y = Math.min(Math.max(0, pos.y), Math.max(0, (viewport()?.innerHeight || 0) - s));
  if (pos.dock === 'none') {
    pos.x = Math.min(Math.max(0, pos.x), Math.max(0, (viewport()?.innerWidth || 0) - s));
  }
}

/** 当前左上角的绝对 x(贴边态由 right 折算,供拖动起步用)。 */
function currentLeft(): number {
  const w = viewport()?.innerWidth || 0;
  if (pos.dock === 'right') return w - size();
  if (pos.dock === 'left') return 0;
  return pos.x;
}

function applyStyle(): void {
  if (!orbEl) return;
  const s = size();
  const opacity = Math.min(1, Math.max(0.2, Number(getSettings().orb.opacity) || 0.62));
  orbEl.style.width = `${s}px`;
  orbEl.style.height = `${s}px`;
  orbEl.style.top = `${pos.y}px`;
  orbEl.style.opacity = String(opacity);
  // 不要在这里 style.left = '' / style.right = ''「清零」:空串只会删掉内联值,
  // 计算值会退回上一个有效值(实测 left 顽固停在 1392px)。
  // 两侧的互斥一律交给下面的分支写死 px / auto。

  const out = dragging || awake;
  // 贴边态故意错开自己的一半做「半隐」;free 态必须整颗落在视口内。
  const tuck = Math.round(s * 0.58);
  const vw = viewport()?.innerWidth || 0;

  // 定位一律 left + translateX,并且把「半隐位移」包含进 left 里算。
  //
  // 实测踩到的坑:页面被二号(bbi-app-host)撑出横向溢出(scrollWidth 1461 > 1440),
  // 于是 `right:0` 贴的是**被撑大的文档右边**,球直接落到视口外(x=1420,视口 1440)。
  // 用 left 锚定视口左缘、把右对齐自己算出来,就不再受别人撑宽文档影响。
  const anchor = pos.dock === 'left' ? 0 : pos.dock === 'right' ? Math.max(0, vw - s) : Math.min(Math.max(0, pos.x), Math.max(0, vw - s));
  const shift = out ? 0 : pos.dock === 'left' ? -tuck : pos.dock === 'right' ? tuck : 0;
  orbEl.style.left = `${anchor}px`;
  orbEl.style.right = 'auto';
  orbEl.style.transform = shift ? `translateX(${shift}px)` : 'translateX(0)';
}

/* ---------------- 拖动 ---------------- */

function onDown(event: PointerEvent): void {
  if (!orbEl) return;
  activePointer = event.pointerId;
  dragging = true;
  moved = 0;
  startX = event.clientX;
  startY = event.clientY;
  grabDX = event.clientX - currentLeft();
  grabDY = event.clientY - pos.y;
  orbEl.setPointerCapture?.(event.pointerId);
  orbEl.classList.add('is-dragging');
  applyStyle();
}

function onMove(event: PointerEvent): void {
  if (!dragging || event.pointerId !== activePointer) return;
  moved = Math.max(moved, Math.abs(event.clientX - startX) + Math.abs(event.clientY - startY));
  pos.dock = 'none';
  pos.x = event.clientX - grabDX;
  pos.y = event.clientY - grabDY;
  clampToViewport();
  applyStyle();
}

function onUp(event: PointerEvent): void {
  if (!dragging || event.pointerId !== activePointer) return;
  dragging = false;
  activePointer = null;
  orbEl?.classList.remove('is-dragging');

  if (moved < CLICK_SLOP) {
    // 视为点击 → 开关面板(再把球滑出来,免得停在半隐状态)
    awake = true;
    applyStyle();
    togglePanel();
    return;
  }

  const left = pos.x;
  const right = (viewport()?.innerWidth || 0) - (pos.x + size());
  if (left <= SNAP_ZONE) pos.dock = 'left';
  else if (right <= SNAP_ZONE) pos.dock = 'right';
  else pos.dock = 'none';
  clampToViewport();
  applyStyle();
  savePos(pos);
}

/* ---------------- 挂载 ---------------- */

/** 按设置显隐悬浮球。设置页改完调用它即可生效,不需要刷新。 */
export function syncOrb(): void {
  const show = getSettings().orb.show;
  if (show && !orbEl) mountOrb();
  else if (!show && orbEl) unmountOrb();
  else if (show && orbEl) {
    clampToViewport();
    applyStyle();
  }
}

function mountOrb(): void {
  if (orbEl) return;
  ensureStyle('htj-zz-ui', UI_CSS);
  pos = loadPos();

  const node = el('div', {
    id: ORB_ID,
    class: 'htj-zz-orb',
    role: 'button',
    tabindex: '0',
    title: '打开绘图姬·中转站',
    'aria-label': '打开绘图姬·中转站',
  }) as HTMLDivElement;
  node.innerHTML = `${ORB_ICON}<span class="htj-zz-orb-badge"></span>`;

  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onUp);
  node.addEventListener('pointerenter', () => {
    awake = true;
    applyStyle();
  });
  node.addEventListener('pointerleave', () => {
    awake = false;
    applyStyle();
  });
  node.addEventListener('focus', () => {
    awake = true;
    applyStyle();
  });
  node.addEventListener('blur', () => {
    awake = false;
    applyStyle();
  });
  node.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      togglePanel();
    }
  });
  // 双击 = 回到默认位置(球被拖到看不见的地方时的救命入口)
  node.addEventListener('dblclick', event => {
    event.preventDefault();
    pos = { dock: 'right', x: 0, y: Math.round((viewport()?.innerHeight || 800) * 0.6) };
    savePos(pos);
    applyStyle();
  });

  document.body.append(node);
  orbEl = node;
  clampToViewport();
  applyStyle();

  viewport()?.addEventListener('resize', onResize);
}

function unmountOrb(): void {
  viewport()?.removeEventListener('resize', onResize);
  orbEl?.remove();
  orbEl = null;
}

function onResize(): void {
  clampToViewport();
  applyStyle();
  savePos(pos);
}

/** 面板里的「回到默认位置」。 */
export function resetOrbPosition(): void {
  pos = { dock: 'right', x: 0, y: Math.round((viewport()?.innerHeight || 800) * 0.6) };
  savePos(pos);
  applyStyle();
}

/** 生成中的状态点:面板正在跑任务时把球上的小点变黄。 */
export function setOrbBusy(busy: boolean): void {
  orbEl?.classList.toggle('is-running', busy);
}

/** 供测试用:当前球体是否已挂载。 */
export function isOrbMounted(): boolean {
  return !!orbEl && document.body.contains(orbEl);
}

/** 供测试用:球体节点。 */
export function orbNode(): HTMLDivElement | null {
  return orbEl;
}

/** 面板打开时把球藏起来,别让它浮在遮罩上面。 */
export function hideOrbForPanel(hidden: boolean): void {
  if (!orbEl) return;
  orbEl.style.display = hidden ? 'none' : '';
}
