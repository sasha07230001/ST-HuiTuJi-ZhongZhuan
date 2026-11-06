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
import { normalizeRelayUrl } from '@/relay/prompt';
import { runChain, storyForFloor } from '@/relay/orchestrator';
import { getSettings, isReady, saveSettings } from '@/state/settings';
import { getContext, isAiStoryMessage } from '@/st/context';
import { BUILTIN_WORKFLOW, DEFAULT_SETTINGS } from '@/types';
import { generateIntoFloor } from '@/ui/card';
import { UI_CSS, el, ensureStyle, toast } from '@/ui/dom';
import { hideOrbForPanel, resetOrbPosition, syncOrb } from '@/ui/orb';

const MASK_ID = 'htj-zz-panel-mask';
const TITLE = '绘图姬·中转站';

type TabId = 'render' | 'channel' | 'prompt';

let mask: HTMLDivElement | null = null;
let activeTab: TabId = 'render';
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
  hideOrbForPanel(true);
  if (tab === 'render') refreshFloorSelect();
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
let pageChannel: HTMLDivElement;
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
    ['channel', '渠道'],
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
    });
    tabs.append(btn);
  }

  pageRender = el('div', { class: 'htj-zz-page' }) as HTMLDivElement;
  pageChannel = el('div', { class: 'htj-zz-page' }) as HTMLDivElement;
  pagePrompt = el('div', { class: 'htj-zz-page' }) as HTMLDivElement;

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
    el('div', { class: 'htj-zz-panel-body' }, pageRender, pageChannel, pagePrompt),
    el('div', { class: 'htj-zz-panel-foot' }, statusLine),
  );

  const overlay = el('div', { id: MASK_ID, class: 'htj-zz-panel-mask' }) as HTMLDivElement;
  overlay.append(panel);
  overlay.addEventListener('mousedown', event => {
    if (event.target === overlay) closePanel();
  });
  document.addEventListener('keydown', onKeyDown);

  buildRenderPage();
  buildChannelPage();
  buildPromptPage();
  mask = overlay;
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

function buildRenderPage(): void {
  floorSelect = el('select', { class: 'text_pole' }) as HTMLSelectElement;
  floorSelect.addEventListener('change', () => {
    const floor = Number(floorSelect.value);
    if (Number.isInteger(floor) && floor >= 0) {
      const picked = storyForFloor(floor);
      if (picked.ok) storyArea.value = picked.text;
    }
  });

  storyArea = el('textarea', { class: 'text_pole htj-zz-textarea', rows: '6' }) as HTMLTextAreaElement;
  storyArea.placeholder = '粘贴任意剧情正文;留空则用上面选中的楼层。';

  canvas = el('div', { class: 'htj-zz-canvas' }) as HTMLDivElement;
  renderCanvasEmpty();

  promptView = el('textarea', { class: 'text_pole', rows: '3' }) as HTMLTextAreaElement;
  promptView.placeholder = '正向提示词(可直接改,然后点「按此提示词出图」)';
  negativeView = el('textarea', { class: 'text_pole', rows: '2' }) as HTMLTextAreaElement;
  negativeView.placeholder = '负面提示词';

  runButton = el('button', { class: 'menu_button', type: 'button', text: '编译并出图' }) as HTMLButtonElement;
  runButton.addEventListener('click', () => void doRun());

  cancelButton = el('button', { class: 'menu_button', type: 'button', text: '取消' }) as HTMLButtonElement;
  cancelButton.disabled = true;
  cancelButton.addEventListener('click', () => {
    abortController?.abort();
  });

  const regenBtn = el('button', { class: 'menu_button', type: 'button', text: '按此提示词出图' }) as HTMLButtonElement;
  regenBtn.addEventListener('click', () => void doRenderWithPrompt());

  const copyBtn = el('button', { class: 'menu_button', type: 'button', text: '复制提示词' }) as HTMLButtonElement;
  copyBtn.addEventListener('click', () => {
    if (promptView.value.trim()) void navigator.clipboard?.writeText(promptView.value.trim());
    toast('已复制正向提示词', 'success');
  });

  const insertBtn = el('button', { class: 'menu_button', type: 'button', text: '插到楼层' }) as HTMLButtonElement;
  insertBtn.addEventListener('click', () => {
    const floor = Number(floorSelect.value);
    if (!Number.isInteger(floor) || floor < 0) {
      toast('先选一个楼层', 'warning');
      return;
    }
    void generateIntoFloor(floor);
    toast(`已把第 ${floor} 楼交给楼层卡片出图`, 'info');
  });

  pageRender.append(
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '素材' }),
      el(
        'div',
        { class: 'htj-zz-row' },
        el('label', { class: 'htj-zz-field' }, el('span', { class: 'htj-zz-label', text: '楼层' }), floorSelect),
      ),
      storyArea,
    ),
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '画面' }),
      canvas,
      el('div', { class: 'htj-zz-btns' }, runButton, cancelButton),
    ),
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '提示词' }),
      el('div', { class: 'htj-zz-promptbox' },
        el('span', { class: 'htj-zz-label', text: '正向' }),
        promptView,
        el('span', { class: 'htj-zz-label', text: '负面' }),
        negativeView,
        el('div', { class: 'htj-zz-btns' }, regenBtn, copyBtn, insertBtn),
      ),
    ),
  );
}

function renderCanvasEmpty(): void {
  canvas.replaceChildren(
    el('div', {
      class: 'htj-zz-canvas-empty',
      text: '还没有图。\n选一个楼层或粘一段正文,点「编译并出图」。',
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
  const typed = storyArea.value.trim();
  const controller = new AbortController();
  abortController = controller;
  setStatus('正在编译…');

  try {
    const result = await runChain({
      floor: Number.isInteger(floor) && floor >= 0 ? floor : -1,
      story: typed || undefined,
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
  const positive = promptView.value.trim();
  if (!positive) {
    toast('正向提示词是空的', 'warning');
    return;
  }
  if (running) return;
  running = true;
  runButton.disabled = true;
  setStatus('按手改的提示词出图…');
  try {
    const settings = getSettings();
    const seed = randomSeed();
    const workflow = renderWorkflow(settings.comfy.workflow, {
      prompt: positive,
      negative: negativeView.value.trim(),
      seed,
    });
    const image = await runWorkflow(settings.comfy, workflow);
    lastResult = {
      positive,
      negative: negativeView.value.trim(),
      compiled: lastResult?.compiled ?? '',
      seed,
      imageUrl: image.url,
    };
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
let orbShowBox: HTMLInputElement;
let orbSizeInput: HTMLInputElement;
let orbOpacityInput: HTMLInputElement;

function buildPromptPage(): void {
  systemArea = el('textarea', { class: 'text_pole htj-zz-textarea', rows: '12' }) as HTMLTextAreaElement;
  systemArea.addEventListener('input', applyPrompt);

  const [styleWrap, style] = textField('恒定画风词(追加在正向后面)', 'masterpiece, best quality, ...');
  styleInput = style;
  style.addEventListener('input', applyPrompt);

  const [negWrap, neg] = textField('恒定负面词', 'lowres, bad anatomy, ...');
  negativeInput = neg;
  neg.addEventListener('input', applyPrompt);

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

  const resetPromptBtn = el('button', { class: 'menu_button', type: 'button', text: '恢复默认编译提示词' }) as HTMLButtonElement;
  resetPromptBtn.addEventListener('click', () => {
    systemArea.value = DEFAULT_SETTINGS.prompt.system;
    applyPrompt();
    toast('已恢复默认', 'success');
  });

  pagePrompt.append(
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '编译提示词' }),
      el('small', { class: 'htj-zz-hint', text: '占位符:{{story}} 剧情正文、{{note}} 额外任务提示。' }),
      systemArea,
      styleWrap,
      negWrap,
      el('label', { class: 'checkbox_label' }, wantNegativeBox, el('span', { text: '让模型额外输出负面词' })),
      retryWrap,
      el('div', { class: 'htj-zz-btns' }, resetPromptBtn),
    ),
    el(
      'div',
      { class: 'htj-zz-cardbox' },
      el('h4', { text: '行为' }),
      el('label', { class: 'checkbox_label' }, autoRunBox, el('span', { text: '每生成一楼自动出图' })),
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
  orbShowBox.checked = s.orb.show;
  orbSizeInput.value = String(s.orb.size);
  orbOpacityInput.value = String(s.orb.opacity);
}

function applyPrompt(): void {
  const next = getSettings();
  next.prompt.system = systemArea.value;
  next.prompt.styleSuffix = styleInput.value;
  next.prompt.negative = negativeInput.value;
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
