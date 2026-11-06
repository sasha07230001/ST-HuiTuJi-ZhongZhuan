import { describe, expect, it } from 'vitest';
import { mergeSettings } from '@/state/settings';
import { DEFAULT_SETTINGS } from '@/types';

describe('mergeSettings', () => {
  it('空值回落默认', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('部分字段保留,缺的补默认', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      autoRun: true,
      relay: { url: 'https://x.com', model: 'm' },
    }) as typeof DEFAULT_SETTINGS;
    expect(merged.autoRun).toBe(true);
    expect(merged.relay.url).toBe('https://x.com');
    expect(merged.relay.model).toBe('m');
    expect(merged.relay.temperature).toBe(DEFAULT_SETTINGS.relay.temperature);
    expect(merged.comfy.url).toBe(DEFAULT_SETTINGS.comfy.url);
  });

  it('类型不对的字段回默认', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      enabled: 'yes',
      relay: { timeoutSec: 'long' },
    }) as typeof DEFAULT_SETTINGS;
    expect(merged.enabled).toBe(true);
    expect(merged.relay.timeoutSec).toBe(DEFAULT_SETTINGS.relay.timeoutSec);
  });

  it('未知字段被丢弃', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { junk: 1 }) as Record<string, unknown>;
    expect('junk' in merged).toBe(false);
  });
});
