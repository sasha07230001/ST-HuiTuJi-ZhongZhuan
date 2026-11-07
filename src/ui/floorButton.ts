/**
 * 楼层按钮:每层 AI 剧情楼右上角放一个「绘图」按钮,手动触发。
 *
 * ST 每次渲染/切换 swipe 都会重建楼层 DOM,所以这里靠事件委托 + MutationObserver,
 * 而不是往每个按钮上绑监听。
 */

import { getContext, isAiStoryMessage } from '@/st/context';
import { illustrateFloor } from '@/ui/card';

const BUTTON_CLASS = 'htj-zz-floor-btn';
const WRAP_CLASS = 'htj-zz-floor-actions';

function findExtraButtons(floor: number): HTMLElement | null {
  const mes = document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"]`);
  if (!mes) return null;
  return mes.querySelector<HTMLElement>('.mes_buttons');
}

/** 给楼层注入按钮(已经注入过就跳过)。 */
function decorateFloor(floor: number): void {
  const ctx = getContext();
  const message = ctx?.chat?.[floor];
  const host = findExtraButtons(floor);
  if (!host) return;
  const existing = host.querySelector<HTMLElement>(`.${WRAP_CLASS}`);
  if (existing) {
    existing.dataset.valid = isAiStoryMessage(message) ? '1' : '0';
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = WRAP_CLASS;
  wrap.dataset.valid = isAiStoryMessage(message) ? '1' : '0';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `menu_button ${BUTTON_CLASS}`;
  btn.title = '把这一楼正文交给中转站编译并出图';
  btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>绘图</span>';
  btn.addEventListener('click', event => {
    event.stopPropagation();
    void trigger(floor, btn);
  });
  wrap.append(btn);
  host.append(wrap);
}

async function trigger(floor: number, btn: HTMLButtonElement): Promise<void> {
  const ctx = getContext();
  if (!ctx) return;
  const message = ctx.chat?.[floor];
  if (!isAiStoryMessage(message)) {
    const toastr = (window as unknown as { toastr?: { warning?: (m: string, t: string) => void } }).toastr;
    toastr?.warning?.('这一楼不是可配图的剧情楼', '绘图姬·中转站');
    return;
  }
  btn.disabled = true;
  try {
    const result = await illustrateFloor(floor);
    if (result.errors.length) {
      const toastr = (window as unknown as { toastr?: { error?: (m: string, t: string) => void } }).toastr;
      toastr?.error?.(result.errors[0], '绘图姬·中转站');
    }
  } finally {
    btn.disabled = false;
  }
}

/** 扫描全聊天,补上缺失的按钮。 */
export function decorateAllFloors(): void {
  const ctx = getContext();
  if (!ctx?.chat) return;
  for (let floor = 0; floor < ctx.chat.length; floor++) decorateFloor(floor);
}

let observer: MutationObserver | null = null;
let scheduled = false;

/** 监听聊天区的重渲染,防抖后重挂按钮。 */
export function bindFloorButtons(): void {
  decorateAllFloors();
  if (observer) return;
  const chat = document.getElementById('chat');
  if (!chat) return;
  observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      decorateAllFloors();
    }, 200);
  });
  observer.observe(chat, { childList: true, subtree: true });
}
