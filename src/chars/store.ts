/**
 * 角色库读写。
 *
 * 库存在 extension_settings 里(跨设备同步),不在 localStorage——
 * 角色档案是用户资产,换设备应该跟着走。
 */

import {
  emptyFields,
  makeEntry,
  normalizeEntries,
  removeEntry,
  upsertEntry,
  type CharEntry,
  type CharField,
} from '@/chars/profile';
import {
  emptyTransient,
  findTransient,
  migrateForFloor,
  normalizeTransients,
  removeTransient,
  transientToTags,
  upsertTransient,
  type TransientPatch,
  type TransientProfile,
} from '@/chars/transient';
import type { CharChange } from '@/chars/archive';
import { getSettings, saveSettings } from '@/state/settings';

/** 读库(每次都读实时的,避免到处传引用)。 */
export function getCharLibrary(): CharEntry[] {
  return getSettings().chars?.entries ?? [];
}

/** 写库。 */
export function setCharLibrary(entries: CharEntry[]): void {
  const next = getSettings();
  next.chars.entries = normalizeEntries(entries);
  saveSettings(next);
}

/** 新增或更新一条。 */
export function saveCharEntry(entry: CharEntry): { created: boolean } {
  const { entries, created } = upsertEntry(getCharLibrary(), entry);
  setCharLibrary(entries);
  return { created };
}

export function deleteCharEntry(name: string): void {
  setCharLibrary(removeEntry(getCharLibrary(), name));
}

/**
 * 把模型报告的变更写回库。
 *
 * 口径:
 * - `new` 且库里没有 → 建档(raw 存整串);
 * - `new` 且库里已有 → 只补空字段,不覆盖用户已填的内容(用户手填优先);
 * - 具体字段 → 直接写该字段(模型认为要修正)。
 */
export function applyChanges(changes: CharChange[]): { created: number; updated: number } {
  if (!changes.length) return { created: 0, updated: 0 };
  const library = [...getCharLibrary()];
  let created = 0;
  let updated = 0;

  for (const change of changes) {
    const index = library.findIndex(e => e.name.toLowerCase() === change.name.trim().toLowerCase());
    if (change.field === 'new') {
      if (index < 0) {
        library.push(
          makeEntry({
            name: change.name,
            fields: emptyFields(),
            raw: change.value,
            source: 'ai',
            enabled: true,
            note: change.reason ? `自动建档:${change.reason}` : '自动建档',
          }),
        );
        created += 1;
      } else {
        // 已有档案:只在为空时补,不覆盖用户手填
        const entry = library[index];
        if (!entry.raw.trim()) {
          entry.raw = change.value;
          updated += 1;
        }
      }
      continue;
    }

    const field = change.field as CharField;
    if (index < 0) {
      // 库里没有这个角色却给了字段变更 → 先建档再写字段
      const entry = makeEntry({ name: change.name, fields: emptyFields(), source: 'ai', enabled: true });
      entry.fields[field] = change.value;
      library.push(entry);
      created += 1;
      continue;
    }
    library[index].fields[field] = change.value;
    library[index].updatedAt = Date.now();
    updated += 1;
  }

  if (created || updated) setCharLibrary(library);
  return { created, updated };
}

/** 依赖注入点:orchestrator 调用它写回变更。 */
let changeSink: ((changes: CharChange[]) => void) | null = null;

export function setChangeSink(sink: (changes: CharChange[]) => void): void {
  changeSink = sink;
}

export function emitChanges(changes: CharChange[]): void {
  if (changeSink) changeSink(changes);
  else applyChanges(changes);
}

/* ---------------- 临时档案 ---------------- */

/** 读临时档案(实时的)。 */
export function getTransients(): TransientProfile[] {
  const s = getSettings();
  return normalizeTransients(s.chars?.transients ?? []);
}

export function setTransients(list: TransientProfile[]): void {
  const next = getSettings();
  next.chars.transients = normalizeTransients(list);
  saveSettings(next);
}

/** 某一楼当前生效的临时档案:按聊天/楼层迁移后再读。 */
export function transientsForRun(chatId: string, floor: number): TransientProfile[] {
  const s = getSettings();
  const list = normalizeTransients(s.chars?.transients ?? []);
  if (s.chars?.transient?.resetOnChatChange === false) return list;
  const migrated = migrateForFloor(list, chatId, floor);
  if (migrated.changed) setTransients(migrated.list);
  return migrated.list;
}

/** 写入一条临时档案;返回是否真的有内容变化。 */
export function saveTransient(
  patch: TransientPatch,
  opts: { chatId?: string; floor?: number } = {},
): { changed: boolean; profile: TransientProfile } {
  const result = upsertTransient(getTransients(), patch, opts);
  if (result.changed) setTransients(result.list);
  return { changed: result.changed, profile: result.profile };
}

/** 手动清空某个角色的临时档案(回到固定档案)。 */
export function clearTransient(name: string): void {
  setTransients(removeTransient(getTransients(), name));
}

/** 全部清空。 */
export function clearAllTransients(): void {
  setTransients([]);
}

/**
 * 把模型读到的变化写回临时档案。
 *
 * 口径:
 * - 冻结的条目跳过(用户手改过,AI 不许覆盖);
 * - raw 非空 → 整串替换;
 * - raw 空但 reason 非空 → 剧情说「脱光了」这类清空,把临时档案整体清掉
 *   (不是写空串留下来,留着空壳会让下次判断混乱)。
 */
export function applyTransientChanges(
  changes: Array<{ name: string; raw: string; reason: string }>,
  opts: { chatId?: string; floor?: number; onlyKnown?: boolean; knownNames?: string[] } = {},
): { updated: number; cleared: number; skipped: number } {
  let updated = 0;
  let cleared = 0;
  let skipped = 0;
  const known = new Set((opts.knownNames ?? []).map(n => n.toLowerCase()));

  for (const change of changes) {
    const name = String(change.name ?? '').trim();
    if (!name) continue;
    if (opts.onlyKnown && known.size && !known.has(name.toLowerCase())) {
      skipped += 1;
      continue;
    }
    const existing = findTransient(getTransients(), name);
    if (existing?.frozen) {
      skipped += 1;
      continue;
    }
    const raw = String(change.raw ?? '').trim();
    if (!raw) {
      // 剧情明确说「什么都不剩了」:清空这一层,回到固定档案
      if (existing) {
        clearTransient(name);
        cleared += 1;
      }
      continue;
    }
    const result = saveTransient({ name, raw, replace: true }, opts);
    if (result.changed) updated += 1;
  }
  return { updated, cleared, skipped };
}

/** 给 UI:某角色的临时档案摘要。 */
export function transientSummary(name: string): string {
  return transientToTags(findTransient(getTransients(), name));
}

/** 空占位,给编辑器新建用。 */
export function blankTransient(name: string, chatId = '', floor = 0): TransientProfile {
  return emptyTransient(name, chatId, floor);
}
