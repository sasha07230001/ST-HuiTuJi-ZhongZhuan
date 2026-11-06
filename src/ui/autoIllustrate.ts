/**
 * 自动插图:AI 回复完一楼 → 自动跑「正文 → 中转站 → CLIP → 出图」→ 图挂到楼层。
 *
 * 原理移植自绘图🐔二号,按本插件「不出 tag、直接出图」的形态做了简化:
 *
 * 1. **只在真正一次生成的最终渲染上触发**。先记 GENERATION_STARTED,
 *    再在 CHARACTER_MESSAGE_RENDERED 里消费它。swipe/编辑/切聊天引起的渲染不算。
 * 2. **不阻塞 ST 收尾**:渲染回调里只 setTimeout 排队,不在事件里做重活。
 * 3. **每楼一把锁 + 一次标记**:同一楼重复触发会被去重;同一条正文不重复编译。
 * 4. **切聊天/删楼时整体清空**,不污染别的聊天。
 *
 * 与二号的差异:二号是「写 tag → 卡片消费标记自动出图」两段式;
 * 我们直接拿到 floor 就出图,不需要写正文、不需要 tag 握手。
 */

import { getContext, isAiStoryMessage } from '@/st/context';
import { generateIntoFloor } from '@/ui/card';

const DIAG = '[HTJ-ZZ][auto]';

interface Gate {
  chatId: string;
  type: string;
}

export interface AutoIllustrateHooks {
  /** 读最新设置:是否启用自动插图。 */
  enabled(): boolean;
  /** 可选的额外门槛(例如配置是否齐全)。 */
  ready?(): boolean;
}

let gate: Gate | null = null;
let bound = false;
const pending = new Set<ReturnType<typeof setTimeout>>();
/** 已处理过的「聊天 + 楼层 + swipe + 正文指纹」,避免同一条重复烧后端。 */
const processed = new Set<string>();
/** 正在出图的楼层。 */
const running = new Set<string>();

function diagnostic(event: string, payload: Record<string, unknown> = {}): void {
  try {
    console.info(`${DIAG} ${event} ${JSON.stringify(payload)}`);
  } catch {
    /* 忽略 */
  }
}

function textFingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function identity(chatId: string, floor: number, swipe: number, text: string): string {
  return `${chatId}|${floor}|${swipe}|${textFingerprint(text)}`;
}

/** 排到下一帧再跑,不阻塞 ST 的收尾。 */
function schedule(floor: number, chatId: string, hooks: AutoIllustrateHooks): void {
  const timer = setTimeout(() => {
    pending.delete(timer);
    void run(floor, chatId, hooks);
  }, 0);
  pending.add(timer);
}

async function run(floor: number, chatId: string, hooks: AutoIllustrateHooks): Promise<void> {
  const ctx = getContext();
  if (!ctx) return;
  if ((ctx.getCurrentChatId?.() ?? '') !== chatId) {
    diagnostic('skip', { floor, reason: 'chat-changed' });
    return;
  }
  if (!hooks.enabled()) {
    diagnostic('skip', { floor, reason: 'disabled' });
    return;
  }
  if (hooks.ready && !hooks.ready()) {
    diagnostic('skip', { floor, reason: 'not-configured' });
    return;
  }

  const message = ctx.chat?.[floor];
  if (!isAiStoryMessage(message)) {
    diagnostic('skip', { floor, reason: 'not-story-message' });
    return;
  }

  const swipe = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
  const id = identity(chatId, floor, swipe, message.mes);
  if (processed.has(id)) {
    diagnostic('skip', { floor, reason: 'already-processed' });
    return;
  }
  const lockKey = `${chatId}|${floor}`;
  if (running.has(lockKey)) {
    diagnostic('skip', { floor, reason: 'already-running' });
    return;
  }

  processed.add(id);
  running.add(lockKey);
  diagnostic('run', { floor, swipe, length: message.mes.length });

  try {
    const record = await generateIntoFloor(floor, {
      note: '自动插图:用这一楼的正文编译一张最贴合当前画面的插图提示词。',
    });
    diagnostic('done', { floor, state: record?.state ?? null, hasImage: !!record?.imageUrl });
  } catch (error) {
    diagnostic('error', { floor, message: error instanceof Error ? error.message : String(error) });
  } finally {
    running.delete(lockKey);
  }
}

/** 绑定 ST 生成事件。重复调用安全。 */
export function bindAutoIllustrate(hooks: AutoIllustrateHooks): void {
  if (bound) return;
  const ctx = getContext();
  const events = ctx?.eventTypes ?? ctx?.event_types;
  if (!ctx?.eventSource || !events) {
    diagnostic('bind:skip', { reason: 'no-event-source' });
    return;
  }
  bound = true;

  ctx.eventSource.on(events.GENERATION_STARTED, (type: unknown, _options: unknown, dryRun: unknown) => {
    const chatId = getContext()?.getCurrentChatId?.() ?? '';
    // quiet / impersonate / dryRun 都不是真正的一次剧情生成
    const eligible = Boolean(
      chatId && !dryRun && typeof type === 'string' && type !== 'quiet' && type !== 'impersonate',
    );
    if (eligible) gate = { chatId, type: String(type) };
    diagnostic('GENERATION_STARTED', { chatId, type, dryRun, eligible });
  });

  ctx.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, (messageId: unknown, type: unknown) => {
    const chatId = getContext()?.getCurrentChatId?.() ?? '';
    // 必须与开跑时的 gate 对上,否则是 swipe/编辑引起的普通渲染
    if (!gate || gate.chatId !== chatId || gate.type !== type) {
      diagnostic('render:skip', { messageId, type, reason: 'not-final-render' });
      return;
    }
    gate = null;
    const floor = Number(messageId);
    if (!Number.isInteger(floor) || floor < 0) return;
    schedule(floor, chatId, hooks);
  });

  ctx.eventSource.on(events.GENERATION_STOPPED, () => {
    gate = null;
    diagnostic('GENERATION_STOPPED', {});
  });

  ctx.eventSource.on(events.CHAT_CHANGED, () => {
    gate = null;
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
    // 换聊天时清空去重表,但保留 processed 之外的重置由下次生成决定
    processed.clear();
    diagnostic('CHAT_CHANGED', {});
  });

  diagnostic('bound', {});
}

/** 供测试:清空内部状态。 */
export function resetAutoIllustrate(): void {
  gate = null;
  bound = false;
  for (const timer of pending) clearTimeout(timer);
  pending.clear();
  processed.clear();
  running.clear();
}
