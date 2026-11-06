import { describe, expect, it } from 'vitest';
import {
  charactersInText,
  emptyFields,
  entryToPromptTags,
  makeEntry,
  mergeCharacterPrompts,
  normalizeEntries,
  textMentionsName,
  upsertEntry,
  removeEntry,
} from '@/chars/profile';
import { parseCastReply } from '@/chars/archive';

describe('entryToPromptTags', () => {
  it('只有 raw 时原样送出', () => {
    const e = makeEntry({ name: 'A', raw: 'silver hair, blue eyes' });
    expect(entryToPromptTags(e)).toBe('silver hair, blue eyes');
  });

  it('按字段顺序拼', () => {
    const e = makeEntry({ name: 'A', fields: { ...emptyFields(), hair: 'long black hair', eyes: 'red eyes' } });
    expect(entryToPromptTags(e)).toBe('long black hair, red eyes');
  });

  it('raw 与字段并存时都送(raw 打底)', () => {
    const e = makeEntry({ name: 'A', raw: '1girl', fields: { ...emptyFields(), hair: 'black hair' } });
    expect(entryToPromptTags(e)).toBe('1girl, black hair');
  });

  it('空档案得空串', () => {
    expect(entryToPromptTags(makeEntry({ name: 'A' }))).toBe('');
  });
});

describe('textMentionsName', () => {
  it('中文名直接包含匹配', () => {
    expect(textMentionsName('苏白粥站在门口', '苏白粥')).toBe(true);
    expect(textMentionsName('洛野站在门口', '苏白粥')).toBe(false);
  });

  it('英文名有词边界,不会误命中', () => {
    expect(textMentionsName('Alice smiled', 'Alice')).toBe(true);
    expect(textMentionsName('Malice smiled', 'Alice')).toBe(false);
  });

  it('空名字不命中', () => {
    expect(textMentionsName('任意文本', '')).toBe(false);
  });
});

describe('charactersInText', () => {
  const make = () =>
    [
      makeEntry({ name: '苏白粥', raw: 'black hair' }),
      makeEntry({ name: '白粥', raw: 'short hair' }),
      makeEntry({ name: '洛野', raw: 'black coat' }),
    ];

  it('长名优先,避免短名抢位', () => {
    const found = charactersInText('苏白粥看着洛野', make());
    const names = found.map(e => e.name);
    expect(names).toContain('苏白粥');
    expect(names).toContain('洛野');
    expect(names).not.toContain('白粥');
  });

  it('跳过被禁用的角色', () => {
    const entries = make();
    entries[0].enabled = false;
    const names = charactersInText('苏白粥看着洛野', entries).map(e => e.name);
    expect(names).not.toContain('苏白粥');
  });
});

describe('mergeCharacterPrompts', () => {
  it('把在场角色外貌拼到原有提示词后面', () => {
    const chars = [makeEntry({ name: 'A', raw: 'silver hair' }), makeEntry({ name: 'B', raw: 'black coat' })];
    expect(mergeCharacterPrompts('1girl, rain', chars)).toBe('1girl, rain, silver hair, black coat');
  });

  it('没有可用角色时原样返回', () => {
    expect(mergeCharacterPrompts('1girl', [])).toBe('1girl');
    expect(mergeCharacterPrompts('1girl', [makeEntry({ name: 'X' })])).toBe('1girl');
  });

  it('跳过禁用角色', () => {
    const disabled = makeEntry({ name: 'B', raw: 'black coat' });
    disabled.enabled = false;
    expect(mergeCharacterPrompts('1girl', [disabled])).toBe('1girl');
  });
});

describe('normalizeEntries', () => {
  it('丢弃非法项、去重', () => {
    const out = normalizeEntries([
      { name: 'A', raw: 'x' },
      { name: 'a', raw: 'y' },
      { name: '' },
      null,
      { name: 'B', fields: { hair: 'black' } },
    ]);
    expect(out.map(e => e.name)).toEqual(['A', 'B']);
  });

  it('非数组输入得空数组', () => {
    expect(normalizeEntries(null)).toEqual([]);
    expect(normalizeEntries('x')).toEqual([]);
  });
});

describe('upsertEntry / removeEntry', () => {
  it('新建与更新', () => {
    const first = upsertEntry([], makeEntry({ name: 'A', raw: 'x' }));
    expect(first.created).toBe(true);
    const second = upsertEntry(first.entries, makeEntry({ name: 'A', raw: 'y' }));
    expect(second.created).toBe(false);
    expect(second.entries[0].raw).toBe('y');
  });

  it('删除', () => {
    const list = [makeEntry({ name: 'A' }), makeEntry({ name: 'B' })];
    expect(removeEntry(list, 'a').map(e => e.name)).toEqual(['B']);
  });
});

describe('parseCastReply', () => {
  it('解析标准 JSON', () => {
    const r = parseCastReply('{"cast":["苏白粥"],"changes":[{"name":"苏白粥","field":"new","value":"black hair","reason":"首次登场"}]}');
    expect(r.cast).toEqual(['苏白粥']);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].field).toBe('new');
  });

  it('容忍代码块与前后废话', () => {
    const r = parseCastReply('好的:\n```json\n{"cast":["A"],"changes":[]}\n```\n完毕');
    expect(r.cast).toEqual(['A']);
  });

  it('坏 JSON 得空结果', () => {
    expect(parseCastReply('完全不是 json')).toEqual({ cast: [], changes: [] });
  });

  it('丢弃非法字段名与缺值项', () => {
    const r = parseCastReply('{"cast":[],"changes":[{"name":"A","field":"bogus","value":"x"},{"name":"B","field":"hair","value":""}]}');
    expect(r.changes).toEqual([]);
  });

  it('接受合法字段名', () => {
    const r = parseCastReply('{"cast":[],"changes":[{"name":"A","field":"hair","value":"black hair"}]}');
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].field).toBe('hair');
  });
});
