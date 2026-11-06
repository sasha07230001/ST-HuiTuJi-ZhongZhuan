import { describe, expect, it } from 'vitest';
import { BUILTIN_WORKFLOW } from '@/types';
import { findClipNodes, getPlaceholders, parseWorkflow, renderWorkflow, WorkflowError } from '@/comfy/workflow';

const PLACEHOLDER_WORKFLOW = JSON.stringify({
  '3': { class_type: 'KSampler', inputs: { seed: '%seed%', model: ['4', 0], positive: ['6', 0], negative: ['7', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['4', 1] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['3', 0] } },
});

const POSITIONAL_WORKFLOW = JSON.stringify({
  '3': { class_type: 'KSampler', inputs: { seed: 42, model: ['4', 0], positive: ['6', 0], negative: ['7', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, bad anatomy', clip: ['4', 1] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['3', 0] } },
});

describe('parseWorkflow', () => {
  it('拒绝空文本', () => {
    expect(() => parseWorkflow('')).toThrow(WorkflowError);
  });
  it('拒绝非 API 格式', () => {
    expect(() => parseWorkflow('{"nodes": []}')).toThrow(/Save \(API Format\)/);
  });
  it('占位符写成裸值时给出提示', () => {
    expect(() => parseWorkflow('{"3": {"class_type": "KSampler", "inputs": {"seed": %seed%}}}')).toThrow(/占位符/);
  });
});

describe('getPlaceholders', () => {
  it('列出全部占位符', () => {
    expect(getPlaceholders(PLACEHOLDER_WORKFLOW)).toEqual(['negative_prompt', 'prompt', 'seed']);
  });
});

describe('renderWorkflow', () => {
  it('占位符式:替换文本,seed 换成数字', () => {
    const out = renderWorkflow(PLACEHOLDER_WORKFLOW, { prompt: 'a girl, "quoted"', negative: 'blurry', seed: 123 });
    expect((out['6'].inputs as Record<string, unknown>).text).toBe('a girl, "quoted"');
    expect((out['7'].inputs as Record<string, unknown>).text).toBe('blurry');
    expect((out['3'].inputs as Record<string, unknown>).seed).toBe(123);
    expect(typeof (out['3'].inputs as Record<string, unknown>).seed).toBe('number');
  });

  it('提示词里的换行与引号不破坏 JSON', () => {
    const nasty = 'line1\nline2 "quote" \\ backslash';
    const out = renderWorkflow(PLACEHOLDER_WORKFLOW, { prompt: nasty, negative: '', seed: 1 });
    expect((out['6'].inputs as Record<string, unknown>).text).toBe(nasty);
  });

  it('定位式:第一个非空 CLIP 写正向,其余写负面', () => {
    const out = renderWorkflow(POSITIONAL_WORKFLOW, { prompt: 'NEW POSITIVE', negative: 'NEW NEGATIVE', seed: 7 });
    expect((out['6'].inputs as Record<string, unknown>).text).toBe('NEW POSITIVE');
    expect((out['7'].inputs as Record<string, unknown>).text).toBe('NEW NEGATIVE');
    expect((out['3'].inputs as Record<string, unknown>).seed).toBe(7);
  });

  it('不支持的占位符明确报错', () => {
    const wf = PLACEHOLDER_WORKFLOW.replace('"x"', '"%width%"');
    expect(() => renderWorkflow(wf, { prompt: 'a', negative: '', seed: 1 })).toThrow(/%width%/);
  });

  it('没有 CLIP 节点时报错', () => {
    const wf = JSON.stringify({ '3': { class_type: 'KSampler', inputs: { seed: 1 } } });
    expect(() => renderWorkflow(wf, { prompt: 'a', negative: '', seed: 1 })).toThrow(/CLIPTextEncode/);
  });

  it('内置工作流可以直接渲染', () => {
    const out = renderWorkflow(BUILTIN_WORKFLOW, { prompt: '1girl', negative: 'bad', seed: 5 });
    expect((out['6'].inputs as Record<string, unknown>).text).toBe('1girl');
    expect((out['7'].inputs as Record<string, unknown>).text).toBe('bad');
  });
});

describe('findClipNodes', () => {
  it('找到两个 CLIP 节点', () => {
    expect(findClipNodes(parseWorkflow(POSITIONAL_WORKFLOW))).toHaveLength(2);
  });
});
