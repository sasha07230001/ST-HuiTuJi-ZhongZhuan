import { describe, expect, it } from 'vitest';
import { buildMessages, splitPosNeg } from '@/relay/orchestrator';
import { DEFAULT_SETTINGS } from '@/types';

describe('splitPosNeg', () => {
  it('带标记时正确拆分', () => {
    const out = splitPosNeg('POSITIVE: 1girl, city\nNEGATIVE: blurry, lowres');
    expect(out.positive).toBe('1girl, city');
    expect(out.negative).toBe('blurry, lowres');
  });
  it('没有标记时整段当正面', () => {
    const out = splitPosNeg('1girl, city, night');
    expect(out.positive).toBe('1girl, city, night');
    expect(out.negative).toBe('');
  });
  it('只有负面也算识别', () => {
    const out = splitPosNeg('NEGATIVE: blurry');
    expect(out.negative).toBe('blurry');
  });
});

describe('buildMessages', () => {
  it('开启负面要求时附加说明', () => {
    const s = { ...DEFAULT_SETTINGS, prompt: { ...DEFAULT_SETTINGS.prompt, wantNegative: true } };
    const msgs = buildMessages(s, '她在雨里站着', '');
    expect(msgs[0].content).toContain('她在雨里站着');
    expect(msgs[1].content).toContain('NEGATIVE:');
  });
  it('关闭时不附加', () => {
    const msgs = buildMessages(DEFAULT_SETTINGS, '她在雨里站着', '');
    expect(msgs[1].content).not.toContain('NEGATIVE:');
  });
});
