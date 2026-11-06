/**
 * ComfyUI 工作流的纯逻辑:占位符渲染、CLIP 节点定位。
 *
 * 与 ST 无关,单测直接跑。提交/轮询/取消那些碰 fetch 的部分在 api.ts。
 */

export type JsonObject = Record<string, unknown>;
export type ComfyWorkflow = Record<string, JsonObject>;

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

const SUPPORTED_PLACEHOLDERS = new Set(['prompt', 'negative_prompt', 'seed']);
const PLACEHOLDER_PATTERN = /%([a-z][a-z0-9_]*)%/g;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 解析并做最低限度的 API 工作流结构校验。 */
export function parseWorkflow(template: string): ComfyWorkflow {
  if (!template.trim()) throw new WorkflowError('请先在设置里粘贴 ComfyUI 工作流(Save API Format 导出)');

  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = detail.includes('%') ? ';占位符必须写成字符串,如 "seed": "%seed%"(带引号)' : '';
    throw new WorkflowError(`工作流 JSON 格式错误:${detail}${hint}`);
  }

  if (!isObject(parsed) || Object.keys(parsed).length === 0) {
    throw new WorkflowError('工作流必须是非空的 JSON 对象');
  }
  const hasApiNode = Object.values(parsed).some(
    node => isObject(node) && typeof node.class_type === 'string' && isObject(node.inputs),
  );
  if (!hasApiNode) throw new WorkflowError('未找到 API 格式节点,请在 ComfyUI 里用「Save (API Format)」导出');
  return parsed as ComfyWorkflow;
}

function collectPlaceholders(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER_PATTERN)) found.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectPlaceholders(item, found));
    return;
  }
  if (isObject(value)) Object.values(value).forEach(item => collectPlaceholders(item, found));
}

export function getPlaceholders(template: string): string[] {
  const found = new Set<string>();
  collectPlaceholders(parseWorkflow(template), found);
  return [...found].sort();
}

function replacePlaceholders(value: unknown, repl: Record<string, string | number>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^%([a-z][a-z0-9_]*)%$/);
    if (exact && Object.hasOwn(repl, exact[1])) return repl[exact[1]];
    return value.replace(PLACEHOLDER_PATTERN, (marker, name: string) =>
      Object.hasOwn(repl, name) ? String(repl[name]) : marker,
    );
  }
  if (Array.isArray(value)) return value.map(item => replacePlaceholders(item, repl));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replacePlaceholders(v, repl)]));
  }
  return value;
}

export interface TemplateValues {
  prompt: string;
  negative: string;
  seed: number;
}

/**
 * 渲染工作流。
 *
 * 两种工作流形态都支持:
 * 1. **占位符式**(推荐):CLIP 节点的 text 写 `%prompt%`,本函数直接替换;
 * 2. **定位式**:工作流里没有 `%prompt%` 时,自动找 CLIPTextEncode 节点,
 *    取第一个「本来就非空」的写正向、其余写负面。这样从二号那边直接搬过来的
 *    工作流不用改一个字也能用。
 *
 * 提示词里的引号/换行不会破坏 JSON——先解析再递归替换,不拼字符串。
 * 精确等于 %seed% 的字符串会被换成数字(KSampler 的 seed 必须是数字)。
 */
export function renderWorkflow(template: string, values: TemplateValues): ComfyWorkflow {
  const workflow = parseWorkflow(template);
  const found = new Set<string>();
  collectPlaceholders(workflow, found);

  const unsupported = [...found].filter(name => !SUPPORTED_PLACEHOLDERS.has(name));
  if (unsupported.length) {
    throw new WorkflowError(
      `工作流含本扩展不支持的占位符:${unsupported.map(x => `%${x}%`).join('、')}(支持 %prompt% %negative_prompt% %seed%)`,
    );
  }

  if (found.has('prompt')) {
    return applySeed(
      replacePlaceholders(workflow, {
        prompt: values.prompt,
        negative_prompt: values.negative,
        seed: values.seed,
      }) as ComfyWorkflow,
      found.has('seed'),
      values.seed,
    );
  }

  // 定位式:直接改工作流里已有节点的 text
  const clips = findClipNodes(workflow);
  if (!clips.length) {
    throw new WorkflowError('工作流里既没有 %prompt%,也找不到 CLIPTextEncode 节点,不知道该把提示词写到哪里');
  }
  const positive = clips.find(node => String(node.inputs.text ?? '').trim()) ?? clips[0];
  positive.inputs.text = values.prompt;
  for (const node of clips) {
    if (node === positive) continue;
    node.inputs.text = values.negative;
  }
  return applySeed(
    replacePlaceholders(workflow, { seed: values.seed }) as ComfyWorkflow,
    found.has('seed'),
    values.seed,
  );
}

/**
 * 工作流里没写 %seed% 时,把本次种子显式塞进采样器节点的 seed 字段。
 * 不塞的话重复出图会永远是同一个种子,「再抽一张」等于白点。
 */
const SAMPLER_CLASSES = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced)$/;

function applySeed(workflow: ComfyWorkflow, alreadyReplaced: boolean, seed: number): ComfyWorkflow {
  if (alreadyReplaced) return workflow;
  for (const node of Object.values(workflow)) {
    if (!isObject(node) || typeof node.class_type !== 'string' || !isObject(node.inputs)) continue;
    if (!SAMPLER_CLASSES.test(node.class_type)) continue;
    if (typeof node.inputs.seed === 'number' || typeof node.inputs.noise_seed === 'number') {
      if (typeof node.inputs.seed === 'number') node.inputs.seed = seed;
      if (typeof node.inputs.noise_seed === 'number') node.inputs.noise_seed = seed;
    }
  }
  return workflow;
}

export interface ClipNode {
  class_type: string;
  inputs: JsonObject & { text: string };
}

/** 找所有 CLIP 文本编码节点(含常见变体)。 */
export function findClipNodes(workflow: ComfyWorkflow): ClipNode[] {
  const found: ClipNode[] = [];
  for (const node of Object.values(workflow)) {
    if (!isObject(node) || typeof node.class_type !== 'string' || !isObject(node.inputs)) continue;
    if (!/clip(text)?encode|textencod/i.test(node.class_type)) continue;
    if (typeof node.inputs.text !== 'string') continue;
    found.push(node as unknown as ClipNode);
  }
  return found;
}

/** 生成随机种子(0 ≤ seed < 2^53)。部分采样器节点不接受 -1 自动随机,故总是显式给值。 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 53);
}
