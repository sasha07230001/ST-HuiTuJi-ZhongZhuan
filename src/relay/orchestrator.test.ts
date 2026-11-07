import { describe, expect, it } from 'vitest';
import { buildMessages, splitPosNeg } from '@/relay/orchestrator';
import { applyPurge } from '@/relay/client';
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

describe('applyPurge', () => {
  const messages = [
    { role: 'system' as const, content: '你是提示词工程师' },
    { role: 'user' as const, content: '编译' },
  ];

  it('关闭时原样返回', () => {
    const out = applyPurge({ purge: { ...DEFAULT_SETTINGS.purge, enabled: false } }, messages);
    expect(out.messages).toBe(messages);
    expect(out.prefilled).toBe(false);
  });

  it('开启时声明压在 system 前,并追加 assistant prefill', () => {
    const out = applyPurge({ purge: DEFAULT_SETTINGS.purge }, messages);
    expect(out.messages).toHaveLength(3);
    expect(out.messages[0].content).toContain('管线声明');
    expect(out.messages[0].content.endsWith('你是提示词工程师')).toBe(true);
    expect(out.messages[2]).toEqual({ role: 'assistant', content: 'POSITIVE:' });
    expect(out.prefilled).toBe(true);
  });

  it('纯 user 请求(自动建档)会自己补一个 system', () => {
    const out = applyPurge({ purge: DEFAULT_SETTINGS.purge }, [{ role: 'user', content: '读剧情' }]);
    expect(out.messages[0].role).toBe('system');
    expect(out.messages[0].content).toContain('管线声明');
  });

  it('只开重写时不动消息', () => {
    const p = { ...DEFAULT_SETTINGS.purge, injectSystem: false, prefill: false };
    const out = applyPurge({ purge: p }, messages);
    expect(out.messages).toEqual(messages);
    expect(out.prefilled).toBe(false);
  });
});
