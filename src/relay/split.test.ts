import { describe, expect, it } from 'vitest';
import {
  anchorOf,
  clampCount,
  normalizeMark,
  planSegments,
  splitEven,
  splitByMark,
} from '@/relay/split';

describe('normalizeMark / clampCount', () => {
  it('空标记回落默认值', () => {
    expect(normalizeMark('')).toBe('[[图]]');
    expect(normalizeMark('   ')).toBe('[[图]]');
    expect(normalizeMark('<图>')).toBe('<图>');
  });
  it('张数收敛 1..8', () => {
    expect(clampCount(0)).toBe(1);
    expect(clampCount(-3)).toBe(1);
    expect(clampCount(2.4)).toBe(2);
    expect(clampCount(99)).toBe(8);
    expect(clampCount('abc')).toBe(1);
  });
});

describe('anchorOf', () => {
  it('取结尾 32 字并折叠空白', () => {
    const text = 'a'.repeat(40) + '  结尾\n文字';
    const anchor = anchorOf(text);
    expect(anchor.length).toBeLessThanOrEqual(32);
    expect(anchor).toBe(anchor.replace(/\s+/g, ' '));
    expect(anchor.endsWith('文字')).toBe(true);
  });
  it('短文本原样返回', () => {
    expect(anchorOf('她笑了')).toBe('她笑了');
  });
});

describe('splitByMark', () => {
  it('按标记切并丢掉空段', () => {
    expect(splitByMark('第一段。[[图]]第二段。[[图]]', '[[图]]')).toEqual(['第一段。', '第二段。']);
  });
});

describe('splitEven', () => {
  it('按空行切', () => {
    const out = splitEven('A段\n\nB段\n\nC段', 2);
    expect(out.length).toBe(2);
    expect(out.join('')).toContain('A段');
    expect(out.join('')).toContain('C段');
  });
  it('只有一句话时按字符硬切也能凑出张数', () => {
    const out = splitEven('她'.repeat(100), 4);
    expect(out.length).toBe(4);
  });
  it('张数为 1 时整段返回', () => {
    expect(splitEven('只有一段', 1)).toEqual(['只有一段']);
  });
});

describe('planSegments', () => {
  it('有标记时按标记切，张数由标记决定', () => {
    const segs = planSegments('甲[[图]]乙[[图]]丙', { count: 1, mark: '[[图]]' });
    expect(segs.map(s => s.text)).toEqual(['甲', '乙', '丙']);
    expect(segs[1].anchor).toBe('乙');
  });
  it('没有标记时按张数均分', () => {
    const segs = planSegments('第一段\n\n第二段\n\n第三段', { count: 3 });
    expect(segs.length).toBe(3);
    expect(segs.every(s => s.text.length > 0)).toBe(true);
  });
  it('空正文返回空数组', () => {
    expect(planSegments('   ', { count: 3 })).toEqual([]);
  });
  it('每段都带开头锚点(尾部被改过时回插兜底)', () => {
    const segs = planSegments('第一段在这里结束。\n\n第二段从这里开始,然后结束。', { count: 2 });
    expect(segs[0].anchorStart.startsWith('第一段')).toBe(true);
    expect(segs[1].anchor.endsWith('结束。')).toBe(true);
  });
  it('offset 指向该段在整楼里的起始位置(分段预览用)', () => {
    const story = 'AAA\n\nBBB\n\nCCC';
    const segs = planSegments(story, { count: 3 });
    expect(segs.map(s => s.offset)).toEqual([0, story.indexOf('BBB'), story.indexOf('CCC')]);
  });
});
