/**
 * 绘图姬·中转站 —— SillyTavern 扩展入口。
 *
 * 链路上只有一道新增的关口:正文先交给中转站模型编译成 CLIP 提示词,
 * 再写进 ComfyUI 工作流的 CLIPTextEncode 节点出图。
 *
 *   剧情正文 ──► 中转站(OpenAI 兼容 url+key) ──► CLIP 提示词 ──► ComfyUI ──► 楼层卡片
 */

import { getSettings, configProblems, isProbablyReady } from '@/state/settings';
import { getContext, waitForContext } from '@/st/context';
import { UI_CSS, el, ensureStyle } from '@/ui/dom';
import { autoIllustrateState, bindAutoIllustrate } from '@/ui/autoIllustrate';
import { hydrateAll, hasLegacyPlaceholder, illustrateFloor, resetFloorCards, stripCardPlaceholders } from '@/ui/card';
import { bindFloorButtons, decorateAllFloors } from '@/ui/floorButton';
import { setOrbBusy, syncOrb } from '@/ui/orb';
import { noteAutoRunDone, togglePanel } from '@/ui/panel';
import { mountSettingsPanel, TITLE } from '@/ui/settingsPanel';

declare const __HTJ_ZZ_VERSION__: string;

const VERSION = typeof __HTJ_ZZ_VERSION__ === 'string' ? __HTJ_ZZ_VERSION__ : 'dev';

/** 上一次提示过的「配置不齐」内容,避免每次生成都弹一遍。 */
let notReadyWarned = '';

/** 加载失败的横幅 id(整个扩展没能初始化时才出现)。 */
const FATAL_ID = 'htj-zz-fatal';

/**
 * 最后一道兜底:整个扩展初始化失败时,页面上必须留点痕迹。
 *
 * 为什么需要:ST 用 `<script type="module">` 加载扩展,模块内抛错**不会**弹到界面上,
 * 只会进控制台。用户看到的是「装了,但酒馆里什么都没有」,而扩展自己在扩展列表里
 * 还是「已启用」状态 —— 完全无从下手。这里把错误打到页面上一块可点的横幅,
 * 至少能知道是加载失败、失败在哪一行。
 */
function mountFatal(reason: string): void {
  try {
    ensureStyle('htj-zz-ui', UI_CSS);
  } catch {
    /* 连样式都注入不了就只写文字 */
  }
  if (document.getElementById(FATAL_ID)) return;
  const box = el('div', {
    id: FATAL_ID,
    class: 'htj-zz-fatal',
    title: '点一下复制错误信息',
  }) as HTMLDivElement;
  box.append(
    el('b', { text: '绘图姬·中转站:扩展没有初始化成功' }),
    el('div', { text: reason }),
    el('small', { text: `版本 ${VERSION} · 点这里复制错误信息,贴给作者排查` }),
  );
  box.addEventListener('click', () => {
    const text = `[绘图姬·中转站] v${VERSION} 初始化失败:${reason}\nUA:${navigator.userAgent}`;
    void navigator.clipboard?.writeText(text);
  });
  document.body.append(box);
}

function fatal(reason: string): void {
  console.error(`[${TITLE}] 初始化失败:${reason}`);
  mountFatal(reason);
}

window.addEventListener?.('error', event => {
  const text = String((event as ErrorEvent).message ?? '');
  // 只抓自己的:别人的报错不该由我们挂横幅
  if (!/htj|绘图姬/i.test(text) && !/dist\/index\.js/.test(String((event as ErrorEvent).filename ?? ''))) return;
  fatal(`运行时错误:${text}`);
});
window.addEventListener?.('unhandledrejection', event => {
  const reason = (event as PromiseRejectionEvent).reason;
  const text = reason instanceof Error ? reason.message : String(reason);
  if (!/htj|绘图姬|index\.js/i.test(text)) return;
  fatal(`未处理的 Promise 拒绝:${text}`);
});

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
      // 用 isProbablyReady 而不是 isReady:换设备/换浏览器后 extension_settings 里
      // 没有 key 也照样自动跑(请求经 ST 服务端转发,服务端有 key 就行),
      // 以前这里判死,手机上勾了自动插图也永远不动。
      ready: () => isProbablyReady(),
      onNotReady: problems => {
        // 每次生成都会走到这里,所以只在内容变化时提示一次(不刷屏)
        const key = problems.join('|');
        if (notReadyWarned === key) return;
        notReadyWarned = key;
        const toastr = (window as unknown as { toastr?: Record<string, (m: string, t: string) => void> }).toastr;
        toastr?.warning?.(`自动插图已开启但配置不齐:${problems.join('、')}`, TITLE);
        console.warn(`[${TITLE}] 自动插图配置不齐:${problems.join('、')}`);
      },
      onBusy: busy => setOrbBusy(busy),
      onDone: info => {
        // 自动流程跑完:面板开着就更新状态行,图库页顺手刷新
        noteAutoRunDone(info);
        decorateAllFloors();
      },
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
    // 注意:CHARACTER_MESSAGE_RENDERED 这里**只补水合**,不在这里做出图决策。
    // 自动出图的闸门/兜底全部由 autoIllustrate 负责,两处都挂会重复触发。
    ctx.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, (messageId: unknown) => {
      const floor = Number(messageId);
      if (Number.isInteger(floor) && floor >= 0) {
        setTimeout(() => {
          void hydrateAll();
          decorateAllFloors();
        }, 50);
      }
    });
    // 切 swipe / 编辑楼层:DOM 会被重建,图得按锚点挂回去
    for (const name of ['MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED'] as const) {
      const eventName = events[name];
      if (!eventName) continue;
      ctx.eventSource.on(eventName, () => {
        setTimeout(() => void hydrateAll(), 60);
      });
    }
    // 往上翻历史:新露出来的楼层同样要补图
    if (events.MORE_MESSAGES_LOADED) {
      ctx.eventSource.on(events.MORE_MESSAGES_LOADED, () => {
        setTimeout(() => {
          void hydrateAll();
          decorateAllFloors();
        }, 120);
      });
    }
    ctx.eventSource.on(events.CHAT_CHANGED, () => {
      setTimeout(() => {
        // 换聊天:先清掉上一聊天的状态卡,再把新聊天已存的图挂回去
        resetFloorCards();
        void hydrateAll();
        decorateAllFloors();
        addTopBarButton();
      }, 200);
    });
  }

  info(`v${VERSION} 已加载`);
}

void boot().catch(error => {
  fatal(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack?.split('\n').slice(0, 3).join('\n') ?? ''}` : String(error));
});

/** 给控制台/其它插件用的小入口。 */
const globalThisAny = globalThis as unknown as Record<string, unknown>;
globalThisAny.htjZhongZhuan = {
  version: VERSION,
  generate: (floor: number) => illustrateFloor(floor),
  generateWithStory: (story: string) => illustrateFloor(-1, { story }),
  openPanel: (tab?: 'render' | 'gallery' | 'channel' | 'chars' | 'prompt') => togglePanel(tab ?? 'render'),
  openSettings: () => document.getElementById('htj-zz-settings')?.scrollIntoView({ behavior: 'smooth' }),
  /** 配置是否齐(控制台自查用)。 */
  configProblems: () => configProblems(),
  /** 自动插图内部状态(控制台自查:绑定成功没有、上次为什么失败)。 */
  autoState: () => autoIllustrateState(),
};
