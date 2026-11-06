/**
 * 角色档案:固定外貌库,保证同一角色每次出图长相一致。
 *
 * 移植自绘图🐔二号的 state/charTags.ts,保留它的核心设计:
 * - **字段化**:发色/瞳色/发型/体型/皮肤/服装/特征/所属 分开存,便于局部改与复用
 * - **raw 快速通道**:整串 danbooru tag 原样保存(从世界书导入的通常是这种)
 *
 * 与二号的差异:二号把角色增量存在楼层的 message.extra 里、按 swipe 派生;
 * 我们不做跨楼层的增量合并(太复杂且容易错),改为**一份全局库**,
 * 由「手动编辑 + 酒馆导入 + 自动建档」三方维护。
 */

/** 角色外貌字段(顺序即拼进提示词的顺序)。 */
export type CharField = 'fandom' | 'sex' | 'hair' | 'eyes' | 'skin' | 'body' | 'extra' | 'outfit';

export const CHAR_FIELDS: readonly CharField[] = ['fandom', 'sex', 'hair', 'eyes', 'skin', 'body', 'extra', 'outfit'];

export const CHAR_FIELD_LABELS: Record<CharField, string> = {
  fandom: '所属',
  sex: '性别',
  hair: '发型发色',
  eyes: '瞳色',
  skin: '皮肤',
  body: '体型',
  extra: '特征',
  outfit: '服装',
};

/** 建档来源。 */
export type CharSource = 'manual' | 'import' | 'ai';

export interface CharEntry {
  /** 角色名(唯一键)。 */
  name: string;
  /** 结构化字段。 */
  fields: Record<CharField, string>;
  /** 整串 danbooru tag(导入/自动建档常走这条)。raw 与 fields 可并存。 */
  raw: string;
  /** 自然语言外貌描述(给模型看的补充)。 */
  nl: string;
  /** 建档来源。 */
  source: CharSource;
  /** 是否参与出图拼装。关掉 = 保留档案但不生效。 */
  enabled: boolean;
  /** 备注(为什么改、从哪来)。 */
  note: string;
  /** 创建/更新时间(毫秒)。 */
  updatedAt: number;
}

/** 空字段集。 */
export function emptyFields(): Record<CharField, string> {
  return { fandom: '', sex: '', hair: '', eyes: '', skin: '', body: '', extra: '', outfit: '' };
}

export function fieldsEmpty(fields: Record<CharField, string>): boolean {
  return CHAR_FIELDS.every(f => !String(fields?.[f] ?? '').trim());
}

export function makeEntry(partial: Partial<CharEntry> & { name: string }): CharEntry {
  return {
    name: partial.name.trim(),
    fields: { ...emptyFields(), ...(partial.fields ?? {}) },
    raw: String(partial.raw ?? '').trim(),
    nl: String(partial.nl ?? '').trim(),
    source: partial.source ?? 'manual',
    enabled: partial.enabled !== false,
    note: String(partial.note ?? ''),
    updatedAt: partial.updatedAt ?? Date.now(),
  };
}

/**
 * 把条目拼成一段可以塞进提示词的外貌描述。
 *
 * 拼装口径(与二号一致):
 * - 有字段就按字段顺序拼;
 * - 没字段但有 raw,就用 raw(整串 tag 原样送);
 * - 两者都有时,raw 打底、字段补充(字段是后改的,以它为准)。
 */
export function entryToPromptTags(entry: CharEntry): string {
  const parts: string[] = [];
  const raw = entry.raw.trim();
  if (raw) parts.push(raw);
  if (!fieldsEmpty(entry.fields)) {
    for (const field of CHAR_FIELDS) {
      const value = String(entry.fields[field] ?? '').trim();
      if (value) parts.push(value);
    }
  }
  return parts.join(', ').replace(/\s*,\s*/g, ', ').replace(/(,\s*)+$/g, '').trim();
}

/** 角色是否在正文里被提到(按名字做词边界匹配,避免「白粥」误命中「白粥粥」以外的词)。 */
export function textMentionsName(text: string, name: string): boolean {
  const t = String(text ?? '');
  const n = String(name ?? '').trim();
  if (!n || !t) return false;
  // 中文名没有词边界,直接用包含;英文名加边界,避免 "Al" 命中 "Alice"
  if (/[\u4e00-\u9fff]/.test(n)) return t.includes(n);
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i').test(t);
}

/**
 * 从某段正文里挑出在场角色。长名优先,并把已命中处从文本里划掉——
 * 否则「苏白粥」命中之后,它的子串「白粥」还会再被认成另一个角色(二号踩过这个坑)。
 */
export function charactersInText(text: string, entries: CharEntry[]): CharEntry[] {
  const sorted = [...entries].sort((a, b) => b.name.length - a.name.length);
  let remaining = String(text ?? '');
  const out: CharEntry[] = [];
  const seen = new Set<string>();
  for (const entry of sorted) {
    if (!entry.enabled) continue;
    const name = entry.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (!textMentionsName(remaining, name)) continue;
    seen.add(key);
    out.push(entry);
    // 划掉本名在文本中的出现,免得它的子串再被当成别的角色
    if (/[\u4e00-\u9fff]/.test(name)) {
      remaining = remaining.split(name).join(' ');
    } else {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      remaining = remaining.replace(new RegExp(escaped, 'gi'), ' ');
    }
  }
  return out;
}

/**
 * 把在场角色的外貌合并进正向提示词。
 *
 * 不做「一个角色一份完整外貌反复展开」——那会让模型画出重叠躯干(二号踩过这个坑)。
 * 这里按角色各出一段,用逗号串起来,角色间以名字区的序号区分。
 */
export function mergeCharacterPrompts(basePrompt: string, characters: CharEntry[]): string {
  const usable = characters.filter(entry => entry.enabled && entryToPromptTags(entry));
  if (!usable.length) return basePrompt;
  const segments = usable.map(entry => {
    const tags = entryToPromptTags(entry);
    return tags;
  });
  const joined = segments.join(', ');
  const base = String(basePrompt ?? '').trim();
  return base ? `${base}, ${joined}` : joined;
}

/** 解析并规整存档(容错:缺字段补默认、非法弃掉)。 */
export function normalizeEntries(raw: unknown): CharEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CharEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const fields = emptyFields();
    const rawFields = record.fields;
    if (rawFields && typeof rawFields === 'object') {
      for (const field of CHAR_FIELDS) {
        const value = (rawFields as Record<string, unknown>)[field];
        if (typeof value === 'string') fields[field] = value;
      }
    }
    out.push(
      makeEntry({
        name,
        fields,
        raw: typeof record.raw === 'string' ? record.raw : '',
        nl: typeof record.nl === 'string' ? record.nl : '',
        source: record.source === 'ai' || record.source === 'import' ? record.source : 'manual',
        enabled: record.enabled !== false,
        note: typeof record.note === 'string' ? record.note : '',
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
      }),
    );
  }
  return out;
}

/** 新增或更新一条;返回是否新建。 */
export function upsertEntry(entries: CharEntry[], entry: CharEntry): { entries: CharEntry[]; created: boolean } {
  const next = [...entries];
  const index = next.findIndex(e => e.name.toLowerCase() === entry.name.toLowerCase());
  if (index >= 0) {
    next[index] = { ...next[index], ...entry, updatedAt: Date.now() };
    return { entries: next, created: false };
  }
  next.push({ ...entry, updatedAt: Date.now() });
  return { entries: next, created: true };
}

export function removeEntry(entries: CharEntry[], name: string): CharEntry[] {
  return entries.filter(e => e.name.toLowerCase() !== name.toLowerCase());
}

export function findEntry(entries: CharEntry[], name: string): CharEntry | undefined {
  return entries.find(e => e.name.toLowerCase() === name.toLowerCase());
}
