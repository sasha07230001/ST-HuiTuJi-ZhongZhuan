/**
 * 端到端:剧情换装 → 临时档案 → 最终送进 ComfyUI CLIP 的那串提示词。
 *
 * 这里不打桩中转站,只验证「拼装」这一段——它是本功能唯一真正容易错的地方:
 * 固定档案的 white dress 与临时档案的 black lace bra 同时出现,图就会糊。
 */
import { describe, expect, it } from 'vitest';
import { emptyFields, entryToPromptTags, makeEntry } from '@/chars/profile';
import { emptyTransient, findTransient, mergeTransientTags, transientToTags } from '@/chars/transient';
import { joinPositive } from '@/relay/prompt';

/** 与 orchestrator ③.5 步相同的拼装口径(抽出来测,避免测到别的东西)。 */
function assemble(
  compiled: string,
  styleSuffix: string,
  present: Array<{ fixed: ReturnType<typeof makeEntry>; tmpTags: string; override: boolean }>,
): string {
  let positive = joinPositive(compiled, styleSuffix);
  const fixedParts: string[] = [];
  const transientParts: string[] = [];
  for (const { fixed, tmpTags, override } of present) {
    const fixedTags = entryToPromptTags(fixed);
    if (tmpTags) {
      transientParts.push(
        override ? mergeTransientTags(fixedTags, tmpTags, fixed) : mergeTransientTags(fixedTags, tmpTags, fixed, { dropFromFixedRaw: false }),
      );
    } else fixedParts.push(fixedTags);
  }
  const merged = [...fixedParts, ...transientParts].filter(Boolean).join(', ');
  return merged ? `${positive}, ${merged}` : positive;
}

const style = 'masterpiece, best quality, anime style';

describe('剧情换装 → 提示词', () => {
  it('临时档案接管服装,固定档案的旧裙子不被送进 CLIP', () => {
    const entry = makeEntry({
      name: '苏白粥',
      fields: { ...emptyFields(), hair: 'silver hair', eyes: 'red eyes', outfit: 'white dress' },
    });
    const tmp = { ...emptyTransient('苏白粥'), raw: 'black lace bra, black lace panties, black thighhighs' };
    const out = assemble('1girl, standing in rain', style, [
      { fixed: entry, tmpTags: transientToTags(tmp), override: true },
    ]);
    expect(out).toContain('black lace bra');
    expect(out).toContain('black lace panties');
    expect(out).not.toContain('white dress');
    // 固定项必须还在
    expect(out).toContain('silver hair');
    expect(out).toContain('red eyes');
  });

  it('没有临时档案时行为和旧版完全一致', () => {
    const entry = makeEntry({ name: 'A', raw: 'silver hair, white dress' });
    const out = assemble('1girl', style, [{ fixed: entry, tmpTags: '', override: true }]);
    expect(out).toBe('1girl, masterpiece, best quality, anime style, silver hair, white dress');
  });

  it('多个角色:一个换装、一个不变,各走各的', () => {
    const a = makeEntry({ name: 'A', fields: { ...emptyFields(), hair: 'black hair', outfit: 'white dress' } });
    const b = makeEntry({ name: 'B', raw: 'short hair, black coat' });
    const out = assemble('2girls, alley', style, [
      { fixed: a, tmpTags: 'black lace bra', override: true },
      { fixed: b, tmpTags: '', override: true },
    ]);
    expect(out).toContain('black lace bra');
    expect(out).not.toContain('white dress');
    expect(out).toContain('black coat');
  });

  it('关闭覆盖时保留旧行为(两串都在)', () => {
    const entry = makeEntry({ name: 'A', raw: 'white dress' });
    const out = assemble('1girl', style, [{ fixed: entry, tmpTags: 'black lace bra', override: false }]);
    expect(out).toContain('white dress');
    expect(out).toContain('black lace bra');
  });

  it('换回白裙后,上一轮的黑色蕾丝不再残留', () => {
    const entry = makeEntry({ name: 'A', fields: { ...emptyFields(), hair: 'black hair' } });
    let tmp = { ...emptyTransient('A'), raw: 'black lace bra' };
    expect(assemble('1girl', style, [{ fixed: entry, tmpTags: transientToTags(tmp), override: true }])).toContain(
      'black lace bra',
    );

    // 下一楼她穿回白裙:整串替换
    tmp = { ...emptyTransient('A'), raw: 'white dress' };
    const out = assemble('1girl', style, [{ fixed: entry, tmpTags: transientToTags(tmp), override: true }]);
    expect(out).toContain('white dress');
    expect(out).not.toContain('black lace bra');
  });

  it('findTransient 能按名字取到刚落盘的状态', () => {
    const list = [{ ...emptyTransient('苏白粥'), raw: 'black lace bra' }];
    expect(transientToTags(findTransient(list, '苏白粥'))).toBe('black lace bra');
  });
});
