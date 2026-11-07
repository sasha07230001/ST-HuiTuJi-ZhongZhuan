/**
 * 临时档案:剧情把角色「此刻的样子」改掉之后,先在这儿存一份,再一起送进 CLIP。
 *
 * ## 为什么固定档案不够用
 *
 * `profile.ts` 里的角色档案是**固定外貌**——发色、瞳色、体型,写定了就不该动,
 * 那是「这个人长什么样」。但剧情推进时会改变**可变状态**:
 * 她换了黑色蕾丝胸罩和内裤、套上了风衣、头发被雨打湿了、缠着绷带。
 * 这些不是「这个人变了」,是「这一刻她是这样」。
 *
 * 塞回固定档案有三宗罪:
 * 1. 永久污染:下一楼她穿回白裙,固定档案里还挂着 black lace bra;
 * 2. 互相打架:固定 raw 里写着 `white dress`,临时状态写着 `black lace bra`,
 *    两串都进 CLIP,采样器按 token 权重骑墙,衣服就糊成一片;
 * 3. 不可回退:swipe / 回档之后,角色档案已经不知道被哪一楼改过了。
 *
 * 所以这一层是**同槽覆盖、可清空**的一层:tmp 里有 outfit,拼提示词时就用 tmp 的,
 * 固定档案里那个 `white dress` 被**换掉**而不是叠加。
 *
 * ## 生命周期
 *
 * - 只有开了「存档」的角色才有 tmp 行(未存档 = 只用固定档案,回到旧行为);
 * - 每轮由中转站模型从正文里读出现在穿戴/状态,有变化才写;
 * - 用户可以在角色档案页手动改、手动清空、手动冻结(不再被 AI 改);
 * - 清理按「剧情连续性」判断,见 `migrateForFloor`。
 */

import { emptyFields, type CharEntry, type CharField } from '@/chars/profile';
import { expandOutfitTags } from '@/chars/outfitSet';

/** 临时档案接管的槽位。发色瞳色这类是「这个人变了」,不该进临时层。 */
export const TRANSIENT_FIELDS: readonly CharField[] = ['outfit', 'body', 'extra', 'hair'];

/** 规整存档时允许读的字段(顺序即拼进提示词的顺序)。 */
export const TRANSIENT_FIELD_ORDER: readonly CharField[] = ['outfit', 'hair', 'body', 'extra'];

/** 一条临时档案。 */
export interface TransientProfile {
  /** 角色名(与 CharEntry.name 对应)。 */
  name: string;
  /** 只在有值的字段。 */
  fields: Record<CharField, string>;
  /** 总拼串:给了就整串送 CLIP(优先级最高,避免字段拆错)。 */
  raw: string;
  /** 所属聊天 id;换聊天自然失效。 */
  chatId: string;
  /** 这一份是在哪一楼确立的。 */
  floor: number;
  /** true = 整串替换;false = 按字段增量合并。 */
  replace: boolean;
  /** 用户冻结后 AI 不再改这条。 */
  frozen: boolean;
  /** 更新时的剧情指纹,用来跳过去重与审计。 */
  sig: string;
  updatedAt: number;
}

export function emptyTransient(name: string, chatId = '', floor = 0): TransientProfile {
  return {
    name: String(name ?? '').trim(),
    fields: emptyFields(),
    raw: '',
    chatId,
    floor,
    replace: true,
    frozen: false,
    sig: '',
    updatedAt: Date.now(),
  };
}

function joinTags(parts: string[]): string {
  return parts
    .map(part => String(part ?? '').trim())
    .filter(Boolean)
    .join(', ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(,\s*)+$/g, '')
    .trim();
}

/** 拼进提示词的串:raw 打底,其次按字段顺序。 */
export function transientToTags(profile: TransientProfile | undefined | null): string {
  if (!profile) return '';
  const raw = String(profile.raw ?? '').trim();
  const fieldParts: string[] = [];
  for (const field of TRANSIENT_FIELD_ORDER) {
    const value = String(profile.fields?.[field] ?? '').trim();
    if (value) fieldParts.push(value);
  }
  return joinTags(raw ? [raw, ...fieldParts] : fieldParts);
}

/**
 * 送 CLIP 用的版本:在 `transientToTags` 之后再展开成套词。
 *
 * 为什么要分两个函数:`transientToTags` 是**存档的原始样子**(编辑器里要给人看原文,
 * 不能看到存进去的 `set` 变成四五个 tag);这一层是**送进采样器的样子**。
 * 混成一个的话,用户手改一次就会被展开结果覆盖回去,再改一次又展开,越滚越长。
 *
 * 展开表见 `chars/outfitSet.ts`:只拆认得出部位的套词,
 * 认不出的原样返回 —— 宁可漏拆也不能瞎拆。
 */
export function transientToClipTags(profile: TransientProfile | undefined | null): string {
  const base = transientToTags(profile);
  if (!base) return '';
  return expandOutfitTags(base).tags;
}

/** 这条临时档案有没有内容。 */
export function transientHasContent(profile: TransientProfile | undefined | null): boolean {
  return !!transientToTags(profile);
}

/** 规整存档(容错:脏数据一律丢弃,不抛错)。 */
export function normalizeTransients(raw: unknown): TransientProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: TransientProfile[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const fields = emptyFields();
    if (r.fields && typeof r.fields === 'object') {
      for (const field of TRANSIENT_FIELDS) {
        const value = (r.fields as Record<string, unknown>)[field];
        if (typeof value === 'string') fields[field] = value;
      }
    }
    out.push({
      name,
      fields,
      raw: typeof r.raw === 'string' ? r.raw : '',
      chatId: typeof r.chatId === 'string' ? r.chatId : '',
      floor: typeof r.floor === 'number' && Number.isFinite(r.floor) ? Math.floor(r.floor) : 0,
      replace: r.replace !== false,
      frozen: r.frozen === true,
      sig: typeof r.sig === 'string' ? r.sig : '',
      updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now(),
    });
  }
  return out;
}

export function findTransient(list: TransientProfile[], name: string): TransientProfile | undefined {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return undefined;
  return list.find(t => t.name.toLowerCase() === key);
}

export interface TransientPatch {
  /** 角色名。 */
  name: string;
  /** 整串;replace !== false 时整串替换。 */
  raw?: string;
  /** 增量字段。传空串 = 显式清掉该槽。 */
  fields?: Partial<Record<CharField, string>>;
  /** 默认 true:raw 非空即整串替换。 */
  replace?: boolean;
  /** 冻结/解冻。 */
  frozen?: boolean;
  /** 剧情指纹。 */
  sig?: string;
  /** 所属聊天(首次建档时用)。 */
  chatId?: string;
}

/**
 * 写入或合并一条,返回新数组(不原地改,方便落盘前比较)。
 *
 * 合并口径:
 * - raw 非空且 replace !== false → **整串替换**,同时清掉旧字段
 *   (否则旧的 outfit 会和新 raw 一起进提示词,衣服又糊了);
 * - raw 空,或者 replace === false → 按字段覆盖,没给的字段保留。
 */
export function upsertTransient(
  list: TransientProfile[],
  patch: TransientPatch,
  opts: { chatId?: string; floor?: number } = {},
): { list: TransientProfile[]; changed: boolean; profile: TransientProfile } {
  const name = String(patch.name ?? '').trim();
  if (!name) {
    const blank = emptyTransient('', '', 0);
    return { list, changed: false, profile: blank };
  }
  const index = list.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
  const base = index >= 0 ? list[index] : emptyTransient(name, opts.chatId ?? '', opts.floor ?? 0);

  const replace = patch.replace !== false;
  const raw = String(patch.raw ?? '').trim();
  let fields: Record<CharField, string> = { ...base.fields };
  let nextRaw = String(base.raw ?? '').trim();

  if (raw && replace) {
    // 整串替换:字段一起清空,否则旧 outfit 会和新 raw 同时送进 CLIP
    fields = emptyFields();
    nextRaw = raw;
  } else {
    // 增量:给了 raw 就换掉整串(字段作为补充),没给就改字段
    if (raw) nextRaw = raw;
    for (const field of TRANSIENT_FIELDS) {
      const value = patch.fields?.[field];
      if (typeof value === 'string') fields[field] = value.trim();
    }
  }

  const merged: TransientProfile = {
    name,
    fields,
    raw: nextRaw,
    chatId: opts.chatId ?? patch.chatId ?? base.chatId,
    floor: opts.floor ?? base.floor,
    replace,
    frozen: patch.frozen === undefined ? base.frozen : patch.frozen,
    sig: String(patch.sig ?? '').trim() || base.sig,
    updatedAt: Date.now(),
  };

  const before = index >= 0 ? transientToTags(list[index]) : '';
  const after = transientToTags(merged);
  const out = [...list];
  if (index >= 0) out[index] = merged;
  else out.push(merged);
  return { list: out, changed: before !== after, profile: merged };
}

export function removeTransient(list: TransientProfile[], name: string): TransientProfile[] {
  const key = String(name ?? '').trim().toLowerCase();
  return list.filter(t => t.name.toLowerCase() !== key);
}

/** 清掉不属于某聊天的临时档案(换聊天时用)。 */
export function pruneByChat(list: TransientProfile[], chatId: string): TransientProfile[] {
  const id = String(chatId ?? '');
  if (!id) return list;
  return list.filter(t => !t.chatId || t.chatId === id);
}

/**
 * 剧情连续性:一条临时档案在「当前这一楼」还算不算数。
 *
 * - 同一聊天、往回 ≤2 楼(重跑/回看相邻几楼)或任意往后楼(继续剧情)→ 保留;
 * - 往回跳得多(读档/换分支)→ 已经过了,清掉;
 * - 聊天 id 变了 → 清掉。
 *
 * 为什么放宽到 2 楼:自动插图会在每楼触发,重跑上一楼是常规操作;
 * 但往回跳三楼以上就是另一条时间线了,那时候的黑色蕾丝不该还穿在身上。
 */
export function shouldReset(e: { chatId?: string; floor?: number }, chatId: string, floor: number): boolean {
  const id = String(chatId ?? '');
  if (e.chatId && id && e.chatId !== id) return true;
  const f = typeof e.floor === 'number' && Number.isFinite(e.floor) ? e.floor : 0;
  if (!Number.isFinite(floor) || floor < 0) return false;
  return floor + 2 < f;
}

/** 按楼层迁移动态状态。返回新数组 + 是否有变化(有变化调用方要落盘)。 */
export function migrateForFloor(
  list: TransientProfile[],
  chatId: string,
  floor: number,
): { list: TransientProfile[]; changed: boolean } {
  const id = String(chatId ?? '');
  const next = list.filter(t => !shouldReset(t, id, floor));
  return { list: next, changed: next.length !== list.length };
}

/** 从一段 tag 串里逐条删掉指定 tag(按逗号切,忽略大小写与多余空白)。 */
export function removeTags(tags: string, toRemove: string[]): string {
  const drop = new Set<string>();
  for (const value of toRemove) {
    for (const piece of String(value ?? '').split(',')) {
      const key = piece.trim().toLowerCase();
      if (key) drop.add(key);
    }
  }
  if (!drop.size) return String(tags ?? '').trim();
  return String(tags ?? '')
    .split(',')
    .map(tag => tag.trim())
    .filter(tag => tag && !drop.has(tag.toLowerCase()))
    .join(', ');
}

/** 临时档案接管了哪些槽位(UI 显示「已覆盖固定档案」用)。 */
export function coveredFields(profile: TransientProfile | undefined | null): CharField[] {
  if (!profile) return [];
  if (String(profile.raw ?? '').trim()) return [...TRANSIENT_FIELDS];
  return TRANSIENT_FIELDS.filter(field => !!String(profile.fields?.[field] ?? '').trim());
}

/**
 * 固定档案 + 临时档案 → 真正要送 CLIP 的那一段。
 *
 * 同槽覆盖是关键:临时档案一旦接管 outfit/body/extra/hair,
 * 固定档案里**同槽位的值要从拼串里剥掉**,否则 `white dress` 和
 * `black lace bra` 同时在场,采样器随机骑墙,衣服糊成一片(这是本层存在的全部理由)。
 *
 * 剥法分两种:
 * - 固定档案用字段存的 → 精确按字段值删除;
 * - 固定档案用 raw 整串存的(酒馆导入多是这种)→ 按 `guessOutfitTags` 认出穿戴段删掉。
 * 无论哪种,**只删被临时档案接管的那一类**,发色瞳色永远保留。
 */
export function mergeTransientTags(
  fixedTags: string,
  transientTags: string,
  fixed: CharEntry | null,
  options: { dropFromFixedRaw?: boolean } = {},
): string {
  const fixedBody = String(fixedTags ?? '').trim();
  const tmp = String(transientTags ?? '').trim();
  if (!tmp) return fixedBody;
  if (!fixedBody) return tmp;

  // 关闭覆盖:两串并存(旧行为)。用户在设置里显式关掉时不该悄悄替他删东西。
  if (options.dropFromFixedRaw === false) return joinTags([fixedBody, tmp]);

  const drop: string[] = [];
  // 固定档案用「字段」存的服装:整段精确删除。
  // 注意:只删**被临时档案接管**的槽位。hair 不在接管范围(临时档案只管穿戴/身体标记),
  // 把 hair 也删掉就是"临时档案给了内衣,结果发色没了"——每张图发色都在飘。
  for (const field of ['outfit', 'body', 'extra'] as CharField[]) {
    const value = String(fixed?.fields?.[field] ?? '').trim();
    if (value) drop.push(value);
  }
  // 固定档案用 raw 整串存的:只剥穿戴类。以 `,` 为界,不会把 "silver hair" 误删
  drop.push(...guessOutfitTags(fixedBody));

  const kept = removeTags(fixedBody, drop);
  const parts = kept ? [kept, tmp] : [tmp];
  return joinTags(parts);
}

/**
 * 从固定档案的整串 tag 里认出「穿戴」那一段。
 *
 * 为什么靠猜:raw 是 `1girl, silver hair, red eyes, white dress` 这种一维串,
 * 没有字段边界。这里只挑明确属于穿戴的词,**宁可漏也不能误删发色瞳色**
 * (误删发色 → 每张图发色都在飘,比衣服糊更难发现)。
 *
 * 边界必须两边都卡死(`(?<![a-z])xxx(?![a-z])`):只写 `\b` 的话,
 * `silver hair` 里的 `air`、`barefoot` 里的 `bare` 都能命中,
 * 发色就被当成穿戴删掉了。这一条是整层最容易出错的地方。
 */
const OUTFIT_WORDS = [
  'dress', 'skirt', 'shirt', 'blouse', 'sweater', 'hoodie', 'jacket', 'coat', 'cloak', 'cape',
  'robe', 'uniform', 'serafuku', 'apron', 'suit', 'vest', 'corset', 'bodice', 'kimono', 'yukata',
  'hanfu', 'qipao', 'cheongsam', 'panties', 'panty', 'underwear', 'lingerie', 'bra', 'brassiere',
  'bikini', 'swimsuit', 'leotard', 'swimwear', 'stockings', 'thighhighs', 'thighhigh', 'pantyhose',
  'tights', 'socks', 'legwear', 'gloves', 'scarf', 'necktie', 'bowtie', 'necklace', 'earrings',
  'bracelet', 'garter', 'choker', 'collar', 'leash', 'shackles', 'handcuffs', 'garter belt',
  'boots', 'shoes', 'sandals', 'heels', 'hat', 'crown', 'hood', 'mask', 'blindfold', 'bandage',
  'bandages', 'bandaged', 'rope', 'bondage', 'shorts', 'pants', 'jeans', 'trousers', 'maid outfit',
  'bunny girl', 'wedding dress', 'school uniform', 'sailor collar', 'tops', 'blazers', 'blazer',
  'revealing clothes', 'torn clothes', 'wet clothes', 'completely nude', 'nude', 'topless',
  'bottomless', 'naked', 'naked apron', 'underboob', 'sideboob',
];

const OUTFIT_PATTERN = new RegExp(`(?<![a-z])(${OUTFIT_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![a-z])`, 'i');

export function guessOutfitTags(raw: string): string[] {
  return String(raw ?? '')
    .split(',')
    .map(tag => tag.trim())
    .filter(tag => tag && OUTFIT_PATTERN.test(tag));
}

/** 一段 tag 里有没有穿戴类内容(判断固定档案是否自带服装)。 */
export function hasOutfitTags(tags: string): boolean {
  return guessOutfitTags(tags).length > 0;
}
