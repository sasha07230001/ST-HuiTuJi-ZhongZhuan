import { describe, expect, it } from 'vitest';
import {
  cleanStoryText,
  joinNegative,
  joinPositive,
  normalizeComfyUrl,
  normalizeRelayUrl,
  renderSystemPrompt,
  unwrapPromptReply,
  validatePrompt,
} from '@/relay/prompt';

describe('normalizeRelayUrl', () => {
  it('纯域名补 /v1', () => {
    expect(normalizeRelayUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1');
    expect(normalizeRelayUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com/v1');
  });
  it('完整端点只留 base', () => {
    expect(normalizeRelayUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1');
  });
  it('自定义子路径原样保留', () => {
    expect(normalizeRelayUrl('https://x.com/v2/coding')).toBe('https://x.com/v2/coding');
  });
  it('空串返回空串', () => {
    expect(normalizeRelayUrl('  ')).toBe('');
  });
});

describe('normalizeComfyUrl', () => {
  it('去掉尾部斜杠', () => {
    expect(normalizeComfyUrl('http://127.0.0.1:8188///')).toBe('http://127.0.0.1:8188');
  });
});

describe('cleanStoryText', () => {
  it('剥 HTML 与 Markdown', () => {
    expect(cleanStoryText('<p>**她**笑了</p>')).toBe('她笑了');
  });
  it('剥掉上一轮出图卡', () => {
    const text = '正文A<htj-zz-card data-x="1">图片</htj-zz-card>正文B';
    expect(cleanStoryText(text)).toBe('正文A正文B');
  });
  it('超长保留尾部', () => {
    const long = 'a'.repeat(7000) + '结尾';
    const out = cleanStoryText(long);
    expect(out.endsWith('结尾')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(6000);
  });
});

describe('unwrapPromptReply', () => {
  it('取代码块内容', () => {
    expect(unwrapPromptReply('好的:\n```\n1girl, smile\n```\n')).toBe('1girl, smile');
  });
  it('剥掉「提示词:」前缀', () => {
    expect(unwrapPromptReply('提示词:1girl, red hair')).toBe('1girl, red hair');
  });
  it('多行合并成一行', () => {
    expect(unwrapPromptReply('1girl,\nred hair,\nkind smile')).toBe('1girl, red hair, kind smile');
  });
  it('空回复得空串', () => {
    expect(unwrapPromptReply('   ')).toBe('');
  });
});

describe('validatePrompt', () => {
  it('英文 tag 通过', () => {
    expect(validatePrompt('1girl, silver hair, night city').ok).toBe(true);
  });
  it('空串不通过', () => {
    expect(validatePrompt('').ok).toBe(false);
  });
  it('全中文不通过', () => {
    expect(validatePrompt('一个女孩站在夜晚的城市里微笑').ok).toBe(false);
  });
  it('以中文为主不通过', () => {
    expect(validatePrompt('1girl 一个女孩站在夜晚的城市里微笑看着远方').ok).toBe(false);
  });
});

describe('joinPositive / joinNegative', () => {
  it('拼接并去重(大小写不敏感)', () => {
    expect(joinPositive('1girl, Blue hair', 'blue hair, masterpiece')).toBe('1girl, Blue hair, masterpiece');
  });
  it('负面拼接', () => {
    expect(joinNegative('blurry', 'lowres')).toBe('blurry, lowres');
  });
});

describe('renderSystemPrompt', () => {
  it('替换两个占位符并保留其它宏', () => {
    const out = renderSystemPrompt('正文:{{story}}\n提示:{{note}}\n用户:{{user}}', '她在雨中', '');
    expect(out).toContain('正文:她在雨中');
    expect(out).toContain('提示:(无)');
    expect(out).toContain('{{user}}');
  });
});
