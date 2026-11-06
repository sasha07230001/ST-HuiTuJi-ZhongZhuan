/**
 * 绘图姬·中转站 —— SillyTavern 扩展入口。
 *
 * 链路上只有一道新增的关口:正文先交给中转站模型编译成 CLIP 提示词,
 * 再写进 ComfyUI 工作流的 CLIPTextEncode 节点出图。
 *
 *   剧情正文 ──► 中转站(OpenAI 兼容 url+key) ──► CLIP 提示词 ──► ComfyUI ──► 楼层卡片
 */

import { getSettings, isReady } from '@/state/settings';
import { getContext, waitForContext } from '@/st/context';
import { bindAutoIllustrate } from '@/ui/autoIllustrate';
import { generateIntoFloor, hydrateAll, hasLegacyPlaceholder, stripCardPlaceholders } from '@/ui/card';
import { bindFloorButtons, decorateAllFloors } from '@/ui/floorButton';
import { syncOrb } from '@/ui/orb';
import { togglePanel } from '@/ui/panel';
import { mountSettingsPanel, TITLE } from '@/ui/settingsPanel';

declare const __HTJ_ZZ_VERSION__: string;

const VERSION = typeof __HTJ_ZZ_VERSION__ === 'string' ? __HTJ_ZZ_VERSION__ : 'dev';

function info(message: string): void {
  console.log(`[${TITLE}] ${message}`);
}

/** 顶栏菜单:打开面板。 */
function addTopBarButton(): void {
  const ctx = getContext();
  const menu = document.getElementById('extensionsMenu');
  if (!menu || !ctx) return;
  if (document.getElementById('htj-zz-topbar')) return;
  const item = document.createElement('div');
  item.className = 'extension_container interactable';
  item.id = 'htj-zz-topbar';

  const button = document.createElement('div');
  button.className = 'list-group-item flex-container flexGap5 interactable';
  button.tabIndex = 0;
  button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>绘图姬·中转站</span>';
  // 顶栏入口 = 打开面板(不再是「直接给最新一楼出图」)。
  // 出图页默认选中最新一楼,点「编译并出图」就行,也能手填正文 / 改提示词。
  button.addEventListener('click', () => {
    togglePanel('render');
  });

  item.append(button);
  menu.append(item);
}

/**
 * 一次性清洗:早期版本把 `<htj-zz-card>` 写进了 message.mes。
 * 那些标签让用户自己的正则(状态美化 / 选项美化)匹配区间被破坏,状态栏退化成源码。
 * 这里把正文里残留的标签洗掉并落盘,让正则重新正常渲染。
 * 只在真的存在残留时才写盘。
 */
async function purgeLegacyPlaceholders(): Promise<void> {
  const ctx = getContext();
  if (!ctx?.chat?.length) return;
  let cleaned = 0;
  for (const message of ctx.chat) {
    if (typeof message?.mes !== 'string' || !hasLegacyPlaceholder(message.mes)) continue;
    message.mes = stripCardPlaceholders(message.mes);
    cleaned += 1;
  }
  if (!cleaned) return;
  await ctx.saveChat?.();
  info(`已清理 ${cleaned} 条消息里的旧占位符,正在重渲染`);
  // 重渲染受影响楼层,让正则重新美化
  try {
    const reload = ctx.reloadCurrentChat as (() => Promise<void>) | undefined;
    if (typeof reload === 'function') void reload.call(ctx);
  } catch {
    /* 没有该 API 时用户手刷一下页面即可 */
  }
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
    await purgeLegacyPlaceholders();
  } catch (error) {
    console.error(`[${TITLE}] 清理旧占位符失败`, error);
  }

  try {
    hydrateAll();
  } catch (error) {
    console.error(`[${TITLE}] 卡片水合失败`, error);
  }

  try {
    bindAutoIllustrate({
      enabled: () => {
        const s = getSettings();
        return s.enabled && s.autoRun;
      },
      ready: () => isReady(),
    });
  } catch (error) {
    console.error(`[${TITLE}] 自动插图绑定失败`, error);
  }

  try {
    addTopBarButton();
  } catch (error) {
    console.error(`[${TITLE}] 顶栏按钮挂载失败`, error);
  }

  // 悬浮球:设置里开着就挂上。它不依赖 ST 事件,纯 DOM,失败也不该拖垮其它部分。
  try {
    syncOrb();
  } catch (error) {
    console.error(`[${TITLE}] 悬浮球挂载失败`, error);
  }

  const events = ctx.eventTypes ?? ctx.event_types;
  if (events) {
    ctx.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, (messageId: unknown) => {
      const floor = Number(messageId);
      if (Number.isInteger(floor) && floor >= 0) {
        setTimeout(() => {
          hydrateAll();
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
  openPanel: (tab?: 'render' | 'channel' | 'prompt') => togglePanel(tab ?? 'render'),
  openSettings: () => document.getElementById('htj-zz-settings')?.scrollIntoView({ behavior: 'smooth' }),
};
