/**
 * 自动建档:让中转站模型读剧情,认出在场角色并补全外貌。
 *
 * 原理移植自绘图🐔二号 autoTag/protocol.ts 的 `cast` + `changes` 设计:
 *
 * - **cast**:本段有哪些角色在场。为什么不能只靠字符串匹配?
 *   剧情里大量用「她」「他」「妈妈」指代,名字根本不出现;匹配只能看本楼,
 *   跨楼层的人物关系它一无所知。让模型在**同一次**请求里顺带回答,零额外成本。
 * - **changes**:模型报告的角色库变更(new=建档,<字段名>=改某个字段)。
 *
 * 与二号的差异:二号让主请求在同一次输出里完成建档与用档;
 * 我们拆成独立的一次请求,只负责「认人 + 建档」,不参与出图,
 * 这样即使用户关了自动插图也能单独维护角色库。
 */

import { compilePrompt } from '@/relay/client';
import { CHAR_FIELDS, CHAR_FIELD_LABELS, type CharEntry, type CharField } from '@/chars/profile';
import { getSettings } from '@/state/settings';

export type ChangeField = 'new' | CharField;

export interface CharChange {
  name: string;
  field: ChangeField;
  value: string;
  reason: string;
}

export interface CastResult {
  /** 本段在场的角色名(模型给的,可能含库里还没有的新角色)。 */
  cast: string[];
  /** 角色库变更。 */
  changes: CharChange[];
}

const FIELDS_LIST = CHAR_FIELDS.map(f => `${f}(${CHAR_FIELD_LABELS[f]})`).join('、');

/** 建档请求的 system 提示词。 */
export function buildArchivePrompt(story: string, library: CharEntry[]): string {
  const known = library
    .filter(e => e.enabled)
    .map(e => `- ${e.name}: ${e.raw || CHAR_FIELDS.map(f => e.fields[f]).filter(Boolean).join(', ') || '(无外貌记录)'}`)
    .join('\n');

  return `你是角色外貌档案管理员。读下面的剧情,判断**这一刻画面里有谁**,并补全他们的固定外貌。

【已知角色库】
${known || '(空)'}

【剧情正文】
${story}

【任务】
1. cast:列出这段剧情里真正在做事的角色(解代词:她/他/妈妈 要按上下文弄清是谁)。
   只列有名字或有明确指代的;纯背景路人不要列。
2. changes:对每个在场角色,如果库里没有、或者外貌信息缺失/需要修正,给出一条变更。
   - 建档用 field="new",value 写完整的外貌 tag 串。
   - 改某个字段用 field 填字段名,value 只写该字段的新值。
   - 库里已经准确、无需改动就不要输出。

【字段表】
${FIELDS_LIST}

【输出格式】
只输出一个 JSON 对象,不要 Markdown、不要解释:
{"cast":["角色名"],"changes":[{"name":"角色名","field":"new","value":"外貌 tag","reason":"为什么"}]}

tag 用英文小写、逗号分隔、多词用空格连接(不要下划线)。
外貌要写具体的发色/瞳色/发型/体型/服装,不要写空泛词。`;
}

/** 从模型回复里抠出 JSON(容忍前后废话与代码块)。 */
export function parseCastReply(raw: string): CastResult {
  const text = String(raw ?? '').trim();
  if (!text) return { cast: [], changes: [] };

  // 优先整段是 JSON;否则找第一个 {...}
  let jsonText = text;
  if (!jsonText.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { cast: [], changes: [] };
    jsonText = text.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { cast: [], changes: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { cast: [], changes: [] };

  const record = parsed as Record<string, unknown>;
  const cast = Array.isArray(record.cast)
    ? record.cast.map(x => String(x ?? '').trim()).filter(Boolean)
    : [];

  const changes: CharChange[] = [];
  if (Array.isArray(record.changes)) {
    for (const item of record.changes) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      const name = String(c.name ?? '').trim();
      const field = String(c.field ?? '').trim();
      const value = String(c.value ?? '').trim();
      if (!name || !field || !value) continue;
      if (field !== 'new' && !CHAR_FIELDS.includes(field as CharField)) continue;
      changes.push({
        name,
        field: field as ChangeField,
        value,
        reason: String(c.reason ?? '').trim(),
      });
    }
  }
  return { cast, changes };
}

/**
 * 跑一次建档:返回在场角色与变更。
 * 失败时返回空结果而不是抛错——建档是锦上添花,不该拖垮出图主流程。
 */
export async function detectCastAndChanges(story: string, library: CharEntry[], signal?: AbortSignal): Promise<CastResult> {
  const s = getSettings();
  if (!s.relay.url.trim() || !s.relay.model.trim()) return { cast: [], changes: [] };
  if (!String(story ?? '').trim()) return { cast: [], changes: [] };

  try {
    const reply = await compilePrompt(
      {
        url: s.relay.url,
        key: s.relay.key,
        model: s.relay.model,
        temperature: 0.3,
        maxTokens: 900,
        timeoutSec: s.relay.timeoutSec,
        // 建档也要读正文:不过 purge 的话,模型会把"受伤的人"读成"站着的人",
        // 档案里的外貌字段从此就是错的,越用越歪。
        purge: s.purge,
      },
      [{ role: 'user', content: buildArchivePrompt(story, library) }],
      { signal },
    );
    return parseCastReply(reply);
  } catch (error) {
    console.warn('[绘图姬·中转站] 自动建档失败(已忽略)', error);
    return { cast: [], changes: [] };
  }
}
