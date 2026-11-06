/**
 * 设置面板:注入到 ST 的「扩展」抽屉里。
 *
 * 刻意不引框架——一个设置页用不着为它背一个 Vue 运行时。
 * 全部原生 DOM,改动即写回 extension_settings。
 */

import { testComfyConnection } from '@/comfy/api';
import { getPlaceholders, WorkflowError } from '@/comfy/workflow';
import { fetchRelayModels, testRelayConnection } from '@/relay/client';
import { normalizeRelayUrl } from '@/relay/prompt';
import { parseStoryScopeTagNames, type StoryScopePick } from '@/relay/storyScope';
import { getSettings, saveSettings } from '@/state/settings';
import { BUILTIN_WORKFLOW, DEFAULT_SETTINGS, type Settings } from '@/types';
import { el, toast } from '@/ui/dom';
import { resetOrbPosition, syncOrb } from '@/ui/orb';
import { openPanel } from '@/ui/panel';

const PANEL_ID = 'htj-zz-settings';
export const TITLE = '绘图姬·中转站';

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return el(
    'label',
    { class: 'htj-zz-field' },
    el('span', { class: 'htj-zz-label', text: label }),
    input,
    hint ? el('small', { class: 'htj-zz-hint', text: hint }) : null,
  );
}

function textInput(value: string, placeholder = '', type = 'text'): HTMLInputElement {
  return el('input', { class: 'text_pole', type, value, placeholder });
}

function checkboxInput(checked: boolean): HTMLInputElement {
  const box = el('input', { type: 'checkbox' });
  box.checked = checked;
  return box;
}

/** 写回一条设置(读最新值再改,避免闭包里的旧快照覆盖别处的改动)。 */
function write(apply: (next: Settings) => void): void {
  const next = getSettings();
  apply(next);
  saveSettings(next);
}

/** 绑定输入:文本在 input 事件写、数字在 change 事件写、勾选在 change 事件写。 */
function bind(
  input: HTMLInputElement | HTMLTextAreaElement,
  apply: (next: Settings, raw: string, checked: boolean) => void,
): void {
  const commit = () => write(next => apply(next, input.value, input instanceof HTMLInputElement ? input.checked : false));
  if (input instanceof HTMLInputElement && (input.type === 'checkbox' || input.type === 'number')) {
    input.addEventListener('change', commit);
  } else {
    input.addEventListener('input', commit);
    input.addEventListener('change', commit);
  }
}

function buildPanel(): HTMLElement {
  const s = getSettings();
  const status = el('div', { class: 'htj-zz-status', text: '' });

  /* ---- 开关 ---- */
  const enabled = checkboxInput(s.enabled);
  bind(enabled, (next, _v, checked) => (next.enabled = checked));
  const autoRun = checkboxInput(s.autoRun);
  bind(autoRun, (next, _v, checked) => (next.autoRun = checked));

  /* ---- 中转站 ---- */
  const relayUrl = textInput(s.relay.url, 'https://api.deepseek.com');
  bind(relayUrl, (next, v) => (next.relay.url = v));
  const relayKey = textInput(s.relay.key, 'sk-...', 'password');
  bind(relayKey, (next, v) => (next.relay.key = v));
  const relayModel = textInput(s.relay.model, 'deepseek-chat');
  bind(relayModel, (next, v) => (next.relay.model = v));
  const relayTemp = textInput(String(s.relay.temperature), '0.8', 'number');
  relayTemp.step = '0.1';
  bind(relayTemp, (next, v) => (next.relay.temperature = Number(v) || DEFAULT_SETTINGS.relay.temperature));
  const relayTokens = textInput(String(s.relay.maxTokens), '400', 'number');
  bind(relayTokens, (next, v) => (next.relay.maxTokens = Math.max(64, Number(v) || DEFAULT_SETTINGS.relay.maxTokens)));
  const relayTimeout = textInput(String(s.relay.timeoutSec), '120', 'number');
  bind(relayTimeout, (next, v) => (next.relay.timeoutSec = Math.max(5, Number(v) || DEFAULT_SETTINGS.relay.timeoutSec)));

  const modelSelect = el('select', { class: 'text_pole htj-zz-models' });
  modelSelect.style.display = 'none';
  modelSelect.addEventListener('change', () => {
    if (!modelSelect.value) return;
    relayModel.value = modelSelect.value;
    write(next => (next.relay.model = modelSelect.value));
  });

  const relayTest = el('button', { class: 'menu_button', type: 'button', text: '测试中转站' });
  relayTest.addEventListener('click', async () => {
    const current = getSettings();
    relayTest.disabled = true;
    relayTest.textContent = '测试中…';
    const result = await testRelayConnection({ ...current.relay, url: normalizeRelayUrl(current.relay.url) });
    toast(result.message, result.ok ? 'success' : 'error');
    status.textContent = result.message;
    relayTest.disabled = false;
    relayTest.textContent = '测试中转站';
  });

  const relayModels = el('button', { class: 'menu_button', type: 'button', text: '拉模型列表' });
  relayModels.addEventListener('click', async () => {
    const current = getSettings();
    relayModels.disabled = true;
    try {
      const list = await fetchRelayModels(current.relay);
      modelSelect.replaceChildren(
        el('option', { value: '', text: `— 共 ${list.length} 个 —` }),
        ...list.map(m => el('option', { value: m, text: m })),
      );
      modelSelect.style.display = list.length ? '' : 'none';
      toast(list.length ? `拉到 ${list.length} 个模型,下拉选一个` : '该中转站没返回模型列表', list.length ? 'success' : 'warning');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      relayModels.disabled = false;
    }
  });

  /* ---- ComfyUI ---- */
  const comfyUrl = textInput(s.comfy.url, 'http://127.0.0.1:8188');
  bind(comfyUrl, (next, v) => (next.comfy.url = v));
  const workflowArea = el('textarea', { class: 'text_pole textarea_compact htj-zz-workflow', rows: '6' });
  workflowArea.value = s.comfy.workflow;
  bind(workflowArea, (next, v) => (next.comfy.workflow = v));
  const allowProxy = checkboxInput(s.comfy.allowServerProxy);
  bind(allowProxy, (next, _v, checked) => (next.comfy.allowServerProxy = checked));

  const workflowInfo = el('small', { class: 'htj-zz-hint', text: '' });
  const updateWorkflowInfo = () => {
    const text = workflowArea.value.trim();
    if (!text) {
      workflowInfo.textContent = '还没填工作流。点「载入内置工作流」可以先用一个最简 SDXL 工作流把链路跑通。';
      return;
    }
    try {
      const found = getPlaceholders(text);
      workflowInfo.textContent = found.length
        ? `占位符:${found.map(x => `%${x}%`).join(' ')}`
        : '没有 %prompt% —— 出图时会自动找 CLIPTextEncode 节点直接改写它的 text。';
    } catch (error) {
      workflowInfo.textContent = error instanceof WorkflowError ? error.message : String(error);
    }
  };
  workflowArea.addEventListener('input', updateWorkflowInfo);
  workflowArea.addEventListener('change', updateWorkflowInfo);
  updateWorkflowInfo();

  const loadBuiltin = el('button', { class: 'menu_button', type: 'button', text: '载入内置工作流' });
  loadBuiltin.addEventListener('click', () => {
    workflowArea.value = BUILTIN_WORKFLOW;
    write(next => (next.comfy.workflow = BUILTIN_WORKFLOW));
    updateWorkflowInfo();
    toast('已载入内置工作流,记得把 CheckpointLoaderSimple 的模型名换成你本地的', 'success');
  });

  const comfyTest = el('button', { class: 'menu_button', type: 'button', text: '测试 ComfyUI' });
  comfyTest.addEventListener('click', async () => {
    const current = getSettings();
    comfyTest.disabled = true;
    comfyTest.textContent = '测试中…';
    const result = await testComfyConnection(current.comfy);
    toast(result.message, result.ok ? 'success' : 'error');
    status.textContent = result.message;
    comfyTest.disabled = false;
    comfyTest.textContent = '测试 ComfyUI';
  });

  /* ---- 编译提示词 ---- */
  const systemArea = el('textarea', { class: 'text_pole textarea_compact htj-zz-system', rows: '10' });
  systemArea.value = s.prompt.system;
  bind(systemArea, (next, v) => (next.prompt.system = v));
  const wantNegative = checkboxInput(s.prompt.wantNegative);
  bind(wantNegative, (next, _v, checked) => (next.prompt.wantNegative = checked));
  const styleInput = textInput(s.prompt.styleSuffix, 'masterpiece, best quality, ...');
  bind(styleInput, (next, v) => (next.prompt.styleSuffix = v));
  const negativeInput = textInput(s.prompt.negative, 'lowres, bad anatomy, ...');
  bind(negativeInput, (next, v) => (next.prompt.negative = v));
  const retryInput = textInput(String(s.prompt.retryCount), '1', 'number');
  bind(retryInput, (next, v) => (next.prompt.retryCount = Math.max(0, Number(v) || 0)));

  const resetPrompt = el('button', { class: 'menu_button', type: 'button', text: '恢复默认提示词' });
  resetPrompt.addEventListener('click', () => {
    systemArea.value = DEFAULT_SETTINGS.prompt.system;
    write(next => (next.prompt.system = DEFAULT_SETTINGS.prompt.system));
    toast('已恢复默认编译提示词', 'success');
  });

  /* ---- 悬浮球 / 面板入口 ---- */
  const orbShow = checkboxInput(s.orb.show);
  orbShow.addEventListener('change', () => {
    write(next => (next.orb.show = orbShow.checked));
    syncOrb();
  });
  const orbSize = textInput(String(s.orb.size), '48', 'number');
  orbSize.addEventListener('change', () => {
    write(next => (next.orb.size = Math.max(28, Math.min(96, Number(orbSize.value) || 48))));
    syncOrb();
  });
  const orbOpacity = textInput(String(s.orb.opacity), '0.62', 'number');
  orbOpacity.step = '0.05';
  orbOpacity.addEventListener('change', () => {
    write(next => (next.orb.opacity = Math.min(1, Math.max(0.2, Number(orbOpacity.value) || 0.62))));
    syncOrb();
  });

  const openPanelBtn = el('button', { class: 'menu_button', type: 'button', text: '打开面板' });
  openPanelBtn.addEventListener('click', () => openPanel('render'));

  const resetOrbBtn = el('button', { class: 'menu_button', type: 'button', text: '悬浮球回到默认位置' });
  resetOrbBtn.addEventListener('click', () => {
    resetOrbPosition();
    toast('悬浮球已回到默认位置', 'success');
  });

  /* ---- 剧情范围 ---- */
  const scopeTags = textInput((s.storyScope?.tags ?? []).join(', '), 'content, story, 正文');
  scopeTags.addEventListener('change', () => {
    write(next => (next.storyScope.tags = parseStoryScopeTagNames(scopeTags.value)));
    scopeTags.value = (getSettings().storyScope.tags ?? []).join(', ');
  });
  const scopePick = el('select', { class: 'text_pole' });
  scopePick.replaceChildren(
    el('option', { value: 'last', text: 'last — 最后一个块(推荐)' }),
    el('option', { value: 'first', text: 'first — 第一个块' }),
    el('option', { value: 'all', text: 'all — 所有块拼接' }),
  );
  scopePick.value = s.storyScope?.pick ?? 'last';
  scopePick.addEventListener('change', () => {
    write(next => (next.storyScope.pick = scopePick.value as StoryScopePick));
  });

  return el(
    'div',
    { class: 'inline-drawer' },
    el(
      'div',
      { class: 'inline-drawer-toggle inline-drawer-header' },
      el('b', { text: TITLE }),
      el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
    ),
    el(
      'div',
      { class: 'inline-drawer-content' },
      el('small', {
        class: 'htj-zz-hint',
        text: '剧情正文 → 中转站模型编译成 CLIP 提示词 → 写进 ComfyUI 工作流 → 出图。',
      }),

      el(
        'fieldset',
        {},
        el('legend', { text: '开关' }),
        el('label', { class: 'checkbox_label' }, enabled, el('span', { text: '启用扩展' })),
        el('label', { class: 'checkbox_label' }, autoRun, el('span', { text: '每生成一楼自动出图' })),
      ),

      el(
        'fieldset',
        {},
        el('legend', { text: '中转站(OpenAI 兼容)' }),
        field('API 地址', relayUrl, '填到域名即可会自动补 /v1;也可填完整的 …/v1'),
        field('API Key', relayKey),
        field('模型', relayModel),
        el('div', { class: 'htj-zz-row' }, relayTest, relayModels),
        modelSelect,
        el('div', { class: 'htj-zz-row' }, field('温度', relayTemp), field('最大 token', relayTokens), field('超时(秒)', relayTimeout)),
      ),

      el(
        'fieldset',
        {},
        el('legend', { text: 'ComfyUI' }),
        field('服务地址', comfyUrl),
        field('工作流 JSON(Save API Format)', workflowArea),
        workflowInfo,
        el('div', { class: 'htj-zz-row' }, loadBuiltin, comfyTest),
        el('label', { class: 'checkbox_label' }, allowProxy, el('span', { text: '浏览器直连失败时经 ST 后端转发(需重启酒馆)' })),
      ),

      el(
        'fieldset',
        {},
        el('legend', { text: '编译提示词' }),
        el('small', { class: 'htj-zz-hint', text: '占位符:{{story}} 剧情正文、{{note}} 额外任务提示。' }),
        systemArea,
        field('恒定画风词(追加在正向后面)', styleInput),
        field('恒定负面词', negativeInput),
        el('label', { class: 'checkbox_label' }, wantNegative, el('span', { text: '让模型额外输出负面词' })),
        field('失败重试次数', retryInput),
        resetPrompt,
      ),

      el(
        'fieldset',
        {},
        el('legend', { text: '剧情范围 / 自动插图' }),
        el('small', { class: 'htj-zz-hint', text: '只把圈定标签包住的正文当剧情;留空 = 整楼都算,取不到时自动回退。' }),
        field('范围标签(逗号分隔)', scopeTags),
        field('同名块取哪个', scopePick),
        el('label', { class: 'checkbox_label' }, autoRun, el('span', { text: '每生成一楼自动插图' })),
      ),

      el(
        'fieldset',
        {},
        el('legend', { text: '悬浮球 / 面板' }),
        el('label', { class: 'checkbox_label' }, orbShow, el('span', { text: '显示悬浮球' })),
        el('div', { class: 'htj-zz-row' }, field('大小(px)', orbSize), field('不透明度(0.2~1)', orbOpacity)),
        el('div', { class: 'htj-zz-row' }, openPanelBtn, resetOrbBtn),
        el('small', { class: 'htj-zz-hint', text: '点悬浮球打开面板;拖动可移动,靠近左右边缘会吸附,双击回到默认位置。' }),
      ),

      status,
    ),
  );
}

/** 注入到 ST 的扩展设置抽屉。重复调用安全。 */
export function mountSettingsPanel(): void {
  if (document.getElementById(PANEL_ID)) return;
  const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
  if (!host) {
    console.warn(`[${TITLE}] 找不到扩展设置容器,设置面板未挂载`);
    return;
  }
  const container = el('div', { id: PANEL_ID });
  container.append(buildPanel());
  host.append(container);
}
