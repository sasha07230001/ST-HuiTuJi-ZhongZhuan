// @vitest-environment jsdom
/**
 * 原位回插的 DOM 行为。
 *
 * 这一层是「图插回剧情对应位置」的全部逻辑,而且完全依赖 DOM 结构,
 * 所以必须真的在 jsdom 里跑,而不是只测 anchorOf() 这种纯函数。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateFloorImages, insertFloorImage, removeFloorImages, INLINE_CLASS } from '@/ui/inlineImage';

function makeFloor(bodyHtml: string): HTMLElement {
  document.body.innerHTML = `<div id="chat"><div class="mes" mesid="1"><div class="mes_text">${bodyHtml}</div></div></div>`;
  const host = document.querySelector<HTMLElement>('#chat .mes[mesid="1"] .mes_text');
  if (!host) throw new Error('测试夹具没建出来');
  return host;
}

function blocks(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`.${INLINE_CLASS}`)];
}

describe('insertFloorImage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('按锚点插到对应段落之后,而不是一律堆到末尾', () => {
    const host = makeFloor('<p>第一段:她推开门,雨声涌了进来。</p><p>第二段:远处霓虹在水里化开。</p>');

    insertFloorImage(1, { id: 'a1', image: 'data:image/png;base64,AAA', anchor: '雨声涌了进来。' });

    const all = blocks();
    expect(all).toHaveLength(1);
    // 插在第一段后面:父节点里,它前面应该是第一段
    const parent = all[0].parentNode as HTMLElement;
    const children = [...parent.children];
    const at = children.indexOf(all[0]);
    expect(at).toBeGreaterThan(0);
    expect(children[at - 1].textContent).toContain('雨声涌了进来');
    expect(host.textContent).toContain('第二段');
  });

  it('锚点找不到时退化为挂在楼层末尾', () => {
    const host = makeFloor('<p>完全不相关的一段。</p>');
    insertFloorImage(1, { id: 'a2', image: 'data:image/png;base64,BBB', anchor: '正文里没有这句话' });
    const all = blocks();
    expect(all).toHaveLength(1);
    expect(all[0].parentElement).toBe(host);
  });

  it('同一个锚点上插两张:按顺序排在已有图之后', () => {
    makeFloor('<p>第一段。</p><p>雨声涌了进来。</p>');
    insertFloorImage(1, { id: 'x1', image: 'data:1', anchor: '雨声涌了进来。' });
    insertFloorImage(1, { id: 'x2', image: 'data:2', anchor: '雨声涌了进来。' });
    const ids = blocks().map(node => node.dataset.htjImageId);
    expect(ids).toEqual(['x1', 'x2']);
  });

  it('同一个 id 再插一次是替换,不会变成两张', () => {
    makeFloor('<p>雨声涌了进来。</p>');
    insertFloorImage(1, { id: 'same', image: 'data:old', anchor: '雨声涌了进来。' });
    insertFloorImage(1, { id: 'same', image: 'data:new', anchor: '雨声涌了进来。' });
    const all = blocks();
    expect(all).toHaveLength(1);
    expect(all[0].querySelector('img')?.getAttribute('src')).toBe('data:new');
  });

  it('楼层 DOM 不存在时返回 false(交给水合重试)', () => {
    document.body.innerHTML = '<div id="chat"></div>';
    const ok = insertFloorImage(99, { id: 'nope', image: 'data:1', anchor: '' });
    expect(ok).toBe(false);
  });

  it('尾锚点被改过时用开头锚点兜底,仍插在那一段后面', () => {
    const host = makeFloor('<p>第一段:她推开门,雨声涌了进来。</p><p>第二段:霓虹化开。</p>');
    insertFloorImage(1, {
      id: 'head1',
      image: 'data:1',
      anchor: '这段已经被用户改掉的结尾',
      anchorStart: '第一段:她推开门,雨声涌了进来。',
    });
    const all = blocks();
    expect(all).toHaveLength(1);
    const children = [...(all[0].parentNode as HTMLElement).children];
    const at = children.indexOf(all[0]);
    expect(children[at - 1].textContent).toContain('雨声涌了进来');
    void host;
  });
});

describe('hydrateFloorImages', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('重渲染后能整批按锚点挂回,且顺序与入库一致', () => {
    makeFloor('<p>开头。</p><p>中段的锚点在这里。</p><p>结尾。</p>');
    hydrateFloorImages(1, [
      { id: 'h1', image: 'data:1', anchor: '中段的锚点在这里。' },
      { id: 'h2', image: 'data:2', anchor: '结尾。' },
    ]);
    expect(blocks().map(n => n.dataset.htjImageId)).toEqual(['h1', 'h2']);
  });

  it('重复水合不会叠图,也不会把图挪错位置', () => {
    makeFloor('<p>开头。</p><p>中段的锚点在这里。</p>');
    const entries = [{ id: 'k1', image: 'data:1', anchor: '中段的锚点在这里。' }];
    hydrateFloorImages(1, entries);
    hydrateFloorImages(1, entries);
    expect(blocks()).toHaveLength(1);
  });

  it('空列表 = 把这一楼的图全清掉', () => {
    makeFloor('<p>锚点。</p>');
    insertFloorImage(1, { id: 'z1', image: 'data:1', anchor: '锚点。' });
    removeFloorImages(1);
    expect(blocks()).toHaveLength(0);
  });
});
