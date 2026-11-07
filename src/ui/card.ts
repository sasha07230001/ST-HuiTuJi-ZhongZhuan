/**
 * 楼层出图:一条完整的「正文 → 分段 → 中转站 → CLIP → ComfyUI → 原位回插」。
 *
 * 三条铁律(都是实测踩出来的,别改):
 *
 * 1. **绝不写 message.mes**。往正文插 `<htj-zz-card>` 会让 ST 整条消息重跑正则,
 *    用户「状态美化 / 选项美化」的匹配区间被破坏,面板退化成源码。
 * 2. **绝不调 updateMessageBlock 重渲染**。ST 的整楼重渲染会把正则产出的
 *    iframe 全部拆掉且不再重建(实测 iframe 3 → 0)。
 * 3. **图片必须是 data URL 落地**。ComfyUI 走的是 `URL.createObjectURL(blob)`,
 *    那个句柄刷新即失效——这正是「图库刷新后全丢」的直接原因。所以出图后第一件事是
 *    `toDataUrl()` 再存 IndexedDB,内存里只留副本。
 *
 * 图挂在哪由 split.ts 决定:正文里有 `[[图]]` 就按标记切,没有就按张数均分;
 * 每一段带自己的 anchor(该段结尾若干字),出完图插回那段正文后面。
 */

import { runChain, resolveStory } from '@/relay/orchestrator';
import { clampCount, normalizeMark, planSegments, type StorySegment } from '@/relay/split';
import { getSettings } from '@/state/settings';
import { getContext, isAiStoryMessage } from '@/st/context';
import {
  deleteStoredImage,
  listFloorImages,
  newImageId,
  saveStoredImage,
  storageHealth,
  toDataUrl,
  trimChatImages,
  type StoredImage,
} from '@/ui/galleryStore';
import { hydrateFloorImages, insertFloorImage, INLINE_CLASS, type InlineImageOptions } from '@/ui/inlineImage';

const TAG_NAME = 'htj-zz-card';
const STATUS_CLASS = 'htj-zz-card';

/** 每楼一把「当前这一跑」的锁。 */
const controllers = new Map<string, AbortController>();
/** 楼层状态卡(生成中 / 失败);成功后退场,由插图接管。 */
const statusCards = new Map<number, HTMLElement>();

export interface IllustrateOptions {
  /** 直接指定正文(公开接口 / 面板手填)。 */
  story?: string;
  /** 给模型的额外任务提示。 */
  note?: string;
  /** 这一次出几张;缺省读设置 prompt.maxImages。 */
  count?: number;
  /** 分段标记;缺省读设置 prompt.segmentMark。 */
  mark?: string;
  /** 显式指定锚点(单张图时插在指定正文片段之后)。 */
  anchor?: string;
  /**
   * 跳过「先清掉这一楼上一轮的图」这一步。
   *
   * 图库页「插回正文」用得到:用户可能只想把某一张(可能是三天前那张)补回去,
   * 不该顺手把这一楼当前挂着的其它图全撸掉。
   */
  keepExisting?: boolean;
}

/** split.ts 之外的补充:这一批图里第几张 / 共几张。 */
export interface IllustrateMeta {
  total: number;
}

export interface IllustrateResult {
  floor: number;
  segments: StorySegment[];
  images: StoredImage[];
  errors: string[];
}

function currentChatId(): string {
  return getContext()?.getCurrentChatId?.() ?? '';
}

function swipeOf(message: { swipe_id?: number } | undefined): number {
  return typeof message?.swipe_id === 'number' ? message.swipe_id : 0;
}

function lockKey(chatId: string, floor: number): string {
  return `${chatId}\u0000${floor}`;
}

function mesTextNode(floor: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"] .mes_text`);
}

/* ---------------- 旧版占位符清理(只清不写) ---------------- */

/**
 * 旧版本留在聊天记录里的 `<htj-zz-card>` 清理器。
 * 本扩展现在**不再往正文写任何标签**;这里只负责把历史残留洗掉。
 */
export function stripCardPlaceholders(text: string): string {
  return text.replace(new RegExp(`<${TAG_NAME}[\\s\\S]*?</${TAG_NAME}>`, 'gi'), '').trimEnd();
}

export function hasLegacyPlaceholder(text: string): boolean {
  return new RegExp(`<${TAG_NAME}`, 'i').test(text);
}

/* ---------------- 状态卡 ---------------- */

function buildStatusCard(floor: number, title: string, status: string): HTMLElement {
  const node = document.createElement('div');
  node.className = STATUS_CLASS;
  node.dataset.seq = 'status';

  const body = document.createElement('div');
  body.className = 'htj-zz-card-body';

  const head = document.createElement('div');
  head.className = 'htj-zz-card-head';
  const name = document.createElement('b');
  name.textContent = title;
  const state = document.createElement('span');
  state.className = 'htj-zz-card-status';
  state.textContent = status;
  head.append(name, state);

  body.append(head);
  node.append(body);
  return node;
}

function ensureStatusCard(floor: number, title = '绘图姬·中转站', status = ''): HTMLElement | null {
  const host = mesTextNode(floor);
  if (!host) return null;
  let node = statusCards.get(floor);
  if (!node || !node.isConnected) {
    node = buildStatusCard(floor, title, status);
    statusCards.set(floor, node);
    host.append(node);
  }
  paintStatus(floor, title, status, []);
  return node;
}

function paintStatus(floor: number, title: string, status: string, actions: Array<{ label: string; run: () => void }>): void {
  const node = statusCards.get(floor);
  if (!node) return;
  const body = node.querySelector<HTMLElement>('.htj-zz-card-body');
  if (!body) return;
  const head = document.createElement('div');
  head.className = 'htj-zz-card-head';
  const name = document.createElement('b');
  name.textContent = title;
  const state = document.createElement('span');
  state.className = 'htj-zz-card-status';
  state.textContent = status;
  head.append(name, state);

  const parts: Node[] = [head];
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'htj-zz-card-actions';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu_button htj-zz-card-btn';
      btn.textContent = action.label;
      btn.addEventListener('click', event => {
        event.stopPropagation();
        action.run();
      });
      row.append(btn);
    }
    parts.push(row);
  }
  body.replaceChildren(...parts);
}

function dropStatusCard(floor: number): void {
  statusCards.get(floor)?.remove();
  statusCards.delete(floor);
}

/* ---------------- 插图 ---------------- */

function captionOf(index: number, total: number, positive: string): string {
  const brief = positive.replace(/\s+/g, ' ').slice(0, 60);
  return total > 1 ? `第 ${index + 1}/${total} 张 · ${brief}` : brief;
}

/**
 * 让这一楼的插图顺序与库里的顺序一致。
 *
 * 图库「插回正文」是单张动作,只把那一张补回它自己的锚点;顺序由 hydrateFloor 管。
 * 这里不复用 hydrateFloor 是因为它会把整楼重排一遍(其它楼层正在生成的图会被摘掉)。
 */

/** 把一张图挂进楼层(楼层 DOM 还没渲染出来时短暂重试)。 */
async function placeImage(floor: number, entry: StoredImage, caption: string): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const ok = insertFloorImage(floor, {
      id: entry.id,
      image: entry.image,
      anchor: entry.anchor,
      caption,
      onRemove: id => {
        void deleteStoredImage(id);
        document
          .querySelectorAll<HTMLElement>(`.${INLINE_CLASS}[data-htj-image-id="${id}"]`)
          .forEach(node => node.remove());
      },
    });
    if (ok) return true;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  return false;
}

/* ---------------- 主入口 ---------------- */

/**
 * 给某一楼出图。
 *
 * - 张数来自 `count`(缺省设置里的 prompt.maxImages);
 * - 正文里写了标记(`[[图]]`)就按标记切,否则按张数均分;
 * - 每张出完立刻落地 + 插回对应段落;失败的那张单独记错误,不影响其它张。
 */
export async function illustrateFloor(floor: number, options: IllustrateOptions = {}): Promise<IllustrateResult> {
  const ctx = getContext();
  const chatId = currentChatId();
  const message = ctx?.chat?.[floor];
  const result: IllustrateResult = { floor, segments: [], images: [], errors: [] };

  /** 手填正文时允许 floor = -1:只出图,没有可插的楼层。 */
  const standalone = Boolean(options.story?.trim());
  if (!ctx || !Number.isInteger(floor) || (floor < 0 && !standalone)) {
    result.errors.push('楼层号无效');
    return result;
  }
  if (!standalone && !isAiStoryMessage(message)) {
    result.errors.push('这一楼不是可配图的剧情楼(用户楼 / 系统楼)');
    return result;
  }

  const settings = getSettings();
  const swipe = swipeOf(message);
  const key = lockKey(chatId, floor);

  // 同一楼重复点 = 打断上一跑,不叠加
  controllers.get(key)?.abort();
  const controller = new AbortController();
  controllers.set(key, controller);

  const total = clampCount(options.count ?? settings.prompt.maxImages);
  const mark = normalizeMark(options.mark ?? settings.prompt.segmentMark);

  let story = options.story?.trim() ?? '';
  if (!story) {
    try {
      story = resolveStory(floor).story;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      return result;
    }
  }

  const segments = planSegments(story, { count: total, mark });
  result.segments = segments;
  if (!segments.length) {
    result.errors.push('正文是空的,没有可编译的内容');
    return result;
  }

  // 重出这一楼:先把上一轮插进去的图清场,免得叠成一片
  if (!options.keepExisting) {
    document
      .querySelectorAll<HTMLElement>(`#chat .mes[mesid="${floor}"] .${INLINE_CLASS}`)
      .forEach(node => node.remove());
  }

  ensureStatusCard(floor, '绘图姬·中转站 · 生成中', `0/${segments.length} 准备中…`);

  try {
    for (const [index, segment] of segments.entries()) {
      const label = segments.length > 1 ? `第 ${index + 1}/${segments.length} 张` : '';
      paintStatus(floor, '绘图姬·中转站 · 生成中', `${label} 正在编译提示词…`, []);

      const note =
        segments.length > 1
          ? `这是整楼里的第 ${index + 1}/${segments.length} 个画面,只画这一段里正在发生的事,不要画其它段落。` +
            (options.note ? ` ${options.note}` : '')
          : options.note ?? '';

      const output = await runChain({
        floor,
        story: segment.text,
        note,
        signal: controller.signal,
        onStatus: text => paintStatus(floor, '绘图姬·中转站 · 生成中', `${label} ${text}`, []),
      });

      paintStatus(floor, '绘图姬·中转站 · 生成中', `${label} 正在落地图片…`, []);

      // blob URL → data URL:不转成 base64,刷新后就是一片空白
      const image = await toDataUrl(output.image.url);
      try {
        output.image.revoke();
      } catch {
        /* 已经是 data URL 时没有可释放的句柄 */
      }

      const anchor = options.anchor && segments.length === 1 ? options.anchor : segment.anchor;
      const entry: StoredImage = {
        id: newImageId(),
        chatId,
        floor,
        swipe,
        index,
        total: segments.length,
        positive: output.positive,
        negative: output.negative,
        compiled: output.compiled,
        seed: output.seed,
        image,
        anchor,
        anchorStart: segment.anchorStart,
        segmentIndex: index,
        createdAt: Date.now(),
      };

      const persisted = settings.gallery.persist && !!image;
      if (settings.gallery.persist) {
        // 存进去(即便 image 是空串也别丢掉这条记录:提示词、锚点、seed 还有用;
        // 水合时会在正文里画一个「图丢了」的占位,点开能重新出)。
        await saveStoredImage(entry);
        await trimChatImages(chatId, settings.gallery.limit);
        if (!image) {
          result.errors.push('图片没能转成 data URL,刷新后会丢;这张的提示词仍保存在图库');
        }
      }
      if (!persisted && settings.gallery.persist) {
        const health = await storageHealth();
        if (!health.ok) result.errors.push(`图库落盘不可用:${health.message}`);
      }
      result.images.push(entry);
      if (floor >= 0) await placeImage(floor, entry, captionOf(index, segments.length, output.positive));
      paintStatus(floor, '绘图姬·中转站 · 生成中', `${label} 完成(${index + 1}/${segments.length})`, []);
    }

    dropStatusCard(floor);
    return result;
  } catch (error) {
    const aborted =
      controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    const messageText = aborted ? '已取消' : error instanceof Error ? error.message : String(error);
    result.errors.push(messageText);
    if (result.images.length) {
      // 已经出了几张:状态卡退场,图留着
      dropStatusCard(floor);
    } else {
      ensureStatusCard(floor, '绘图姬·中转站 · 失败', messageText);
      paintStatus(floor, '绘图姬·中转站 · 失败', messageText, [
        { label: '重试', run: () => void illustrateFloor(floor, options) },
        { label: '关闭', run: () => dropStatusCard(floor) },
      ]);
    }
    return result;
  } finally {
    if (controllers.get(key) === controller) controllers.delete(key);
  }
}

/** 兼容旧调用点的名字:返回本次出图结果(不再返回内存 record)。 */
export async function generateIntoFloor(
  floor: number,
  options: IllustrateOptions = {},
): Promise<IllustrateResult> {
  return illustrateFloor(floor, options);
}

/** 取消某楼正在跑的生成(含多张里已排队的那几张)。 */
export function cancelFloor(floor: number): void {
  controllers.get(lockKey(currentChatId(), floor))?.abort();
}

/* ---------------- 水合:刷新后把图挂回去 ---------------- */

/** 这一楼当前 DOM 里已经挂着的图 id 顺序。 */
function renderedIds(floor: number): string[] {
  return [...document.querySelectorAll<HTMLElement>(`#chat .mes[mesid="${floor}"] .${INLINE_CLASS}`)]
    .map(node => node.dataset.htjImageId ?? '')
    .filter(Boolean);
}

/** 把某一楼已存下来的图挂回正文(幂等:顺序没变就什么都不做)。 */
export async function hydrateFloor(floor: number): Promise<void> {
  const ctx = getContext();
  const message = ctx?.chat?.[floor];
  if (!message) return;
  if (!mesTextNode(floor)) return;

  const chatId = currentChatId();
  const swipe = swipeOf(message);
  const stored = await listFloorImages(chatId, floor, swipe);
  const wanted = stored.map(entry => entry.id);
  const existing = renderedIds(floor);
  if (wanted.length === existing.length && wanted.every((id, i) => id === existing[i])) return;

  hydrateFloorImages(
    floor,
    stored.map(entry => ({
      id: entry.id,
      image: entry.image,
      anchor: entry.anchor,
      anchorStart: entry.anchorStart ?? '',
      caption: captionOf(entry.index, stored.length, entry.positive),
      onRemove: id => {
        void deleteStoredImage(id);
        document
          .querySelectorAll<HTMLElement>(`.${INLINE_CLASS}[data-htj-image-id="${id}"]`)
          .forEach(node => node.remove());
      },
    })),
  );
}

/** 把当前聊天里所有已渲染楼层的图挂回去。 */
export async function hydrateAll(): Promise<void> {
  const ctx = getContext();
  if (!ctx?.chat) return;
  for (let floor = 0; floor < ctx.chat.length; floor++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await hydrateFloor(floor);
    } catch {
      /* 单楼失败不该拖垮整轮水合 */
    }
  }
}

/* ---------------- 图库 → 正文 ---------------- */

/**
 * 把一张**已存在的**图挂回它自己的楼层与段落(图库页「插回正文」)。
 *
 * 与 hydrateFloor 的区别:这是显式动作,楼层里已经挂着这张图时也要重新插一遍
 * (用户可能刚删过 DOM 上的那张),并且不碰这一楼的其它图。
 *
 * @returns 是否真的插进 DOM(楼层还没渲染出来 → false,调用方提示用户先滚到那一楼)
 */
export async function insertStoredImageIntoFloor(entry: StoredImage): Promise<boolean> {
  const ctx = getContext();
  if (!ctx) return false;
  if (entry.floor < 0) return false;
  if ((ctx.getCurrentChatId?.() ?? '') !== entry.chatId) return false;
  const total = entry.total && entry.total > 0 ? entry.total : 1;
  const caption = captionOf(entry.index, total, entry.positive);
  const options: InlineImageOptions = {
    id: entry.id,
    image: entry.image,
    anchor: entry.anchor,
    anchorStart: entry.anchorStart,
    caption,
    onRemove: id => {
      void deleteStoredImage(id);
      document
        .querySelectorAll<HTMLElement>(`.${INLINE_CLASS}[data-htj-image-id="${id}"]`)
        .forEach(node => node.remove());
    },
  };
  // 已经挂着同一个 id:换掉它(用户可能手动删过锚点上的位置)
  document
    .querySelectorAll<HTMLElement>(`#chat .mes[mesid="${entry.floor}"] .${INLINE_CLASS}[data-htj-image-id="${entry.id}"]`)
    .forEach(node => node.remove());
  for (let attempt = 0; attempt < 4; attempt++) {
    if (insertFloorImage(entry.floor, options)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  return false;
}

/** 让楼层滚进视野(图库点「插回正文」之后)。 */
export function revealFloor(floor: number): void {
  const node = document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"]`);
  if (!node) return;
  try {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch {
    node.scrollIntoView();
  }
  node.classList.add('htj-zz-flash');
  setTimeout(() => node.classList.remove('htj-zz-flash'), 1200);
}

/** 把当前聊天里所有已渲染楼层的图挂回去。 */

/** 换聊天:清掉上一轮的 DOM 状态(图本身按 chatId 隔离,不会串)。 */
export function resetFloorCards(): void {
  statusCards.forEach(node => node.remove());
  statusCards.clear();
}
