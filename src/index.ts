/**
 * 绘图姬·中转站 —— SillyTavern 扩展入口。
 *
 * 链路上只有一道新增的关口:正文先交给中转站模型编译成 CLIP 提示词,
 * 再写进 ComfyUI 工作流的 CLIPTextEncode 节点出图。
 *
 *   剧情正文 ──► 中转站(OpenAI 兼容 url+key) ──► CLIP 提示词 ──► ComfyUI ──► 楼层卡片
 */

import { getSettings, isReady } from '@/state/settings';
import { getContext, reloadMessageDom, waitForContext } from '@/st/context';
import { bindAutoRun } from '@/ui/autoRun';
import { cardPlaceholder, generateIntoFloor, hydrateAll, hydrateFloor, stripCardPlaceholders } from '@/ui/card';
import { bindFloorButtons, decorateAllFloors } from '@/ui/floorButton';
import { mountSettingsPanel, TITLE } from '@/ui/settingsPanel';

declare const __HTJ_ZZ_VERSION__: string;

const VERSION = typeof __HTJ_ZZ_VERSION__ === 'string' ? __HTJ_ZZ_VERSION__ : 'dev';

function info(message: string): void {
  console.log(`[${TITLE}] ${message}`);
}

/** 自动流程:在某楼末尾追加卡片占位符并就地出图。 */
async function autoRunFloor(floor: number): Promise<void> {
  const ctx = getContext();
  const message = ctx?.chat?.[floor];
  if (!ctx || !message) return;
  if (!isReady()) {
    const toastr = (window as unknown as { toastr?: { warning?: (m: string, t: string) => void } }).toastr;
    toastr?.warning?.('中转站或 ComfyUI 还没配置完整,去扩展设置里填一下', TITLE);
    return;
  }

  const placeholder = cardPlaceholder(0);
  if (!message.mes.includes(placeholder)) {
    message.mes = `${stripCardPlaceholders(message.mes)}\n\n${placeholder}`;
    await ctx.saveChat?.();
    reloadMessageDom(floor);
  }

  // 等 ST 把占位符渲染成 card 容器后再往里画
  await new Promise(resolve => setTimeout(resolve, 60));
  hydrateFloor(floor);

  await generateIntoFloor(floor, {
    story: stripCardPlaceholders(message.mes),
    note: '自动模式:用这一楼的正文编译一张最贴合当前画面的插图提示词。',
  });
}

/** 顶栏菜单:一键为最新一楼出图。 */
function addTopBarButton(): void {
  const ctx = getContext();
  const menu = document.getElementById('extensionsMenu');
  if (!menu || !ctx) return;
  const item = document.createElement('div');
  item.className = 'extension_container interactable';
  item.id = 'htj-zz-topbar';

  const button = document.createElement('div');
  button.className = 'list-group-item flex-container flexGap5 interactable';
  button.tabIndex = 0;
  button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>绘图姬·中转站</span>';
  button.addEventListener('click', () => {
    if (!isReady()) {
      const toastr = (window as unknown as { toastr?: { warning?: (m: string, t: string) => void } }).toastr;
      toastr?.warning?.('中转站或 ComfyUI 还没配置完整,去扩展设置里填一下', TITLE);
      return;
    }
    const ctxNow = getContext();
    const floor = (ctxNow?.chat?.length ?? 0) - 1;
    if (floor < 0) return;
    void autoRunFloor(floor);
  });

  item.append(button);
  menu.append(item);
}

/**
 * 加载顺序:扩展脚本可能在 ST 的 getContext 就绪之前执行,
 * 也可能在 DOMContentLoaded 之前执行。这里用原生事件,**不依赖 jQuery**——
 * bundle 把 jquery 标成 external 映射到全局 $,加载顺序一旦不对就是
 * ReferenceError,整个扩展初始化会当场断掉(实测踩到过)。
 */
async function boot(): Promise<void> {
  info(`v${VERSION} 正在加载…`);

  const onReady = (fn: () => void) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };

  onReady(() => {
    try {
      mountSettingsPanel();
    } catch (error) {
      console.error(`[${TITLE}] 设置面板挂载失败`, error);
    }
  });

  const ctx = await waitForContext();
  if (!ctx) {
    console.warn(`[${TITLE}] 等不到 SillyTavern 上下文,扩展未完成初始化`);
    return;
  }

  try {
    mountSettingsPanel();
  } catch {
    /* onReady 里已兜过一次 */
  }

  try {
    bindFloorButtons();
  } catch (error) {
    console.error(`[${TITLE}] 楼层按钮挂载失败`, error);
  }

  try {
    hydrateAll();
  } catch (error) {
    console.error(`[${TITLE}] 卡片水合失败`, error);
  }

  try {
    bindAutoRun({
      enabled: () => {
        const s = getSettings();
        return s.enabled && s.autoRun;
      },
      run: autoRunFloor,
    });
  } catch (error) {
    console.error(`[${TITLE}] 自动流程绑定失败`, error);
  }

  try {
    addTopBarButton();
  } catch (error) {
    console.error(`[${TITLE}] 顶栏按钮挂载失败`, error);
  }

  const events = ctx.eventTypes ?? ctx.event_types;
  if (events) {
    ctx.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, (messageId: unknown) => {
      const floor = Number(messageId);
      if (Number.isInteger(floor) && floor >= 0) {
        setTimeout(() => {
          hydrateFloor(floor);
          decorateAllFloors();
        }, 50);
      }
    });
    ctx.eventSource.on(events.CHAT_CHANGED, () => {
      setTimeout(() => {
        hydrateAll();
        decorateAllFloors();
        addTopBarButton();
      }, 200);
    });
  }

  info(`v${VERSION} 已加载`);
}

void boot();

/** 给控制台/其它插件用的小入口。 */
const globalThisAny = globalThis as unknown as Record<string, unknown>;
globalThisAny.htjZhongZhuan = {
  version: VERSION,
  generate: (floor: number) => generateIntoFloor(floor),
  generateWithStory: (story: string) => generateIntoFloor(-1, { story }),
  openSettings: () => document.getElementById('htj-zz-settings')?.scrollIntoView({ behavior: 'smooth' }),
};
