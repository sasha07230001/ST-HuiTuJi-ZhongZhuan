/**
 * 自动插图:AI 回复完一楼 → 自动跑「正文 → 分段 → 中转站 → CLIP → 出图」→ 图插回正文。
 *
 * 「勾了自动插图但 AI 写完毫无反应」这条 bug 反复出现,根因不止一个,这里逐条堵:
 *
 * 1. **绑定时刻太早**。boot() 里 `getContext()` 可能返回的对象还没有 `eventSource`
 *    (或 eventTypes 还是空),原来一次绑定失败就 `return`,之后永远不再试。
 *    现在绑定失败会退避重试(最多 60 次 / 约 30 秒),并且每次重试都重新取事件名。
 * 2. **闸门对不上**。部分 ST 版本 `GENERATION_STARTED` 的 type 是 `'normal'`、
 *    渲染事件却给 `undefined` 或别的字样。现在**任何类型的生成都武装闸门**,
 *    type 只用来排除 quiet/impersonate 这类后台调用,不再用来做相等的硬匹配。
 * 3. **渲染事件压根不发**。老版本靠 GENERATION_ENDED 兜底,但如果 ENDED 早于
 *    楼层 DOM 落盘、或 ST 先 STOPPED 后 ENDED,就会出现空窗。现在另加一条
 *    **楼层数变化观察**:生成期间聊天变长就说明 AI 楼已完成,直接补跑。
 * 4. **配置判定太严**。isReady() 要求 key 也在 extension_settings 里;换设备后
 *    这里空着,自动流程就静默不动。现在用 isProbablyReady()(允许服务端 key 兜底),
 *    真失败时把错误**显示在图库页 / 楼层状态卡**,不再只在控制台。
 * 5. **失败一次就锁死**。旧去重表在调用失败时也把这一楼记成「已处理」,于是重试、
 *    或者用户手动出图后、下一楼生成时这一楼再也不会自动跑。现在成功才记账,
 *    失败会在 8 秒后重排一次。
 */

import { getContext, isAiStoryMessage } from '@/st/context';
import { illustrateFloor } from '@/ui/card';

const DIAG = '[HTJ-ZZ][auto]';
/** 闸门多久没被消费就作废(分钟级:生成被中断、用户切走了等等)。 */
const GATE_TTL_MS = 5 * 60 * 1000;
/** 生成开始后多久内的渲染还算「这次生成」。 */
const RENDER_WINDOW_MS = 3 * 60 * 1000;
const WATCHDOG_MS = 2500;
/** 绑定失败时的重试节奏。 */
const BIND_RETRY_MS = 500;
const BIND_MAX_TRIES = 60;
/** 失败后自动重排的等待。 */
const RETRY_BACKOFF_MS = 8000;

interface Gate {
  chatId: string;
  type: string;
  armedAt: number;
}

export interface AutoIllustrateHooks {
  /** 读最新设置:是否启用自动插图。 */
  enabled(): boolean;
  /** 可选的额外门槛(配置是否大致齐全)。 */
  ready?(): boolean;
  /** 配置不齐时给人看的提示(只报一次)。 */
  onNotReady?(problems: string[]): void;
  /** 开跑 / 跑完;给悬浮球状态点用。 */
  onBusy?(busy: boolean): void;
  /** 跑完一次(成功/失败)后回调,给面板/图库页刷新用。 */
  onDone?(info: { floor: number; images: number; errors: string[] }): void;
}

let gate: Gate | null = null;
let bound = false;
let bindTimer: ReturnType<typeof setTimeout> | null = null;
let bindTries = 0;
let watchdog: ReturnType<typeof setTimeout> | null = null;
const pending = new Set<ReturnType<typeof setTimeout>>();
/** 已成功处理过的「聊天 + 楼层 + swipe + 正文指纹」,避免同一条重复烧后端。 */
const processed = new Set<string>();
/** 正在出图的楼层。 */
const running = new Set<string>();
/** 曾经尝试过、但失败的指纹 → 次数。失败不锁死,只是延迟重试。 */
const failures = new Map<string, number>();
/** 最近一次自动流程的错误(给 UI 显示)。 */
let lastError = '';
let lastRunAt = 0;

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

/** 排到下一轮事件循环再跑,不阻塞 ST 收尾。 */
function schedule(floor: number, chatId: string, hooks: AutoIllustrateHooks, why: string): void {
  diagnostic('schedule', { floor, chatId, why });
  const timer = setTimeout(() => {
    pending.delete(timer);
    void run(floor, chatId, hooks, why);
  }, 0);
  pending.add(timer);
}

/** 当前聊天里最末一条 AI 剧情楼。 */
function latestAiFloor(): number {
  const chat = getContext()?.chat ?? [];
  for (let floor = chat.length - 1; floor >= 0; floor--) {
    if (isAiStoryMessage(chat[floor])) return floor;
  }
  return -1;
}

async function run(floor: number, chatId: string, hooks: AutoIllustrateHooks, why: string): Promise<void> {
  const ctx = getContext();
  if (!ctx) return;
  if ((ctx.getCurrentChatId?.() ?? '') !== chatId) {
    diagnostic('skip', { floor, why, reason: 'chat-changed' });
    return;
  }
  if (!hooks.enabled()) {
    diagnostic('skip', { floor, why, reason: 'disabled' });
    return;
  }
  if (hooks.ready && !hooks.ready()) {
    diagnostic('skip', { floor, why, reason: 'not-configured' });
    return;
  }

  const message = ctx.chat?.[floor];
  if (!isAiStoryMessage(message)) {
    diagnostic('skip', { floor, why, reason: 'not-story-message' });
    return;
  }

  const swipe = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
  const id = identity(chatId, floor, swipe, message.mes);
  if (processed.has(id)) {
    diagnostic('skip', { floor, why, reason: 'already-processed' });
    return;
  }
  const lockKey = `${chatId}|${floor}`;
  if (running.has(lockKey)) {
    diagnostic('skip', { floor, why, reason: 'already-running' });
    return;
  }

  running.add(lockKey);
  hooks.onBusy?.(true);
  lastRunAt = Date.now();
  diagnostic('run', { floor, swipe, why, length: message.mes.length });

  let ok = false;
  try {
    const result = await illustrateFloor(floor, {
      note: '自动插图:用这一楼的正文编译最贴合当前画面的插图提示词。',
    });
    ok = result.images.length > 0 && result.errors.length === 0;
    diagnostic('done', {
      floor,
      images: result.images.length,
      segments: result.segments.length,
      errors: result.errors,
    });
    if (result.errors.length) {
      lastError = result.errors[0];
      if (!result.images.length) toastOnce(`自动插图失败:${result.errors[0]}`, 'error');
    } else {
      lastError = '';
    }
    hooks.onDone?.({ floor, images: result.images.length, errors: result.errors });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    lastError = text;
    diagnostic('error', { floor, message: text });
    toastOnce(`自动插图失败:${text}`, 'error');
    hooks.onDone?.({ floor, images: 0, errors: [text] });
  } finally {
    running.delete(lockKey);
    hooks.onBusy?.(false);
    if (ok) {
      processed.add(id);
      failures.delete(id);
    } else {
      // 失败不锁死:这一楼还能再自动跑一次(延迟防打转),用户手动点也随时能跑。
      const times = (failures.get(id) ?? 0) + 1;
      failures.set(id, times);
      if (times <= 2) {
        diagnostic('retry-later', { floor, times, afterMs: RETRY_BACKOFF_MS * times });
        const timer = setTimeout(() => {
          pending.delete(timer);
          void run(floor, chatId, hooks, 'retry');
        }, RETRY_BACKOFF_MS * times);
        pending.add(timer);
      }
    }
  }
}

/** 同一类提示只弹一次,别让自动流程刷屏。 */
const toasted = new Set<string>();
function toastOnce(text: string, kind: 'info' | 'success' | 'warning' | 'error'): void {
  if (toasted.has(text)) return;
  toasted.add(text);
  const toastr = (window as unknown as Record<string, Record<string, (m: string, t: string) => void>>).toastr;
  const fn = toastr?.[kind] ?? toastr?.info;
  if (fn) fn.call(toastr, text, '绘图姬·中转站');
  else console.warn(`[绘图姬·中转站] ${text}`);
}

/** 武装闸门;不合格的生成(quiet/impersonate/dryRun)不武装。 */
function armGate(chatId: string, type: unknown, dryRun: unknown): void {
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  const eligible = Boolean(chatId && !dryRun && t !== 'quiet' && t !== 'impersonate');
  gate = eligible ? { chatId, type: t, armedAt: Date.now() } : null;
  diagnostic('arm', { chatId, type, dryRun, eligible });
}

/**
 * 消费闸门:只要求同聊天 + 在时间窗内。
 *
 * 刻意**不再**要求渲染事件的 type 与 GENERATION_STARTED 的 type 字符串完全相等:
 * 实测不同 ST 版本一边给 `'normal'` 一边给 `undefined`(或 `'normal'` vs `'first_message'`),
 * 老实现因此把每一次真生成的最终渲染都判成「不是这次生成」,自动图永远不起。
 * 现在 type 只在 GENERATION_STARTED 那一侧用来排除后台调用。
 */
function consumeGate(chatId: string): boolean {
  if (!gate) return false;
  if (Date.now() - gate.armedAt > GATE_TTL_MS) {
    gate = null;
    return false;
  }
  if (gate.chatId !== chatId) return false;
  gate = null;
  return true;
}

/** 生成开始后,聊天变长/末楼内容变化都说明 AI 已经落楼 —— 兜底补跑。 */
function armContentObserver(chatId: string, hooks: AutoIllustrateHooks): void {
  const ctx = getContext();
  const lengthAtArm = ctx?.chat?.length ?? 0;
  let tries = 0;
  const tick = () => {
    if (!gate) return;
    const current = getContext();
    if (!current) return;
    if ((current.getCurrentChatId?.() ?? '') !== chatId) return;
    const grew = (current.chat?.length ?? 0) > lengthAtArm;
    const floor = latestAiFloor();
    if (grew && floor >= 0) {
      diagnostic('content-observer', { floor, tries });
      gate = null;
      schedule(floor, chatId, hooks, 'content-grew');
      return;
    }
    tries += 1;
    if (tries > 120) return; // 最多看 60 秒
    const timer = setTimeout(tick, 500);
    pending.add(timer);
  };
  const timer = setTimeout(tick, 600);
  pending.add(timer);
}

/** 绑定 ST 生成事件。重复调用安全;失败会退避重试,不会一失手就再也不绑。 */
export function bindAutoIllustrate(hooks: AutoIllustrateHooks): void {
  if (bound) {
    diagnostic('bind:skip', { reason: 'already-bound' });
    return;
  }
  const ctx = getContext();
  const events = ctx?.eventTypes ?? ctx?.event_types;
  const ready = !!(ctx?.eventSource && events && events.GENERATION_STARTED);
  if (!ready) {
    bindTries += 1;
    diagnostic('bind:wait', { tries: bindTries, hasSource: !!ctx?.eventSource, hasEvents: !!events });
    if (bindTries <= BIND_MAX_TRIES && !bindTimer) {
      bindTimer = setTimeout(() => {
        bindTimer = null;
        bindAutoIllustrate(hooks);
      }, BIND_RETRY_MS);
    }
    return;
  }
  bound = true;
  bindTries = 0;

  const chatIdNow = () => getContext()?.getCurrentChatId?.() ?? '';

  ctx!.eventSource.on(events!.GENERATION_STARTED, (type: unknown, _options: unknown, dryRun: unknown) => {
    const chatId = chatIdNow();
    armGate(chatId, type, dryRun);

    if (watchdog) clearTimeout(watchdog);
    if (!gate) return;

    // 看门狗:2.5 秒后闸门还没被消费 → 直接补跑最新楼。
    // 这一层是「AI 写完了但不出图」的最终兜底,不依赖任何渲染事件的细节。
    watchdog = setTimeout(() => {
      watchdog = null;
      if (!gate) return;
      if (Date.now() - gate.armedAt > RENDER_WINDOW_MS) {
        gate = null;
        return;
      }
      const nowChat = chatIdNow();
      if (!nowChat || nowChat !== gate.chatId) return;
      const floor = latestAiFloor();
      if (floor < 0) return;
      diagnostic('watchdog', { floor, type: gate.type });
      gate = null;
      schedule(floor, nowChat, hooks, 'watchdog');
    }, WATCHDOG_MS);

    // 第三层:直接看聊天长度(有的 ST 版本既不发渲染、ENDED 又早于落盘)
    armContentObserver(gate.chatId, hooks);
  });

  ctx!.eventSource.on(events!.CHARACTER_MESSAGE_RENDERED, (messageId: unknown, _type: unknown) => {
    const chatId = chatIdNow();
    const floor = Number(messageId);
    const matched = consumeGate(chatId);
    diagnostic('CHARACTER_MESSAGE_RENDERED', { chatId, messageId, matched });
    if (!Number.isInteger(floor) || floor < 0) return;
    if (!matched) {
      // 渲染事件没带闸门(编辑 / swipe / 切聊天重渲染):什么都不做。
      return;
    }
    schedule(floor, chatId, hooks, 'rendered');
  });

  // ST 可能在最终渲染之前就发 GENERATION_ENDED;此时闸门还在,用它补跑。
  if (events!.GENERATION_ENDED) {
    ctx!.eventSource.on(events!.GENERATION_ENDED, () => {
      const chatId = chatIdNow();
      if (!gate || gate.chatId !== chatId) {
        diagnostic('GENERATION_ENDED', { chatId, action: 'gate-already-consumed' });
        return;
      }
      const floor = latestAiFloor();
      diagnostic('GENERATION_ENDED', { chatId, floor, action: 'fallback' });
      if (floor < 0) return;
      gate = null;
      schedule(floor, chatId, hooks, 'generation-ended');
    });
  }

  ctx!.eventSource.on(events!.GENERATION_STOPPED, () => {
    // 只记日志,不清闸门:部分版本先发 STOPPED 再发渲染事件,
    // 在这里清掉会把马上要到的召回挡掉(实测踩到过)。
    diagnostic('GENERATION_STOPPED', { action: 'keep-gate' });
  });

  ctx!.eventSource.on(events!.CHAT_CHANGED, () => {
    gate = null;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
    processed.clear();
    failures.clear();
    diagnostic('CHAT_CHANGED', {});
  });

  diagnostic('bound', {
    generationStarted: events!.GENERATION_STARTED,
    characterRendered: events!.CHARACTER_MESSAGE_RENDERED,
    generationEnded: events!.GENERATION_ENDED ?? null,
  });
}

/** 自动流程的当前状态(面板「提示词」页显示)。 */
export function autoIllustrateState(): { bound: boolean; lastError: string; lastRunAt: number } {
  return { bound, lastError, lastRunAt };
}

/** 供测试 / 换聊天时清空内部状态。 */
export function resetAutoIllustrate(): void {
  gate = null;
  bound = false;
  bindTries = 0;
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  if (bindTimer) clearTimeout(bindTimer);
  bindTimer = null;
  for (const timer of pending) clearTimeout(timer);
  pending.clear();
  processed.clear();
  failures.clear();
  running.clear();
  lastError = '';
  lastRunAt = 0;
}

/** 供测试 / 面板用:手动喂一次生成开始(等价于 ST 的 GENERATION_STARTED)。 */
export function debugArmGeneration(type = 'normal'): void {
  armGate(getContext()?.getCurrentChatId?.() ?? '', type, false);
}
