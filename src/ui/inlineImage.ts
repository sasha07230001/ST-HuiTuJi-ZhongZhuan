/**
 * 原位回插：把生成的图插进楼层正文的对应位置，而不是一律堆在末尾。
 *
 * 为什么只在 DOM 层动手、绝不改 message.mes：
 * 往正文里写标签会让 ST 整条消息重跑正则，用户「状态美化 / 选项美化」的匹配区间
 * 会被破坏（历史版本踩过，状态栏直接退化成源码）。所以这里只找 DOM 里的文本节点，
 * 把图片块插在它后面；楼层被 ST 重渲染后由 hydrate 重新挂回。
 *
 * 定位方式：每张图带着「这段正文的结尾若干字」（anchor），在 .mes_text 的可见文本里
 * 找最后一次出现的位置，插在它所在的段落之后。找不到就退化到楼层末尾。
 */

export const INLINE_CLASS = 'htj-zz-inline-image';
const MIN_ANCHOR = 4;

export interface InlineImageOptions {
  id: string;
  image: string;
  anchor: string;
  /** 这段正文的开头若干字。锚点(DOM 里改过 / 楼层被 ST 重渲染过)找不到时用它兜底。 */
  anchorStart?: string;
  /** 图下的说明（第几张 / 提示词摘要）。 */
  caption?: string;
  /** 是否是占位（生成中）。 */
  pending?: boolean;
  /** 点删除时回调。 */
  onRemove?: (id: string) => void;
}

/** CSS.escape 在部分环境（老 Safari / jsdom）没有，自己兜一个。 */
function escapeId(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (css?.escape) return css.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

function mesTextNode(floor: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"] .mes_text`);
}

interface TextHit {
  node: Text;
  offset: number;
}

/** 弯引号/全角空格这类「看起来一样」的字符统一掉,免得锚点和渲染后的正文对不上。 */
function normalizeChar(ch: string): string {
  if (ch === '“' || ch === '”') return '"';
  if (ch === '‘' || ch === '’') return "'";
  if (ch === '\u00a0' || ch === '\u3000') return ' ';
  return ch;
}

/**
 * 把所有文本节点拼起来找 needle 的最后一次出现。
 *
 * 两个坑,这里都吃掉:
 * 1. **段落边界**:锚点正好在某段结尾时,`endPos` 会等于下一段的起点。
 *    老实现用 `endPos >= starts[i]` 判断,于是把图挂到了下一段后面(插低一段)。
 *    改成用「最后一个匹配字符的位置」判定就对了。
 * 2. **空白与引号**:锚点来自清洗过的正文(空白被折叠),DOM 里却保留原文换行;
 *    所以先做一次「去空白 + 规范引号」的归一化再匹配,命中率明显更高。
 */
function findLastTextHit(root: HTMLElement, needle: string): TextHit | null {
  if (!needle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let acc = '';
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    nodes.push(text);
    starts.push(acc.length);
    acc += text.data;
    current = walker.nextNode();
  }
  if (!nodes.length) return null;

  const locate = (endExclusive: number): TextHit | null => {
    const lastPos = endExclusive - 1;
    if (lastPos < 0) return null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (lastPos >= starts[i]) return { node: nodes[i], offset: lastPos - starts[i] + 1 };
    }
    return { node: nodes[0], offset: 0 };
  };

  // 先试原文精确匹配
  const exact = acc.lastIndexOf(needle);
  if (exact >= 0) return locate(exact + needle.length);

  // 再做「去空白 + 规范引号」的归一化匹配,需要一张回原坐标的表
  const chars: string[] = [];
  const backMap: number[] = [];
  for (let i = 0; i < acc.length; i++) {
    const ch = normalizeChar(acc[i]);
    if (/\s/.test(ch)) continue;
    chars.push(ch);
    backMap.push(i);
  }
  const haystack = chars.join('');
  const target = [...needle].map(normalizeChar).filter(ch => !/\s/.test(ch)).join('');
  if (!target) return null;

  const candidates = [target];
  // 兜底:只用结尾一小段(前面可能有表情符号/特殊排版对不齐)
  if (target.length > MIN_ANCHOR * 2) candidates.push(target.slice(-Math.min(16, target.length)));

  for (const candidate of candidates) {
    if (candidate.length < MIN_ANCHOR) continue;
    const at = haystack.lastIndexOf(candidate);
    if (at < 0) continue;
    const rawStart = backMap[at];
    const rawEnd = backMap[at + candidate.length - 1] + 1;
    if (rawStart === undefined || rawEnd === undefined) continue;
    return locate(rawEnd);
  }
  return null;
}

/** 从文本节点往上爬到 .mes_text 的直接子元素（段落级），好在它后面整块插入。 */
function blockAncestor(root: HTMLElement, node: Node): HTMLElement | null {
  let current: Node | null = node;
  while (current && current.parentNode !== root) {
    current = current.parentNode;
  }
  return current instanceof HTMLElement ? current : null;
}

/**
 * 「这段正文开头」的位置。
 *
 * 尾锚点失效的典型场景:用户改了这一段的最后一句、或 ST 的某个正则把正文拆进了
 * 别的节点。这时候还能靠开头那截字找到这一段,图不至于被甩到楼层末尾。
 */
function findFirstTextHit(root: HTMLElement, needle: string): TextHit | null {
  const target = [...String(needle ?? '')].map(normalizeChar).filter(ch => !/\s/.test(ch)).join('');
  if (target.length < MIN_ANCHOR) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const backMap: Array<{ node: number; offset: number }> = [];
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    const base = nodes.length;
    nodes.push(text);
    for (let i = 0; i < text.data.length; i++) {
      const ch = normalizeChar(text.data[i]);
      if (/\s/.test(ch)) continue;
      backMap.push({ node: base, offset: i });
    }
    current = walker.nextNode();
  }
  if (!backMap.length) return null;
  const haystack = backMap.map(x => normalizeChar(nodes[x.node].data[x.offset])).join('');
  const at = haystack.indexOf(target.slice(0, Math.min(16, target.length)));
  if (at < 0) return null;
  const hit = backMap[at];
  return hit ? { node: nodes[hit.node], offset: hit.offset } : null;
}

function buildBlock(options: InlineImageOptions): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `${INLINE_CLASS}${options.pending ? ' is-pending' : ''}`;
  wrap.dataset.htjImageId = options.id;

  if (options.image) {
    const link = document.createElement('a');
    link.href = options.image;
    link.target = '_blank';
    link.rel = 'noopener';
    const img = document.createElement('img');
    img.src = options.image;
    img.alt = options.caption ?? '生成图';
    img.loading = 'lazy';
    link.append(img);
    wrap.append(link);
  } else {
    const pending = document.createElement('div');
    pending.className = 'htj-zz-inline-pending';
    pending.textContent = options.caption ?? '生成中…';
    wrap.append(pending);
  }

  const bar = document.createElement('div');
  bar.className = 'htj-zz-inline-bar';
  const cap = document.createElement('span');
  cap.className = 'htj-zz-inline-cap';
  cap.textContent = options.caption ?? '';
  bar.append(cap);
  if (options.onRemove) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'menu_button htj-zz-inline-del';
    del.textContent = '删除这张';
    del.addEventListener('click', event => {
      event.stopPropagation();
      options.onRemove?.(options.id);
    });
    bar.append(del);
  }
  wrap.append(bar);
  return wrap;
}

/**
 * 默认插入点：楼层正文末尾。整楼只有一张图且没有标记时就走这里。
 */
function appendToFloor(floor: number, block: HTMLElement): boolean {
  const host = mesTextNode(floor);
  if (!host) return false;
  host.append(block);
  return true;
}

/**
 * 插一张图。
 * @returns 是否找到楼层 DOM 并插入成功（楼层还没渲染出来时返回 false，交给 hydrate 重试）
 */
export function insertFloorImage(floor: number, options: InlineImageOptions): boolean {
  const host = mesTextNode(floor);
  if (!host) return false;

  const existing = host.querySelector<HTMLElement>(`.${INLINE_CLASS}[data-htj-image-id="${escapeId(options.id)}"]`);
  const block = buildBlock(options);
  if (existing) {
    existing.replaceWith(block);
    return true;
  }

  const hit = findLastTextHit(host, options.anchor) ?? findFirstTextHit(host, options.anchorStart ?? '');
  if (!hit) return appendToFloor(floor, block);

  const blockEl = blockAncestor(host, hit.node);
  if (!blockEl) {
    // 文本直接挂在 .mes_text 下：插到该文本节点之后
    hit.node.parentNode?.insertBefore(block, hit.node.nextSibling);
    return true;
  }

  // 同一个锚点上可能已经挂过图（多张图切到同一段），插到已有图之后，保持顺序
  let cursor: Element = blockEl;
  while (cursor.nextElementSibling?.classList.contains(INLINE_CLASS)) {
    cursor = cursor.nextElementSibling;
  }
  cursor.parentNode?.insertBefore(block, cursor.nextSibling);
  return true;
}

/** 移除某张图的 DOM（只动扩展自己插的节点）。 */
export function removeFloorImage(id: string): void {
  document
    .querySelectorAll<HTMLElement>(`.${INLINE_CLASS}[data-htj-image-id="${escapeId(id)}"]`)
    .forEach(node => node.remove());
}

/** 移除某楼里所有扩展插入的图（「重插图」前清场）。 */
export function removeFloorImages(floor: number): void {
  document
    .querySelectorAll<HTMLElement>(`#chat .mes[mesid="${floor}"] .${INLINE_CLASS}`)
    .forEach(node => node.remove());
}

/** 把某楼已存在的图重新按锚点排一遍（ST 重渲染后 hydrate 用）。 */
export function hydrateFloorImages(floor: number, entries: InlineImageOptions[]): void {
  removeFloorImages(floor);
  for (const entry of entries) insertFloorImage(floor, entry);
}
