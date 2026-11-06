/**
 * ST 自带扩展端点之外的补充后端接口:/api/plugin/htj-zhongzhuan/comfy。
 *
 * 为什么需要:SillyTavern 的 API 端点是锁定的(白名单),第三方扩展没法新增 /api/xxx。
 * 唯一例外是 /api/plugin/<插件目录名>/... 这类路由,它会转发给 public/scripts/extensions/
 * third-party/<插件目录名>/server 下的 index.js 的 init(router)。
 *
 * 这个后端只做一件事:浏览器直连 ComfyUI 被 CORS 挡住时,替前端转发请求。
 * 拿不到 ST 的 server 依赖(单测 / 脱离酒馆运行)时,模块照常加载但 init 不注册任何东西。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const EXTENSION_DIR = path.resolve(SERVER_DIR, '..');
const DATA_DIR = path.join(EXTENSION_DIR, '.data');

const PING_TIMEOUT_MS = 8000;
const GENERATE_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 500;

function endpoint(base, suffix) {
  return `${String(base || '').trim().replace(/\/+$/, '')}/${String(suffix).replace(/^\/+/, '')}`;
}

function downloadOf(url) {
  // SSRF 防护:只允许 http/https
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('ComfyUI 地址不合法');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 http/https 地址');
  return parsed;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = PING_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 注册路由。由 ST 在扩展加载时调用。
 * @param {import('express').Router} router
 * @param {object} [deps] ST 传入的 server 依赖(未用,保持签名兼容)
 */
export async function init(router, deps) {
  if (!router || typeof router.get !== 'function') {
    console.warn('[绘图姬·中转站] 未拿到 express Router,后端转发不可用');
    return;
  }

  router.post('/ping', async (request, response) => {
    const url = downloadOf(request.body?.url);
    try {
      const res = await fetchWithTimeout(endpoint(url, 'system_stats'));
      response.status(res.ok ? 200 : 502).send(res.ok ? { ok: true } : { error: `ComfyUI 返回 ${res.status}` });
    } catch (error) {
      response.status(502).send({ error: `连不上 ComfyUI:${error?.message || error}` });
    }
  });

  router.post('/generate', async (request, response) => {
    const url = downloadOf(request.body?.url);
    const prompt = String(request.body?.prompt || '');
    if (!prompt) {
      response.status(400).send({ error: '缺少工作流内容' });
      return;
    }

    try {
      const queued = await fetch(endpoint(url, 'prompt'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: prompt,
      });
      if (!queued.ok) {
        response.status(502).send({ error: `ComfyUI 拒绝了工作流:${await queued.text().catch(() => '')}` });
        return;
      }
      const { prompt_id: promptId, node_errors: nodeErrors } = await queued.json();
      if (!promptId) {
        response.status(502).send({ error: `ComfyUI 未返回 prompt_id:${JSON.stringify(nodeErrors || {})}` });
        return;
      }

      const startedAt = Date.now();
      let file = null;
      while (!file) {
        if (Date.now() - startedAt > GENERATE_TIMEOUT_MS) {
          response.status(504).send({ error: '等待 ComfyUI 结果超时(10 分钟)' });
          return;
        }
        const history = await fetch(endpoint(url, `history/${encodeURIComponent(promptId)}`)).then(r => r.json());
        const item = history?.[promptId];
        const outputs = item?.outputs || {};
        for (const output of Object.values(outputs)) {
          const files = output?.images || output?.gifs || [];
          const found = files.find(x => x && typeof x.filename === 'string');
          if (found) {
            file = found;
            break;
          }
        }
        if (item?.status?.status_str === 'error') {
          const detail = (item.status.messages || [])
            .filter(m => Array.isArray(m) && m[0] === 'execution_error')
            .map(m => m[1]?.exception_message || '执行失败')
            .join(';');
          response.status(502).send({ error: `ComfyUI 执行失败:${detail || '未知错误'}` });
          return;
        }
        if (file) break;
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      const query = new URLSearchParams({
        filename: file.filename,
        subfolder: file.subfolder || '',
        type: file.type || 'output',
      });
      const imageResponse = await fetch(`${endpoint(url, 'view')}?${query}`);
      if (!imageResponse.ok) {
        response.status(502).send({ error: `读取 ComfyUI 输出图片失败:${imageResponse.status}` });
        return;
      }

      const buffer = Buffer.from(await imageResponse.arrayBuffer());
      const base64 = buffer.toString('base64');
      const format = String(file.filename).split('.').pop()?.toLowerCase() || 'png';

      // 顺手落一份到扩展目录,页面刷新后仍能显示服务器端记录(可选)
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(path.join(DATA_DIR, `${crypto.randomUUID()}.${format}`), buffer);
      } catch {
        /* 落盘失败不影响返回 */
      }

      response.send({ format, data: base64 });
    } catch (error) {
      response.status(500).send({ error: `转发失败:${error?.message || error}` });
    }
  });

  console.log('[绘图姬·中转站] 后端转发接口已注册:/api/plugin/htj-zhongzhuan/comfy');
}

export async function exit() {}
