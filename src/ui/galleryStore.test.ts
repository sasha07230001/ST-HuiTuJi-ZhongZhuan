/**
 * 图库持久化:无 IndexedDB 时(jsdom / 老浏览器)必须退化成内存实现,
 * 而且增删查改的语义要和真库一致,否则「刷新丢图」的修法在测试里看不见。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearChatImages,
  deleteStoredImage,
  listFloorImages,
  listStoredImages,
  newImageId,
  resetGalleryMemory,
  saveStoredImage,
  trimChatImages,
  type StoredImage,
} from '@/ui/galleryStore';

function entry(over: Partial<StoredImage> = {}): StoredImage {
  return {
    id: newImageId(),
    chatId: 'chat-a',
    floor: 3,
    swipe: 0,
    index: 0,
    positive: 'masterpiece, 1girl',
    negative: 'lowres',
    compiled: '1girl',
    seed: 42,
    image: 'data:image/png;base64,AAA',
    anchor: '结尾',
    createdAt: Date.now(),
    ...over,
  };
}

describe('galleryStore(内存兜底)', () => {
  beforeEach(() => {
    resetGalleryMemory();
  });

  it('存进去能按聊天读出来', async () => {
    await saveStoredImage(entry({ id: 'a1' }));
    await saveStoredImage(entry({ id: 'b1', chatId: 'chat-b' }));
    const list = await listStoredImages('chat-a');
    expect(list.map(x => x.id)).toEqual(['a1']);
  });

  it('按楼层+swipe 过滤', async () => {
    await saveStoredImage(entry({ id: 'f3', floor: 3, swipe: 0 }));
    await saveStoredImage(entry({ id: 'f4', floor: 4, swipe: 0 }));
    await saveStoredImage(entry({ id: 'f3s1', floor: 3, swipe: 1 }));
    const list = await listFloorImages('chat-a', 3, 0);
    expect(list.map(x => x.id)).toEqual(['f3']);
  });

  it('同 id 覆盖而不是新增', async () => {
    await saveStoredImage(entry({ id: 'dup', positive: 'old' }));
    await saveStoredImage(entry({ id: 'dup', positive: 'new' }));
    const list = await listStoredImages('chat-a');
    expect(list).toHaveLength(1);
    expect(list[0].positive).toBe('new');
  });

  it('按楼层/序号排序(多图回插顺序靠它)', async () => {
    await saveStoredImage(entry({ id: 'b', floor: 5, index: 0, createdAt: 1 }));
    await saveStoredImage(entry({ id: 'a', floor: 2, index: 1, createdAt: 2 }));
    await saveStoredImage(entry({ id: 'c', floor: 2, index: 0, createdAt: 3 }));
    const list = await listStoredImages('chat-a');
    expect(list.map(x => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('删一张 / 清空一个聊天', async () => {
    await saveStoredImage(entry({ id: 'x' }));
    await saveStoredImage(entry({ id: 'y', chatId: 'chat-b' }));
    await deleteStoredImage('x');
    expect(await listStoredImages('chat-a')).toHaveLength(0);
    await clearChatImages('chat-b');
    expect(await listStoredImages('chat-b')).toHaveLength(0);
  });

  it('超过上限删最老的', async () => {
    for (let i = 0; i < 5; i++) {
      await saveStoredImage(entry({ id: `i${i}`, createdAt: 1000 + i }));
    }
    const removed = await trimChatImages('chat-a', 2);
    expect(removed).toBe(3);
    const left = await listStoredImages('chat-a');
    expect(left.map(x => x.id).sort()).toEqual(['i3', 'i4']);
  });
});
