/**
 * ComfyUI 运行时:提交工作流、轮询结果、取消。
 *
 * 通道策略与二号一致:
 * 1. 浏览器直连优先(延迟最低、不占 ST 服务端);
 * 2. 仅当请求「根本没送达后端」(fetch TypeError:CORS/拒连/断网)时才回退到 ST 后端转发;
 * 3. HTTP 状态错误是服务端真实反馈,不重试——转发过去结果一样;
 * 4. 用户取消(AbortError)直接抛出。
 */

import { comfyEndpoint, normalizeComfyUrl } from '@/relay/prompt';
import { ST_COMFY_PROXY, type ComfyChannel } from '@/types';
import { getContext } from '@/st/context';
import type { ComfyWorkflow, JsonObject } from '@/comfy/workflow';

export class ComfyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ComfyError';
  }
}

export interface ComfyImage {
  url: string;
  filename: string;
  format: string;
  revoke(): void;
}

export interface ComfyProgress {
  /** 前面还有几个任务;0 = 正在执行,null = 未知。 */
  onQueue?(ahead: number | null): void;
}

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof TypeError;
}

function requireHeaders(): Record<string, string> {
  const ctx = getContext();
  if (!ctx) throw new ComfyError('SillyTavern 上下文不可用');
  return ctx.getRequestHeaders();
}

async function responseError(response: Response, label: string): Promise<ComfyError> {
  const text = (await response.text().catch(() => '')).trim();
  return new ComfyError(`${label} (${response.status})${text ? `:${text.slice(0, 400)}` : ''}`, response.status);
}

/** 连通性测试:先试浏览器直连,再试 ST 后端转发。 */
export async function testComfyConnection(conn: ComfyChannel, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  if (!normalizeComfyUrl(conn.url)) return { ok: false, message: '请先填写 ComfyUI 地址' };

  try {
    const resp = await fetch(comfyEndpoint(conn.url, 'system_stats'), { signal });
    if (resp.ok) return { ok: true, message: '浏览器直连正常' };
  } catch (error) {
    if (!isNetworkError(error)) return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (!conn.allowServerProxy) return { ok: false, message: '浏览器连不上 ComfyUI(CORS/拒连),且未开启后端转发' };

  try {
    const resp = await fetch(`${ST_COMFY_PROXY}/ping`, {
      method: 'POST',
      headers: requireHeaders(),
      body: JSON.stringify({ url: conn.url.trim() }),
      signal,
    });
    if (resp.ok) return { ok: true, message: '经 ST 后端转发正常' };
    return { ok: false, message: `ST 后端转发失败 (${resp.status});若是 404,请重启 SillyTavern 让后端接口注册` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/* ---------------- 直接出图 ---------------- */

async function queueDirect(conn: ComfyChannel, workflow: ComfyWorkflow, signal?: AbortSignal): Promise<string> {
  const resp = await fetch(comfyEndpoint(conn.url, 'prompt'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
    signal,
  });
  if (!resp.ok) throw await responseError(resp, 'ComfyUI 拒绝了工作流');
  const data = (await resp.json()) as { prompt_id?: unknown; node_errors?: unknown };
  if (typeof data.prompt_id !== 'string' || !data.prompt_id) {
    throw new ComfyError(
      `ComfyUI 未返回 prompt_id${data.node_errors ? `:${JSON.stringify(data.node_errors).slice(0, 500)}` : ''}`,
    );
  }
  return data.prompt_id;
}

type QueueEntry = [number, string, ...unknown[]];

function isQueueEntry(value: unknown): value is QueueEntry {
  return Array.isArray(value) && typeof value[1] === 'string';
}

/** 任务在 ComfyUI 队列里的位置。取不到一律当「未知」,不因此中断出图。 */
async function fetchQueuePosition(
  conn: ComfyChannel,
  promptId: string,
  signal?: AbortSignal,
): Promise<{ running: boolean; ahead: number | null } | null> {
  try {
    const resp = await fetch(comfyEndpoint(conn.url, 'queue'), { signal });
    if (!resp.ok) return null;
    const data = (await resp.json()) as JsonObject;
    if (!Array.isArray(data.queue_running) || !Array.isArray(data.queue_pending)) return null;
    const running = data.queue_running.filter(isQueueEntry);
    const pending = data.queue_pending.filter(isQueueEntry);
    if (running.some(entry => entry[1] === promptId)) return { running: true, ahead: 0 };
    const mine = pending.find(entry => entry[1] === promptId);
    if (!mine) return { running: false, ahead: null };
    const ahead = pending.filter(entry => entry[0] < mine[0]).length + running.length;
    return { running: false, ahead };
  } catch {
    return null;
  }
}

/**
 * 取消已入队的任务。排队中的摘队列,正在跑的才 interrupt;
 * 位置查不到时两条都发(delete 是无害空操作,interrupt 带 prompt_id 只影响自己)。
 */
async function cancelPrompt(conn: ComfyChannel, promptId: string): Promise<void> {
  const position = await fetchQueuePosition(conn, promptId);
  const post = (path: string, body: JsonObject) =>
    fetch(comfyEndpoint(conn.url, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    if (position?.running) {
      await post('interrupt', { prompt_id: promptId });
      return;
    }
    if (position) {
      await post('queue', { delete: [promptId] });
      return;
    }
    await Promise.allSettled([post('queue', { delete: [promptId] }), post('interrupt', { prompt_id: promptId })]);
  } catch {
    /* 取消尽力而为 */
  }
}

interface OutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

function findOutputFile(item: unknown): OutputFile | null {
  if (!isObject(item) || !isObject(item.outputs)) return null;
  for (const output of Object.values(item.outputs)) {
    if (!isObject(output)) continue;
    for (const key of ['images', 'gifs']) {
      const files = output[key];
      if (!Array.isArray(files)) continue;
      const file = files.find(x => isObject(x) && typeof x.filename === 'string');
      if (file) return file as unknown as OutputFile;
    }
  }
  return null;
}

function executionError(item: unknown): string | null {
  if (!isObject(item) || !isObject(item.status)) return null;
  if (item.status.status_str !== 'error') return null;
  const messages = item.status.messages;
  if (!Array.isArray(messages)) return 'ComfyUI 工作流执行失败';
  const details = messages
    .filter(m => Array.isArray(m) && m[0] === 'execution_error' && isObject(m[1]))
    .map(m => {
      const data = m[1] as JsonObject;
      return `${String(data.node_type ?? '节点')} [${String(data.node_id ?? '?')}]:${String(data.exception_message ?? data.exception_type ?? '执行失败')}`;
    });
  return details.length ? details.join('\n') : 'ComfyUI 工作流执行失败';
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function fileFormat(filename: string, mime = ''): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext && /^[a-z0-9]+$/.test(ext)) return ext;
  return mime.split('/').pop()?.toLowerCase() || 'png';
}

async function pollDirectResult(
  conn: ComfyChannel,
  promptId: string,
  signal: AbortSignal | undefined,
  progress: ComfyProgress,
): Promise<ComfyImage> {
  const onAbort = () => void cancelPrompt(conn, promptId);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const startedAt = Date.now();
    let file: OutputFile | null = null;
    let watchQueue = !!progress.onQueue;
    while (!file) {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) throw new ComfyError('等待 ComfyUI 结果超时(10 分钟)');
      const resp = await fetch(comfyEndpoint(conn.url, `history/${encodeURIComponent(promptId)}`), { signal });
      if (!resp.ok) throw await responseError(resp, '读取 ComfyUI 任务状态失败');
      const history = (await resp.json()) as JsonObject;
      const item = history[promptId];
      const err = executionError(item);
      if (err) throw new ComfyError(err);
      file = findOutputFile(item);
      if (!file && isObject(item) && isObject(item.status) && item.status.completed === true) {
        throw new ComfyError('工作流执行完成但没有图片输出;请确认工作流里包含 SaveImage 节点');
      }
      if (file) break;
      if (watchQueue) {
        const position = await fetchQueuePosition(conn, promptId, signal);
        progress.onQueue?.(position?.ahead ?? null);
        if (position?.running || position?.ahead === null) watchQueue = false;
      }
      await abortableDelay(POLL_INTERVAL_MS, signal);
    }

    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder ?? '',
      type: file.type ?? 'output',
    });
    const imgResp = await fetch(`${comfyEndpoint(conn.url, 'view')}?${query}`, { signal });
    if (!imgResp.ok) throw await responseError(imgResp, '读取 ComfyUI 输出图片失败');
    const blob = await imgResp.blob();
    const url = URL.createObjectURL(blob);
    return {
      url,
      filename: file.filename,
      format: fileFormat(file.filename, blob.type),
      revoke: () => URL.revokeObjectURL(url),
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/* ---------------- 经 ST 后端转发 ---------------- */

async function generateViaServer(conn: ComfyChannel, workflow: ComfyWorkflow, signal?: AbortSignal): Promise<ComfyImage> {
  const resp = await fetch(`${ST_COMFY_PROXY}/generate`, {
    method: 'POST',
    headers: requireHeaders(),
    body: JSON.stringify({ url: conn.url.trim(), prompt: JSON.stringify({ prompt: workflow }) }),
    signal,
  });
  if (!resp.ok) throw await responseError(resp, 'ComfyUI 生图失败');
  const data = (await resp.json()) as { format?: unknown; data?: unknown };
  if (typeof data.data !== 'string' || !data.data) throw new ComfyError('ST 后端未返回图片数据');
  const format = typeof data.format === 'string' && data.format ? data.format.toLowerCase() : 'png';
  return {
    url: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${data.data}`,
    filename: `htj-zz-${Date.now()}.${format}`,
    format,
    revoke() {},
  };
}

/* ---------------- 对外唯一入口 ---------------- */

export interface GenerateOptions {
  signal?: AbortSignal;
  progress?: ComfyProgress;
}

/**
 * 提交渲染好的工作流并等图。
 * 回退只在「排队之前」发生:拿到 prompt_id 就代表任务已入队,
 * 之后的轮询失败不重发,避免重复出图。
 */
export async function runWorkflow(
  conn: ComfyChannel,
  workflow: ComfyWorkflow,
  opts: GenerateOptions = {},
): Promise<ComfyImage> {
  if (!normalizeComfyUrl(conn.url)) throw new ComfyError('请先填写 ComfyUI 服务地址');
  const signal = opts.signal;
  const progress = opts.progress ?? {};

  let queued = false;
  try {
    const promptId = await queueDirect(conn, workflow, signal);
    queued = true;
    return await pollDirectResult(conn, promptId, signal, progress);
  } catch (error) {
    if (queued || signal?.aborted || !isNetworkError(error) || !conn.allowServerProxy) throw error;
    return generateViaServer(conn, workflow, signal);
  }
}
