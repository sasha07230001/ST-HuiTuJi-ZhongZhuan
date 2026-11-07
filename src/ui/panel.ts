/**
 * 绘图姬·中转站面板。
 *
 * 从「悬浮球」或顶栏菜单打开。三个页签:
 *   - 出图:选楼层 / 手填正文 → 中转站编译 → 出图;实时显示编译进度与结果
 *   - 渠道:中转站与 ComfyUI 的连接配置
 *   - 提示词:编译用 system 提示词、恒定画风/负面词
 *
 * 复用 relay/orchestrator 的 runChain,与楼层卡片走同一条链,不重复实现。
 */

import { runWorkflow, testComfyConnection } from '@/comfy/api';
import { getPlaceholders, randomSeed, renderWorkflow } from '@/comfy/workflow';
import { fetchRelayModels, testRelayConnection } from '@/relay/client';
import { composeNegative, composePositive, normalizeRelayUrl } from '@/relay/prompt';
import { parseStoryScopeTagNames, type StoryScopePick } from '@/relay/storyScope';
import { runChain, storyForFloor, storyForRun } from '@/relay/orchestrator';
import { clampCount, MAX_SEGMENTS, normalizeMark, planSegments } from '@/relay/split';
import { getSettings, isReady, saveSettings } from '@/state/settings';
import { getContext, isAiStoryMessage } from '@/st/context';
import { BUILTIN_WORKFLOW, DEFAULT_SETTINGS } from '@/types';
import { autoIllustrateState } from '@/ui/autoIllustrate';
import { hydrateFloor, illustrateFloor, insertStoredImageIntoFloor, revealFloor } from '@/ui/card';
import { buildCharsPage } from '@/ui/charsPage';
import { deleteStoredImage, listStoredImages, storageHealth, type StoredImage } from '@/ui/galleryStore';
import { UI_CSS, applyConstantWordsToWorkflow, el, ensureStyle, toast } from '@/ui/dom';
import { hideOrbForPanel, resetOrbPosition, syncOrb } from '@/ui/orb';

const MASK_ID = 'htj-zz-panel-mask';
const TITLE = '绘图姬·中转站';
/** 刚打开面板的这段时间里,落在遮罩上的按下事件一律忽略。
 *  触摸设备在 pointerup 后会补发一套兼容鼠标事件,那一套正好砸在刚铺满屏幕的遮罩上,
 *  按原来的写法就是「点悬浮球 → 面板闪一下 → 立刻被自己关掉」。 */
const OPEN_GUARD_MS = 450;

type TabId = 'render' | 'gallery' | 'channel' | 'chars' | 'prompt';

let mask: HTMLDivElement | null = null;
let activeTab: TabId = 'render';
let openedAt = 0;
let running = false;
let abortController: AbortController | null = null;
/** 最近一次编译结果,供「编辑后重出」用。 */
let lastResult: { positive: string; negative: string; compiled: string; seed: number; imageUrl: string } | null = null;

export function isPanelOpen(): boolean {
  return !!mask && document.body.contains(mask);
}

/** 打开 / 关闭 / 切换。 */
export function togglePanel(tab: TabId = activeTab): void {
  if (isPanelOpen()) closePanel();
  else openPanel(tab);
}

export function openPanel(tab: TabId = 'render'): void {
  activeTab = tab;
  if (!mask) buildPanel();
  if (!mask) return;
  mask.style.display = '';
  document.body.append(mask);
  openedAt = Date.now();
  hideOrbForPanel(true);
  if (tab === 'render') refreshFloorSelect();
  if (tab === 'gallery') void refreshGalleryPage();
  if (tab === 'channel') refreshChannelForm();
  if (tab === 'prompt') refreshPromptForm();
  switchTab(tab);
}

export function closePanel(): void {
  abortController?.abort();
  abortController = null;
  running = false;
  mask?.remove();
  hideOrbForPanel(false);
}

/** 面板是否刚刚才被打开(这期间落下的关闭动作都按误触处理)。 */
function justOpened(): boolean {
  return Date.now() - openedAt < OPEN_GUARD_MS;
}

function switchTab(tab: TabId): void {
  activeTab = tab;
  mask?.querySelectorAll<HTMLElement>('.htj-zz-tab').forEach(node => {
    node.classList.toggle('is-active', node.dataset.tab === tab);
  });
  mask?.querySelectorAll<HTMLElement>('.htj-zz-page').forEach(node => {
    node.classList.toggle('htj-zz-hide', node.dataset.page !== tab);
  });
}

/* ---------------- 构建骨架 ---------------- */

let pageRender: HTMLDivElement;
let pageGallery: HTMLDivElement;
let pageChannel: HTMLDivElement;
let pageChars: HTMLDivElement;
let pagePrompt: HTMLDivElement;
let statusLine: HTMLElement;

function buildPanel(): void {
  ensureStyle('htj-zz-ui', UI_CSS);

  const closeBtn = el('button', { class: 'menu_button', type: 'button', text: '✕' });
  closeBtn.title = '关闭(Esc)';
  closeBtn.addEventListener('click', () => closePanel());

  const tabs = el('div', { class: 'htj-zz-tabs' });
  const tabDefs: Array<[TabId, string]> = [
    ['render', '出图'],
    ['gallery', '图库'],
    ['channel', '渠道'],
    ['chars', '角色档案'],
    ['prompt', '提示词'],
  ];
  for (const [id, label] of tabDefs) {
    const btn = el('button', { class: 'htj-zz-tab', type: 'button', text: label });
    btn.dataset.tab = id;
    btn.addEventListener('click', () => {
      switchTab(id);
      if (id === 'channel') refreshChannelForm();
      if (id === 'prompt') refreshPromptForm();
      if (id === 'render') refreshFloorSelect();
      if (id === 'chars') rebuildCharsPage();
      if (id === 'gallery') void refreshGalleryPage();
    });
    tabs.append(btn);
  }

  pageRender = el('div', { class: 'htj-zz-page' }) as HTMLDivElement;
  pageGallery = el('div', { class: 'htj-zz-page' }) as HTMLDivElement;
  pageChannel = el('div', { class: 'htj-zz-page' }) as HTMLDivElement;
  pageChars = el('div', { class: 'htj-zz-page' }) as HTMLDivElement;
  pagePrompt = el('div', { class: 'htj-zz-page' }) as HTMLDivElement;
  // data-page 是 switchTab 唯一的对号依据:漏掉它,page 全被判为「不是当前页」
  // 而一起藏起来,面板就成了空白(已实测踩到两次)。
  pageRender.dataset.page = 'render';
  pageGallery.dataset.page = 'gallery';
  pageChannel.dataset.page = 'channel';
  pageChars.dataset.page = 'chars';
  pagePrompt.dataset.page = 'prompt';

  statusLine = el('span', { class: 'htj-zz-panel-sub', text: '就绪' });

  const panel = el(
    'div',
    { class: 'htj-zz-panel', role: 'dialog', 'aria-label': TITLE },
    el(
      'div',
      { class: 'htj-zz-panel-head' },
      el('span', { class: 'htj-zz-panel-title', text: TITLE }),
      el('span', { class: 'htj-zz-panel-sub', text: '正文 → 中转站编译 → CLIP → ComfyUI' }),
      el('span', { class: 'htj-zz-panel-spacer' }),
      closeBtn,
    ),
    tabs,
    el('div', { class: 'htj-zz-panel-body' }, pageRender, pageGallery, pageChannel, pageChars, pagePrompt),
    el('div', { class: 'htj-zz-panel-foot' }, statusLine),
  );

  const overlay = el('div', { id: MASK_ID, class: 'htj-zz-panel-mask' }) as HTMLDivElement;
  overlay.append(panel);
  // 只在「真正按在遮罩空白处」时关闭:
  // - 用 pointerdown 而不是 mousedown:触摸设备补发的兼容 mousedown 不算;
  // - 刚打开的 450ms 内一律不理,挡住同一次点击的尾巴。
  overlay.addEventListener('pointerdown', event => {
    if (event.target !== overlay) return;
    if (justOpened()) return;
    event.preventDefault();
    closePanel();
  });
  overlay.addEventListener('mousedown', event => {
    if (event.target !== overlay) return;
    if (justOpened()) return;
    closePanel();
  });
  document.addEventListener('keydown', onKeyDown);

  buildRenderPage();
  buildGalleryPage();
  buildChannelPage();
  buildPromptPage();
  buildCharsPageInto();
  mask = overlay;
  // 关键:所有 page 初始都藏着,必须立刻把当前页签点亮,
  // 否则首次打开是一整片空白,要点一下页签才有内容。
  switchTab(activeTab);
}

/** 角色档案页:每次切过去重建,保证列表是库里最新的。 */
function buildCharsPageInto(): void {
  pageChars.replaceChildren(buildCharsPage(() => rebuildCharsPage()));
}

function rebuildCharsPage(): void {
  if (!pageChars) return;
  pageChars.replaceChildren(buildCharsPage(() => rebuildCharsPage()));
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isPanelOpen()) {
    event.stopPropagation();
    closePanel();
  }
}

function setStatus(text: string): void {
  if (statusLine) statusLine.textContent = text;
}

/* ---------------- 出图页 ---------------- */

let floorSelect: HTMLSelectElement;
let storyArea: HTMLTextAreaElement;
let canvas: HTMLDivElement;
let promptView: HTMLTextAreaElement;
let negativeView: HTMLTextAreaElement;
let runButton: HTMLButtonElement;
let cancelButton: HTMLButtonElement;
let countInput: HTMLInputElement;
let markInput: HTMLInputElement;
let previewBox: HTMLElement;
let constBar: HTMLElement;

function buildRenderPage(): void {
  floorSelect = el('select', { class: 'text_pole' }) as HTMLSelectElement;
  floorSelect.addEventListener('change', () => {
    const floor = Number(floorSelect.value);
    if (Number.isInteger(floor) && floor >= 0) {
      const picked = storyForFloor(floor);
      if (picked.ok) storyArea.value = picked.text;
      refreshSegmentPreview();
    }
  });

  storyArea = el('textarea', { class: 'text_pole htj-zz-textarea', rows: '6' }) as HTMLTextAreaElement;
  storyArea.placeholder = '粘贴任意剧情正文;留空则用上面选中的楼层。';
  storyArea.addEventListener('input', refreshSegmentPreview);

  countInput = el('input', { class: 'text_pole', type: 'number', min: '1', max: String(MAX_SEGMENTS), step: '1' }) as HTMLInputElement;
  countInput.addEventListener('change', () => {
    countInput.value = String(clampCount(countInput.value));
    const next = getSettings();
    next.prompt.maxImages = Number(countInput.value);
    saveSettings(next);
    refreshSegmentPreview();
  });

  markInput = el('input', { class: 'text_pole', type: 'text', placeholder: '[[图]]' }) as HTMLInputElement;
  markInput.addEventListener('change', () => {
    markInput.value = normalizeMark(markInput.value);
    const next = getSettings();
    next.prompt.segmentMark = markInput.value;
    saveSettings(next);
    refreshSegmentPreview();
  });

  previewBox = el('div', { class: 'htj-zz-segments' });

  // 恒定词横幅:让用户一眼看到「这次进 CLIP 的头两个词是什么」,
  // 不用来回翻设置页去确认保存成功没有。
  constBar = el('div', { class: 'htj-zz-constbar' });
  refreshConstBar();

  canvas = el('div', { class: 'htj-zz-canvas' }) as HTMLDivElement;
  renderCanvasEmpty();

  promptView = el('textarea', { class: 'text_pole', rows: '3' }) as HTMLTextAreaElement;
  promptView.placeholder = '正向提示词(可直接改,然后点「按此提示词出图」)';
  negativeView = el('textarea', { class: 'text_pole', rows: '2' }) as HTMLTextAreaElement;
  negativeView.placeholder = '负面提示词';

  runButton = el('button', { class: 'menu_button', type: 'button', text: '编译并预览' }) as HTMLButtonElement;
  runButton.addEventListener('click', () => void doRun());

  cancelButton = el('button', { class: 'menu_button', type: 'button', text: '取消' }) as HTMLButtonElement;
  cancelButton.disabled = true;
  cancelButton.addEventListener('click', () => {
    abortController?.abort();
  });

  /** 「按张数出图并插回正文」:正文 → N 段 → N 张图 → 各插回自己那段。 */
  const multiBtn = el('button', { class: 'menu_button', type: 'button', text: '按张数出图并插回正文' }) as HTMLButtonElement;
  multiBtn.title = '按「出几张」把正文切成 N 段,每段单独出图,出完插回那一段后面';
  multiBtn.addEventListener('click', () => void doMultiRun(multiBtn));

  const regenBtn = el('button', { class: 'menu_button', type: 'button', text: '按此提示词出图' }) as HTMLButtonElement;
  regenBtn.addEventListener('click', () => void doRenderWithPrompt());

  const copyBtn = el('button', { class: 'menu_button', type: 'button', text: '复制提示词' }) as HTMLButtonElement;
  copyBtn.addEventListener('click', () => {
    if (promptView.value.trim()) void navigator.clipboard?.writeText(promptView.value.trim());
    toast('已复制正向提示词', 'success');
  });

  const insertBtn = el('button', { class: 'menu_button', type: 'button', text: '插到楼层' }) as HTMLButtonElement;
  insertBtn.addEventListener('click', () => void doMultiRun(insertBtn));

  pageRender.append(
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '素材' }),
      constBar,
      el(
        'div',
        { class: 'htj-zz-row' },
        el('label', { class: 'htj-zz-field' }, el('span', { class: 'htj-zz-label', text: '楼层' }), floorSelect),
        el(
          'label',
          { class: 'htj-zz-field htj-zz-field-narrow' },
          el('span', { class: 'htj-zz-label', text: '出几张' }),
          countInput,
        ),
        el(
          'label',
          { class: 'htj-zz-field htj-zz-field-narrow' },
          el('span', { class: 'htj-zz-label', text: '分段标记' }),
          markInput,
        ),
      ),
      storyArea,
      el('small', {
        class: 'htj-zz-hint',
        text: '正文里写分段标记(默认 [[图]]),图就插回标记所在的段落;没有标记则按张数把正文均分。',
      }),
    ),
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '分段预览(图会插回这些位置)' }),
      previewBox,
    ),
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '画面' }),
      canvas,
      el('div', { class: 'htj-zz-btns' }, multiBtn, runButton, cancelButton),
      el('small', {
        class: 'htj-zz-hint',
        text: '「按张数出图并插回正文」= 按上面的张数把正文切成 N 段,每段单独编译、单独出图,出完插回那一段后面。',
      }),
    ),
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '提示词' }),
      el('div', { class: 'htj-zz-promptbox' },
        el('span', { class: 'htj-zz-label', text: '正向(恒定画风词已前置在最前)' }),
        promptView,
        el('span', { class: 'htj-zz-label', text: '负面(恒定负面词已前置在最前)' }),
        negativeView,
        el('div', { class: 'htj-zz-btns' }, regenBtn, copyBtn, insertBtn),
      ),
    ),
  );
}

/** 出图页顶部的恒定词横幅:当前生效的两串(前置)。 */
export function refreshConstBar(): void {
  if (!constBar) return;
  const s = getSettings();
  const style = (s.prompt.styleSuffix || '').trim();
  const neg = (s.prompt.negative || '').trim();
  const bound = autoIllustrateState();
  const words: Node[] = [
    el('div', {}, el('b', { text: '正向最前:' }), style || '(空 —— 去「提示词」页填恒定画风词)'),
    el('div', {}, el('b', { text: '负面最前:' }), neg || '(空)'),
    el('div', {
      class: 'htj-zz-hint',
      text: `自动插图:${s.autoRun ? '已开' : '未开'} · 事件${bound.bound ? '已绑定' : '未绑定'}` +
        (bound.lastError ? ` · 上次失败:${bound.lastError}` : ''),
    }),
  ];
  constBar.replaceChildren(...words);
}

/** 当前面板里这段正文会怎么切、每张图的锚点落在哪。 */
function refreshSegmentPreview(): void {
  if (!previewBox) return;
  const floor = Number(floorSelect?.value ?? '');
  const typed = storyArea?.value.trim() ?? '';
  let story = typed;
  if (!story && Number.isInteger(floor) && floor >= 0) {
    try {
      story = storyForRun(floor);
    } catch {
      story = '';
    }
  }
  if (!story) {
    previewBox.replaceChildren(el('small', { class: 'htj-zz-hint', text: '还没有正文。选一个楼层或粘一段。' }));
    return;
  }
  const count = clampCount(countInput?.value ?? getSettings().prompt.maxImages);
  const mark = normalizeMark(markInput?.value ?? getSettings().prompt.segmentMark);
  const segments = planSegments(story, { count, mark });
  const rows = segments.map(segment =>
    el(
      'div',
      { class: 'htj-zz-segment-row' },
      el('span', { class: 'htj-zz-badge', text: `第 ${segment.index + 1} 张` }),
      el('span', { class: 'htj-zz-segment-text', text: segment.text.replace(/\s+/g, ' ').slice(0, 90) }),
      el('span', { class: 'htj-zz-hint', text: `锚点:…${segment.anchor.slice(-16)}` }),
    ),
  );
  previewBox.replaceChildren(...rows);
}

function renderCanvasEmpty(): void {
  canvas.replaceChildren(
    el('div', {
      class: 'htj-zz-canvas-empty',
      text: '还没有图。\n选一个楼层或粘一段正文,点「编译并预览」。',
    }),
  );
}

function refreshFloorSelect(): void {
  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  const previous = floorSelect.value;
  const options: HTMLOptionElement[] = [el('option', { value: '', text: '— 手填正文 —' }) as HTMLOptionElement];
  for (let floor = 0; floor < chat.length; floor++) {
    const message = chat[floor];
    if (!isAiStoryMessage(message)) continue;
    const preview = String(message.mes ?? '').replace(/\s+/g, ' ').slice(0, 36);
    options.push(el('option', { value: String(floor), text: `#${floor} ${preview}` }) as HTMLOptionElement);
  }
  floorSelect.replaceChildren(...options);
  // 默认选最新一楼
  const last = options[options.length - 1];
  const target = previous && options.some(o => o.value === previous) ? previous : last?.value ?? '';
  floorSelect.value = target;
  if (target) {
    const picked = storyForFloor(Number(target));
    if (picked.ok) storyArea.value = picked.text;
  }
  const s = getSettings();
  countInput.value = String(clampCount(s.prompt.maxImages));
  markInput.value = normalizeMark(s.prompt.segmentMark);
  refreshSegmentPreview();
}

/**
 * 面板里手填的正文:只有和楼层原文不一样才当成「用户改过」交给链路。
 * 一样的话就不传,让 runChain 自己走剧情范围逻辑(否则会绕过范围标签)。
 */
function manualStory(floor: number): string | undefined {
  const typed = storyArea.value.trim();
  if (!typed) return undefined;
  if (Number.isInteger(floor) && floor >= 0) {
    try {
      if (storyForRun(floor) === typed) return undefined;
    } catch {
      /* 取不到楼层就按手填处理 */
    }
  }
  return typed;
}

/** 一次出 N 张,插回正文。 */
async function doMultiRun(button: HTMLButtonElement): Promise<void> {
  if (running) return;
  const settings = getSettings();
  if (!isReady(settings)) {
    toast('中转站或 ComfyUI 还没配齐,去「渠道」页填一下', 'warning');
    switchTab('channel');
    refreshChannelForm();
    return;
  }
  const floor = Number(floorSelect.value);
  const count = clampCount(countInput.value);
  running = true;
  runButton.disabled = true;
  button.disabled = true;
  cancelButton.disabled = false;
  setStatus(count > 1 ? `正在分段出图(共 ${count} 张)…` : '正在出图…');
  try {
    const result = await illustrateFloor(Number.isInteger(floor) && floor >= 0 ? floor : -1, {
      story: manualStory(floor),
      count,
      mark: normalizeMark(markInput.value),
    });
    if (result.images.length) {
      showImage(result.images[result.images.length - 1].image);
      promptView.value = result.images[result.images.length - 1].positive;
      negativeView.value = result.images[result.images.length - 1].negative;
      const done = `已出 ${result.images.length}/${result.segments.length} 张,已按锚点插回正文`;
      setStatus(done);
      toast(done, 'success');
      // 面板开着看不到正文,把楼层滚过去让用户直接确认插到哪了
      if (Number.isInteger(floor) && floor >= 0) revealFloor(floor);
      if (activeTab === 'gallery') void refreshGalleryPage();
    }
    if (result.errors.length) {
      setStatus(`部分失败:${result.errors[0]}`);
      toast(result.errors[0], 'error');
    }
  } catch (error) {
    setStatus('失败');
    toast(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    running = false;
    runButton.disabled = false;
    button.disabled = false;
    cancelButton.disabled = true;
  }
}

async function doRun(): Promise<void> {
  if (running) return;
  const settings = getSettings();
  if (!isReady(settings)) {
    toast('中转站或 ComfyUI 还没配齐,去「渠道」页填一下', 'warning');
    switchTab('channel');
    refreshChannelForm();
    return;
  }

  running = true;
  runButton.disabled = true;
  cancelButton.disabled = false;
  const floor = Number(floorSelect.value);
  const controller = new AbortController();
  abortController = controller;
  setStatus('正在编译…');

  try {
    const result = await runChain({
      floor: Number.isInteger(floor) && floor >= 0 ? floor : -1,
      story: manualStory(floor),
      signal: controller.signal,
      onStatus: text => setStatus(text),
    });
    lastResult = {
      positive: result.positive,
      negative: result.negative,
      compiled: result.compiled,
      seed: result.seed,
      imageUrl: result.image.url,
    };
    promptView.value = result.positive;
    negativeView.value = result.negative;
    showImage(result.image.url);
    setStatus(`完成 · seed ${result.seed}`);
  } catch (error) {
    const aborted = controller.signal.aborted;
    setStatus(aborted ? '已取消' : '失败');
    if (!aborted) {
      const message = error instanceof Error ? error.message : String(error);
      toast(message, 'error');
    }
  } finally {
    running = false;
    abortController = null;
    runButton.disabled = false;
    cancelButton.disabled = true;
  }
}

async function doRenderWithPrompt(): Promise<void> {
  const typedPositive = promptView.value.trim();
  if (!typedPositive) {
    toast('正向提示词是空的', 'warning');
    return;
  }
  if (running) return;
  running = true;
  runButton.disabled = true;
  setStatus('按手改的提示词出图…');
  try {
    const settings = getSettings();
    // 手改提示词也要把恒定词带上,而且是**前置**:CLIP 对最前面的 token 最敏感,
    // 工作流只吃前 75 个 token 时,画风词丢在末尾等于没写。
    const positive = composePositive(settings.prompt.styleSuffix, typedPositive);
    const negative = composeNegative(settings.prompt.negative, negativeView.value.trim());
    const seed = randomSeed();
    const workflow = renderWorkflow(settings.comfy.workflow, {
      prompt: positive,
      negative,
      seed,
    });
    const image = await runWorkflow(settings.comfy, workflow);
    lastResult = {
      positive,
      negative,
      compiled: lastResult?.compiled ?? '',
      seed,
      imageUrl: image.url,
    };
    promptView.value = positive;
    negativeView.value = negative;
    showImage(image.url);
    setStatus(`完成 · seed ${seed}`);
  } catch (error) {
    setStatus('失败');
    toast(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    running = false;
    runButton.disabled = false;
  }
}

function showImage(url: string): void {
  const img = el('img', { src: url, alt: '生成的图片' }) as HTMLImageElement;
  canvas.replaceChildren(img);
}

/* ---------------- 图库页 ---------------- */

let galleryBox: HTMLElement;
let galleryCount: HTMLElement;

function buildGalleryPage(): void {
  const refreshBtn = el('button', { class: 'menu_button', type: 'button', text: '刷新' }) as HTMLButtonElement;
  refreshBtn.addEventListener('click', () => void refreshGalleryPage());

  const fillBtn = el('button', { class: 'menu_button', type: 'button', text: '把最新一张填回出图页' }) as HTMLButtonElement;
  fillBtn.addEventListener('click', () => {
    if (!lastResult) {
      toast('还没有可复用的提示词', 'warning');
      return;
    }
    promptView.value = lastResult.positive;
    negativeView.value = lastResult.negative;
    showImage(lastResult.imageUrl);
    switchTab('render');
  });

  galleryCount = el('span', { class: 'htj-zz-hint', text: '' });
  galleryBox = el('div', { class: 'htj-zz-gallery' });

  pageGallery.append(
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '图库(当前聊天)' }),
      el('small', {
        class: 'htj-zz-hint',
        text: '出过的图存在浏览器 IndexedDB 里,刷新/重开酒馆都还在;楼层被 ST 重渲染时按锚点自动挂回正文对应位置。',
      }),
      el('div', { class: 'htj-zz-btns' }, refreshBtn, fillBtn, galleryCount),
      galleryBox,
    ),
  );
}

function galleryCard(item: StoredImage): HTMLElement {
  const img = el('img', { src: item.image, alt: `#${item.floor} 的插图`, loading: 'lazy' }) as HTMLImageElement;
  const total = item.total && item.total > 0 ? item.total : 1;

  /**
   * 「插回正文」:先拿**这一张的提示词**去正文里找它对应的那段剧情,
   * 再把图按锚点插回那段之后。
   *
   * 两个阶段:
   *  1. 楼层 DOM 会在(用户可能滚到别处了):直接把图挂回去,再滚过去;
   *  2. 楼层 DOM 不在(ST 做了虚拟滚动 / 用户还没翻到):先把这一楼的 DOM 拉出来
   *     (hydrateFloor 会触发渲染器按 chat 数据重建),再挂。
   *     实在拉不出来就把提示词塞回出图页,让用户点一次「按此提示词出图」。
   */
  const open = el('button', { class: 'menu_button', type: 'button', text: '插回正文' }) as HTMLButtonElement;
  open.title = '按这张图的锚点插回它所在的那段剧情后面,并滚到那一楼';
  open.addEventListener('click', async () => {
    open.disabled = true;
    try {
      const ok = await insertStoredImageIntoFloor(item);
      if (ok) {
        revealFloor(item.floor);
        toast(`已把第 ${item.floor} 楼第 ${item.index + 1}/${total} 张挂回它对应的那段剧情`, 'success');
        return;
      }
      promptView.value = item.positive;
      negativeView.value = item.negative;
      switchTab('render');
      toast(`第 ${item.floor} 楼的楼层还没渲染出来,提示词已填进出图页,点「按此提示词出图」即可`, 'warning');
    } finally {
      open.disabled = false;
    }
  });

  const use = el('button', { class: 'menu_button', type: 'button', text: '用这串提示词' }) as HTMLButtonElement;
  use.addEventListener('click', () => {
    promptView.value = item.positive;
    negativeView.value = item.negative;
    switchTab('render');
    toast('已填入出图页', 'success');
  });

  const del = el('button', { class: 'menu_button', type: 'button', text: '删除' }) as HTMLButtonElement;
  del.addEventListener('click', async () => {
    await deleteStoredImage(item.id);
    document.querySelectorAll<HTMLElement>(`.htj-zz-inline-image[data-htj-image-id="${item.id}"]`).forEach(n => n.remove());
    await refreshGalleryPage();
  });

  const when = new Date(item.createdAt);
  const meta = el('span', {
    class: 'htj-zz-hint',
    text: `#${item.floor} · 第 ${item.index + 1}/${total} 张 · seed ${item.seed} · ${when.toLocaleString()}`,
  });
  const promptHint = el('span', {
    class: 'htj-zz-hint htj-zz-gallery-prompt',
    text: (item.positive || '').replace(/\s+/g, ' ').slice(0, 140),
  });

  return el(
    'div',
    { class: 'htj-zz-gallery-card' },
    el('a', { href: item.image, target: '_blank', rel: 'noopener', class: 'htj-zz-gallery-thumb' }, img),
    el('div', { class: 'htj-zz-gallery-body' }, meta, promptHint, el('div', { class: 'htj-zz-btns' }, open, use, del)),
  );
}

async function refreshGalleryPage(): Promise<void> {
  if (!galleryBox) return;
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  const items = await listStoredImages(chatId);
  if (galleryCount) galleryCount.textContent = `共 ${items.length} 张`;

  // 落盘不可用要说出来。这就是「刷新后图直接丢了」在 iOS 无痕模式下的真面目:
  // IndexedDB 打不开,旧实现静默退到内存 Map,用户看到的一直是「刚刚明明还在」。
  const health = await storageHealth();
  if (!health.ok) {
    galleryBox.replaceChildren(
      el('div', {
        class: 'htj-zz-warn',
        text:
          `⚠ 浏览器不让本页写 IndexedDB:${health.message} ` +
          '这些图只存在内存里,刷新就会消失。换成普通(非无痕)模式 / 允许本站存储后重新出图即可持久保留。',
      }),
      ...(items.length ? [...items].reverse().map(galleryCard) : []),
    );
    return;
  }

  if (!items.length) {
    galleryBox.replaceChildren(
      el('div', { class: 'htj-zz-canvas-empty', text: '这个聊天还没有存下来的图。' }),
    );
    return;
  }
  galleryBox.replaceChildren(...[...items].reverse().map(galleryCard));
}

/* ---------------- 渠道页 ---------------- */

let chUrl: HTMLInputElement;
let chKey: HTMLInputElement;
let chModel: HTMLInputElement;
let chTemp: HTMLInputElement;
let chTokens: HTMLInputElement;
let chTimeout: HTMLInputElement;
let modelSelect: HTMLSelectElement;
let comfyUrl: HTMLInputElement;
let workflowArea: HTMLTextAreaElement;
let allowProxy: HTMLInputElement;
let workflowInfo: HTMLElement;

function textField(label: string, placeholder = '', type = 'text'): [HTMLElement, HTMLInputElement] {
  const input = el('input', { class: 'text_pole', type, placeholder }) as HTMLInputElement;
  return [el('label', { class: 'htj-zz-field' }, el('span', { class: 'htj-zz-label', text: label }), input), input];
}

function buildChannelPage(): void {
  const [urlWrap, url] = textField('API 地址', 'https://api.deepseek.com');
  const [keyWrap, key] = textField('API Key', 'sk-...', 'password');
  const [modelWrap, model] = textField('模型', 'deepseek-chat');
  const [tempWrap, temp] = textField('温度', '0.8', 'number');
  const [tokensWrap, tokens] = textField('最大 token', '400', 'number');
  const [timeoutWrap, timeout] = textField('超时(秒)', '120', 'number');
  chUrl = url;
  chKey = key;
  chModel = model;
  chTemp = temp;
  chTokens = tokens;
  chTimeout = timeout;

  modelSelect = el('select', { class: 'text_pole htj-zz-hide' }) as HTMLSelectElement;
  modelSelect.addEventListener('change', () => {
    if (!modelSelect.value) return;
    chModel.value = modelSelect.value;
    applyChannel();
  });

  const testBtn = el('button', { class: 'menu_button', type: 'button', text: '测试中转站' }) as HTMLButtonElement;
  testBtn.addEventListener('click', async () => {
    applyChannel();
    const s = getSettings();
    testBtn.disabled = true;
    testBtn.textContent = '测试中…';
    const result = await testRelayConnection({ ...s.relay, url: normalizeRelayUrl(s.relay.url) });
    toast(result.message, result.ok ? 'success' : 'error');
    setStatus(result.message);
    testBtn.disabled = false;
    testBtn.textContent = '测试中转站';
  });

  const modelsBtn = el('button', { class: 'menu_button', type: 'button', text: '拉模型列表' }) as HTMLButtonElement;
  modelsBtn.addEventListener('click', async () => {
    applyChannel();
    const s = getSettings();
    modelsBtn.disabled = true;
    try {
      const list = await fetchRelayModels(s.relay);
      modelSelect.replaceChildren(
        el('option', { value: '', text: `— 共 ${list.length} 个 —` }) as HTMLOptionElement,
        ...list.map(m => el('option', { value: m, text: m }) as HTMLOptionElement),
      );
      modelSelect.classList.toggle('htj-zz-hide', list.length === 0);
      toast(list.length ? `拉到 ${list.length} 个模型` : '没有返回模型列表', list.length ? 'success' : 'warning');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      modelsBtn.disabled = false;
    }
  });

  const [comfyWrap, cUrl] = textField('服务地址', 'http://127.0.0.1:8188');
  comfyUrl = cUrl;
  comfyUrl.addEventListener('input', applyChannel);
  comfyUrl.addEventListener('change', applyChannel);

  workflowArea = el('textarea', { class: 'text_pole htj-zz-textarea', rows: '8' }) as HTMLTextAreaElement;
  workflowArea.addEventListener('input', () => {
    applyChannel();
    updateWorkflowInfo();
  });

  workflowInfo = el('small', { class: 'htj-zz-hint' });

  allowProxy = el('input', { type: 'checkbox' }) as HTMLInputElement;
  allowProxy.addEventListener('change', applyChannel);

  const testComfy = el('button', { class: 'menu_button', type: 'button', text: '测试 ComfyUI' }) as HTMLButtonElement;
  testComfy.addEventListener('click', async () => {
    applyChannel();
    const result = await testComfyConnection(getSettings().comfy);
    toast(result.message, result.ok ? 'success' : 'error');
    setStatus(result.message);
  });

  const loadBuiltin = el('button', { class: 'menu_button', type: 'button', text: '载入内置工作流' }) as HTMLButtonElement;
  loadBuiltin.addEventListener('click', () => {
    workflowArea.value = BUILTIN_WORKFLOW;
    applyChannel();
    updateWorkflowInfo();
    toast('已载入内置工作流,记得换成本地模型名', 'success');
  });

  for (const input of [url, key, model, temp, tokens, timeout]) {
    input.addEventListener('input', applyChannel);
    input.addEventListener('change', applyChannel);
  }

  pageChannel.append(
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '中转站(OpenAI 兼容)' }),
      urlWrap,
      el('small', { class: 'htj-zz-hint', text: '填到域名会自动补 /v1;也可填完整的 …/v1。请求经 SillyTavern 服务端转发。' }),
      keyWrap,
      modelWrap,
      el('div', { class: 'htj-zz-row' }, modelSelect),
      el('div', { class: 'htj-zz-btns' }, testBtn, modelsBtn),
      el('div', { class: 'htj-zz-row' }, tempWrap, tokensWrap, timeoutWrap),
    ),
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: 'ComfyUI' }),
      comfyWrap,
      el('label', { class: 'htj-zz-field' },
        el('span', { class: 'htj-zz-label', text: '工作流 JSON(Save API Format)' }),
        workflowArea,
      ),
      workflowInfo,
      el('div', { class: 'htj-zz-btns' }, loadBuiltin, testComfy),
      el('label', { class: 'checkbox_label' }, allowProxy, el('span', { text: '直连失败时经 ST 后端转发(需另装后端插件)' })),
    ),
  );
}

function refreshChannelForm(): void {
  const s = getSettings();
  chUrl.value = s.relay.url;
  chKey.value = s.relay.key;
  chModel.value = s.relay.model;
  chTemp.value = String(s.relay.temperature);
  chTokens.value = String(s.relay.maxTokens);
  chTimeout.value = String(s.relay.timeoutSec);
  comfyUrl.value = s.comfy.url;
  workflowArea.value = s.comfy.workflow;
  allowProxy.checked = s.comfy.allowServerProxy;
  updateWorkflowInfo();
}

function applyChannel(): void {
  const next = getSettings();
  next.relay.url = chUrl.value;
  next.relay.key = chKey.value;
  next.relay.model = chModel.value;
  next.relay.temperature = Number(chTemp.value) || DEFAULT_SETTINGS.relay.temperature;
  next.relay.maxTokens = Math.max(64, Number(chTokens.value) || DEFAULT_SETTINGS.relay.maxTokens);
  next.relay.timeoutSec = Math.max(5, Number(chTimeout.value) || DEFAULT_SETTINGS.relay.timeoutSec);
  next.comfy.url = comfyUrl.value;
  next.comfy.workflow = workflowArea.value;
  next.comfy.allowServerProxy = allowProxy.checked;
  saveSettings(next);
}

function updateWorkflowInfo(): void {
  const text = workflowArea.value.trim();
  if (!text) {
    workflowInfo.textContent = '还没填工作流。可以点「载入内置工作流」先用一份实测可跑的。';
    return;
  }
  try {
    const found = getPlaceholders(text);
    workflowInfo.textContent = found.length
      ? `占位符:${found.map(x => `%${x}%`).join(' ')}`
      : '没有 %prompt% —— 出图时会自动找 CLIPTextEncode 节点改写。';
  } catch (error) {
    workflowInfo.textContent = error instanceof Error ? error.message : String(error);
  }
}

/* ---------------- 提示词页 ---------------- */

let systemArea: HTMLTextAreaElement;
let styleInput: HTMLInputElement;
let negativeInput: HTMLInputElement;
let wantNegativeBox: HTMLInputElement;
let retryInput: HTMLInputElement;
let autoRunBox: HTMLInputElement;
let scopeTagsInput: HTMLInputElement;
let scopePickSelect: HTMLSelectElement;
let orbShowBox: HTMLInputElement;
let orbSizeInput: HTMLInputElement;
let orbOpacityInput: HTMLInputElement;
let promptPreview: HTMLElement;

function buildPromptPage(): void {
  systemArea = el('textarea', { class: 'text_pole htj-zz-textarea', rows: '12' }) as HTMLTextAreaElement;
  systemArea.addEventListener('input', applyPrompt);

  /* 恒定画风词 / 恒定负面词:改成「改完点保存」。
   *
   * 为什么不做成边打边存:这两个串是**所有**出图的头部,
   * 敲一半的字会立刻跟着下一张图进 CLIP(比如把 "cinematic lighting" 删到 "cinema"),
   * 用户看到的是一张风格突然跑掉的图,却不知道是自己上一步的输入造成的。 */
  styleInput = el('input', {
    class: 'text_pole',
    type: 'text',
    value: getSettings().prompt.styleSuffix,
    placeholder: 'masterpiece, best quality, ...',
  }) as HTMLInputElement;
  negativeInput = el('input', {
    class: 'text_pole',
    type: 'text',
    value: getSettings().prompt.negative,
    placeholder: 'lowres, bad anatomy, ...',
  }) as HTMLInputElement;

  const saveStyleBtn = el('button', { class: 'menu_button', type: 'button', text: '保存恒定画风词' }) as HTMLButtonElement;
  saveStyleBtn.addEventListener('click', () => {
    const next = getSettings();
    next.prompt.styleSuffix = styleInput.value.trim();
    saveSettings(next);
    toast('恒定画风词已保存(下次出图起生效,前置在正向最前面)', 'success');
    refreshPromptPreview();
    refreshConstBar();
  });

  const saveNegBtn = el('button', { class: 'menu_button', type: 'button', text: '保存恒定负面词' }) as HTMLButtonElement;
  saveNegBtn.addEventListener('click', () => {
    const next = getSettings();
    next.prompt.negative = negativeInput.value.trim();
    saveSettings(next);
    toast('恒定负面词已保存(前置在负面最前面)', 'success');
    refreshPromptPreview();
    refreshConstBar();
  });

  /**
   * 同步到 ComfyUI:把这两串**直接写进工作流模板**。
   *
   * 运行时本来就会在送 CLIP 前把它们拼到最前面,但用户在 ComfyUI 原生界面
   * 看到的仍是自己那份 JSON,以为「没生效」。这个按钮把模板里的 CLIP 文本改成
   * `画风词, %prompt%` / `负面词, %negative_prompt%`,两边就是同一份。
   */
  const syncComfyBtn = el('button', { class: 'menu_button', type: 'button', text: '同步恒定词到 ComfyUI 工作流' }) as HTMLButtonElement;
  syncComfyBtn.addEventListener('click', () => {
    const s = getSettings();
    const style = styleInput.value.trim() || s.prompt.styleSuffix.trim();
    const neg = negativeInput.value.trim() || s.prompt.negative.trim();
    const result = applyConstantWordsToWorkflow(s.comfy.workflow, style, neg);
    if (!result.ok) {
      toast(result.message, 'error');
      return;
    }
    if (result.changed) {
      const next = getSettings();
      next.prompt.styleSuffix = style;
      next.prompt.negative = neg;
      next.comfy.workflow = result.template;
      saveSettings(next);
      if (workflowArea) workflowArea.value = result.template;
      if (comfyUrl) updateWorkflowInfo();
      toast('已把恒定词前置写进 ComfyUI 工作流(正向 %prompt% / 负面 %negative_prompt%)', 'success');
    } else {
      toast(result.message, 'info');
    }
    refreshPromptPreview();
    refreshConstBar();
  });

  for (const input of [styleInput, negativeInput]) {
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      (input === styleInput ? saveStyleBtn : saveNegBtn).click();
    });
    // 只刷新「有没有未保存改动」的提示,不写设置
    input.addEventListener('input', refreshPromptPreview);
  }

  promptPreview = el('div', { class: 'htj-zz-hint htj-zz-prompt-preview' });

  wantNegativeBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  wantNegativeBox.addEventListener('change', applyPrompt);

  const [retryWrap, retry] = textField('失败重试次数', '1', 'number');
  retryInput = retry;
  retry.addEventListener('change', applyPrompt);

  autoRunBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  autoRunBox.addEventListener('change', () => {
    const next = getSettings();
    next.autoRun = autoRunBox.checked;
    saveSettings(next);
  });

  // 剧情范围
  scopeTagsInput = el('input', {
    class: 'text_pole',
    type: 'text',
    placeholder: 'content, story, 正文',
  }) as HTMLInputElement;
  scopeTagsInput.addEventListener('change', () => {
    const next = getSettings();
    next.storyScope.tags = parseStoryScopeTagNames(scopeTagsInput.value);
    // 回写规范化后的写法,让用户看到实际生效的标签名
    scopeTagsInput.value = next.storyScope.tags.join(', ');
    saveSettings(next);
  });

  scopePickSelect = el('select', { class: 'text_pole' }) as HTMLSelectElement;
  scopePickSelect.replaceChildren(
    el('option', { value: 'last', text: 'last — 最后一个块(推荐)' }) as HTMLOptionElement,
    el('option', { value: 'first', text: 'first — 第一个块' }) as HTMLOptionElement,
    el('option', { value: 'all', text: 'all — 所有块拼接' }) as HTMLOptionElement,
  );
  scopePickSelect.addEventListener('change', () => {
    const next = getSettings();
    next.storyScope.pick = scopePickSelect.value as StoryScopePick;
    saveSettings(next);
  });

  orbShowBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  orbShowBox.addEventListener('change', () => {
    const next = getSettings();
    next.orb.show = orbShowBox.checked;
    saveSettings(next);
    syncOrb();
  });

  const [sizeWrap, size] = textField('悬浮球大小(px)', '48', 'number');
  orbSizeInput = size;
  size.addEventListener('change', () => {
    const next = getSettings();
    next.orb.size = Math.max(28, Math.min(96, Number(size.value) || 48));
    saveSettings(next);
    syncOrb();
  });

  const [opacityWrap, op] = textField('悬浮球不透明度(0.2~1)', '0.62', 'number');
  op.step = '0.05';
  orbOpacityInput = op;
  op.addEventListener('change', () => {
    const next = getSettings();
    next.orb.opacity = Math.min(1, Math.max(0.2, Number(op.value) || 0.62));
    saveSettings(next);
    syncOrb();
  });

  const resetOrbBtn = el('button', { class: 'menu_button', type: 'button', text: '悬浮球回到默认位置' }) as HTMLButtonElement;
  resetOrbBtn.addEventListener('click', () => {
    resetOrbPosition();
    toast('悬浮球已回到默认位置', 'success');
  });

  const resetPromptBtn = el('button', { class: 'menu_button', type: 'button', text: '恢复默认编译提示词 / 恒定词' }) as HTMLButtonElement;
  resetPromptBtn.addEventListener('click', () => {
    systemArea.value = DEFAULT_SETTINGS.prompt.system;
    styleInput.value = DEFAULT_SETTINGS.prompt.styleSuffix;
    negativeInput.value = DEFAULT_SETTINGS.prompt.negative;
    const next = getSettings();
    next.prompt.styleSuffix = DEFAULT_SETTINGS.prompt.styleSuffix;
    next.prompt.negative = DEFAULT_SETTINGS.prompt.negative;
    saveSettings(next);
    applyPrompt();
    refreshPromptPreview();
    toast('已恢复默认(编译提示词 + 恒定画风词 + 恒定负面词)', 'success');
  });

  pagePrompt.append(
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '编译提示词' }),
      el('small', { class: 'htj-zz-hint', text: '占位符:{{story}} 剧情正文、{{note}} 额外任务提示。' }),
      systemArea,
      el('h4', { class: 'htj-zz-subhead', text: '恒定画风词 / 恒定负面词' }),
      el('small', {
        class: 'htj-zz-hint',
        text: '这两串会在每次出图时**前置**到 ComfyUI 的正/负 CLIP 文本最前面(CLIP 对开头的 token 最敏感,工作流只吃前 75 个 token 时末尾等于没写)。填完点保存。',
      }),
      el(
        'label',
        { class: 'htj-zz-field' },
        el('span', { class: 'htj-zz-label', text: '恒定画风词(正向前置)' }),
        styleInput,
      ),
      el('div', { class: 'htj-zz-btns' }, saveStyleBtn),
      el(
        'label',
        { class: 'htj-zz-field' },
        el('span', { class: 'htj-zz-label', text: '恒定负面词(负面前置)' }),
        negativeInput,
      ),
      el('div', { class: 'htj-zz-btns' }, saveNegBtn),
      el('div', { class: 'htj-zz-btns' }, syncComfyBtn),
      el('small', {
        class: 'htj-zz-hint',
        text: '「同步恒定词到 ComfyUI 工作流」会直接改「渠道」页那份工作流 JSON,把两串写到 %prompt% / %negative_prompt% 的最前面;不改这个,运行时也照样前置,但 ComfyUI 原生界面里看不到。',
      }),
      promptPreview,
      el('label', { class: 'checkbox_label' }, wantNegativeBox, el('span', { text: '让模型额外输出负面词' })),
      retryWrap,
      el('div', { class: 'htj-zz-btns' }, resetPromptBtn),
    ),
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '剧情范围' }),
      el('small', {
        class: 'htj-zz-hint',
        text: '只把圈定标签包住的正文当剧情;留空 = 整楼都算。取不到成对标签时自动回退整楼。',
      }),
      el('label', { class: 'htj-zz-field' },
        el('span', { class: 'htj-zz-label', text: '范围标签' }),
        scopeTagsInput,
      ),
      el('small', { class: 'htj-zz-hint', text: '多个标签用逗号分隔,可粘 <content>、content_fox 这类写法。' }),
      el('div', { class: 'htj-zz-row' },
        el('label', { class: 'htj-zz-field' },
          el('span', { class: 'htj-zz-label', text: '同名块取哪个' }),
          scopePickSelect,
        ),
      ),
    ),
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '行为' }),
      el('label', { class: 'checkbox_label' }, autoRunBox, el('span', { text: '每生成一楼自动插图' })),
      el('small', {
        class: 'htj-zz-hint',
        text: 'AI 回复完自动取正文走「中转站 → CLIP → 出图」,图按分段锚点插回正文;每楼只自动跑一次。张数与分段标记在「出图」页设置。',
      }),
      el('label', { class: 'checkbox_label' }, orbShowBox, el('span', { text: '显示悬浮球' })),
      el('div', { class: 'htj-zz-row' }, sizeWrap, opacityWrap),
      el('div', { class: 'htj-zz-btns' }, resetOrbBtn),
      el('small', { class: 'htj-zz-hint', text: '悬浮球:拖动可移动,靠近左右边缘会吸附;双击回到默认位置。' }),
    ),
  );
}

function refreshPromptForm(): void {
  const s = getSettings();
  systemArea.value = s.prompt.system;
  styleInput.value = s.prompt.styleSuffix;
  negativeInput.value = s.prompt.negative;
  wantNegativeBox.checked = s.prompt.wantNegative;
  retryInput.value = String(s.prompt.retryCount);
  autoRunBox.checked = s.autoRun;
  scopeTagsInput.value = (s.storyScope?.tags ?? []).join(', ');
  scopePickSelect.value = s.storyScope?.pick ?? 'last';
  orbShowBox.checked = s.orb.show;
  orbSizeInput.value = String(s.orb.size);
  orbOpacityInput.value = String(s.orb.opacity);
  refreshPromptPreview();
}

/** 让人一眼看到「最终进 CLIP 的那串长什么样」,恒定词在最前面。 */
function refreshPromptPreview(): void {
  if (!promptPreview) return;
  const s = getSettings();
  const sample = '1girl, silver hair, standing in the rain, neon light';
  const positive = composePositive(s.prompt.styleSuffix, sample);
  const negative = composeNegative(s.prompt.negative, '');
  // 顺手把「未保存的编辑」也标出来:输入框里的内容和已保存的不一样时提示一句
  const dirty: string[] = [];
  if (styleInput && styleInput.value.trim() !== s.prompt.styleSuffix.trim()) dirty.push('画风词');
  if (negativeInput && negativeInput.value.trim() !== s.prompt.negative.trim()) dirty.push('负面词');
  promptPreview.replaceChildren(
    el('div', { text: `最终正向示例:${positive}` }),
    el('div', { text: `最终负面示例:${negative || '(空)'}` }),
    el('div', {
      class: 'htj-zz-hint',
      text: dirty.length
        ? `⚠ ${dirty.join(' / ')} 有改动还没保存,现在的出图仍用旧值 —— 点上面的「保存」按钮`
        : '已保存值与生效值一致',
    }),
  );
}

function applyPrompt(): void {
  const next = getSettings();
  next.prompt.system = systemArea.value;
  next.prompt.wantNegative = wantNegativeBox.checked;
  next.prompt.retryCount = Math.max(0, Number(retryInput.value) || 0);
  saveSettings(next);
}

/* ---------------- 给其它模块的入口 ---------------- */

/** 打开面板并直接显示一张图(楼层卡片「在面板中打开」用)。 */
export function openPanelWithImage(url: string, positive = '', negative = ''): void {
  openPanel('render');
  showImage(url);
  if (positive) promptView.value = positive;
  if (negative) negativeView.value = negative;
}

/** 面板正在出图时把球上的状态点变黄。 */
export function panelBusy(): boolean {
  return running;
}

/** 自动插图跑完之后,面板开着就顺手刷新一下(图和提示词都是新的)。 */
export function noteAutoRunDone(info: { floor: number; images: number; errors: string[] }): void {
  if (!isPanelOpen()) return;
  if (info.images > 0) setStatus(`自动插图完成 · #${info.floor} 出了 ${info.images} 张`);
  else if (info.errors.length) setStatus(`自动插图失败:${info.errors[0]}`);
  if (activeTab === 'gallery') void refreshGalleryPage();
}
