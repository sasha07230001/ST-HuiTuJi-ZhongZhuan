/**
 * 「恒定画风词 / 恒定负面词」写进工作流模板:
 * 用户在 ComfyUI 原生界面里看到的，必须和运行时送进去的是同一份。
 */

import { describe, expect, it } from 'vitest';
import { applyConstantWordsToWorkflow } from '@/ui/dom';
import { renderWorkflow } from '@/comfy/workflow';

const HEAD = 'masterpiece, best quality';
const NEG = 'lowres, bad hands';

function workflowWithPlaceholders(): string {
  return JSON.stringify({
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['4', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['4', 0] } },
  });
}

function workflowPositional(): string {
  return JSON.stringify({
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl', clip: ['4', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 0] } },
  });
}

describe('applyConstantWordsToWorkflow', () => {
  it('占位符式:恒定词前置写在 %prompt% 前面', () => {
    const out = applyConstantWordsToWorkflow(workflowWithPlaceholders(), HEAD, NEG);
    expect(out.ok).toBe(true);
    expect(out.changed).toBe(true);
    const wf = JSON.parse(out.template) as Record<string, { inputs: { text: string } }>;
    expect(wf['6'].inputs.text).toBe(`${HEAD}, %prompt%`);
    expect(wf['7'].inputs.text).toBe(`${NEG}, %negative_prompt%`);
  });

  it('幂等:同一串再同步一次不会再叠一层', () => {
    const once = applyConstantWordsToWorkflow(workflowWithPlaceholders(), HEAD, NEG);
    const twice = applyConstantWordsToWorkflow(once.template, HEAD, NEG);
    expect(twice.changed).toBe(false);
    expect(twice.template).toBe(once.template);
  });

  it('定位式:第一个非空 CLIP 当正向,其余当负面', () => {
    const out = applyConstantWordsToWorkflow(workflowPositional(), HEAD, NEG);
    expect(out.ok).toBe(true);
    const wf = JSON.parse(out.template) as Record<string, { inputs: { text: string } }>;
    expect(wf['6'].inputs.text).toBe(`${HEAD}, masterpiece, 1girl`);
    expect(wf['7'].inputs.text).toBe(NEG);
  });

  it('写进去之后,渲染工作流时恒定词仍然在最前面', () => {
    const out = applyConstantWordsToWorkflow(workflowWithPlaceholders(), HEAD, NEG);
    const rendered = renderWorkflow(out.template, { prompt: '1girl, rain', negative: 'blurry', seed: 7 }) as unknown as Record<
      string,
      { inputs: { text: string } }
    >;
    const pos = rendered['6'].inputs.text as string;
    const neg = rendered['7'].inputs.text as string;    // 模板里写的是 `恒定词, %prompt%`,替换后就是 `恒定词, 1girl, rain`
    expect(pos.startsWith(HEAD)).toBe(true);
    expect(pos.endsWith('1girl, rain')).toBe(true);
    expect(neg.startsWith(NEG)).toBe(true);
  });

  it('坏 JSON / 空工作流给出人话错误', () => {
    expect(applyConstantWordsToWorkflow('{oops', HEAD, NEG).ok).toBe(false);
    expect(applyConstantWordsToWorkflow('{}', HEAD, NEG).ok).toBe(false);
  });

  it('没有 CLIP 节点时明说不知道往哪写', () => {
    const bare = JSON.stringify({ '1': { class_type: 'KSampler', inputs: { seed: 1 } } });
    const out = applyConstantWordsToWorkflow(bare, HEAD, NEG);
    expect(out.ok).toBe(false);
    expect(out.message).toContain('CLIPTextEncode');
  });
});
