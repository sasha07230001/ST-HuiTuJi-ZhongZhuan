/**
 * 设置存取:读写 ST 的 extension_settings(服务器端 settings.json)。
 * 整棵设置树做一次深合并,老版本存下来的残缺字段不会让新版本崩。
 */

import { getContext } from '@/st/context';
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Settings } from '@/types';

type AnyRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并:用 defaults 做形状基准,把 raw 里类型对的字段盖上去。 */
export function mergeSettings(defaults: unknown, raw: unknown): unknown {
  if (!isPlainObject(defaults)) {
    if (typeof defaults === 'string') return typeof raw === 'string' ? raw : defaults;
    if (typeof defaults === 'number') {
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : defaults;
    }
    if (typeof defaults === 'boolean') return typeof raw === 'boolean' ? raw : defaults;
    return defaults;
  }
  const out: AnyRecord = {};
  const source = isPlainObject(raw) ? raw : {};
  for (const [key, def] of Object.entries(defaults)) {
    if (!(key in source)) {
      out[key] = def;
      continue;
    }
    const value = source[key];
    if (isPlainObject(def)) {
      out[key] = mergeSettings(def, value);
    } else if (Array.isArray(def)) {
      // 数组默认值必须保持数组类型。默认非空(如角色库)时保留存档内容,
      // 默认为空(如 storyScope.tags)时同样接受存档数组——两种情况都不能
      // 把非数组的脏数据漏给下游,否则 .filter / .join 会炸。
      out[key] = Array.isArray(value) ? value : def;
    } else if (typeof def === 'string') {
      out[key] = typeof value === 'string' ? value : def;
    } else if (typeof def === 'number') {
      out[key] = typeof value === 'number' && Number.isFinite(value) ? value : def;
    } else if (typeof def === 'boolean') {
      out[key] = typeof value === 'boolean' ? value : def;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 当前生效的设置(每次调用都读 ST 的实时值,避免到处传引用)。 */
export function getSettings(): Settings {
  const ctx = getContext();
  const raw = ctx?.extensionSettings?.[SETTINGS_KEY];
  return mergeSettings(DEFAULT_SETTINGS, raw) as Settings;
}

/** 落盘。ST 的 saveSettingsDebounced 会防抖写服务器。 */
export function saveSettings(next: Settings): void {
  const ctx = getContext();
  if (!ctx) return;
  if (!ctx.extensionSettings) ctx.extensionSettings = {};
  ctx.extensionSettings[SETTINGS_KEY] = next;
  ctx.saveSettingsDebounced?.();
}

/** 「中转站 + ComfyUI + 提示词」三块都配齐了没有;缺什么以人话返回。 */
export function configProblems(s: Settings = getSettings()): string[] {
  const problems: string[] = [];
  if (!s.relay.url.trim()) problems.push('中转站地址未填');
  if (!s.relay.model.trim()) problems.push('中转站模型未填');
  if (!s.relay.key.trim()) problems.push('中转站 API Key 未填');
  if (!s.comfy.url.trim()) problems.push('ComfyUI 地址未填');
  if (!s.comfy.workflow.trim()) problems.push('ComfyUI 工作流未填');
  return problems;
}

export function isReady(s: Settings = getSettings()): boolean {
  return configProblems(s).length === 0;
}

/**
 * 换设备 / 浏览器不同源时,`extension_settings` 里**看不到**别处配过的 key。
 *
 * 自动插图以前是硬门槛 `isReady()`,于是手机上(或换了浏览器)明明勾了「自动插图」,
 * 却只弹一句「配置不齐」再也不动。这里多认一条**兜底**:中转站地址 + 模型 + 至少一个
 * 密钥来源(本项目 key,或设置里其它 OpenAI 兼容渠道的 key),就算「能用」——
 * 请求经 ST 服务端转发,服务端会用自己那份 key 去补。
 *
 * 注意:手动按钮永远不受这个门槛限制,点了就跑,错了给错误信息。
 */
export function isProbablyReady(): boolean {
  const s = getSettings();
  if (isReady(s)) return true;
  const hasRelay = !!s.relay.url.trim() && !!s.relay.model.trim();
  const hasComfy = !!s.comfy.url.trim() && !!s.comfy.workflow.trim();
  if (!hasRelay || !hasComfy) return false;
  if (s.relay.key.trim()) return true;
  // ST 自己的 settings 里任意一个 OpenAI 兼容渠道有 key,后端转发就能用上
  const serverKey = getServerFallbackKey();
  return !!serverKey;
}

/**
 * ST 可能把「自定义 OpenAI 兼容端点」存在其它几个键下(不同版本不同名)。
 * 这里按已知的几个键找一个非空字符串当兜底,找不到返回空串。只读,不写。
 */
export function getServerFallbackKey(): string {
  const ctx = getContext();
  const settings = ctx?.extensionSettings ?? {};
  const candidates: Array<[string, string]> = [
    ['openai', 'reverse_proxy_password'],
    ['openai', 'proxy_password'],
    ['custom', 'proxy_password'],
    ['custom', 'reverse_proxy_password'],
  ];
  for (const [group, field] of candidates) {
    const box = settings[group];
    if (!box || typeof box !== 'object') continue;
    const value = (box as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  // 最后再看一眼本扩展自己的 key(调用方已经判过一次,这里只是让函数自洽)
  const own = settings[SETTINGS_KEY];
  if (own && typeof own === 'object') {
    const relay = (own as Record<string, unknown>).relay;
    if (relay && typeof relay === 'object') {
      const key = (relay as Record<string, unknown>).key;
      if (typeof key === 'string' && key.trim()) return key.trim();
    }
  }
  return '';
}
