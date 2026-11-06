/// <reference types="vite/client" />

declare const __HTJ_ZZ_VERSION__: string;

/** ST 全局提供的 jQuery。 */
declare const $: JQueryLike;

interface JQueryLike {
  (ready: () => void): void;
  (window: Window): { on(event: string, handler: () => void): void };
}
