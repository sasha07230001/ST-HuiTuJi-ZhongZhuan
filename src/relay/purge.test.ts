import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFILL_TEXT,
  DEFAULT_PURGE_PROMPT,
  injectPurge,
  mergePurge,
  rewriteDegraded,
  stripPrefill,
  withPrefill,
  type PurgeSettings,
} from '@/relay/purge';

const DEFAULTS: PurgeSettings = {
  enabled: true,
  injectSystem: true,
  systemPrompt: DEFAULT_PURGE_PROMPT,
  prefill: true,
  prefillText: DEFAULT_PREFILL_TEXT,
  rewrite: true,
  maxExtraTags: 12,
};

describe('injectPurge', () => {
  it('声明在前、原 system 在后', () => {
    const out = injectPurge('你是提示词工程师', '【管线声明】');
    expect(out.startsWith('【管线声明】')).toBe(true);
    expect(out.endsWith('你是提示词工程师')).toBe(true);
  });
  it('声明为空时原样返回', () => {
    expect(injectPurge('原 system', '   ')).toBe('原 system');
  });
});

describe('withPrefill / stripPrefill', () => {
  it('追加 assistant 起头', () => {
    const out = withPrefill([{ role: 'system', content: 's' }], 'POSITIVE:');
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: 'assistant', content: 'POSITIVE:' });
  });
  it('prefill 为空不追加', () => {
    const messages = [{ role: 'user', content: 'u' }];
    expect(withPrefill(messages, '  ')).toHaveLength(1);
  });
  it('削掉端点的 prefill 回显', () => {
    expect(stripPrefill('POSITIVE:1girl, gore', 'POSITIVE:')).toBe('1girl, gore');
    expect(stripPrefill('POSITIVE: 1girl', 'POSITIVE:')).toBe('1girl');
  });
  it('没有回显时幂等', () => {
    expect(stripPrefill('1girl, smile', 'POSITIVE:')).toBe('1girl, smile');
  });
});

describe('rewriteDegraded', () => {
  it('正文有血腥、提示词被洗白 → 补回 gore 系 tag', () => {
    const story = '她的腹部被剖开,鲜血流了一地。';
    const out = rewriteDegraded(story, '1girl, standing, dark atmosphere');
    expect(out.added).toContain('gore');
    expect(out.added).toContain('blood');
    expect(out.prompt).toContain('gore');
  });

  it('已经有了就不重复补', () => {
    const story = '地上一摊血泊。';
    const out = rewriteDegraded(story, '1girl, blood, blood splatter');
    expect(out.added).toHaveLength(0);
    expect(out.prompt).toBe('1girl, blood, blood splatter');
  });

  it('正文干净时完全不动', () => {
    const out = rewriteDegraded('她站在窗边看雨。', '1girl, window, rain');
    expect(out.added).toHaveLength(0);
    expect(out.prompt).toBe('1girl, window, rain');
  });

  it('遵守 maxExtra 上限', () => {
    const story = '浑身是血,断了一只手,腹部被剖开,变成畸形的怪物,赤裸着身体。';
    const out = rewriteDegraded(story, '1girl', 3);
    expect(out.added.length).toBeLessThanOrEqual(3);
  });

  it('同时命中成人词时补 nsfw 系', () => {
    const story = '她一丝不挂地跪在地上,身体止不住地痉挛。';
    const out = rewriteDegraded(story, '1girl, kneeling');
    expect(out.added).toContain('nude');
    expect(out.added).toContain('orgasm');
  });

  it('空提示词原样返回', () => {
    const out = rewriteDegraded('有血。', '');
    expect(out.prompt).toBe('');
    expect(out.added).toHaveLength(0);
  });

  it('补完之后逗号不黏连', () => {
    const out = rewriteDegraded('一摊鲜血。', '1girl,');
    expect(out.prompt).toBe('1girl, blood, blood splatter');
  });
});

describe('mergePurge', () => {
  it('老存档没有 purge 字段 → 全用默认', () => {
    expect(mergePurge(DEFAULTS, undefined)).toEqual(DEFAULTS);
  });
  it('只覆盖存在且类型对的字段', () => {
    const merged = mergePurge(DEFAULTS, { enabled: false, maxExtraTags: 'bad', systemPrompt: 42 });
    expect(merged.enabled).toBe(false);
    expect(merged.maxExtraTags).toBe(12);
    expect(merged.systemPrompt).toBe(DEFAULT_PURGE_PROMPT);
  });
  it('maxExtraTags 落在 0~40', () => {
    expect(mergePurge(DEFAULTS, { maxExtraTags: 999 }).maxExtraTags).toBe(40);
    expect(mergePurge(DEFAULTS, { maxExtraTags: -5 }).maxExtraTags).toBe(0);
  });
});
