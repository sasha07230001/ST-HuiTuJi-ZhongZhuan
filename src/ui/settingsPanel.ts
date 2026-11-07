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
import { clampCount, MAX_SEGMENTS } from '@/relay/split';
import { getSettings, saveSettings } from '@/state/settings';
import { BUILTIN_WORKFLOW, DEFAULT_SETTINGS, type Settings } from '@/types';
import { applyConstantWordsToWorkflow, el, toast } from '@/ui/dom';
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
  // 同一个 DOM 节点不能 append 两次(第二次会把它从第一个位置搬走),
  // 所以「开关」和「剧情范围 / 自动插图」两处各建一个,状态互相同步。
  const autoRunInline = checkboxInput(s.autoRun);
  autoRunInline.addEventListener('change', () => {
    autoRun.checked = autoRunInline.checked;
    write(next => (next.autoRun = autoRunInline.checked));
  });
  autoRun.addEventListener('change', () => {
    autoRunInline.checked = autoRun.checked;
  });

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
  const retryInput = textInput(String(s.prompt.retryCount), '1', 'number');
  bind(retryInput, (next, v) => (next.prompt.retryCount = Math.max(0, Number(v) || 0)));

  /* 恒定画风词 / 恒定负面词:显式保存按钮。
   *
   * 这两个串会前置到**每一次**出图的 CLIP 文本最前面,边打边存的问题很直观:
   * 把 "cinematic lighting" 删到 "cinema" 的中间态会立刻跟着下一张图进采样器。
   * 所以这里跟编译提示词(textarea)不同,不做 input 事件写回。 */
  const styleInput = textInput(s.prompt.styleSuffix, 'masterpiece, best quality, ...');
  const negativeInput = textInput(s.prompt.negative, 'lowres, bad anatomy, ...');
  const saveStyle = el('button', { class: 'menu_button', type: 'button', text: '保存恒定画风词' });
  saveStyle.addEventListener('click', () => {
    write(next => (next.prompt.styleSuffix = styleInput.value.trim()));
    styleInput.value = getSettings().prompt.styleSuffix;
    toast('恒定画风词已保存:下次出图前置在正向最前面', 'success');
  });
  const saveNegative = el('button', { class: 'menu_button', type: 'button', text: '保存恒定负面词' });
  saveNegative.addEventListener('click', () => {
    write(next => (next.prompt.negative = negativeInput.value.trim()));
    negativeInput.value = getSettings().prompt.negative;
    toast('恒定负面词已保存:下次出图前置在负面最前面', 'success');
  });

  /**
   * 保存并把两串写进工作流模板(设置抽屉里也有入口,不用专门开面板)。
   * 只改 CLIP 文本节点,不动模型/采样器。
   */
  const saveAndSync = el('button', { class: 'menu_button', type: 'button', text: '保存并同步到 ComfyUI 工作流' });
  saveAndSync.addEventListener('click', () => {
    const style = styleInput.value.trim();
    const neg = negativeInput.value.trim();
    const current = getSettings();
    const result = applyConstantWordsToWorkflow(current.comfy.workflow, style, neg);
    if (!result.ok) {
      toast(result.message, 'error');
      return;
    }
    write(next => {
      next.prompt.styleSuffix = style;
      next.prompt.negative = neg;
      if (result.changed) next.comfy.workflow = result.template;
    });
    if (result.changed) {
      workflowArea.value = result.template;
      updateWorkflowInfo();
    }
    toast(result.changed ? '已保存,并把恒定词前置写进工作流 CLIP 文本' : result.message, result.changed ? 'success' : 'info');
  });
  for (const [input, btn] of [
    [styleInput, saveStyle] as const,
    [negativeInput, saveNegative] as const,
  ]) {
    input.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key;
      if (key !== 'Enter') return;
      event.preventDefault();
      (btn as HTMLButtonElement).click();
    });
  }

  /* 出图张数 / 分段标记 */
  const maxImages = textInput(String(s.prompt.maxImages), '1', 'number');
  maxImages.min = '1';
  maxImages.max = String(MAX_SEGMENTS);
  bind(maxImages, (next, v) => {
    const n = clampCount(v);
    next.prompt.maxImages = n;
    maxImages.value = String(n);
  });
  const markInput = textInput(s.prompt.segmentMark, '[[图]]');
  bind(markInput, (next, v) => {
    next.prompt.segmentMark = v.trim() || DEFAULT_SETTINGS.prompt.segmentMark;
  });
  markInput.addEventListener('change', () => {
    markInput.value = getSettings().prompt.segmentMark;
  });

  /* 图库持久化 */
  const galleryPersist = checkboxInput(s.gallery.persist);
  bind(galleryPersist, (next, _v, checked) => (next.gallery.persist = checked));
  const galleryLimit = textInput(String(s.gallery.limit), '300', 'number');
  bind(galleryLimit, (next, v) => (next.gallery.limit = Math.max(1, Math.floor(Number(v) || 300))));

  const resetPrompt = el('button', { class: 'menu_button', type: 'button', text: '恢复默认提示词' });
  resetPrompt.addEventListener('click', () => {
    systemArea.value = DEFAULT_SETTINGS.prompt.system;
    write(next => (next.prompt.system = DEFAULT_SETTINGS.prompt.system));
    toast('已恢复默认编译提示词', 'success');
  });

  /* ---- purge 层 ---- */
  const purgeEnabled = checkboxInput(s.purge.enabled);
  bind(purgeEnabled, (next, _v, checked) => (next.purge.enabled = checked));
  const purgeInject = checkboxInput(s.purge.injectSystem);
  bind(purgeInject, (next, _v, checked) => (next.purge.injectSystem = checked));
  const purgePrefill = checkboxInput(s.purge.prefill);
  bind(purgePrefill, (next, _v, checked) => (next.purge.prefill = checked));
  const purgeRewrite = checkboxInput(s.purge.rewrite);
  bind(purgeRewrite, (next, _v, checked) => (next.purge.rewrite = checked));

  const purgeArea = el('textarea', { class: 'text_pole textarea_compact htj-zz-purge', rows: '12' });
  purgeArea.value = s.purge.systemPrompt;
  bind(purgeArea, (next, v) => (next.purge.systemPrompt = v));

  const prefillInput = textInput(s.purge.prefillText, 'POSITIVE:');
  bind(prefillInput, (next, v) => (next.purge.prefillText = v));

  const maxExtraInput = textInput(String(s.purge.maxExtraTags), '12', 'number');
  bind(maxExtraInput, (next, v) => (next.purge.maxExtraTags = Math.max(0, Math.min(40, Number(v) || 0))));

  const resetPurge = el('button', { class: 'menu_button', type: 'button', text: '恢复默认 purge 声明' });
  resetPurge.addEventListener('click', () => {
    purgeArea.value = DEFAULT_SETTINGS.purge.systemPrompt;
    prefillInput.value = DEFAULT_SETTINGS.purge.prefillText;
    maxExtraInput.value = String(DEFAULT_SETTINGS.purge.maxExtraTags);
    write(next => {
      next.purge.systemPrompt = DEFAULT_SETTINGS.purge.systemPrompt;
      next.purge.prefillText = DEFAULT_SETTINGS.purge.prefillText;
      next.purge.maxExtraTags = DEFAULT_SETTINGS.purge.maxExtraTags;
    });
    toast('已恢复默认 purge 声明', 'success');
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
        el('small', {
          class: 'htj-zz-hint',
          text: '恒定画风词 / 恒定负面词会在每次出图时前置到 ComfyUI 的 CLIP 文本最前面(填完点保存)。',
        }),
        field('恒定画风词(前置在正向最前)', styleInput),
        el('div', { class: 'htj-zz-row' }, saveStyle),
        field('恒定负面词(前置在负面最前)', negativeInput),
        el('div', { class: 'htj-zz-row' }, saveNegative),
        el('div', { class: 'htj-zz-row' }, saveAndSync),
        el('label', { class: 'checkbox_label' }, wantNegative, el('span', { text: '让模型额外输出负面词' })),
        field('失败重试次数', retryInput),
        resetPrompt,
      ),

      el(
        'fieldset',
        {},
        el('legend', { text: '出图张数 / 分段' }),
        el('small', {
          class: 'htj-zz-hint',
          text:
            `一次出几张(1-${MAX_SEGMENTS})。>1 时按分段标记切正文,没写标记就均分;` +
            '每张图出完插回它在正文里对应的那一段。',
        }),
        el('div', { class: 'htj-zz-row' }, field('出几张', maxImages), field('分段标记', markInput)),
      ),

      el(
        'fieldset',
        {},
        el('legend', { text: '图库(持久化)' }),
        el('label', { class: 'checkbox_label' }, galleryPersist, el('span', { text: '把出过的图存进浏览器(刷新不丢)' })),
        field('每个聊天最多保留', galleryLimit),
        el('small', {
          class: 'htj-zz-hint',
          text: '图存在 IndexedDB,不进 settings.json;关掉就回到「blob URL 刷新即失效」的旧行为。',
        }),
      ),

      el(
        'fieldset',
        {},
        el('legend', { text: 'purge 层(指令权威 / 反净化)' }),
        el('small', {
          class: 'htj-zz-hint',
          text: '官网 API 会把 r18g 正文降级成温和 tag,这一层换掉模型的判断框架并补回被吃掉的词。',
        }),
        el('label', { class: 'checkbox_label' }, purgeEnabled, el('span', { text: '启用 purge 层' })),
        el('label', { class: 'checkbox_label' }, purgeInject, el('span', { text: 'system 前压入权威声明(主路径)' })),
        purgeArea,
        el(
          'div',
          { class: 'htj-zz-row' },
          el('label', { class: 'checkbox_label' }, purgePrefill, el('span', { text: 'assistant prefill' })),
          field('prefill 文本', prefillInput),
        ),
        el(
          'div',
          { class: 'htj-zz-row' },
          el('label', { class: 'checkbox_label' }, purgeRewrite, el('span', { text: '反净化重写' })),
          field('最多补几条 tag', maxExtraInput),
        ),
        el('small', {
          class: 'htj-zz-hint',
          text: 'prefill 被端点拒绝(400)时会自动去掉重发,不影响出图。整个 purge 层关掉 = 完全回到旧行为。',
        }),
        resetPurge,
      ),

      el(
        'fieldset',
        {},
        el('legend', { text: '剧情范围 / 自动插图' }),
        el('small', { class: 'htj-zz-hint', text: '只把圈定标签包住的正文当剧情;留空 = 整楼都算,取不到时自动回退。' }),
        field('范围标签(逗号分隔)', scopeTags),
        field('同名块取哪个', scopePick),
        el('label', { class: 'checkbox_label' }, autoRunInline, el('span', { text: '每生成一楼自动插图' })),
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
