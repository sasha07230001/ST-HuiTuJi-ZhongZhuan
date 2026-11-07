/**
 * 正文分段：一次出多张图时，决定「哪一段正文对应哪一张图」。
 *
 * 两种模式：
 * 1. **标记模式**（推荐）：正文里写 `[[图]]`（可改），每个标记前后切一刀，
 *    一段配一张图，图最后插回标记所在的正文位置。
 * 2. **均分模式**：正文里没有标记时，按张数把正文尽量均匀地切成 N 段
 *    （先按空行，再按单换行/句末标点，最后才按字符硬切）。
 *
 * 纯函数，不碰宿主，单测直接跑。
 */

/** 默认锚点标记。用户在正文里写它，就是「这里要一张图」。 */
export const DEFAULT_SEGMENT_MARK = '[[图]]';

/** 一次最多出几张。再多就该拆楼层了，ComfyUI 排队也不划算。 */
export const MAX_SEGMENTS = 8;

/** 回插定位片段的长度：取该段正文结尾这么多字，在渲染后的 DOM 里找它。 */
const ANCHOR_LEN = 32;

export interface StorySegment {
  /** 第几张（从 0 起）。 */
  index: number;
  /** 送给中转站的正文片段（已去掉标记本身）。 */
  text: string;
  /** 回插定位片段：该段结尾的若干字，用于在 .mes_text 里定位插入点。 */
  anchor: string;
  /** 回插兜底片段：该段开头的若干字（尾部被改过 / ST 重渲染改过空白时用）。 */
  anchorStart: string;
  /** 这一段在整楼里从第几个字符开始（分段预览与调试用）。 */
  offset: number;
}

export interface SegmentPlanOptions {
  /** 期望张数（标记模式下达不到也无所谓）。 */
  count?: number;
  /** 锚点标记。 */
  mark?: string;
}

/** 标记统一成一个非空字符串；用户清空输入框时回落到默认标记。 */
export function normalizeMark(mark: string | undefined | null): string {
  const m = String(mark ?? '').trim();
  return m || DEFAULT_SEGMENT_MARK;
}

/** 张数收敛到 1..MAX_SEGMENTS；脏数据按 1 处理。 */
export function clampCount(count: unknown): number {
  const n = Math.round(Number(count));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_SEGMENTS, n);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 回插定位片段：正文结尾若干字（折叠空白，便于和渲染后的文本对上）。 */
export function anchorOf(text: string): string {
  const flat = collapse(text);
  if (!flat) return '';
  return flat.length <= ANCHOR_LEN ? flat : flat.slice(-ANCHOR_LEN);
}

/** 回插定位片段：正文开头若干字。尾锚点被改过时用它兜底。 */
export function headOf(text: string): string {
  const flat = collapse(text);
  if (!flat) return '';
  return flat.length <= ANCHOR_LEN ? flat : flat.slice(0, ANCHOR_LEN);
}

/** 按标记切段；没有标记时返回整段。 */
export function splitByMark(story: string, mark: string): string[] {
  const m = normalizeMark(mark);
  return String(story ?? '')
    .split(m)
    .map(part => part.trim())
    .filter(Boolean);
}

/**
 * 把正文尽量均匀地切成 count 段。
 *
 * 优先用作者的段落结构：空行 → 单换行/句末标点 → 字符硬切。
 * 硬切是最后手段：宁可切开一句话，也不能少出一张图。
 */
export function splitEven(story: string, count: number): string[] {
  const text = String(story ?? '').trim();
  if (!text) return [];
  const n = clampCount(count);
  if (n <= 1) return [text];

  let chunks = text
    .split(/\n{2,}/)
    .map(c => c.trim())
    .filter(Boolean);

  if (chunks.length < n) {
    const finer = text
      .split(/(?<=[。！？!?…」』）)\n])/)
      .map(c => c.trim())
      .filter(Boolean);
    if (finer.length > chunks.length) chunks = finer;
  }

  if (chunks.length < n) {
    const size = Math.ceil(text.length / n);
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size).trim());
    return out.filter(Boolean).slice(0, n);
  }

  // 段落数够：按「每组合并多少段」压成 n 组，尽量等量
  const per = Math.ceil(chunks.length / n);
  const groups: string[] = [];
  for (let i = 0; i < chunks.length; i += per) {
    groups.push(chunks.slice(i, i + per).join('\n\n'));
  }
  return groups.slice(0, n);
}

/**
 * 出图的唯一分段入口。
 *
 * - 正文里有标记 → 按标记切（张数由标记数量决定）；
 * - 没有标记 → 按 count 均分。
 */
export function planSegments(story: string, options: SegmentPlanOptions = {}): StorySegment[] {
  const text = String(story ?? '').trim();
  if (!text) return [];
  const mark = normalizeMark(options.mark);
  const parts = text.includes(mark) ? splitByMark(text, mark) : splitEven(text, clampCount(options.count));
  let cursor = 0;
  return parts.map((part, index) => {
    // offset 只是「大致从哪起」,用于预览里标出「第几张对应正文第几段」;
    // 用 indexOf 从上一段之后找,避免完全相同的两段都指到第一处。
    const head = part.slice(0, 12);
    const at = head ? text.indexOf(head, cursor) : -1;
    if (at >= 0) cursor = at;
    return {
      index,
      text: part,
      anchor: anchorOf(part),
      anchorStart: headOf(part),
      offset: at >= 0 ? at : cursor,
    };
  });
}
