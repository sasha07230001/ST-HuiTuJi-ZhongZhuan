/**
 * 纯文本工具:URL 规范化、提示词清洗、验收。
 *
 * 这里全部是纯函数,不碰宿主。理由很简单——中转站最容易坏的两个地方
 * (地址填法五花八门、模型爱在 tag 外面裹解释)都只靠这一层挡住,
 * 能单独跑测试才敢改。
 */

/**
 * 规范化 OpenAI 兼容 base url:
 * - 用户填完整 /chat/completions 时只去掉端点后缀;
 * - 纯域名自动补 /v1;
 * - 已带路径的地址原样保留(别破坏 /v2/coding 这类自定义路由)。
 */
export function normalizeRelayUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

/** 首地址返回 404/405 时试的备用形式:加/去 /v1。 */
export function alternateRelayUrl(url: string): string {
  return /\/v1$/i.test(url) ? url.replace(/\/v1$/i, '') : `${url}/v1`;
}

/** 去掉 ComfyUI 地址尾部的斜杠。 */
export function normalizeComfyUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** 拼 ComfyUI 端点。 */
export function comfyEndpoint(base: string, path: string): string {
  return `${normalizeComfyUrl(base)}/${path.replace(/^\/+/, '')}`;
}

/** 正文最大送入量(字符)。剧情楼偶尔有几千字,截尾比截头更糟——高潮通常在后面,故保留尾部。 */
export const MAX_STORY_CHARS = 6000;

/**
 * 清洗要送进中转站的正文:
 * - 去掉 HTML 标签、Markdown 装饰(别让 <div> 之类挤占 token);
 * - 去掉已存在的出图卡标记,别把上一轮的 tag 当正文再喂回去;
 * - 折叠空白;超长保留尾部。
 */
export function cleanStoryText(raw: string): string {
  return raw
    .replace(/<htj-zz-card[\s\S]*?<\/htj-zz-card>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`~]{1,3}/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(-MAX_STORY_CHARS);
}

/**
 * 抽出模型回复里的提示词正文。模型很爱裹一层代码块或加个「提示词:」前缀,
 * 全都剥掉;剥完空串就是真空(调用方据此重试)。
 */
export function unwrapPromptReply(raw: string): string {
  let text = String(raw ?? '').trim();
  if (!text) return '';
  // 优先取 ```...``` 代码块里的内容
  const fenced = text.match(/```[a-zA-Z]*\n?([\s\S]*?)```/);
  if (fenced && fenced[1].trim()) text = fenced[1];
  text = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^(prompt|提示词|positive|正向)\s*[:：]?$/i.test(line))
    .join(' ')
    .replace(/^(prompt|提示词|positive prompt|正向提示词)\s*[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/** 校验一条提示词是否像样:不能空、不能是整段中文(ComfyUI 的 CLIP 吃英文)。 */
export function validatePrompt(text: string): { ok: boolean; reason: string } {
  const t = text.trim();
  if (!t) return { ok: false, reason: '模型返回了空提示词' };
  const latin = (t.match(/[a-zA-Z]/g) ?? []).length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (latin < 3) return { ok: false, reason: '提示词里几乎没有英文,ComfyUI 的 CLIP 读不懂' };
  if (cjk > latin) return { ok: false, reason: '提示词以中文为主,请让中转站输出英文 tag' };
  if (t.length > 4000) return { ok: false, reason: `提示词过长(${t.length} 字符),CLIP 会被截断` };
  return { ok: true, reason: '' };
}

/** 把恒定画风词并到正向提示词后面,去重且保持顺序。 */
export function joinPositive(prompt: string, styleSuffix: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of `${prompt},${styleSuffix}`.split(',')) {
    const tag = part.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.join(', ');
}

/** 把恒定负面词并到动态负面词后面。 */
export function joinNegative(dynamic: string, fixed: string): string {
  return joinPositive(dynamic ?? '', fixed ?? '');
}

/**
 * 正向合成:恒定画风词**前置**。
 *
 * CLIP 的注意力对越靠前的 token 越敏感,而且不少采样器/工作流只吃前 75 个 token。
 * 画风基线丢在末尾等于把最能定调的那几个词放到最容易被截断的位置——
 * 所以恒定词必须在最前面,模型编译出来的具体画面描述跟在后面。
 */
export function composePositive(style: string, core: string): string {
  return joinPositive(style ?? '', core ?? '');
}

/** 负面合成:恒定负面词同样前置。 */
export function composeNegative(fixed: string, core: string): string {
  return joinPositive(fixed ?? '', core ?? '');
}

/**
 * 正文清洗+提示词模板渲染。占位符 {{story}} {{note}} 换成实际文本,
 * 其余 `{{xxx}}` 原样保留(可能是用户想留给 ST 的宏)。
 */
export function renderSystemPrompt(template: string, story: string, note: string): string {
  return template
    .replace(/\{\{story\}\}/gi, story)
    .replace(/\{\{note\}\}/gi, note || '(无)');
}

/** 超时包装器:把整个请求(建连+读完 body+读 SSE)一起算进时限。 */
export async function withTimeout<T>(
  timeoutSec: number,
  external: AbortSignal | undefined,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  const sec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 120;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1000, sec * 1000));

  try {
    return await task(ctrl.signal);
  } catch (error) {
    if (timedOut) throw new Error(`${label}超时(>${sec}秒)`);
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}
