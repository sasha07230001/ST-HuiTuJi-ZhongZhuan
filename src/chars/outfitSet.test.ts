import { describe, expect, it } from 'vitest';
import { expandOutfitTag, expandOutfitTags, SPLIT_EXAMPLES } from '@/chars/outfitSet';
import { emptyFields, makeEntry } from '@/chars/profile';
import { emptyTransient, transientToClipTags, transientToTags } from '@/chars/transient';
import { mergeTransientTags } from '@/chars/transient';

const tags = (input: string) => expandOutfitTag(input).tags;

describe('expandOutfitTag · 该拆的', () => {
  it('black lace set → 胸罩 + 内裤(核心场景,材质必须保留)', () => {
    expect(tags('black lace set')).toEqual(['black lace bra', 'black lace panties']);
  });

  it('sheer black lace set → 定语完整复制', () => {
    expect(tags('sheer black lace set')).toEqual(['sheer black lace bra', 'sheer black lace panties']);
  });

  it('纯 set 也拆,不带定语', () => {
    expect(tags('set')).toEqual(['bra', 'panties']);
  });

  it('black set → 带颜色的内衣套', () => {
    expect(tags('black set')).toEqual(['black bra', 'black panties']);
  });

  it('white lingerie → 拆成 lingerie + bra + panties', () => {
    expect(tags('white lingerie')).toEqual(['white lingerie', 'white bra', 'white panties']);
  });

  it('red bikini → 泳衣本体 + 上下两件', () => {
    expect(tags('red bikini')).toEqual(['red bikini', 'red bikini top', 'red bikini bottom']);
  });

  it('school uniform → 上衣 + 裙 + 领', () => {
    expect(tags('school uniform')).toEqual([
      'school uniform',
      'serafuku',
      'pleated skirt',
      'sailor collar',
    ]);
  });

  it('bunny suit → 本体 + 耳 + 网袜', () => {
    expect(tags('black bunny suit')).toEqual([
      'black bunny suit',
      'bunny ears',
      'black fishnet tights',
      'white collar',
    ]);
  });

  it('maid outfit → 本体 + 围裙 + 头饰', () => {
    expect(tags('maid outfit')).toEqual(['maid outfit', 'apron', 'maid headdress']);
  });

  it('pajamas → 上下两件', () => {
    expect(tags('pajamas')).toEqual(['pajamas', 'pajama top', 'pajama pants']);
  });

  it('多个定语都复制到每个部件', () => {
    expect(tags('sheer black lace set')).toEqual(['sheer black lace bra', 'sheer black lace panties']);
  });

  it('and 连接的成套:两侧都得带上颜色', () => {
    expect(tags('black bra and panties')).toEqual(['black bra', 'black panties']);
    expect(tags('matching black bra and panties set')).toEqual(['black bra', 'black panties']);
    expect(tags('bra and panties')).toEqual(['bra', 'panties']);
  });

  it('expanded 标记正确', () => {
    expect(expandOutfitTag('black lace set').expanded).toBe(true);
    expect(expandOutfitTag('black lace bra').expanded).toBe(false);
  });
});

describe('expandOutfitTag · 不该拆的(宁漏勿错)', () => {
  it('单一部件原样返回', () => {
    expect(tags('black lace bra')).toEqual(['black lace bra']);
    expect(tags('lace panties')).toEqual(['lace panties']);
    expect(tags('black thighhighs')).toEqual(['black thighhighs']);
    expect(tags('pleated skirt')).toEqual(['pleated skirt']);
  });

  it('只有颜色材质,没套名', () => {
    expect(tags('black lace')).toEqual(['black lace']);
    expect(tags('sheer black lace')).toEqual(['sheer black lace']);
    expect(tags('lace')).toEqual(['lace']);
  });

  it('没写「套」不猜(black dress 不该被拆成两件)', () => {
    expect(tags('black dress')).toEqual(['black dress']);
    expect(tags('white shirt')).toEqual(['white shirt']);
    expect(tags('satin slip dress')).toEqual(['satin slip dress']);
    expect(tags('black veil dress')).toEqual(['black veil dress']);
  });

  it('and 拆分只认穿戴部件(黑发红瞳不能被拆)', () => {
    expect(tags('black hair and red eyes')).toEqual(['black hair and red eyes']);
  });

  it('剧情通用词不受影响', () => {
    expect(tags('completely nude')).toEqual(['completely nude']);
    expect(tags('wolf')).toEqual(['wolf']);
  });

  it('空串安全', () => {
    expect(tags('')).toEqual([]);
    expect(expandOutfitTag('   ').expanded).toBe(false);
  });

  it('只拆一次,不会有二次展开', () => {
    const once = expandOutfitTag('black lace set');
    for (const t of once.tags) {
      expect(expandOutfitTag(t).expanded).toBe(false);
    }
  });
});

describe('expandOutfitTags · 整串', () => {
  it('展开并去重', () => {
    const out = expandOutfitTags('1girl, black lace set, black lace bra, wet hair');
    expect(out.tags).toBe('1girl, black lace bra, black lace panties, wet hair');
    expect(out.expanded).toEqual(['black lace set']);
  });

  it('报告展开了哪些词', () => {
    const out = expandOutfitTags('black lace set, red bikini');
    expect(out.expanded).toEqual(['black lace set', 'red bikini']);
  });
  it('没有套词时原样(顺序不变)', () => {
    expect(expandOutfitTags('1girl, silver hair, white dress').tags).toBe('1girl, silver hair, white dress');
    expect(expandOutfitTags('1girl, silver hair, white dress').expanded).toEqual([]);
  });

  it('空串安全', () => {
    expect(expandOutfitTags('').tags).toBe('');
  });
});

describe('transientToClipTags 与存档分层', () => {
  it('存档保留原文,送 CLIP 才展开', () => {
    const tmp = { ...emptyTransient('苏白粥'), raw: 'black lace set' };
    expect(transientToTags(tmp)).toBe('black lace set');
    expect(transientToClipTags(tmp)).toBe('black lace bra, black lace panties');
  });

  it('字段形式也展开', () => {
    const tmp = { ...emptyTransient('A'), fields: { ...emptyFields(), outfit: 'black lace set' } };
    expect(transientToClipTags(tmp)).toBe('black lace bra, black lace panties');
  });

  it('空档案得空串', () => {
    expect(transientToClipTags(emptyTransient('A'))).toBe('');
    expect(transientToClipTags(null)).toBe('');
  });
});

describe('展开后与固定档案合并', () => {
  it('成套蕾丝顶掉白裙,且拆成两件', () => {
    const entry = makeEntry({
      name: '苏白粥',
      fields: { ...emptyFields(), hair: 'silver hair', outfit: 'white dress' },
    });
    const tmp = { ...emptyTransient('苏白粥'), raw: 'black lace set' };
    const out = mergeTransientTags('silver hair, white dress', transientToClipTags(tmp), entry);
    expect(out).toBe('silver hair, black lace bra, black lace panties');
    expect(out).not.toContain('white dress');
    expect(out).not.toContain('set');
  });
});

describe('SPLIT_EXAMPLES', () => {
  it('每条示例的右侧都是 ≥2 个具体 tag', () => {
    for (const line of SPLIT_EXAMPLES.split('\n')) {
      const [left, right] = line.split('→').map(s => s.trim());
      expect(left.length).toBeGreaterThan(0);
      expect(right.split(',').length).toBeGreaterThanOrEqual(2);
    }
  });

  it('示例里的左侧真的会被展开', () => {
    for (const line of SPLIT_EXAMPLES.split('\n')) {
      const left = line.split('→')[0].trim();
      expect(expandOutfitTag(left).expanded).toBe(true);
    }
  });
});
