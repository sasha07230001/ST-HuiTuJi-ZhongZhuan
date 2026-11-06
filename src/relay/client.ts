/**
 * 中转站客户端:把剧情编译成 CLIP 提示词的那一次模型调用。
 *
 * 关键设计——**请求走 SillyTavern 服务端代理**,而不是浏览器直连:
 *   POST /api/backends/chat-completions/generate
 *   { chat_completion_source: 'openai', reverse_proxy: <后端的 url>, proxy_password: <key> }
 * 这带来两个直接好处:
 * 1. 没有 CORS 问题——任何 OpenAI 兼容中转站(哪怕没开跨域)都能用;
 * 2. key 只经 ST 服务端转发,不暴露给页面上别的脚本。
 * 这是 ST 自己的「自定义 OpenAI 兼容端点」通道,不是本扩展私有的东西。
 *
 * 本模块不读写设置,只接受一个 RelayChannel。
 */

import { ST_GENERATE_URL, ST_STATUS_URL } from '@/types';
import {
  alternateRelayUrl,
  normalizeRelayUrl,
  unwrapPromptReply,
  withTimeout,
  validatePrompt,
} from '@/relay/prompt';
import { getContext } from '@/st/context';

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export interface RelayConn {
  url: string;
  key: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutSec?: number;
}

/**
 * 组装 ST 代理的请求体。
 * 刻意非流式:中转站出图这一跳要的是「一次给完的完整 tag」,流式只增加拼接出错的面。
 * 也刻意不发 tools——tag 必须直接输出,不能被工具调用拐走。
 */
export function buildRelayBody(conn: RelayConn, messages: ChatMsg[], base: string): Record<string, unknown> {
  return {
    chat_completion_source: 'openai',
    reverse_proxy: base,
    proxy_password: conn.key || '',
    model: conn.model,
    messages,
    temperature: Number.isFinite(conn.temperature) ? conn.temperature : 0.8,
    max_tokens: Number.isFinite(conn.maxTokens) ? conn.maxTokens : 400,
    stream: false,
    tool_choice: 'none',
    presence_penalty: 0,
    frequency_penalty: 0,
  };
}

/** 把 string / content-parts 数组 / 其它类型统一成文本。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (const part of value) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') out += text;
      }
    }
    return out;
  }
  return '';
}

/**
 * 从响应体提取答案。标准链之外还要看 reasoning 一族:
 * 推理模型(deepseek-reasoner 等)有时把全部内容塞进 reasoning_content 而 content 为空。
 */
export function extractRelayContent(data: unknown): string {
  const d = data as Record<string, any> | null | undefined;
  const msg = d?.choices?.[0]?.message;
  const content = textOf(msg?.content) || textOf(d?.choices?.[0]?.text) || textOf(d?.content);
  if (content.trim()) return content.trim();
  return textOf(msg?.reasoning) || textOf(msg?.reasoning_content) || textOf(msg?.thinking);
}

export interface RelayOptions {
  signal?: AbortSignal;
  /** 只有首个地址明确返回 404/405 时才换备用形式(/v1)重试一次。 */
  allowUrlFallback?: boolean;
}

/** 发一次补全,返回原始文本与最终采用的 base url。 */
async function callOnce(conn: RelayConn, messages: ChatMsg[], base: string, opts: RelayOptions): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw new RelayError('SillyTavern 上下文不可用');
  const body = buildRelayBody(conn, messages, base);
  const timeoutSec = conn.timeoutSec ?? 120;

  return withTimeout(timeoutSec, opts.signal, '中转站请求', async signal => {
    const resp = await fetch(ST_GENERATE_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new RelayError(`中转站请求失败 (${resp.status})${text ? `：${text.slice(0, 300)}` : ''}`, resp.status);
    }
    const data = await resp.json().catch(() => null);
    const err = (data as Record<string, any> | null)?.error;
    if (err) throw new RelayError(typeof err === 'string' ? err : err.message || '中转站返回错误');
    const content = extractRelayContent(data);
    if (!content) throw new RelayError('中转站返回了空内容');
    return content;
  });
}

/**
 * 让中转站把剧情编译成 CLIP 提示词。失败会抛出人话错误,调用方负责 toast。
 * 返回值已剥掉代码块/前缀,但**还没**加恒定画风词——那是 settings 层的事。
 */
export async function compilePrompt(
  conn: RelayConn,
  messages: ChatMsg[],
  opts: RelayOptions = {},
): Promise<string> {
  if (!conn.url.trim()) throw new RelayError('请先填写中转站 API 地址');
  if (!conn.model.trim()) throw new RelayError('请先填写中转站模型名');

  const base = normalizeRelayUrl(conn.url);
  try {
    const raw = await callOnce(conn, messages, base, opts);
    const text = unwrapPromptReply(raw);
    const verdict = validatePrompt(text);
    if (!verdict.ok) throw new RelayError(verdict.reason);
    return text;
  } catch (error) {
    const status = error instanceof RelayError ? error.status : undefined;
    if (!opts.allowUrlFallback || (status !== 404 && status !== 405)) throw error;
    const fallback = alternateRelayUrl(base);
    if (!fallback || fallback === base) throw error;
    const raw = await callOnce(conn, messages, fallback, { ...opts, allowUrlFallback: false });
    const text = unwrapPromptReply(raw);
    const verdict = validatePrompt(text);
    if (!verdict.ok) throw new RelayError(verdict.reason);
    return text;
  }
}

/** 连通性测试:发一句极短的话,确认 url/key/model 三者都对。 */
export async function testRelayConnection(conn: RelayConn, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  try {
    const base = normalizeRelayUrl(conn.url);
    const reply = await callOnce(conn, [{ role: 'user', content: '只回复两个字:正常' }], base, {
      signal,
      allowUrlFallback: false,
    });
    return { ok: true, message: `连通正常,返回:${reply.slice(0, 40)}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 拉模型列表(走 ST 的 /status 代理,标准 /v1/models)。只需 url + key。 */
export async function fetchRelayModels(conn: Pick<RelayConn, 'url' | 'key' | 'timeoutSec'>): Promise<string[]> {
  const ctx = getContext();
  if (!ctx) throw new RelayError('SillyTavern 上下文不可用');
  if (!conn.url.trim()) throw new RelayError('请先填写 API 地址');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeRelayUrl(conn.url),
    proxy_password: conn.key || '',
  };

  return withTimeout(conn.timeoutSec ?? 60, undefined, '拉取模型', async signal => {
    const resp = await fetch(ST_STATUS_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new RelayError(`拉取模型失败 (${resp.status})${text ? `：${text.slice(0, 200)}` : ''}`, resp.status);
    }
    const data = (await resp.json().catch(() => null)) as Record<string, any> | null;
    const list: unknown = data?.data ?? data?.models ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
      .sort();
  });
}
