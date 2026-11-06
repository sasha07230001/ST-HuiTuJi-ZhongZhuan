/**
 * 正文清洗链:范围裁剪 → 去思维链 → 去自定义标签 → 折叠空白。
 *
 * 这是「送进中转站之前」的最后一道过滤。与 relay/prompt.ts 的 cleanStoryText
 * 分工不同:那边只管 HTML/Markdown 装饰与长度,这边管**语义噪声**
 * (思维链、状态块、用户点名要剔除的标签)。
 */

import { scopedStoryText, type StoryScopePick } from '@/relay/storyScope';

const RE_THINK_BLOCK = /<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi;
const RE_COMMENT = /<!--[\s\S]+?-->/g;

/**
 * 按标签名生成「整块删除」正则(含标签与内部内容)。
 *
 * 边界用前瞻 `(?=[\s/>])` 而不是 `\b`:`\b` 只认 ASCII 词字符,中文标签
 * (如 `<雪>`)在「雪」与「>」之间没有词边界,会匹配失败;前瞻对中英文都成立,
 * 且同样能防止 `<snow>` 误吃 `<snowball>` 前缀。
 */
function blockStripRegexes(tag: string): RegExp[] {
  const safe = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`<${safe}(?=[\\s/>])[^>]*>[\\s\\S]*?</${safe}>`, 'gi'), // 配对块
    new RegExp(`<\\/?${safe}(?=[\\s/>])[^>]*\\/?>`, 'gi'), // 落单的开/闭/自闭标签
  ];
}

function stripCustomTags(text: string, tags: string[]): string {
  let out = text;
  for (const tag of tags) {
    const name = tag.trim();
    if (!name) continue;
    for (const re of blockStripRegexes(name)) out = out.replace(re, '');
  }
  return out;
}

export interface CleanOptions {
  /** 剧情范围标签;为空则不裁。 */
  scopeTags?: string[];
  /** 多块时取哪个。 */
  scopePick?: StoryScopePick;
  /** 用户配置的「整块剔除」标签名。 */
  stripTags?: string[];
}

export interface CleanResult {
  /** 清洗后的正文;可能为空串(调用方据此终止)。 */
  text: string;
  /** 范围是否生效。 */
  scopeApplied: boolean;
  /** 命中的范围标签。 */
  scopeTagsMatched: string[];
  /** 说明,写日志用。 */
  reason: string;
}

/**
 * 跑完整清洗。范围取不到时**回退整楼**——宁可多带点杂音,也不能把剧情洗没。
 */
export function cleanForPrompt(source: string, options: CleanOptions = {}): CleanResult {
  const raw = String(source ?? '');
  const scopeTags = options.scopeTags ?? [];
  const scoped = scopeTags.length ? scopedStoryText(raw, scopeTags, options.scopePick ?? 'last') : null;
  const scopeApplied = scoped !== null;
  const base = scopeApplied ? scoped! : raw;

  let text = base
    .replace(RE_THINK_BLOCK, '')
    .replace(RE_COMMENT, '');
  text = stripCustomTags(text, options.stripTags ?? []);
  text = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    text,
    scopeApplied,
    scopeTagsMatched: scopeApplied ? scopeTags : [],
    reason: scopeApplied ? 'scope' : text ? 'whole' : 'empty',
  };
}
