/**
 * 自动流程:每生成一楼后自动走一次「正文 → 中转站 → CLIP → 出图」。
 *
 * 正确性要点(照抄二号踩过的坑):
 * - 只在**真正的一次生成**的**最终渲染**上触发:先记 GENERATION_STARTED,
 *   再在 CHARACTER_MESSAGE_RENDERED 里消费它;swipe/编辑/切聊天导致的渲染不算。
 * - 不阻塞 ST 的收尾:渲染回调里只 setTimeout(0) 排队。
 */

import { getContext } from '@/st/context';

interface Gate {
  chatId: string;
  type: string;
}

const DIAG = '[HTJ-ZZ][auto]';

let gate: Gate | null = null;
let bound = false;
const pending = new Set<ReturnType<typeof setTimeout>>();

function diagnostic(event: string, payload: Record<string, unknown> = {}): void {
  try {
    console.info(`${DIAG} ${event} ${JSON.stringify(payload)}`);
  } catch {
    /* 忽略 */
  }
}

function schedule(floor: number, chatId: string, run: (floor: number) => Promise<void>): void {
  const timer = setTimeout(() => {
    pending.delete(timer);
    if ((getContext()?.getCurrentChatId?.() ?? '') !== chatId) {
      diagnostic('skip', { floor, reason: 'chat-changed' });
      return;
    }
    void run(floor);
  }, 0);
  pending.add(timer);
}

export interface AutoRunHooks {
  /** 判定是否该自动跑(读最新设置)。 */
  enabled(): boolean;
  /** 真正执行一次。 */
  run(floor: number): Promise<void>;
}

export function bindAutoRun(hooks: AutoRunHooks): void {
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
    const eligible = Boolean(chatId && !dryRun && typeof type === 'string' && type !== 'quiet' && type !== 'impersonate');
    if (eligible) gate = { chatId, type: String(type) };
    diagnostic('GENERATION_STARTED', { chatId, type, dryRun, eligible });
  });

  ctx.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, (messageId: unknown, type: unknown) => {
    const chatId = getContext()?.getCurrentChatId?.() ?? '';
    if (!gate || gate.chatId !== chatId || gate.type !== type) {
      diagnostic('render:skip', { messageId, type, reason: 'not-final-render' });
      return;
    }
    gate = null;
    const floor = Number(messageId);
    if (!Number.isInteger(floor) || floor < 0) return;
    if (!hooks.enabled()) {
      diagnostic('render:skip', { floor, reason: 'disabled' });
      return;
    }
    schedule(floor, chatId, hooks.run);
  });

  ctx.eventSource.on(events.GENERATION_STOPPED, () => {
    gate = null;
    diagnostic('GENERATION_STOPPED', {});
  });

  ctx.eventSource.on(events.CHAT_CHANGED, () => {
    gate = null;
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
    diagnostic('CHAT_CHANGED', {});
  });

  diagnostic('bound', {});
}
