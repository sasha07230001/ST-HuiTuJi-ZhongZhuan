/**
 * 楼层里的出图卡。
 *
 * 设计取舍:
 * - 生成的数据(图片 data URL、提示词、状态)全部放在模块内的 Map 里,以
 *   「聊天 id + 楼层 + swipe」为键;正文里只存一个占位符 `<htj-zz-card seq="0">`。
 *   这样几千张 base64 图不会把聊天记录撑爆,ST 重渲染楼层也不会丢图。
 * - 卡片挂载是幂等的:楼层重渲染后重新 hydrate 一遍即可。
 */

import { runWorkflow } from '@/comfy/api';
import { randomSeed, renderWorkflow } from '@/comfy/workflow';
import { runChain } from '@/relay/orchestrator';
import { getSettings } from '@/state/settings';
import { getContext, reloadMessageDom, type STMessage } from '@/st/context';

export type CardState = 'idle' | 'running' | 'done' | 'error';

export interface CardRecord {
  /** 正向提示词(含画风词)。 */
  positive: string;
  /** 中转站原始输出。 */
  compiled: string;
  /** image data url;空 = 还没出图。 */
  imageUrl: string;
  state: CardState;
  /** 运行中的人话状态 / 失败原因。 */
  status: string;
  seed: number;
}

const TAG_NAME = 'htj-zz-card';
const records = new Map<string, CardRecord>();
const running = new Map<string, AbortController>();

function cardKey(chatId: string, floor: number, swipeId: number): string {
  return `${chatId}\u0000${floor}\u0000${swipeId}`;
}

function currentChatId(): string {
  return getContext()?.getCurrentChatId?.() ?? '';
}

function swipeOf(message: STMessage | undefined): number {
  return typeof message?.swipe_id === 'number' ? message.swipe_id : 0;
}

export function getCardRecord(key: string): CardRecord | undefined {
  return records.get(key);
}

export function setCardRecord(key: string, record: CardRecord): void {
  records.set(key, record);
}

/**
 * 旧版本残留的占位符清理器。
 *
 * 本扩展现在**不再往正文写占位符**;这个函数只用于把旧版留在聊天记录里的
 * `<htj-zz-card>` 洗掉(那些正是破坏用户正则的元凶)。新代码不应调用它以外的写操作。
 */
export function stripCardPlaceholders(text: string): string {
  return text.replace(new RegExp(`<${TAG_NAME}[\\s\\S]*?</${TAG_NAME}>`, 'gi'), '').trimEnd();
}

/** 判断正文里是否残留旧版占位符。 */
export function hasLegacyPlaceholder(text: string): boolean {
  return new RegExp(`<${TAG_NAME}`, 'i').test(text);
}

/**
 * 把某楼的一张图跑完整条链,并把状态推到卡片上。
 * 卡片 DOM 已挂载时实时更新;未挂载时只更新 record,下一次 hydrate 读取。
 */
export async function generateIntoFloor(
  floor: number,
  options: { story?: string; note?: string; seq?: number } = {},
): Promise<CardRecord | null> {
  const ctx = getContext();
  if (!ctx) return null;
  const chatId = ctx.getCurrentChatId?.() ?? '';
  const message = ctx.chat?.[floor];
  const swipeId = swipeOf(message);
  const key = cardKey(chatId, floor, swipeId);
  const seq = options.seq ?? 0;

  running.get(key)?.abort();
  const controller = new AbortController();
  running.set(key, controller);

  const record: CardRecord = records.get(key) ?? {
    positive: '',
    compiled: '',
    imageUrl: '',
    state: 'idle',
    status: '',
    seed: 0,
  };
  record.state = 'running';
  record.status = '准备中…';
  records.set(key, record);
  // 先把卡片容器建出来:即使正文里的占位符还没渲染成 DOM,也要有个挂载点。
  ensureCardContainer(floor, seq);
  paint(floor, seq, record);

  try {
    const result = await runChain({
      floor,
      story: options.story,
      note: options.note,
      signal: controller.signal,
      onStatus: text => {
        record.status = text;
        paint(floor, seq, record);
      },
    });
    record.positive = result.positive;
    record.compiled = result.compiled;
    record.imageUrl = result.image.url;
    record.seed = result.seed;
    record.state = 'done';
    record.status = '';
    records.set(key, record);
    // 出图成功 → 把图真正插进楼层并重渲染,而不是只改内存里的 record。
    await commitImageToFloor(floor, record);
    return record;
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    record.state = aborted ? 'idle' : 'error';
    record.status = aborted ? '已取消' : error instanceof Error ? error.message : String(error);
    records.set(key, record);
    paint(floor, seq, record);
    return record;
  } finally {
    if (running.get(key) === controller) running.delete(key);
  }
}

/**
 * 把记录里的图落进楼层。
 *
 * 两条铁律(都是实测踩出来的):
 *
 * 1. **绝不写 message.mes**。往正文插 `<htj-zz-card>` 会让 ST 整条消息重跑正则,
 *    用户「状态美化 / 选项美化」的匹配区间被破坏,面板退化成源码。
 * 2. **绝不调 updateMessageBlock 重渲染**。ST 的整楼重渲染会把正则产出的
 *    iframe 全部拆掉且不再重建(实测 iframe 3 → 0),状态栏直接消失。
 *
 * 所以卡片只活在 DOM 层:直接在 .mes_text 末尾挂一个节点。
 * 楼层被 ST 重渲染时(切 swipe、编辑等),由 hydrateAll 重新挂回。
 */
async function commitImageToFloor(floor: number, record: CardRecord): Promise<void> {
  // .mes_text 可能正被 ST 替换,给它几个短帧重试;但不触发任何重渲染。
  for (let attempt = 0; attempt < 6; attempt++) {
    const holder = ensureCardContainer(floor, 0);
    if (holder) {
      renderCardInto(holder, record, floor, 0);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * 保证楼层 DOM 里有一个 .htj-zz-card 挂载点。
 *
 * 只在 .mes_text 末尾追加,不依赖正文里存在任何标签——
 * 因为本扩展不再往 message.mes 里写占位符。
 */
function ensureCardContainer(floor: number, seq: number): HTMLElement | null {
  const mesNode = document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"]`);
  const textNode = mesNode?.querySelector<HTMLElement>('.mes_text');
  if (!textNode) return null;
  ensureStyle();

  const existing = textNode.querySelector<HTMLElement>(`.htj-zz-card[data-seq="${seq}"]`);
  if (existing) return existing;

  const holder = document.createElement('div');
  holder.className = 'htj-zz-card';
  holder.dataset.seq = String(seq);
  textNode.append(holder);
  return holder;
}

/** 取消某楼在跑的生成。 */
export function cancelFloor(floor: number): void {
  const ctx = getContext();
  const key = cardKey(ctx?.getCurrentChatId?.() ?? '', floor, swipeOf(ctx?.chat?.[floor]));
  running.get(key)?.abort();
}

/* ---------------- DOM ---------------- */

function paint(floor: number, seq: number, record: CardRecord): void {
  // 注意:按 **class** 找,不按标签名。挂载点是我们自己造的 div.htj-zz-card;
  // 用标签名 htj-zz-card 会永远匹配不到(已实测踩到,表现为卡片空白无内容)。
  const node = document.querySelector<HTMLElement>(
    `#chat .mes[mesid="${floor}"] .htj-zz-card[data-seq="${seq}"]`,
  );
  if (node) renderCardInto(node, record, floor, seq);
}

function renderCardInto(node: HTMLElement, record: CardRecord, floor: number, seq: number): void {
  let body = node.querySelector<HTMLElement>('.htj-zz-card-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'htj-zz-card-body';
    node.append(body);
  }

  const title =
    record.state === 'running'
      ? '绘图姬·中转站 · 生成中'
      : record.state === 'error'
        ? '绘图姬·中转站 · 失败'
        : '绘图姬·中转站';

  const head = document.createElement('div');
  head.className = 'htj-zz-card-head';
  const titleEl = document.createElement('b');
  titleEl.textContent = title;
  const statusEl = document.createElement('span');
  statusEl.className = 'htj-zz-card-status';
  statusEl.textContent = record.status || '';
  head.append(titleEl, statusEl);

  const parts: Node[] = [head];

  if (record.imageUrl) {
    const link = document.createElement('a');
    link.href = record.imageUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'htj-zz-card-image';
    const img = document.createElement('img');
    img.src = record.imageUrl;
    img.alt = '生成的图片';
    link.append(img);
    parts.push(link);
  }
  if (record.positive) parts.push(promptBlock('正向提示词', record.positive));
  if (record.compiled && record.compiled !== record.positive) {
    parts.push(promptBlock('中转站原始输出', record.compiled));
  }
  parts.push(controls(floor, seq, record));

  body.replaceChildren(...parts);
}

function promptBlock(label: string, text: string): HTMLElement {
  const wrap = document.createElement('details');
  wrap.className = 'htj-zz-card-prompt';
  const summary = document.createElement('summary');
  summary.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = text;
  wrap.append(summary, pre);
  return wrap;
}

function controls(floor: number, seq: number, record: CardRecord): HTMLElement {
  const row = el('div', 'htj-zz-card-actions');
  const running_ = record.state === 'running';

  const regen = button('重新生成', () => {
    void generateIntoFloor(floor, { seq });
  }, running_);
  const cancel = button('取消', () => cancelFloor(floor), !running_);

  const copy = button('复制提示词', () => {
    if (!record.positive) return;
    void navigator.clipboard?.writeText(record.positive);
  }, !record.positive);

  const edit = button('编辑提示词', async () => {
    const next = window.prompt('修改正向提示词(保存后重新出图)', record.positive);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    await regenerateWithPrompt(floor, seq, trimmed);
  }, running_ || !record.positive);

  const remove = button('移除卡片', () => {
    // 只删 DOM 节点与记录,不碰正文——正文归用户和正则脚本所有
    const ctx = getContext();
    const key = cardKey(ctx?.getCurrentChatId?.() ?? '', floor, swipeOf(ctx?.chat?.[floor]));
    records.delete(key);
    running.get(key)?.abort();
    document
      .querySelectorAll<HTMLElement>(`#chat .mes[mesid="${floor}"] .htj-zz-card[data-seq="${seq}"]`)
      .forEach(node => node.remove());
  });

  row.append(regen, cancel, copy, edit, remove);
  return row;
}

/** 用一张手改过的提示词直接出图(跳过中转站)。 */
async function regenerateWithPrompt(floor: number, seq: number, positive: string): Promise<void> {
  const ctx = getContext();
  const key = cardKey(ctx?.getCurrentChatId?.() ?? '', floor, swipeOf(ctx?.chat?.[floor]));
  const record = records.get(key);
  if (!record) return;
  const s = getSettings();
  record.state = 'running';
  record.status = '按手改的提示词出图…';
  paint(floor, seq, record);
  try {
    const seed = randomSeed();
    const workflow = renderWorkflow(s.comfy.workflow, { prompt: positive, negative: s.prompt.negative, seed });
    const image = await runWorkflow(s.comfy, workflow);
    record.positive = positive;
    record.imageUrl = image.url;
    record.seed = seed;
    record.state = 'done';
    record.status = '';
  } catch (error) {
    record.state = 'error';
    record.status = error instanceof Error ? error.message : String(error);
  }
  records.set(key, record);
  paint(floor, seq, record);
}

function button(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'menu_button htj-zz-card-btn';
  node.textContent = label;
  node.disabled = disabled;
  node.addEventListener('click', event => {
    event.stopPropagation();
    onClick();
  });
  return node;
}

function el(tag: string, className: string, ...children: (Node | null)[]): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child) node.append(child);
  return node;
}

/* ---------------- 挂载 ---------------- */

/** 给自定义元素定义样式(只在第一次挂载时注入)。 */
function ensureStyle(): void {
  if (document.getElementById('htj-zz-style')) return;
  const style = document.createElement('style');
  style.id = 'htj-zz-style';
  style.textContent = CARD_CSS;
  document.head.append(style);
}

/**
 * 把内存里的出图记录挂回楼层 DOM。幂等,ST 每次重渲染消息后都要调一次。
 * 只读 message,绝不写——正文归用户和正则脚本所有。
 */
export function hydrateFloor(floor: number): void {
  const ctx = getContext();
  const message = ctx?.chat?.[floor];
  if (!message) return;
  const key = cardKey(ctx?.getCurrentChatId?.() ?? '', floor, swipeOf(message));
  const record = records.get(key);
  if (!record) return;
  const holder = ensureCardContainer(floor, 0);
  if (holder) renderCardInto(holder, record, floor, 0);
}

/** 把全聊天里还带着占位符的楼层都挂一遍。 */
export function hydrateAll(): void {
  const ctx = getContext();
  if (!ctx?.chat) return;
  for (let floor = 0; floor < ctx.chat.length; floor++) hydrateFloor(floor);
}

const CARD_CSS = `
.htj-zz-card {
  margin: 0.75em 0;
  padding: 0.75em;
  border-radius: 10px;
  border: 1px solid var(--SmartThemeBorderColor, rgba(128,128,128,.35));
  background: var(--SmartThemeBlurTintColor, rgba(0,0,0,.15));
  font-size: 0.95em;
}
.htj-zz-card-head { display: flex; gap: .75em; align-items: baseline; flex-wrap: wrap; margin-bottom: .5em; }
.htj-zz-card-head b { font-weight: 600; }
.htj-zz-card-status { opacity: .75; font-size: .85em; }
.htj-zz-card-image { display: block; }
.htj-zz-card-image img { max-width: 100%; border-radius: 8px; display: block; }
.htj-zz-card-prompt { margin: .5em 0 0; font-size: .85em; }
.htj-zz-card-prompt summary { cursor: pointer; opacity: .8; }
.htj-zz-card-prompt pre { white-space: pre-wrap; word-break: break-word; margin: .35em 0 0; opacity: .9; }
.htj-zz-card-actions { display: flex; gap: .5em; flex-wrap: wrap; margin-top: .6em; }
.htj-zz-card-btn { width: auto !important; }
`;
