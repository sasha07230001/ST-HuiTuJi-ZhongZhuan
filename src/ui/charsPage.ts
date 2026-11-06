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
import { deleteCharEntry, getCharLibrary, saveCharEntry, setCharLibrary } from '@/chars/store';
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

  const listBox = el('div', { class: 'htj-zz-charlist' });
  const editorBox = el('div', { class: 'htj-zz-chareditor' });

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

        const edit = el('button', { class: 'menu_button', type: 'button', text: '编辑' }) as HTMLButtonElement;
        edit.addEventListener('click', () => openEditor(entry, false));

        const del = el('button', { class: 'menu_button', type: 'button', text: '删除' }) as HTMLButtonElement;
        del.addEventListener('click', () => {
          if (!window.confirm(`删除角色档案「${entry.name}」?`)) return;
          deleteCharEntry(entry.name);
          toast(`已删除「${entry.name}」`, 'success');
          notify();
        });

        return el('div', { class: 'htj-zz-charrow' },
          el('div', { class: 'htj-zz-charrow-main' },
            el('label', { class: 'checkbox_label' }, toggle, el('b', { text: entry.name })),
            el('small', { class: 'htj-zz-hint', text: summary }),
            el('small', { class: 'htj-zz-hint', text: `来源:${entry.source}${entry.note ? ` · ${entry.note}` : ''}` }),
          ),
          el('div', { class: 'htj-zz-btns' }, edit, del),
        );
      }),
    );
  };

  renderList();

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
