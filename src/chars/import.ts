/**
 * 从酒馆导入角色档案。
 *
 * 两条来源,按可靠性排序:
 * 1. **世界书里的角色 tag 条目** —— 实测最可靠:「苏白粥_人物tag」这类条目
 *    内容就是现成的 danbooru tag,直接进 raw 字段,零转换。
 * 2. **角色卡的 description / personality** —— 多数卡是自然语言,存进 nl;
 *    里面若含 tag 行也一并收下。
 *
 * 刻意**不自动解析自然语言成字段**:那是 AI 的活,交给自动建档那一步,
 * 本地导入只做「能确定的」,不确定的留给 AI 或用户手改。
 */

import { CHAR_FIELDS, emptyFields, makeEntry, type CharEntry } from '@/chars/profile';
import { getContext } from '@/st/context';

export interface ImportCandidate {
  name: string;
  raw: string;
  nl: string;
  source: 'worldbook' | 'card';
  /** 来源描述,展示用。 */
  origin: string;
}

/** 从条目备注里抠出角色名:`苏白粥_人物tag` → `苏白粥`。 */
function nameFromComment(comment: string): string {
  const text = String(comment ?? '').trim();
  if (!text) return '';
  // 常见写法:名字_后缀 / 名字-后缀 / 【名字】后缀
  const bracket = text.match(/^[【\[（(]([^】\]）)]+)[】\]）)]/);
  if (bracket) return bracket[1].trim();
  const under = text.split(/[_\-—·]/)[0]?.trim();
  if (under && under.length <= 20) return under;
  return text.length <= 20 ? text : '';
}

/** 判断内容像不像 danbooru tag 串(以英文逗号分隔、英文为主)。 */
function looksLikeTags(content: string): boolean {
  const text = String(content ?? '').trim();
  if (text.length < 8) return false;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (latin < 10 || cjk > latin * 0.6) return false;
  return text.includes(',');
}

/** 把 tag 串压成一行(去掉换行与多余空白)。 */
function flattenTags(content: string): string {
  return String(content ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s*\n+\s*/g, ', ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(,\s*)+/g, ', ')
    .trim();
}

/** 读一本世界书的条目。 */
async function readWorldbook(name: string): Promise<Array<{ comment: string; content: string }>> {
  const ctx = getContext();
  if (!ctx) return [];
  try {
    const response = await fetch('/api/worldinfo/get', {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify({ name }),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { entries?: Record<string, { comment?: string; content?: string }> };
    const entries = data?.entries ?? {};
    return Object.values(entries).map(entry => ({
      comment: String(entry?.comment ?? ''),
      content: String(entry?.content ?? ''),
    }));
  } catch {
    return [];
  }
}

/**
 * 扫描所有世界书 + 当前角色卡,给出可导入的角色候选。
 * 只做「能确定」的提取,不做语义解析。
 */
export async function collectImportCandidates(): Promise<ImportCandidate[]> {
  const ctx = getContext();
  if (!ctx) return [];
  const out: ImportCandidate[] = [];
  const seen = new Set<string>();

  const push = (candidate: ImportCandidate) => {
    const key = candidate.name.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };

  // 1) 世界书里的角色 tag 条目
  const ctxAny = ctx as unknown as { getWorldInfoNames?: () => string[] };
  const wbNames = typeof ctxAny.getWorldInfoNames === 'function' ? ctxAny.getWorldInfoNames() : [];
  for (const wb of wbNames) {
    const entries = await readWorldbook(wb);
    for (const entry of entries) {
      const comment = entry.comment;
      if (!/tag|人物|角色|外貌|人设/i.test(comment)) continue;
      if (!looksLikeTags(entry.content)) continue;
      const name = nameFromComment(comment);
      if (!name) continue;
      push({
        name,
        raw: flattenTags(entry.content),
        nl: '',
        source: 'worldbook',
        origin: `世界书「${wb}」· ${comment}`,
      });
    }
  }

  // 2) 角色卡
  const characters = (ctx as unknown as { characters?: Array<Record<string, unknown>> }).characters ?? [];
  for (const card of characters) {
    const name = String(card?.name ?? '').trim();
    if (!name) continue;
    const description = String(card?.description ?? '');
    const personality = String(card?.personality ?? '');
    const combined = `${description}\n${personality}`.trim();
    if (!combined) continue;
    const tagLike = looksLikeTags(combined);
    push({
      name,
      raw: tagLike ? flattenTags(combined).slice(0, 1200) : '',
      nl: tagLike ? '' : combined.slice(0, 1200),
      source: 'card',
      origin: `角色卡「${name}」`,
    });
  }

  return out;
}

/** 把候选转成档案条目。 */
export function candidateToEntry(candidate: ImportCandidate): CharEntry {
  return makeEntry({
    name: candidate.name,
    fields: emptyFields(),
    raw: candidate.raw,
    nl: candidate.nl,
    source: 'import',
    enabled: true,
    note: candidate.origin,
  });
}

/** 给 UI 用的字段清单(避免 UI 再引一次常量)。 */
export { CHAR_FIELDS };
