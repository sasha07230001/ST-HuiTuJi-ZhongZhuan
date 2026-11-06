/**
 * 「正文 → 中转站 → CLIP → 出图」那条链的唯一实现。
 *
 * 楼层卡片、楼层按钮、自动流程都走这一个函数,不各自复制一份。
 *
 * 数据流:
 *   剧情正文 ──clean──► 中转站模型 ──英文 tag──► 合并画风/负面 ──► 工作流 CLIPTextEncode ──► ComfyUI
 *
 * 这里的「中转站」就是中间那道编译器:它吃正文,吐出可直接写进 CLIP 节点的提示词。
 */

import { runWorkflow } from '@/comfy/api';
import { randomSeed, renderWorkflow, WorkflowError } from '@/comfy/workflow';
import { compilePrompt, RelayError, type ChatMsg } from '@/relay/client';
import {
  cleanStoryText,
  joinNegative,
  joinPositive,
  renderSystemPrompt,
} from '@/relay/prompt';
import { extractStoryScope } from '@/relay/storyScope';
import { getSettings } from '@/state/settings';
import { getContext, isAiStoryMessage } from '@/st/context';
import type { ClipPrompt, Settings } from '@/types';

export interface RunInput {
  /** 楼层号。自动/手动入口都传。 */
  floor: number;
  /** 直接指定正文(公开接口/调试用);缺省取当前聊天的 floor 楼。 */
  story?: string;
  /** 给模型的额外任务提示。 */
  note?: string;
  signal?: AbortSignal;
  /** 进度回调:人话,直接显示在卡片上。 */
  onStatus?(text: string): void;
}

export interface RunOutput {
  /** 实际送入 CLIP 的正向提示词(含画风词)。 */
  positive: string;
  /** 实际写入的负面提示词。 */
  negative: string;
  /** 中转站原始输出(未加画风词)。 */
  compiled: string;
  seed: number;
  image: { url: string; filename: string; format: string; revoke(): void };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 取某一楼的正文;AI 楼才算数。 */
export function storyForFloor(floor: number): { ok: boolean; text: string; reason: string } {
  const ctx = getContext();
  if (!ctx) return { ok: false, text: '', reason: 'SillyTavern 上下文不可用' };
  const message = ctx.chat?.[floor];
  if (!message) return { ok: false, text: '', reason: `第 ${floor} 楼不存在` };
  if (!isAiStoryMessage(message)) {
    return { ok: false, text: '', reason: '这一楼不是可配图的剧情楼(用户楼 / 系统楼)' };
  }
  const cleaned = cleanStoryText(message.mes);
  if (!cleaned) return { ok: false, text: '', reason: '这一楼清洗后没有剩下正文' };
  return { ok: true, text: cleaned, reason: '' };
}

/** 组装中转站的消息列表。 */
export function buildMessages(s: Settings, story: string, note: string): ChatMsg[] {
  const system = renderSystemPrompt(s.prompt.system, story, note);
  const userTail = s.prompt.wantNegative
    ? '另外单独给出一行负面提示词,以 "NEGATIVE:" 开头;正面那行以 "POSITIVE:" 开头。'
    : '';
  return [
    { role: 'system', content: system },
    { role: 'user', content: `请把上面的剧情编译成提示词。${userTail}` },
  ];
}

/**
 * 拆分模型输出里的正负两段。要求给负面时会带 POSITIVE:/NEGATIVE: 标记;
 * 没标记就整段当正面(兼容不爱守规矩的模型)。
 */
export function splitPosNeg(reply: string): { positive: string; negative: string } {
  const posMatch = reply.match(/POSITIVE\s*[:：]\s*([\s\S]*?)(?=NEGATIVE\s*[:：]|$)/i);
  const negMatch = reply.match(/NEGATIVE\s*[:：]\s*([\s\S]*)$/i);
  if (posMatch || negMatch) {
    return {
      positive: (posMatch?.[1] ?? '').trim().replace(/\s+/g, ' '),
      negative: (negMatch?.[1] ?? '').trim().replace(/\s+/g, ' '),
    };
  }
  return { positive: reply.trim(), negative: '' };
}

/**
 * 完整的一条链。失败抛错(RelayError / WorkflowError / ComfyError / AbortError),
 * 调用方负责 toast 与卡片状态。
 */
export async function runChain(input: RunInput): Promise<RunOutput> {
  const s = getSettings();
  const status = (text: string) => input.onStatus?.(text);

  // ① 拿正文
  let rawStory = (input.story ?? '').trim();
  if (!rawStory) {
    const picked = storyForFloor(input.floor);
    if (!picked.ok) throw new Error(picked.reason);
    // 注意:storyForFloor 已做 cleanStoryText,但范围必须在**清洗前**的原文上取,
    // 因为 cleanStoryText 会剥掉标签,之后就再也找不到块了。
    const ctx = getContext();
    const message = ctx?.chat?.[input.floor];
    rawStory = String(message?.mes ?? picked.text);
  }

  // ② 剧情范围:只把圈定标签里的内容当剧情;取不到就回退整楼
  const scopeTags = s.storyScope?.tags ?? [];
  let scoped: string | null = null;
  if (scopeTags.length) {
    const scope = extractStoryScope(rawStory, scopeTags, s.storyScope.pick);
    scoped = scope.text;
    if (scoped) {
      status(`已按剧情范围取得 ${scoped.length} 字`);
    } else {
      console.info(`[绘图姬·中转站] 剧情范围未生效(${scope.reason}),按整楼处理`);
    }
  }

  const story = cleanStoryText(scoped ?? rawStory);
  if (!story) throw new Error('正文是空的,没有可编译的内容');

  // ③ 中转站编译
  status('正在交给中转站编译提示词…');
  const messages = buildMessages(s, story, input.note ?? '');
  let compiled = '';
  const retries = Math.max(0, Math.floor(s.prompt.retryCount || 0));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      compiled = await compilePrompt(
        {
          url: s.relay.url,
          key: s.relay.key,
          model: s.relay.model,
          temperature: s.relay.temperature,
          maxTokens: s.relay.maxTokens,
          timeoutSec: s.relay.timeoutSec,
        },
        messages,
        { signal: input.signal, allowUrlFallback: true },
      );
      break;
    } catch (error) {
      lastError = error;
      if (input.signal?.aborted) throw new DOMException('已取消', 'AbortError');
      if (attempt < retries) {
        status(`第 ${attempt + 1} 次编译失败,重试中…`);
        await sleep(600, input.signal);
      }
    }
  }
  if (!compiled) {
    throw lastError instanceof Error ? lastError : new RelayError('中转站没有给出提示词');
  }

  // ③ 合并恒定画风/负面
  const split = splitPosNeg(compiled);
  const positive = joinPositive(split.positive || compiled, s.prompt.styleSuffix);
  const negative = joinNegative(split.negative, s.prompt.negative);

  // ④ 渲染工作流并出图
  status('提示词已就绪,正在提交 ComfyUI…');
  const seed = randomSeed();
  let workflow;
  try {
    workflow = renderWorkflow(s.comfy.workflow, { prompt: positive, negative, seed });
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(error instanceof Error ? error.message : String(error));
  }

  const image = await runWorkflow(
    { url: s.comfy.url, workflow: s.comfy.workflow, allowServerProxy: s.comfy.allowServerProxy },
    workflow,
    {
      signal: input.signal,
      progress: {
        onQueue: ahead => {
          if (ahead === null) return;
          status(ahead === 0 ? 'ComfyUI 正在生成…' : `ComfyUI 排队中,前面还有 ${ahead} 个任务`);
        },
      },
    },
  );

  return { positive, negative, compiled, seed, image };
}
