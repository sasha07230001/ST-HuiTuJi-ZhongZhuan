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
