/**
 * SillyTavern getContext() 的薄封装 + 类型。
 * 整个扩展只通过这里接触宿主,宿主变了只改这一处。
 */

export interface STMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  swipes?: string[];
  swipe_id?: number;
  send_date?: string;
  extra?: Record<string, unknown>;
}

/**
 * 是不是一条「剧情消息」:ST 真·系统消息之外的一切,含被 /hide 隐藏的普通楼。
 * 判据只看 extra.type——ST 只给 narrator/comment/sys 这类盖这个戳,/hide 只翻 is_system。
 */
export function isStoryMessage(message: STMessage | undefined): message is STMessage {
  if (!message || typeof message.mes !== 'string' || !message.mes.trim()) return false;
  return !(message.is_system && typeof message.extra?.type === 'string');
}

/** 剧情消息里的 AI 楼。自动流程只认这种楼。 */
export function isAiStoryMessage(message: STMessage | undefined): message is STMessage {
  return isStoryMessage(message) && !message.is_user;
}

export interface STEventSource {
  on(event: string, handler: (...args: any[]) => void): void;
  off?(event: string, handler: (...args: any[]) => void): void;
  emit?(event: string, ...args: any[]): Promise<void> | void;
}

export interface STContext {
  chat: STMessage[];
  chatMetadata: Record<string, unknown>;
  name1: string;
  name2: string;
  getCurrentChatId: () => string | undefined;
  getRequestHeaders: () => Record<string, string>;
  saveMetadataDebounced?: () => void;
  saveChat?: () => Promise<void>;
  /** = extension_settings,写进服务器 settings.json,跨设备同步。ST 稳定 API。 */
  extensionSettings?: Record<string, unknown>;
  saveSettingsDebounced?: () => void;
  eventSource: STEventSource;
  eventTypes: Record<string, string>;
  event_types?: Record<string, string>;
  updateMessageBlock?: (messageId: number, message: STMessage, options?: { rerenderMessage?: boolean }) => unknown;
  saveMetadata?: () => Promise<void>;
  [k: string]: unknown;
}

interface SillyTavernGlobal {
  getContext?: () => STContext;
}

export function getContext(): STContext | null {
  try {
    const st = (window as unknown as { SillyTavern?: SillyTavernGlobal }).SillyTavern;
    return st?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

/** ST 尚未就绪时轮询等待。 */
export async function waitForContext(timeoutMs = 20000): Promise<STContext | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ctx = getContext();
    if (ctx) return ctx;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return null;
}

/** 持久化当前楼层的 DOM(图片卡片挂上去以后要重渲染才看得到)。 */
export function reloadMessageDom(messageId: number): void {
  const ctx = getContext();
  const message = ctx?.chat?.[messageId];
  if (ctx?.updateMessageBlock && message) {
    try {
      ctx.updateMessageBlock(messageId, message);
      return;
    } catch {
      /* 落到下面的 DOM 兜底 */
    }
  }
  try {
    const nodes = document.querySelectorAll(`#chat .mes[mesid="${messageId}"]`);
    nodes.forEach(node => node.setAttribute('data-htj-zz-stale', '1'));
    window.dispatchEvent(new CustomEvent('htj-zz:rerender', { detail: { messageId } }));
  } catch {
    /* 无 DOM 环境(测试)时忽略 */
  }
}
