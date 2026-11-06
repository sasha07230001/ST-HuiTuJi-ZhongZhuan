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
