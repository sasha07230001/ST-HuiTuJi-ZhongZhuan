import { describe, expect, it } from 'vitest';
import { emptyFields, makeEntry } from '@/chars/profile';
import {
  coveredFields,
  emptyTransient,
  findTransient,
  guessOutfitTags,
  mergeTransientTags,
  migrateForFloor,
  normalizeTransients,
  pruneByChat,
  removeTags,
  shouldReset,
  transientHasContent,
  transientToTags,
  upsertTransient,
} from '@/chars/transient';
import { buildTransientPrompt, normalizeTags, parseTransientReply, trimStory } from '@/chars/transientReader';

describe('transientToTags', () => {
  it('只有 raw 时原样送出', () => {
    const t = { ...emptyTransient('A'), raw: 'black lace bra, black lace panties' };
    expect(transientToTags(t)).toBe('black lace bra, black lace panties');
  });

  it('按字段顺序拼(raw 打底)', () => {
    const t = {
      ...emptyTransient('A'),
      raw: 'wet hair',
      fields: { ...emptyFields(), outfit: 'black lace bra', body: 'trembling' },
    };
    expect(transientToTags(t)).toBe('wet hair, black lace bra, trembling');
  });

  it('空条目得空串', () => {
    expect(transientToTags(emptyTransient('A'))).toBe('');
    expect(transientHasContent(emptyTransient('A'))).toBe(false);
  });
});

describe('upsertTransient', () => {
  it('raw 非空时整串替换,并清掉旧字段', () => {
    // 先把服装放在字段里
    let list = upsertTransient([], {
      name: '苏白粥',
      raw: '',
      fields: { ...emptyFields(), outfit: 'white dress' },
      replace: false,
    }).list;
    expect(transientToTags(list[0])).toBe('white dress');

    // 剧情换了黑色蕾丝:整串替换,旧的 white dress 不许残留
    const next = upsertTransient(list, { name: '苏白粥', raw: 'black lace bra, black lace panties' });
    expect(transientToTags(next.list[0])).toBe('black lace bra, black lace panties');
    expect(next.changed).toBe(true);
  });

  it('增量字段合并,没给的字段保留', () => {
    let list = upsertTransient([], { name: 'A', raw: 'black lace bra', replace: false }).list;
    list = upsertTransient(list, {
      name: 'A',
      fields: { outfit: 'black lace set', extra: 'silk ribbon' },
      replace: false,
    }).list;
    expect(transientToTags(list[0])).toBe('black lace bra, black lace set, silk ribbon');
  });

  it('同名大小写不产生两条', () => {
    let list = upsertTransient([], { name: 'Alice', raw: 'x' }).list;
    const second = upsertTransient(list, { name: 'alice', raw: 'y' });
    expect(second.list).toHaveLength(1);
    expect(transientToTags(second.list[0])).toBe('y');
  });

  it('冻结状态沿袭,显式解冻才生效', () => {
    let list = upsertTransient([], { name: 'A', raw: 'x', frozen: true }).list;
    list = upsertTransient(list, { name: 'A', raw: 'y' }).list;
    expect(list[0].frozen).toBe(true);
    list = upsertTransient(list, { name: 'A', frozen: false }).list;
    expect(list[0].frozen).toBe(false);
  });

  it('没变化时 changed=false', () => {
    const list = upsertTransient([], { name: 'A', raw: 'black lace bra' }).list;
    expect(upsertTransient(list, { name: 'A', raw: 'black lace bra' }).changed).toBe(false);
  });
});

describe('mergeTransientTags', () => {
  it('无临时档案时原样返回固定串', () => {
    expect(mergeTransientTags('silver hair, white dress', '', null)).toBe('silver hair, white dress');
  });

  it('只有临时档案时直接用它', () => {
    expect(mergeTransientTags('', 'black lace bra', null)).toBe('black lace bra');
  });

  it('临时档案顶掉固定档案里的字段服装', () => {
    const entry = makeEntry({
      name: 'A',
      fields: { ...emptyFields(), hair: 'silver hair', outfit: 'white dress' },
    });
    // 固定档案拼串 = raw + 字段,顺序是 hair 在前、outfit 在后
    const fixed = 'silver hair, white dress';
    const out = mergeTransientTags(fixed, 'black lace bra, black lace panties', entry);
    expect(out).toBe('silver hair, black lace bra, black lace panties');
    expect(out).not.toContain('white dress');
  });

  it('固定字段里的 odd 服装也被剥掉,发色保留', () => {
    const entry = makeEntry({
      name: 'A',
      fields: { ...emptyFields(), hair: 'silver hair', outfit: 'white dress, thighhighs' },
    });
    const out = mergeTransientTags('silver hair, white dress, thighhighs', 'black lace bra', entry);
    expect(out).toBe('silver hair, black lace bra');
  });

  it('临时档案顶掉固定 raw 里的穿戴段,但保住发色瞳色', () => {
    const entry = makeEntry({ name: 'A', raw: '1girl, silver hair, red eyes, white dress' });
    const out = mergeTransientTags('1girl, silver hair, red eyes, white dress', 'black lace bra', entry);
    expect(out).toBe('1girl, silver hair, red eyes, black lace bra');
  });

  it('关闭覆盖时两串并存(旧行为)', () => {
    const out = mergeTransientTags('white dress', 'black lace bra', null, { dropFromFixedRaw: false });
    expect(out).toBe('white dress, black lace bra');
  });
});

describe('guessOutfitTags / removeTags', () => {
  it('只挑穿戴类,不碰发色瞳色', () => {
    const tags = guessOutfitTags('1girl, silver hair, red eyes, white dress, thighhighs');
    expect(tags).toEqual(['white dress', 'thighhighs']);
  });

  it('removeTags 按整 tag 删,忽略大小写', () => {
    expect(removeTags('Silver Hair, White Dress', ['white dress'])).toBe('Silver Hair');
  });
});

describe('shouldReset / migrateForFloor', () => {
  it('同一聊天相邻楼层保留', () => {
    expect(shouldReset({ chatId: 'c1', floor: 10 }, 'c1', 10)).toBe(false);
    expect(shouldReset({ chatId: 'c1', floor: 10 }, 'c1', 11)).toBe(false);
    expect(shouldReset({ chatId: 'c1', floor: 10 }, 'c1', 8)).toBe(false);
  });

  it('往回跳三楼以上作废', () => {
    expect(shouldReset({ chatId: 'c1', floor: 10 }, 'c1', 7)).toBe(true);
  });

  it('换聊天作废', () => {
    expect(shouldReset({ chatId: 'c1', floor: 10 }, 'c2', 10)).toBe(true);
  });

  it('迁移只留下还成立的条目', () => {
    const list = [
      { ...emptyTransient('A', 'c1', 10), raw: 'x' },
      { ...emptyTransient('B', 'c2', 10), raw: 'y' },
    ];
    const out = migrateForFloor(list, 'c1', 10);
    expect(out.list.map(t => t.name)).toEqual(['A']);
    expect(out.changed).toBe(true);
  });
});

describe('normalizeTransients / pruneByChat', () => {
  it('脏数据丢弃、去重、只收允许字段', () => {
    const out = normalizeTransients([
      { name: 'A', raw: 'x', fields: { outfit: 'bra', fandom: '不该收' } },
      { name: 'a', raw: 'y' },
      { name: '' },
      null,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].fields.outfit).toBe('bra');
    expect(out[0].fields.fandom).toBe('');
  });

  it('非数组得空数组', () => {
    expect(normalizeTransients('x')).toEqual([]);
  });

  it('按聊天剪枝', () => {
    const list = [emptyTransient('A', 'c1'), emptyTransient('B', 'c2'), emptyTransient('C', '')];
    expect(pruneByChat(list, 'c1').map(t => t.name)).toEqual(['A', 'C']);
  });
});

describe('coveredFields', () => {
  it('raw 接管全部槽位', () => {
    expect(coveredFields({ ...emptyTransient('A'), raw: 'x' })).toEqual(['outfit', 'body', 'extra', 'hair']);
  });
  it('只有字段时只报有值的', () => {
    const t = { ...emptyTransient('A'), fields: { ...emptyFields(), outfit: 'bra' } };
    expect(coveredFields(t)).toEqual(['outfit']);
  });
});

describe('parseTransientReply', () => {
  it('解析标准 JSON', () => {
    const r = parseTransientReply(
      '{"cast":["苏白粥"],"changes":[{"name":"苏白粥","raw":"Black_Lace_Bra, black lace panties","reason":"换装","evidence":"她换上了黑色蕾丝"}]}',
    );
    expect(r.cast).toEqual(['苏白粥']);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].raw).toBe('black lace bra, black lace panties'); // 下划线转空格
    expect(r.changes[0].evidence).toBe('她换上了黑色蕾丝');
  });

  it('容忍代码块', () => {
    const r = parseTransientReply('好的\n```json\n{"cast":[],"changes":[]}\n```');
    expect(r.cast).toEqual([]);
  });

  it('坏 JSON 得空结果', () => {
    expect(parseTransientReply('不是 json')).toEqual({ cast: [], changes: [] });
  });

  it('raw 空但有 reason 视为清空指令(保留)', () => {
    const r = parseTransientReply('{"changes":[{"name":"A","reason":"她把衣服全脱了"}]}');
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].raw).toBe('');
  });

  it('什么都没说的条目丢弃', () => {
    const r = parseTransientReply('{"changes":[{"name":"A"}]}');
    expect(r.changes).toEqual([]);
  });
});

describe('normalizeTags / trimStory', () => {
  it('小写化并去下划线', () => {
    expect(normalizeTags('Black_Lace_Bra ,  Wet_Hair')).toBe('black lace bra, wet hair');
  });
  it('超长保留尾部', () => {
    const story = 'a'.repeat(100) + 'TAIL';
    expect(trimStory(story, 10)).toBe('a'.repeat(6) + 'TAIL');
  });
});

describe('buildTransientPrompt', () => {
  it('带上固定档案与当前临时状态', () => {
    const entry = makeEntry({ name: '苏白粥', raw: 'silver hair, white dress' });
    const tmp = { ...emptyTransient('苏白粥'), raw: 'black lace bra' };
    const prompt = buildTransientPrompt('她换上了黑色蕾丝', [entry], [tmp]);
    expect(prompt).toContain('苏白粥');
    expect(prompt).toContain('silver hair, white dress');
    expect(prompt).toContain('black lace bra');
    expect(prompt).toContain('她换上了黑色蕾丝');
    expect(prompt).toContain('"changes"');
  });
});

describe('findTransient', () => {
  it('按名字忽略大小写查找', () => {
    const list = [{ ...emptyTransient('Alice'), raw: 'x' }];
    expect(findTransient(list, 'alice')?.raw).toBe('x');
    expect(findTransient(list, 'nobody')).toBeUndefined();
  });
});
