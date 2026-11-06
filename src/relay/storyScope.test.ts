import { describe, expect, it } from 'vitest';
import {
  extractStoryScope,
  hasStoryScope,
  parseStoryScopeTagNames,
  scopedStoryText,
} from '@/relay/storyScope';

describe('parseStoryScopeTagNames', () => {
  it('逗号/顿号/空白分隔', () => {
    expect(parseStoryScopeTagNames('content, story、正文 正文2')).toEqual(['content', 'story', '正文', '正文2']);
  });
  it('剥掉尖括号与波浪壳', () => {
    expect(parseStoryScopeTagNames('<content>, content_fox~, </story>')).toEqual(['content', 'content_fox', 'story']);
  });
  it('去重(大小写不敏感)', () => {
    expect(parseStoryScopeTagNames('Content, content, CONTENT')).toEqual(['Content']);
  });
  it('空串得空数组', () => {
    expect(parseStoryScopeTagNames('   ')).toEqual([]);
  });
});

describe('extractStoryScope', () => {
  const story = '<thought>我在想什么</thought><content>她站在雨里看着霓虹。</content>';

  it('取到成对块里的剧情', () => {
    const r = extractStoryScope(story, ['content']);
    expect(r.text).toBe('她站在雨里看着霓虹。');
    expect(r.reason).toBe('ok');
  });

  it('没配标签 → 不生效', () => {
    expect(extractStoryScope(story, []).text).toBeNull();
  });

  it('标签没成对 → 回退(不猜)', () => {
    const r = extractStoryScope('content 只是文字出现了一下', ['content']);
    expect(r.text).toBeNull();
    expect(r.reason).toContain('没有找到成对');
  });

  it('标签存在但内容为空 → 不生效', () => {
    const r = extractStoryScope('<content>   </content>', ['content']);
    expect(r.text).toBeNull();
  });

  it('多个同名块:默认取最后一个', () => {
    const text = '<content>格式示例</content>中间<content>真正文</content>';
    expect(extractStoryScope(text, ['content']).text).toBe('真正文');
  });

  it('pick=first 取第一个', () => {
    const text = '<content>第一</content><content>第二</content>';
    expect(extractStoryScope(text, ['content'], 'first').text).toBe('第一');
  });

  it('pick=all 全部拼接', () => {
    const text = '<content>第一</content><content>第二</content>';
    expect(extractStoryScope(text, ['content'], 'all').text).toBe('第一\n\n第二');
  });

  it('兼容带属性与波浪壳', () => {
    const text = '<content_fox~ lang="zh">狐狸尾巴</content_fox~>';
    expect(extractStoryScope(text, ['content_fox']).text).toBe('狐狸尾巴');
  });

  it('大小写不敏感', () => {
    expect(extractStoryScope('<CONTENT>大写</CONTENT>', ['content']).text).toBe('大写');
  });

  it('多标签按文中出现顺序拼接', () => {
    const text = '<b>乙</b><a>甲</a>';
    expect(extractStoryScope(text, ['a', 'b'], 'all').text).toBe('乙\n\n甲');
  });

  it('记录命中块数与标签名', () => {
    const r = extractStoryScope('<a>x</a><a>y</a>', ['a']);
    expect(r.blockCount).toBe(2);
    expect(r.matchedTags).toEqual(['a']);
  });

  it('返回空正文时按失败处理', () => {
    expect(extractStoryScope('', ['content']).text).toBeNull();
  });
});

describe('scopedStoryText / hasStoryScope', () => {
  it('取不到返回 null,便于调用方回退整楼', () => {
    expect(scopedStoryText('没有标签的正文', ['content'])).toBeNull();
  });
  it('hasStoryScope 判空', () => {
    expect(hasStoryScope([])).toBe(false);
    expect(hasStoryScope([''])).toBe(false);
    expect(hasStoryScope(['content'])).toBe(true);
  });
});
