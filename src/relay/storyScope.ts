/**
 * 剧情范围:只把用户圈定标签包住的那块正文当剧情,送给中转站编译。
 *
 * 移植自绘图🐔二号(ST-HuiTuJi-2)的 autoTag/storyScope.ts,原样保留它的纪律:
 *
 * **宁可少清洗,也不能把剧情洗没。**
 * - 没配范围 → 原样。
 * - 配了但没匹配到任何成对块 → 原样(标签可能只是文本里出现,或换了写法)。
 * - 生效的判据只有一个:**有成对的 `<标签>…</标签>` 且内容非空**。
 *
 * 为什么需要:模型常在正文外写思维链、状态块、格式示例(`<StatusPlaceHolderImpl/>`
 * 之类),那些字一起喂给中转站就是纯噪音,会污染画面。
 */

/** 标签外内容占比超过这个值只打日志,不改变结果。 */
export const STORY_SCOPE_NOISE_LIMIT = 0.5;

export type StoryScopePick = 'all' | 'last' | 'first';

export interface StoryScopeResult {
  /** 取到的剧情;null = 本次不生效,调用方按整楼处理。 */
  text: string | null;
  /** 用到的标签名(去重)。 */
  matchedTags: string[];
  /** 命中的成对块数。 */
  blockCount: number;
  /** 没生效的原因,写日志用。 */
  reason: string;
}

/**
 * 把配置文本拆成标签名。支持逗号/中文逗号/顿号/空白分隔,
 * 也允许直接粘 `<content>`、`content_fox~` 这类带壳写法。
 */
export function parseStoryScopeTagNames(raw: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const piece of String(raw ?? '').split(/[,，、\s]+/)) {
    const clean = piece
      .trim()
      .replace(/^<\??\/?/, '')
      .replace(/~?\/?>$/, '')
      .replace(/~$/, '')
      .replace(/\/$/, '')
      .trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(clean);
  }
  return names;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `<name …>…</name>` 成对块(大小写不敏感,兼容 `~` 波浪壳)。 */
function pairedBlockRegex(name: string): RegExp {
  const n = escapeRegex(name);
  return new RegExp(`<(${n})~?[^>]*>([\\s\\S]*?)<\\/\\1~?>`, 'gi');
}

function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

function stripMatchedBlocks(text: string, tags: string[]): string {
  let out = text;
  for (const name of tags.map(tag => tag.trim()).filter(Boolean)) {
    out = out.replace(pairedBlockRegex(name), ' ');
  }
  return out;
}

/**
 * 按剧情范围标签从整楼正文里取出剧情。只认成对块;
 * 标签只是出现、没包住内容时一律不猜,回退整楼是安全默认。
 */
export function extractStoryScope(
  source: string,
  tags: string[],
  pick: StoryScopePick = 'last',
): StoryScopeResult {
  const text = String(source ?? '');
  const names = tags.map(tag => tag.trim()).filter(Boolean);
  const fallback = (reason: string, matchedTags: string[] = [], blockCount = 0): StoryScopeResult => ({
    text: null,
    matchedTags,
    blockCount,
    reason,
  });
  if (!names.length) return fallback('未配置范围标签');
  if (!text.trim()) return fallback('正文为空');

  const blocks: Array<{ tag: string; start: number; value: string }> = [];
  for (const name of names) {
    for (const match of text.matchAll(pairedBlockRegex(name))) {
      const value = (match[2] ?? '').trim();
      if (!value) continue;
      blocks.push({ tag: (match[1] ?? '').trim(), start: match.index ?? 0, value });
    }
  }
  blocks.sort((left, right) => left.start - right.start);
  const matchedTags = [...new Set(blocks.map(block => block.tag))];
  if (!blocks.length) return fallback('没有找到成对的 <标签>…</标签> 块', matchedTags, 0);

  const picked = pick === 'first' ? [blocks[0]] : pick === 'all' ? blocks : [blocks[blocks.length - 1]];
  const scoped = picked.map(block => block.value).join('\n\n').trim();
  if (!scoped) return fallback('取到的剧情是空的', matchedTags, blocks.length);

  const noise = squashWhitespace(stripMatchedBlocks(text, names)).length;
  const whole = squashWhitespace(text).length;
  if (whole && noise / whole > STORY_SCOPE_NOISE_LIMIT) {
    console.info(
      `[绘图姬·中转站] 剧情范围:标签外内容占整楼 ${Math.round((noise / whole) * 100)}%,` +
        '确认范围没配错的话可忽略(仍按范围编译)',
    );
  }
  return { text: scoped, matchedTags, blockCount: blocks.length, reason: 'ok' };
}

/** 范围出来的剧情;取不到返回 null(调用方回退整楼)。 */
export function scopedStoryText(source: string, tags: string[], pick: StoryScopePick = 'last'): string | null {
  return extractStoryScope(source, tags, pick).text;
}

export function hasStoryScope(tags: string[]): boolean {
  return tags.some(tag => !!String(tag ?? '').trim());
}
