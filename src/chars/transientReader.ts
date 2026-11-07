/**
 * 临时档案的读取:让中转站模型从正文里读出「角色此刻的样子」。
 *
 * 与 `archive.ts`(固定建档)分工明确:
 * - archive:发色/瞳色/体型 —— 除非剧情真的改变了它们(染发、受伤),否则不该变;
 * - 本模块:穿戴/身体状态/标记 —— 每楼都可能变,变了就要跟着变。
 *
 * 两次调用刻意分开,不合并在同一次请求里:
 * 合并的话,模型会把「她换了黑色蕾丝胸罩」写进**固定档案的 outfit 字段**,
 * 下一楼她穿回白裙,固定档案还挂着 black lace bra,越用越歪。
 * 分开之后,固定档案只吃稳定项,活的东西全落在临时层,可清空、可回退。
 */

import { compilePrompt } from '@/relay/client';
import type { CharEntry } from '@/chars/profile';
import type { TransientProfile } from '@/chars/transient';
import { SPLIT_EXAMPLES } from '@/chars/outfitSet';
import { getSettings } from '@/state/settings';

export interface TransientChange {
  /** 角色名。 */
  name: string;
  /** 整串(这一刻的完整穿戴/状态);空串 = 剧情明确说脱光了之类的「清空」。 */
  raw: string;
  /** 这一楼到底改了什么,给用户看。 */
  reason: string;
  /** 剧情原文里的依据片段(可选,用于审计)。 */
  evidence: string;
}

export interface TransientResult {
  /** 在场角色(模型给的,可作为 cast 兜底)。 */
  cast: string[];
  changes: TransientChange[];
}

const MAX_STORY_CHARS = 4000;

/** 建档请求的 system 提示词。纯函数,单测直接跑。 */
export function buildTransientPrompt(
  story: string,
  library: CharEntry[],
  current: TransientProfile[],
): string {
  const known = library
    .filter(e => e.enabled)
    .map(e => {
      const fixed = e.raw || Object.values(e.fields ?? {}).filter(Boolean).join(', ') || '(无固定外貌)';
      const tmp = current.find(t => t.name.toLowerCase() === e.name.toLowerCase());
      const tmpText = tmp ? (tmp.raw || Object.values(tmp.fields ?? {}).filter(Boolean).join(', ')) : '';
      return `- ${e.name}: 固定【${fixed}】${tmpText ? `;当前临时状态【${tmpText}】` : ';当前临时状态【无】'}`;
    })
    .join('\n');

  return `你是角色「当前状态」的记录员。读下面的剧情,只看**这一刻**每个在场角色身上发生了什么变化:穿了什么、脱了什么、身体处于什么状态、有没有新增伤痕/饰品/束缚。

【已知角色库】
${known || '(空)'}

【剧情正文】
${story}

【任务】
1. 只记录**会随剧情变化**的东西:
   - 穿戴:内外衣、鞋袜、配饰,材质和颜色都写(black lace bra, black lace panties, black pantyhose);
   - 身体状态:湿透、出汗、发抖、受伤、被绑、怀孕可见等;
   - 剪发/染发这类真的改变了外貌的,也记。
2. **不要**重复固定档案里已经写对的内容(发色、瞳色、体型)。没变化就不要输出这个角色。
3. **绝不写「套」这种聚合词**,必须拆到部位。
   写 set / 一套 / 套装 这种词,采样器只会画出上半截(胸罩有了,内裤没画)。
   颜色和材质要复制到每个部件上。

【必须拆开写(照着抄)】
- ${SPLIT_EXAMPLES}

4. 剧情说「只剩内衣」→ 也要写清是哪种颜色材质的内衣/内裤,各成一条。
5. 剧情明确说脱光了 → raw 写 "completely nude"。
6. 剧情片段不够判断时,宁可不输出,也不要猜。

【输出格式】
只输出一个 JSON 对象,不要 Markdown、不要解释:
{"cast":["角色名"],"changes":[{"name":"角色名","raw":"这一刻的完整 tag 串","reason":"这一楼改了什么","evidence":"剧情里的依据原句"}]}

tag 用英文小写、逗号分隔、多词用空格连接(不要下划线),danbooru 风格。`;
}
/** 从模型回复里抠出 JSON(容忍代码块与前后废话)。 */
export function parseTransientReply(raw: string): TransientResult {
  const text = String(raw ?? '').trim();
  if (!text) return { cast: [], changes: [] };

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

  const changes: TransientChange[] = [];
  if (Array.isArray(record.changes)) {
    for (const item of record.changes) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      const name = String(c.name ?? '').trim();
      const rawTags = String(c.raw ?? '').trim();
      const reason = String(c.reason ?? '').trim();
      if (!name) continue;
      // raw 空 + reason 空 = 什么都没说,丢弃;raw 空但有 reason 是合法的「清空」指令
      if (!rawTags && !reason) continue;
      changes.push({
        name,
        raw: normalizeTags(rawTags),
        reason: reason || '剧情未说明具体变化',
        evidence: String(c.evidence ?? '').trim(),
      });
    }
  }
  return { cast, changes };
}

/** tag 规范化:小写、去下划线、折叠逗号。 */
export function normalizeTags(input: string): string {
  return String(input ?? '')
    .replace(/_/g, ' ')
    .split(',')
    .map(tag => tag.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(', ');
}

/** 把正文裁到够用的长度(模型只需要这一楼的变化;超长反而稀释注意力)。 */
export function trimStory(story: string, limit = MAX_STORY_CHARS): string {
  const text = String(story ?? '').trim();
  return text.length > limit ? text.slice(-limit) : text;
}

/**
 * 跑一次读取。失败返回空结果,不抛错——临时档案是锦上添花,
 * 挂了也要让出图主流程照常走(与 archive.ts 同一纪律)。
 */
export async function detectTransientChanges(
  story: string,
  library: CharEntry[],
  current: TransientProfile[],
  signal?: AbortSignal,
): Promise<TransientResult> {
  const s = getSettings();
  if (!s.relay.url.trim() || !s.relay.model.trim()) return { cast: [], changes: [] };
  const trimmed = trimStory(story);
  if (!trimmed) return { cast: [], changes: [] };

  try {
    const reply = await compilePrompt(
      {
        url: s.relay.url,
        key: s.relay.key,
        model: s.relay.model,
        temperature: 0.2,
        maxTokens: 700,
        timeoutSec: s.relay.timeoutSec,
        purge: s.purge,
      },
      [{ role: 'user', content: buildTransientPrompt(trimmed, library, current) }],
      { signal },
    );
    return parseTransientReply(reply);
  } catch (error) {
    console.warn('[绘图姬·中转站] 临时档案读取失败(已忽略)', error);
    return { cast: [], changes: [] };
  }
}
