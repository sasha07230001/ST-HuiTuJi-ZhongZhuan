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
import { detectCastAndChanges } from '@/chars/archive';
import { detectTransientChanges } from '@/chars/transientReader';
import {
  charactersInText,
  entryToPromptTags,
  findEntry,
  type CharEntry,
} from '@/chars/profile';
import {
  findTransient,
  mergeTransientTags,
  transientToClipTags,
  transientToTags,
  type TransientProfile,
} from '@/chars/transient';
import { applyTransientChanges, emitChanges, transientsForRun } from '@/chars/store';
import {
  cleanStoryText,
  composeNegative,
  composePositive,
  renderSystemPrompt,
} from '@/relay/prompt';
import { extractStoryScope } from '@/relay/storyScope';
import { rewriteDegraded } from '@/relay/purge';
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
  /** 本次用到的临时档案快照(给卡片显示「用了哪个临时状态」)。 */
  transients: Array<{ name: string; tags: string; source: 'stored' | 'fresh' | 'none' }>;
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

/**
 * 取「这一次真正要送进中转站的那段正文」:原文 → 剧情范围 → 清洗。
 *
 * 抽成公开函数有两个用处:
 * 1. runChain 内部只用这一份实现,不复制;
 * 2. 一次出多张图时,分段必须发生在**同一段**正文上(split.ts 的输入),
 *    否则「范围标签」里切出来的段落和实际编译的段落会对不上,图就插错位置。
 *
 * `story` 显式给出时原样当作正文(不再套剧情范围——调用方已经处理过)。
 */
export function resolveStory(
  floor: number,
  story?: string,
  onStatus?: (text: string) => void,
): { story: string; raw: string } {
  let rawStory = (story ?? '').trim();
  if (!rawStory) {
    const picked = storyForFloor(floor);
    if (!picked.ok) throw new Error(picked.reason);
    // 注意:storyForFloor 已做 cleanStoryText,但范围必须在**清洗前**的原文上取,
    // 因为 cleanStoryText 会剥掉标签,之后就再也找不到块了。
    const ctx = getContext();
    const message = ctx?.chat?.[floor];
    rawStory = String(message?.mes ?? picked.text);
  } else {
    return { story: cleanStoryText(rawStory), raw: rawStory };
  }

  const s = getSettings();
  const scopeTags = s.storyScope?.tags ?? [];
  let scoped: string | null = null;
  if (scopeTags.length) {
    const scope = extractStoryScope(rawStory, scopeTags, s.storyScope.pick);
    scoped = scope.text;
    if (scoped) onStatus?.(`已按剧情范围取得 ${scoped.length} 字`);
    else console.info(`[绘图姬·中转站] 剧情范围未生效(${scope.reason}),按整楼处理`);
  }

  const clean = cleanStoryText(scoped ?? rawStory);
  if (!clean) throw new Error('正文是空的,没有可编译的内容');
  return { story: clean, raw: scoped ?? rawStory };
}

/** 楼层正文(含剧情范围与清洗);一次出多张图时用它做分段输入。 */
export function storyForRun(floor: number, onStatus?: (text: string) => void): string {
  return resolveStory(floor, undefined, onStatus).story;
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

  // ①② 拿正文 + 剧情范围 + 清洗(与多图分段共用同一份实现)
  const story = resolveStory(input.floor, input.story, status).story;

  // ③ 中转站编译
  status(s.purge?.enabled ? '正在交给中转站编译提示词(purge 已开)…' : '正在交给中转站编译提示词…');
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
          purge: s.purge,
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

  // ③.1 反净化:模型还是给了"温和版"时,按正文把 tag 补回去
  //
  // 位置在 split 之后:wantNegative 打开时模型输出是 POSITIVE:/NEGATIVE: 两段,
  // 只该往正面那条上补,否则 gore 之类的词会跑到负面里把图洗白。
  const split = splitPosNeg(compiled);
  let positiveCore = split.positive || compiled;
  let negativeCore = split.negative;
  if (s.purge?.enabled && s.purge.rewrite) {
    const fixed = rewriteDegraded(story, positiveCore, s.purge.maxExtraTags);
    if (fixed.added.length) {
      positiveCore = fixed.prompt;
      status(`已补回 ${fixed.added.length} 个被降级的 tag`);
    }
  }

  // ③ 合并恒定画风/负面:恒定词一律**前置**(见 composePositive 的注释)
  let positive = composePositive(s.prompt.styleSuffix, positiveCore);
  const negative = composeNegative(s.prompt.negative, negativeCore);

  // ③.5 角色档案:固定外貌 + 临时档案(此刻的穿戴/状态)
  //
  // 两层拼装的顺序很重要:
  //   固定档案 → 说明「她是谁、长什么样」;
  //   临时档案 → 说明「这一刻她穿着什么」,并且**顶掉**固定档案里的穿戴槽位。
  //
  // 为什么临时层必须能覆盖而不是追加:固定 raw 里写着 white dress,
  // 正文说换了黑色蕾丝,两串一起进 CLIP,衣服就会糊成一片。
  const ctx = getContext();
  const chatId = ctx?.getCurrentChatId?.() ?? '';
  const transientEnabled = s.chars?.transient?.enabled !== false;
  const transientLog: Array<{ name: string; tags: string; source: 'stored' | 'fresh' | 'none' }> = [];

  if (s.chars?.autoMerge !== false && (s.chars?.entries?.length ?? 0) > 0) {
    status('正在匹配在场角色…');
    const library = s.chars.entries;
    let cast: string[] = [];

    if (s.chars?.autoArchive !== false) {
      const detected = await detectCastAndChanges(story, library, input.signal);
      cast = detected.cast;
      if (detected.changes.length) {
        emitChanges(detected.changes);
        status(`已更新 ${detected.changes.length} 条角色档案`);
      }
    }

    // 模型给的 cast 优先;没给就用正文里出现的名字兜底
    const present = cast.length
      ? cast.map(name => findEntry(library, name)).filter((e): e is CharEntry => !!e)
      : charactersInText(story, library);

    // 临时档案:先按聊天/楼层迁移掉过期状态,再让模型读这一楼的即时变化
    let transients: TransientProfile[] = [];
    if (transientEnabled) {
      transients = transientsForRun(chatId, input.floor);
    }

    if (transientEnabled && s.chars?.transient?.autoUpdate !== false && present.length) {
      status('正在读取角色当前状态(临时档案)…');
      const detected = await detectTransientChanges(story, library, transients, input.signal);
      if (detected.changes.length) {
        const result = applyTransientChanges(detected.changes, {
          chatId,
          floor: input.floor,
          onlyKnown: s.chars?.transient?.onlyKnown !== false,
          knownNames: library.map(e => e.name),
        });
        if (result.updated || result.cleared) {
          status(
            `临时档案已更新 ${result.updated} 条` +
              (result.cleared ? `、清空 ${result.cleared} 条` : ''),
          );
        }
        if (result.skipped) console.info(`[绘图姬·中转站] 临时档案跳过 ${result.skipped} 条(冻结或不在角色库)`);
        // 重新读一次,拿到刚写进去的状态
        transients = transientsForRun(chatId, input.floor);
      }
      // 本次读出来的变化即使没落盘(冻结/未变化),也用于本次出图
      if (detected.cast.length && !cast.length) cast = detected.cast;
    }

    if (present.length) {
      const fixedParts: string[] = [];
      const transientParts: string[] = [];
      for (const entry of present) {
        const fixedTags = entryToPromptTags(entry);
        const tmp = findTransient(transients, entry.name);
        // 送 CLIP 用展开后的版本:`black lace set` → `black lace bra, black lace panties`,
        // 否则采样器只画上半截。存档里仍是用户/模型写的原文,编辑器打开不会看到被改过的样子。
        const tmpTags = transientToClipTags(tmp);
        const tmpStored = transientToTags(tmp);
        if (tmpTags) {
          const override = s.chars?.transient?.overrideFixed !== false;
          transientParts.push(
            mergeTransientTags(fixedTags, tmpTags, entry, override ? {} : { dropFromFixedRaw: false }),
          );
          transientLog.push({ name: entry.name, tags: tmpStored, source: 'stored' });
        } else {
          fixedParts.push(fixedTags);
          transientLog.push({ name: entry.name, tags: '', source: 'none' });
        }
      }
      const merged = [...fixedParts, ...transientParts].filter(Boolean).join(', ');
      if (merged) {
        positive = positive ? `${positive}, ${merged}` : merged;
      }
      const withTmp = transientLog.filter(x => x.source === 'stored').length;
      status(
        `已拼入 ${present.length} 个角色的外貌` +
          (withTmp ? `(其中 ${withTmp} 个带临时档案)` : ''),
      );
    }
  }

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

  return { positive, negative, compiled, seed, transients: transientLog, image };
}
