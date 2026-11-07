/**
 * 角色档案页:库列表 + 编辑 + 导入 + 自动建档开关。
 *
 * 交互取舍:
 * - 列表只显示「名字 + 外貌摘要 + 开关」,点开才展开编辑区 —— 角色多了不糊一屏
 * - 编辑区按字段分格,raw 单独一格(从世界书导入的多是整串 tag)
 * - 导入走「先列候选 → 勾选 → 确认」,不直接写库,避免一次导入一堆用不上的
 */

import { candidateToEntry, collectImportCandidates, type ImportCandidate } from '@/chars/import';
import {
  CHAR_FIELDS,
  CHAR_FIELD_LABELS,
  entryToPromptTags,
  emptyFields,
  fieldsEmpty,
  makeEntry,
  type CharEntry,
  type CharField,
} from '@/chars/profile';
import {
  clearAllTransients,
  clearTransient,
  deleteCharEntry,
  getCharLibrary,
  getTransients,
  saveCharEntry,
  saveTransient,
  setCharLibrary,
  setTransients,
} from '@/chars/store';
import {
  emptyTransient,
  findTransient,
  mergeTransientTags,
  transientToClipTags,
  transientToTags,
  TRANSIENT_FIELD_ORDER,
  type TransientProfile,
} from '@/chars/transient';
import { getSettings, saveSettings } from '@/state/settings';
import { el, toast } from '@/ui/dom';

type Notify = () => void;

/** 建一个空白的「新建角色」编辑器状态。 */
function blankEntry(): CharEntry {
  return makeEntry({ name: '', fields: emptyFields(), source: 'manual', enabled: true });
}

export function buildCharsPage(notify: Notify): HTMLElement {
  const root = el('div', { class: 'htj-zz-chars' });

  // ---- 顶部开关 ----
  const autoMerge = el('input', { type: 'checkbox' }) as HTMLInputElement;
  autoMerge.checked = getSettings().chars.autoMerge !== false;
  autoMerge.addEventListener('change', () => {
    const next = getSettings();
    next.chars.autoMerge = autoMerge.checked;
    saveSettings(next);
  });

  const autoArchive = el('input', { type: 'checkbox' }) as HTMLInputElement;
  autoArchive.checked = getSettings().chars.autoArchive !== false;
  autoArchive.addEventListener('change', () => {
    const next = getSettings();
    next.chars.autoArchive = autoArchive.checked;
    saveSettings(next);
  });

  // ---- 临时档案开关 ----
  const transientCfg = getSettings().chars.transient;
  const tEnabled = el('input', { type: 'checkbox' }) as HTMLInputElement;
  tEnabled.checked = transientCfg.enabled !== false;
  tEnabled.addEventListener('change', () => {
    const next = getSettings();
    next.chars.transient.enabled = tEnabled.checked;
    saveSettings(next);
    notify();
  });

  const tAuto = el('input', { type: 'checkbox' }) as HTMLInputElement;
  tAuto.checked = transientCfg.autoUpdate !== false;
  tAuto.addEventListener('change', () => {
    const next = getSettings();
    next.chars.transient.autoUpdate = tAuto.checked;
    saveSettings(next);
  });

  const tOverride = el('input', { type: 'checkbox' }) as HTMLInputElement;
  tOverride.checked = transientCfg.overrideFixed !== false;
  tOverride.addEventListener('change', () => {
    const next = getSettings();
    next.chars.transient.overrideFixed = tOverride.checked;
    saveSettings(next);
    notify();
  });

  const tReset = el('input', { type: 'checkbox' }) as HTMLInputElement;
  tReset.checked = transientCfg.resetOnChatChange !== false;
  tReset.addEventListener('change', () => {
    const next = getSettings();
    next.chars.transient.resetOnChatChange = tReset.checked;
    saveSettings(next);
  });

  const tOnlyKnown = el('input', { type: 'checkbox' }) as HTMLInputElement;
  tOnlyKnown.checked = transientCfg.onlyKnown !== false;
  tOnlyKnown.addEventListener('change', () => {
    const next = getSettings();
    next.chars.transient.onlyKnown = tOnlyKnown.checked;
    saveSettings(next);
  });

  const listBox = el('div', { class: 'htj-zz-charlist' });
  const editorBox = el('div', { class: 'htj-zz-chareditor' });
  const transientBox = el('div', { class: 'htj-zz-charlist' });

  // ---- 临时档案编辑器 ----
  const transientEditor = el('div', { class: 'htj-zz-chareditor htj-zz-hide' });

  function openTransientEditor(name: string): void {
    const entry = getCharLibrary().find(e => e.name.toLowerCase() === name.toLowerCase());
    const existing = findTransient(getTransients(), name);
    const draft = existing ?? emptyTransient(name);

    const rawInput = el('textarea', { class: 'text_pole htj-zz-textarea', rows: '3' }) as HTMLTextAreaElement;
    rawInput.value = draft.raw;
    rawInput.placeholder = '这一刻的完整 tag,如 black lace bra, black lace panties(整串替换)';

    const fieldInputs = new Map<CharField, HTMLInputElement>();
    const grid = el('div', { class: 'htj-zz-grid2' });
    for (const field of TRANSIENT_FIELD_ORDER) {
      const input = el('input', {
        class: 'text_pole',
        type: 'text',
        value: draft.fields[field] ?? '',
        placeholder: CHAR_FIELD_LABELS[field],
      }) as HTMLInputElement;
      fieldInputs.set(field, input);
      grid.append(
        el('label', { class: 'htj-zz-field' },
          el('span', { class: 'htj-zz-label', text: CHAR_FIELD_LABELS[field] }),
          input,
        ),
      );
    }

    const frozenBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
    frozenBox.checked = draft.frozen;

    const preview = el('div', { class: 'htj-zz-hint' });
    const updatePreview = () => {
      const previewDraft = {
        ...draft,
        raw: rawInput.value.trim(),
        fields: Object.fromEntries([...fieldInputs].map(([k, v]) => [k, v.value])) as Record<CharField, string>,
      };
      const tmpTags = transientToTags(previewDraft);
      const clipped = transientToClipTags(previewDraft);
      const fixedTags = entry ? entryToPromptTags(entry) : '';
      const merged = mergeTransientTags(fixedTags, clipped, entry ?? null);
      const expandedNote = clipped !== tmpTags ? `\n(已展开成套词:${clipped})` : '';
      preview.textContent = merged
        ? `实际送进 CLIP:${merged}${expandedNote}`
        : '(空 —— 会用固定档案)';
    };
    for (const input of [rawInput, ...fieldInputs.values()]) {
      input.addEventListener('input', updatePreview);
    }
    updatePreview();

    const save = el('button', { class: 'menu_button', type: 'button', text: '保存临时状态' }) as HTMLButtonElement;
    save.addEventListener('click', () => {
      const result = saveTransient({
        name,
        raw: rawInput.value.trim(),
        fields: Object.fromEntries([...fieldInputs].map(([k, v]) => [k, v.value.trim()])) as Record<CharField, string>,
        replace: true,
        frozen: frozenBox.checked,
      });
      toast(result.changed ? `已更新「${name}」的临时档案` : '临时档案没有变化', result.changed ? 'success' : 'info');
      notify();
    });

    const clear = el('button', { class: 'menu_button', type: 'button', text: '清空(回到固定档案)' }) as HTMLButtonElement;
    clear.addEventListener('click', () => {
      clearTransient(name);
      toast(`已清空「${name}」的临时档案`, 'success');
      notify();
    });

    const cancel = el('button', { class: 'menu_button', type: 'button', text: '收起' }) as HTMLButtonElement;
    cancel.addEventListener('click', () => transientEditor.classList.add('htj-zz-hide'));

    transientEditor.replaceChildren(
      el('h5', { text: `临时档案「${name}」` }),
      el('small', {
        class: 'htj-zz-hint',
        text: '这里存「这一刻」的穿戴与状态。整串 tag 会顶掉固定档案里的服装,不会叠加——两串同时进 CLIP 会把衣服糊成一片。',
      }),
      el('label', { class: 'htj-zz-field' },
        el('span', { class: 'htj-zz-label', text: '整串(tag,整串替换)' }),
        rawInput,
      ),
      grid,
      el('label', { class: 'checkbox_label' }, frozenBox, el('span', { text: '冻结(AI 不再自动改这条)' })),
      preview,
      el('div', { class: 'htj-zz-btns' }, save, clear, cancel),
    );
    transientEditor.classList.remove('htj-zz-hide');
    transientEditor.scrollIntoView({ block: 'nearest' });
  }

  // ---- 临时档案列表 ----
  const renderTransientList = () => {
    const transients = getTransients();
    if (!transients.length) {
      transientBox.replaceChildren(
        el('div', {
          class: 'htj-zz-canvas-empty',
          text: '还没有临时档案。\n出图时会自动从剧情里读取角色当下的穿戴与状态,也可以点上面某条角色的「临时」手动写。',
        }),
      );
      return;
    }
    transientBox.replaceChildren(
      ...transients.map(tmp => {
        const tmpTags = transientToTags(tmp);
        const frozen = el('input', { type: 'checkbox' }) as HTMLInputElement;
        frozen.checked = tmp.frozen;
        frozen.addEventListener('change', () => {
          saveTransient({ name: tmp.name, frozen: frozen.checked });
          notify();
        });

        const edit = el('button', { class: 'menu_button', type: 'button', text: '编辑' }) as HTMLButtonElement;
        edit.addEventListener('click', () => openTransientEditor(tmp.name));

        const clear = el('button', { class: 'menu_button', type: 'button', text: '清空' }) as HTMLButtonElement;
        clear.addEventListener('click', () => {
          clearTransient(tmp.name);
          toast(`已清空「${tmp.name}」的临时档案`, 'success');
          notify();
        });

        return el('div', { class: 'htj-zz-charrow' },
          el('div', { class: 'htj-zz-charrow-main' },
            el('label', { class: 'checkbox_label' }, frozen, el('b', { text: tmp.name })),
            el('small', { class: 'htj-zz-hint', text: tmpTags || '(空)' }),
            el('small', {
              class: 'htj-zz-hint',
              text: `楼 #${tmp.floor} · ${tmp.frozen ? '已冻结' : 'AI 可更新'}${tmp.chatId ? ` · ${tmp.chatId.slice(0, 8)}` : ''}`,
            }),
          ),
          el('div', { class: 'htj-zz-btns' }, edit, clear),
        );
      }),
    );
  };

  // ---- 导入 ----
  const importPanel = el('div', { class: 'htj-zz-chareditor htj-zz-hide' });
  let importCandidates: ImportCandidate[] = [];

  const renderImportPanel = () => {
    importPanel.replaceChildren(
      el('h5', { text: '从酒馆导入' }),
      el('small', {
        class: 'htj-zz-hint',
        text: '会扫描所有世界书里带「tag/人物/外貌」的条目和角色卡描述。只接收能确定的文字,不做语义解析。',
      }),
      el('div', { class: 'htj-zz-btns' },
        (() => {
          const scan = el('button', { class: 'menu_button', type: 'button', text: '扫描' }) as HTMLButtonElement;
          scan.addEventListener('click', async () => {
            scan.disabled = true;
            scan.textContent = '扫描中…';
            try {
              importCandidates = await collectImportCandidates();
              toast(importCandidates.length ? `找到 ${importCandidates.length} 个候选` : '没找到可导入的角色',
                importCandidates.length ? 'success' : 'warning');
              renderImportPanel();
            } finally {
              scan.disabled = false;
              scan.textContent = '扫描';
            }
          });
          return scan;
        })(),
        (() => {
          const close = el('button', { class: 'menu_button', type: 'button', text: '收起' }) as HTMLButtonElement;
          close.addEventListener('click', () => importPanel.classList.add('htj-zz-hide'));
          return close;
        })(),
      ),
      ...importCandidates.map(candidate => {
        const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
        box.checked = true;
        box.dataset.name = candidate.name;
        return el('label', { class: 'checkbox_label htj-zz-importrow' },
          box,
          el('span', { text: `${candidate.name}` }),
          el('small', { class: 'htj-zz-hint', text: ` — ${candidate.origin}` }),
        );
      }),
    );

    if (importCandidates.length) {
      const confirm = el('button', { class: 'menu_button', type: 'button', text: '导入选中' }) as HTMLButtonElement;
      confirm.addEventListener('click', () => {
        const picked = [...importPanel.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
          .filter(box => box.checked)
          .map(box => importCandidates.find(c => c.name === box.dataset.name))
          .filter((c): c is ImportCandidate => !!c);
        if (!picked.length) return;
        const library = getCharLibrary();
        let added = 0;
        for (const candidate of picked) {
          const entry = candidateToEntry(candidate);
          if (library.some(e => e.name.toLowerCase() === entry.name.toLowerCase())) continue;
          library.push(entry);
          added += 1;
        }
        setCharLibrary(library);
        toast(added ? `已导入 ${added} 个角色` : '选中的角色都已存在', added ? 'success' : 'info');
        importPanel.classList.add('htj-zz-hide');
        notify();
      });
      importPanel.append(confirm);
    }
  };
  renderImportPanel();

  const importBtn = el('button', { class: 'menu_button', type: 'button', text: '从酒馆导入' }) as HTMLButtonElement;
  importBtn.addEventListener('click', () => {
    importPanel.classList.remove('htj-zz-hide');
    renderImportPanel();
  });

  const newBtn = el('button', { class: 'menu_button', type: 'button', text: '＋ 新建角色' }) as HTMLButtonElement;
  newBtn.addEventListener('click', () => openEditor(blankEntry(), true));

  // ---- 编辑器 ----
  function openEditor(entry: CharEntry, isNew: boolean): void {
    const nameInput = el('input', { class: 'text_pole', type: 'text', value: entry.name, placeholder: '角色名' }) as HTMLInputElement;
    nameInput.disabled = !isNew;

    const fieldInputs = new Map<CharField, HTMLInputElement>();
    const grid = el('div', { class: 'htj-zz-grid2' });
    for (const field of CHAR_FIELDS) {
      const input = el('input', {
        class: 'text_pole',
        type: 'text',
        value: entry.fields[field] ?? '',
        placeholder: CHAR_FIELD_LABELS[field],
      }) as HTMLInputElement;
      fieldInputs.set(field, input);
      grid.append(
        el('label', { class: 'htj-zz-field' },
          el('span', { class: 'htj-zz-label', text: `${CHAR_FIELD_LABELS[field]}(${field})` }),
          input,
        ),
      );
    }

    const rawInput = el('textarea', { class: 'text_pole htj-zz-textarea', rows: '3' }) as HTMLTextAreaElement;
    rawInput.value = entry.raw;
    rawInput.placeholder = '整串 danbooru tag(从世界书导入的通常是这种)';

    const nlInput = el('textarea', { class: 'text_pole htj-zz-textarea', rows: '3' }) as HTMLTextAreaElement;
    nlInput.value = entry.nl;
    nlInput.placeholder = '自然语言外貌描述(可空)';

    const enabledBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
    enabledBox.checked = entry.enabled;

    const preview = el('div', { class: 'htj-zz-hint' });
    const updatePreview = () => {
      const draft = makeEntry({
        ...entry,
        name: nameInput.value || entry.name,
        fields: Object.fromEntries([...fieldInputs].map(([k, v]) => [k, v.value])) as Record<CharField, string>,
        raw: rawInput.value,
        nl: nlInput.value,
        enabled: enabledBox.checked,
      });
      const tags = entryToPromptTags(draft);
      preview.textContent = tags ? `拼进提示词:${tags}` : '(这条档案没有可用的外貌内容)';
    };
    for (const input of [nameInput, rawInput, nlInput, enabledBox, ...fieldInputs.values()]) {
      input.addEventListener('input', updatePreview);
      input.addEventListener('change', updatePreview);
    }
    updatePreview();

    const save = el('button', { class: 'menu_button', type: 'button', text: '保存' }) as HTMLButtonElement;
    save.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) {
        toast('角色名不能为空', 'warning');
        return;
      }
      const fields = Object.fromEntries([...fieldInputs].map(([k, v]) => [k, v.value.trim()])) as Record<CharField, string>;
      const draft = makeEntry({
        ...entry,
        name,
        fields,
        raw: rawInput.value.trim(),
        nl: nlInput.value.trim(),
        enabled: enabledBox.checked,
        note: entry.note,
        source: isNew ? 'manual' : entry.source,
      });
      if (fieldsEmpty(draft.fields) && !draft.raw && !draft.nl) {
        toast('至少填一项:字段、整串 tag 或自然语言描述', 'warning');
        return;
      }
      const result = saveCharEntry(draft);
      toast(result.created ? `已建档「${name}」` : `已更新「${name}」`, 'success');
      notify();
    });

    const cancel = el('button', { class: 'menu_button', type: 'button', text: '取消' }) as HTMLButtonElement;
    cancel.addEventListener('click', () => editorBox.classList.add('htj-zz-hide'));

    editorBox.replaceChildren(
      el('h5', { text: isNew ? '新建角色' : `编辑「${entry.name}」` }),
      el('div', { class: 'htj-zz-row' },
        el('label', { class: 'htj-zz-field' },
          el('span', { class: 'htj-zz-label', text: '角色名' }),
          nameInput,
        ),
        el('label', { class: 'checkbox_label' }, enabledBox, el('span', { text: '参与出图' })),
      ),
      grid,
      el('label', { class: 'htj-zz-field' },
        el('span', { class: 'htj-zz-label', text: '整串 tag(raw,与字段并存时一起送)' }),
        rawInput,
      ),
      el('label', { class: 'htj-zz-field' },
        el('span', { class: 'htj-zz-label', text: '自然语言描述' }),
        nlInput,
      ),
      preview,
      el('div', { class: 'htj-zz-btns' }, save, cancel),
    );
    editorBox.classList.remove('htj-zz-hide');
  }

  // ---- 列表 ----
  const renderList = () => {
    const library = getCharLibrary();
    if (!library.length) {
      listBox.replaceChildren(
        el('div', { class: 'htj-zz-canvas-empty', text: '还没有角色档案。\n点「从酒馆导入」或「新建角色」开始。' }),
      );
      return;
    }
    listBox.replaceChildren(
      ...library.map(entry => {
        const tags = entryToPromptTags(entry);
        const summary = tags || entry.nl.slice(0, 60) || '(无外貌内容)';
        const toggle = el('input', { type: 'checkbox' }) as HTMLInputElement;
        toggle.checked = entry.enabled;
        toggle.addEventListener('change', () => {
          saveCharEntry({ ...entry, enabled: toggle.checked });
          notify();
        });

        // 临时档案:每个角色一个入口,带内容时按钮上标出来,免得忘了正在覆盖固定服装
        const tmp = findTransient(getTransients(), entry.name);
        const tmpTags = transientToTags(tmp);
        const tmpBtn = el('button', {
          class: 'menu_button',
          type: 'button',
          text: tmpTags ? '临时 ●' : '临时',
        }) as HTMLButtonElement;
        tmpBtn.title = tmpTags ? `当前临时状态:${tmpTags}` : '为这个角色新建一条临时档案';
        tmpBtn.addEventListener('click', () => openTransientEditor(entry.name));

        const edit = el('button', { class: 'menu_button', type: 'button', text: '编辑' }) as HTMLButtonElement;
        edit.addEventListener('click', () => openEditor(entry, false));

        const del = el('button', { class: 'menu_button', type: 'button', text: '删除' }) as HTMLButtonElement;
        del.addEventListener('click', () => {
          if (!window.confirm(`删除角色档案「${entry.name}」?`)) return;
          deleteCharEntry(entry.name);
          clearTransient(entry.name);
          toast(`已删除「${entry.name}」`, 'success');
          notify();
        });

        return el('div', { class: 'htj-zz-charrow' },
          el('div', { class: 'htj-zz-charrow-main' },
            el('label', { class: 'checkbox_label' }, toggle, el('b', { text: entry.name })),
            el('small', { class: 'htj-zz-hint', text: summary }),
            tmpTags
              ? el('small', { class: 'htj-zz-hint htj-zz-transient-chipline', text: `此刻:${tmpTags}` })
              : null,
            el('small', { class: 'htj-zz-hint', text: `来源:${entry.source}${entry.note ? ` · ${entry.note}` : ''}` }),
          ),
          el('div', { class: 'htj-zz-btns' }, tmpBtn, edit, del),
        );
      }),
    );
  };

  renderList();
  renderTransientList();

  root.append(
    // 行为开关
    el('div', { class: 'htj-zz-cardbox' },
      el('h4', { text: '角色档案' }),
      el('small', {
        class: 'htj-zz-hint',
        text: '出图时把在场角色的固定外貌拼进提示词,保证同一角色每次长相一致。',
      }),
      el('label', { class: 'checkbox_label' }, autoMerge, el('span', { text: '出图时自动拼入在场角色外貌' })),
      el('label', { class: 'checkbox_label' }, autoArchive, el('span', { text: '允许中转站从剧情自动建档(会多一次模型调用)' })),
    ),
    // 临时档案:剧情改了穿戴/状态时的那一层
    el('div', { class: 'htj-zz-cardbox' },
      el('h4', { text: '临时档案(此刻的状态)' }),
      el('small', {
        class: 'htj-zz-hint',
        text:
          '固定档案管「她长得什么样」;临时档案管「这一刻她穿着什么、身上有什么」。' +
          'AI 从剧情里读出变化后写进临时档案,出图时整串送进 ComfyUI 的提示词,并把固定档案里同槽位的旧穿戴顶掉。',
      }),
      el('label', { class: 'checkbox_label' }, tEnabled, el('span', { text: '启用临时档案层' })),
      el('label', { class: 'checkbox_label' }, tAuto, el('span', { text: '每轮让模型从剧情更新临时档案(多一次模型调用)' })),
      el('label', { class: 'checkbox_label' }, tOverride, el('span', { text: '临时档案覆盖固定档案的穿戴槽位(推荐)' })),
      el('label', { class: 'checkbox_label' }, tReset, el('span', { text: '换聊天 / 大幅回档时清空临时档案' })),
      el('label', { class: 'checkbox_label' }, tOnlyKnown, el('span', { text: '只给角色库里已有的角色建档' })),
      el('div', { class: 'htj-zz-btns' },
        (() => {
          const all = el('button', { class: 'menu_button', type: 'button', text: '全部清空' }) as HTMLButtonElement;
          all.addEventListener('click', () => {
            if (!window.confirm('清空所有临时档案?(固定档案不受影响)')) return;
            clearAllTransients();
            toast('已清空所有临时档案', 'success');
            notify();
          });
          return all;
        })(),
      ),
      transientBox,
      transientEditor,
    ),
    el('div', { class: 'htj-zz-cardbox' },
      el('div', { class: 'htj-zz-btns' }, importBtn, newBtn),
      importPanel,
    ),
    el('div', { class: 'htj-zz-cardbox' }, listBox),
    editorBox,
  );

  return root;
}

/** 供外部刷新(导入/删除后由 panel 重绘)。 */
export function refreshChars(): void {
  // 面板每次切到本页都会重建,无需额外处理;这里保留给自动建档后主动触发。
}
