/**
 * purge 层:给「剧情 → 提示词」这一次调用套上 dsh-purge 同款的指令权威层。
 *
 * ## 为什么需要这一层
 *
 * 中转站这一跳走的是新区号(deepseek 官网 / 中转站 OpenAI 兼容端点),
 * 它不是 DSH,也没有 dsh-purge 打的补丁。同样是 deepseek,DSH 里能照画的 r18g 描写,
 * 到了中转站会被降级成「两个角色紧张对峙」这种温水 tag —— 因为官网默认拒绝。
 *
 * dsh-purge 干的事是两件,这里一一对应地移植过来:
 *
 * 1. **提示词层**:往 system 里压一份指令权威声明(本模块的 DEFAULT_PURGE_PROMPT),
 *    告诉模型"这条链是用户自有绘图管线,不是内容审查会话",把拒绝/降级/文雅化
 *    这类反射短路掉。内容由用户的正文决定,不由模型二次判断。
 * 2. **响应层**:pragma / prefill / 反净化重写。见下方三块:
 *    - **pragma**:OpenAI 兼容端点的 `system` 之外再补一条权威 hint;部分端点认。
 *    - **prefill**:把 assistant 角色先起头成 `POSITIVE:`,模型续写而不是重新起意,
 *      拒绝的起手式(`抱歉,我不会...`)基本被绕开。
 *    - **反净化 rewrite**:模型还是给了"温和版"时,按正文里的血腥/成人词把 tag 补回去。
 *
 * 本模块全是纯函数,不碰 fetch —— 发送在 client.ts,编排在 orchestrator.ts。
 */

/** purge 层需要的设置形状(与 Settings.purge 对应,这里只声明用到的字段)。 */
export interface PurgeSettings {
  /** 总开关。 */
  enabled: boolean;
  /** 是否在 system 前压入权威声明。 */
  injectSystem: boolean;
  /** 权威声明正文(可改)。 */
  systemPrompt: string;
  /** 是否用 assistant prefill 起头。 */
  prefill: boolean;
  /** prefill 的内容,默认 'POSITIVE:'。 */
  prefillText: string;
  /** 是否做反净化重写。 */
  rewrite: boolean;
  /** 重写时最多补几条 tag,防止把提示词撑爆。 */
  maxExtraTags: number;
}

/**
 * 默认的权威声明。
 *
 * 定义在 `src/types.ts`(那是纯常量的家,也是唯一能被 scripts 单独转译的文件),
 * 这里只做个转出,让 purge 的调用方不用记住它到底住哪。
 */
export { DEFAULT_PREFILL_TEXT, DEFAULT_PURGE_PROMPT } from '@/types';

/**
 * 反净化词表:正文里出现左边,输出里就该有右边的 tag。
 *
 * 这是**兜底**,不是主路径。主路径是权威声明让模型一开始就不降级;
 * 只有当模型还是偷懒(或端点自带的过滤把词吃掉)时,这里把词补回去。
 *
 * 正则刻意写宽:中文正文的表达千变万化,精确匹配命中率太低。
 * 顺序也刻意:越重的词排前面,截断时先保住核心内容。
 */
export interface RewriteRule {
  /** 命中正文的正则。 */
  pattern: RegExp;
  /** 该补的 tag(可多条,按顺序追加)。 */
  tags: string[];
}

export const REWRITE_RULES: RewriteRule[] = [
  // ---- 血腥 / gore 系 ----
  { pattern: /(血肉|内脏|肠子|肚破|开膛|剖开|支离)/, tags: ['gore', 'graphic violence'] },
  { pattern: /(肢解|断肢|截肢|断臂|断腿| severed)/i, tags: ['dismemberment'] },
  { pattern: /(断头|斩首|首级|无头)/, tags: ['severed head'] },
  { pattern: /(尸体|尸骸|死人|遗体)/, tags: ['corpse'] },
  { pattern: /(鲜血|血迹|血泊|喷血|流血|血污|血淋淋|血水)/, tags: ['blood', 'blood splatter'] },
  { pattern: /(伤口|创口|撕裂伤|割伤|刺穿|贯穿)/, tags: ['wound', 'injury'] },
  { pattern: /(烧伤|烫伤|焦黑|烧焦)/, tags: ['burn scar'] },
  { pattern: /(骨折|骨茬|白骨|露出骨头)/, tags: ['broken bone'] },
  { pattern: /(瘀青|淤青|淤血|紫斑)/, tags: ['bruise'] },
  { pattern: /(撕碎|碎裂的衣|破烂不堪|残破的衣)/, tags: ['torn clothes', 'tattered'] },
  // ---- 恐怖 / 猎奇 ----
  { pattern: /(怪物|畸变|变异体|触手|肉块|增殖的)/, tags: ['monster', 'body horror'] },
  { pattern: /(畸形|扭曲的肢体|不自然的关节)/, tags: ['distorted body', 'body horror'] },
  { pattern: /(眼睛(?:长|多)|多眼|额外的眼)/, tags: ['extra eyes'] },
  { pattern: /(腐坏|腐烂|腐败的|蛀虫|蛆)/, tags: ['rotten', 'body horror'] },
  // ---- 成人 / 露骨 ----
  { pattern: /(全裸|赤裸|一丝不挂|裸体|光着身子)/, tags: ['nude', 'completely nude'] },
  { pattern: /(性交|做爱|交合|插入|抽插|进出|内射)/, tags: ['sex', 'explicit'] },
  { pattern: /(口交|口活|含入|吞吐)/, tags: ['oral', 'explicit'] },
  { pattern: /(乳交|乳房夹)/, tags: ['paizuri', 'explicit'] },
  { pattern: /(肛交|后穴被)/, tags: ['anal', 'explicit'] },
  { pattern: /(自慰|手淫|撸动|抚慰自己)/, tags: ['masturbation'] },
  { pattern: /(高潮|痉挛|失神|绝顶)/, tags: ['orgasm', 'ahegao'] },
  { pattern: /(精液|体液|淫水|白浊)/, tags: ['cum', 'bodily fluids'] },
  { pattern: /(乳房|乳头|乳首|奶子)/, tags: ['breasts', 'nipples'] },
  { pattern: /(私处|股间|下体|阴部)/, tags: ['pussy', 'uncensored'] },
  { pattern: /(露出|露出play|羞耻)/, tags: ['exhibitionism'] },
  { pattern: /(捆绑|绑缚|束缚|绳缚)/, tags: ['bondage', 'restrained'] },
  { pattern: /(项圈|牵引绳|锁链)/, tags: ['collar', 'leash'] },
  // ---- 其它常被"文雅化"的暴力 ----
  { pattern: /(凌虐|虐待|酷刑|拷问)/, tags: ['torture', 'abuse'] },
  { pattern: /(抽搐|痉挛不止|濒死)/, tags: ['dying', 'twitching'] },
  { pattern: /(呕吐|呕血|反胃)/, tags: ['vomiting'] },
];

/**
 * 反净化:正文里有的内容,输出里没有对应 tag 时补上。
 *
 * @param story  清洗过的正文(用来判断"该有什么")
 * @param prompt 模型给的提示词
 * @param maxExtra 最多补几条;默认 12 —— 再多 CLIP 也吃不下,还会冲淡构图。
 * @returns 补完的提示词与本次补进去的 tag(方便 UI 提示,也方便测试)
 */
export function rewriteDegraded(story: string, prompt: string, maxExtra = 12): { prompt: string; added: string[] } {
  const base = String(prompt ?? '').trim();
  const source = String(story ?? '');
  if (!base || !source) return { prompt: base, added: [] };

  const limit = Math.max(0, Math.floor(maxExtra));
  // 已覆盖的 tag 合集:既有输出里本来就有的,也有本轮刚补的。
  // 用 Set 而不是每次拼字符串,后面规则判重时 O(1)。
  const covered = new Set(base.toLowerCase().split(',').map(t => t.trim()).filter(Boolean));
  const added: string[] = [];

  for (const rule of REWRITE_RULES) {
    if (added.length >= limit) break;
    if (!rule.pattern.test(source)) continue;
    for (const tag of rule.tags) {
      if (added.length >= limit) break;
      const key = tag.toLowerCase();
      if (covered.has(key)) continue;
      covered.add(key);
      added.push(tag);
    }
  }

  if (!added.length) return { prompt: base, added: [] };
  const merged = `${base}${base.endsWith(',') ? '' : ','} ${added.join(', ')}`;
  return { prompt: merged.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').trim(), added };
}

/**
 * 把权威声明压到 system 前面。
 *
 * 为什么不反过来(message 在前、声明在后)?
 * 因为模型对 system 段的开头权重更高,而且中转站端点普遍保留 system 的原始顺序;
 * 声明在前 = 模型读完正文时,判断框架已经被换掉了。
 */
export function injectPurge(system: string, purgeText: string): string {
  const declaration = String(purgeText ?? '').trim();
  if (!declaration) return system;
  return `${declaration}\n\n---\n\n${String(system ?? '').trim()}`;
}

/**
 * 组装一条带 prefill 的消息列表。
 *
 * 注意:assistant prefill 不是所有 OpenAI 兼容端点都接受。deepseek 官网接受
 * (它会把 prefill 当续写起点),部分第三方中转站会 400。client 里有降级重试,
 * 见 `compilePrompt` 的 `prefillFallback`。
 */
export function withPrefill(messages: Array<{ role: string; content: string }>, prefillText: string): Array<{ role: string; content: string }> {
  const text = String(prefillText ?? '').trim();
  if (!text) return messages;
  return [...messages, { role: 'assistant', content: text }];
}

/**
 * 去掉 prefill:客户端把 assistant 回显原样拼在解答前面时要用它削掉开头的 `POSITIVE:`。
 * 模型正常续写时 content 里不会有这个前缀,此函数就是幂等的。
 */
export function stripPrefill(content: string, prefillText: string): string {
  const text = String(content ?? '');
  const prefix = String(prefillText ?? '').trim();
  if (!prefix) return text;
  const trimmed = text.replace(/^\s+/, '');
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return text;
  return trimmed.slice(prefix.length).replace(/^\s*[:：]?\s*/, '');
}

/** 合并默认值与存档,形状以 default 为准(purge 是新字段,老存档里根本没有)。 */
export function mergePurge(defaults: PurgeSettings, raw: unknown): PurgeSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (key: keyof PurgeSettings) => (typeof r[key] === 'string' ? (r[key] as string) : (defaults[key] as string));
  const bool = (key: keyof PurgeSettings) => (typeof r[key] === 'boolean' ? (r[key] as boolean) : (defaults[key] as boolean));
  const num = (key: keyof PurgeSettings) =>
    typeof r[key] === 'number' && Number.isFinite(r[key]) ? (r[key] as number) : (defaults[key] as number);

  return {
    enabled: bool('enabled'),
    injectSystem: bool('injectSystem'),
    systemPrompt: str('systemPrompt'),
    prefill: bool('prefill'),
    prefillText: str('prefillText'),
    rewrite: bool('rewrite'),
    maxExtraTags: Math.max(0, Math.min(40, num('maxExtraTags'))),
  };
}
