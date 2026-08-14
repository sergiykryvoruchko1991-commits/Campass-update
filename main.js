const { Plugin, Modal, Notice, ItemView, MarkdownView, moment, setIcon, Setting, PluginSettingTab, requestUrl } = require('obsidian');

const VIEW_TYPE = 'compass-sidebar-view';
const COMPASS_PLUGIN_VERSION = '2.3.1';
const COMPASS_DATA_SCHEMA_VERSION = 3;

const COMPASS_UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/sergiykryvoruchko1991-commits/Campass-update/main/latest.json';
const COMPASS_UPDATE_ALLOWED_FILES = ['main.js', 'styles.css', 'manifest.json'];
const COMPASS_SHARED_SESSION_SECRET_ID = 'compass-shared-session-v1';

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const av = pa[i] || 0;
    const bv = pb[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function formatJournalDate(date) {
  const value = moment(date, 'YYYY-MM-DD', true);
  return value.isValid() ? value.format('DD.MM.YYYY') : String(date || '');
}

async function sha256Text(text) {
  if (!window.crypto?.subtle) throw new Error('На устройстве недоступна проверка SHA-256');
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const BUILTIN_TYPES = [
  { key: 'car', label: '🚗 Машина', journal: 'Машина' },
  { key: 'idea', label: '💡 Идея', journal: 'Идеи' },
  { key: 'invest', label: '💰 Инвестиции', journal: 'Инвестиции' },
  { key: 'principle', label: '🧭 Принцип', journal: 'Принципы' },
  { key: 'food', label: '🍳 Еда', journal: 'Еда' },
  { key: 'test', label: '🧪 Тест', journal: 'Тест' },
  { key: 'note', label: '📝 Просто заметка', journal: null }
];

const BUILTIN_JOURNALS = [
  ['🚗', 'Машина'],
  ['💡', 'Идеи'],
  ['💰', 'Инвестиции'],
  ['🧭', 'Принципы'],
  ['🍳', 'Еда'],
  ['🧪', 'Тест']
];

class ChoiceModal extends Modal {
  constructor(app, plugin, onChoose) {
    super(app);
    this.plugin = plugin;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('compass-choice-modal');
    contentEl.createEl('h2', { text: 'Добавить блок в день' });
    const grid = contentEl.createDiv({ cls: 'compass-grid' });
    this.plugin.getAllTypes().forEach(type => {
      const button = grid.createEl('button', { text: type.label, cls: 'compass-choice' });
      button.onclick = () => {
        this.close();
        this.onChoose(type);
      };
    });
  }

  onClose() { this.contentEl.empty(); }
}

class AddSectionModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.name = '';
    this.emoji = '📌';
    this.sectionType = 'journal';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('compass-section-modal', 'compass-add-section-modal');
    contentEl.createEl('h2', { text: 'Новый раздел' });

    // 1. Название: первое поле, чтобы на iPhone оно оставалось над клавиатурой.
    const nameSetting = new Setting(contentEl)
      .setName('Название раздела')
      .setDesc('Например: Работа или Пароход')
      .addText(text => {
        text.setPlaceholder('Название');
        text.inputEl.addClass('compass-section-name-input');
        text.onChange(value => { this.name = value.trim(); });

        const keepVisible = () => {
          const item = text.inputEl.closest('.setting-item') || text.inputEl;
          [80, 220, 450].forEach(delay => window.setTimeout(() => {
            try { item.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' }); } catch (_) {}
          }, delay));
        };
        text.inputEl.addEventListener('focus', keepVisible);
        text.inputEl.addEventListener('click', keepVisible);
      });
    nameSetting.settingEl.addClass('compass-section-name-setting');

    // 2. Значок.
    new Setting(contentEl)
      .setName('Значок')
      .setDesc('Любой emoji')
      .addText(text => text
        .setPlaceholder('📌')
        .setValue(this.emoji)
        .onChange(value => { this.emoji = value.trim() || '📌'; }));

    // 3. Тип раздела. Короткие подписи без дополнительного текста.
    new Setting(contentEl)
      .setName('Тип раздела')
      .setDesc('Журнал — для записей · База знаний — для папок и файлов')
      .addDropdown(dropdown => dropdown
        .addOption('journal', '📒 Журнал')
        .addOption('library', '📚 База знаний')
        .setValue(this.sectionType)
        .onChange(value => { this.sectionType = value; }));

    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    const cancel = actions.createEl('button', { text: 'Отмена' });
    cancel.onclick = () => this.close();
    const create = actions.createEl('button', { text: 'Создать', cls: 'mod-cta' });
    create.onclick = async () => {
      if (!this.name) {
        new Notice('Введите название раздела');
        return;
      }
      const ok = await this.plugin.addCustomSection(this.name, this.emoji, this.sectionType);
      if (ok) this.close();
    };
  }

  onClose() { this.contentEl.empty(); }
}

class NewDocumentModal extends Modal {
  constructor(app, plugin, folderPath, onCreated) {
    super(app);
    this.plugin = plugin;
    this.folderPath = folderPath;
    this.onCreated = onCreated;
    this.name = '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Новая заметка' });
    new Setting(contentEl)
      .setName('Название')
      .setDesc('Заметка будет создана в текущей папке базы знаний.')
      .addText(text => {
        text.setPlaceholder('Название заметки');
        text.onChange(value => { this.name = value.trim(); });
        setTimeout(() => text.inputEl.focus(), 50);
      });

    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    actions.createEl('button', { text: 'Отмена' }).onclick = () => this.close();
    const create = actions.createEl('button', { text: 'Создать заметку', cls: 'mod-cta' });
    create.onclick = async () => {
      if (!this.name) return new Notice('Введите название заметки');
      const file = await this.plugin.createLibraryDocument(this.folderPath, this.name);
      if (file) {
        this.close();
        if (this.onCreated) this.onCreated(file);
      }
    };
  }

  onClose() { this.contentEl.empty(); }
}

class NewLibraryFolderModal extends Modal {
  constructor(app, plugin, parentPath, onCreated) {
    super(app);
    this.plugin = plugin;
    this.parentPath = parentPath;
    this.onCreated = onCreated;
    this.name = '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Новая папка' });
    new Setting(contentEl)
      .setName('Название')
      .setDesc('Внутри неё можно будет создавать другие папки и заметки.')
      .addText(text => {
        text.setPlaceholder('Например: Главный двигатель');
        text.onChange(value => { this.name = value.trim(); });
        setTimeout(() => text.inputEl.focus(), 50);
      });

    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    actions.createEl('button', { text: 'Отмена' }).onclick = () => this.close();
    const create = actions.createEl('button', { text: 'Создать папку', cls: 'mod-cta' });
    create.onclick = async () => {
      if (!this.name) return new Notice('Введите название папки');
      const folder = await this.plugin.createLibraryFolder(this.parentPath, this.name);
      if (folder) {
        this.close();
        if (this.onCreated) this.onCreated(folder);
      }
    };
  }

  onClose() { this.contentEl.empty(); }
}

class LibraryModal extends Modal {
  constructor(app, plugin, rootPath, emoji, label, currentPath = null) {
    super(app);
    this.plugin = plugin;
    this.rootPath = rootPath;
    this.currentPath = currentPath || rootPath;
    this.emoji = emoji;
    this.label = label;
  }

  onOpen() { this.render(); }

  getRelativeParts() {
    if (this.currentPath === this.rootPath) return [];
    return this.currentPath.slice(this.rootPath.length).replace(/^\//, '').split('/').filter(Boolean);
  }

  openFolder(path) {
    this.currentPath = path;
    this.render();
  }

  renderBreadcrumbs(container) {
    const crumbs = container.createDiv({ cls: 'compass-library-breadcrumbs' });
    const root = crumbs.createEl('button', { text: this.label, cls: 'compass-library-crumb' });
    root.onclick = () => this.openFolder(this.rootPath);
    let path = this.rootPath;
    for (const part of this.getRelativeParts()) {
      crumbs.createSpan({ text: '›', cls: 'compass-library-crumb-separator' });
      path = `${path}/${part}`;
      const target = path;
      const crumb = crumbs.createEl('button', { text: part, cls: 'compass-library-crumb' });
      crumb.onclick = () => this.openFolder(target);
    }
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('compass-library-modal');

    const header = contentEl.createDiv({ cls: 'compass-library-header compass-library-browser-header' });
    const titleWrap = header.createDiv({ cls: 'compass-library-title-wrap' });
    titleWrap.createEl('h2', { text: `${this.emoji} ${this.currentPath === this.rootPath ? this.label : this.currentPath.split('/').pop()}` });
    if (this.currentPath !== this.rootPath) {
      const up = header.createEl('button', { text: '← Назад', cls: 'compass-library-back' });
      up.onclick = () => {
        const parent = this.currentPath.split('/').slice(0, -1).join('/');
        this.openFolder(parent.startsWith(this.rootPath) ? parent : this.rootPath);
      };
    }

    this.renderBreadcrumbs(contentEl);

    const createBar = contentEl.createDiv({ cls: 'compass-library-create-bar' });
    const addFolder = createBar.createEl('button', { text: '＋ Папка', cls: 'mod-cta' });
    addFolder.onclick = () => new NewLibraryFolderModal(this.app, this.plugin, this.currentPath, () => this.render()).open();
    const addFile = createBar.createEl('button', { text: '＋ Заметка' });
    addFile.onclick = () => {
      new NewDocumentModal(this.app, this.plugin, this.currentPath, async file => {
        await this.app.workspace.getLeaf(false).openFile(file);
      }).open();
    };

    const folder = this.app.vault.getAbstractFileByPath(this.currentPath);
    const children = folder && Array.isArray(folder.children) ? [...folder.children] : [];
    const folders = children
      .filter(item => Array.isArray(item.children))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const files = children
      .filter(item => item.extension === 'md' && !/^README$/i.test(item.basename))
      .sort((a, b) => a.basename.localeCompare(b.basename, 'ru'));

    if (!folders.length && !files.length) {
      contentEl.createEl('p', {
        text: 'Папка пока пустая. Создай подпапку или заметку.',
        cls: 'setting-item-description compass-library-empty'
      });
      return;
    }

    const list = contentEl.createDiv({ cls: 'compass-library-list compass-library-tree-list' });
    folders.forEach(folderItem => {
      const button = list.createEl('button', { cls: 'compass-library-entry compass-library-folder' });
      button.createSpan({ text: '📁', cls: 'compass-library-entry-icon' });
      button.createSpan({ text: folderItem.name, cls: 'compass-library-entry-name' });
      button.createSpan({ text: '›', cls: 'compass-library-entry-chevron' });
      button.onclick = () => this.openFolder(folderItem.path);
    });
    files.forEach(file => {
      const button = list.createEl('button', { cls: 'compass-library-entry compass-library-note' });
      button.createSpan({ text: '📄', cls: 'compass-library-entry-icon' });
      button.createSpan({ text: file.basename, cls: 'compass-library-entry-name' });
      button.onclick = async () => {
        this.close();
        await this.app.workspace.getLeaf(false).openFile(file);
      };
    });
  }

  onClose() { this.contentEl.empty(); }
}


class SectionActionsModal extends Modal {
  constructor(app, plugin, section) {
    super(app);
    this.plugin = plugin;
    this.section = section;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('compass-section-actions-modal');
    contentEl.createEl('h2', { text: `${this.section.emoji} ${this.section.name}` });
    contentEl.createEl('p', {
      text: this.section.type === 'journal'
        ? 'Архивация уберёт тему из активного меню и из списка новых блоков. Уже сделанные записи в дневнике останутся на месте, а журнал со ссылками будет сохранён в Архиве.'
        : 'Архивация уберёт базу знаний из активного меню и перенесёт её папку со всеми файлами в Архив.',
      cls: 'setting-item-description'
    });

    const archive = contentEl.createEl('button', { text: '📦 Перенести в архив', cls: 'compass-danger-action' });
    archive.onclick = async () => {
      const ok = await this.plugin.archiveSection(this.section);
      if (ok) this.close();
    };

    const cancel = contentEl.createEl('button', { text: 'Отмена', cls: 'compass-secondary-action' });
    cancel.onclick = () => this.close();
  }

  onClose() { this.contentEl.empty(); }
}

class ArchiveItemModal extends Modal {
  constructor(app, plugin, item, onDone) {
    super(app);
    this.plugin = plugin;
    this.item = item;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: `${this.item.emoji} ${this.item.name}` });
    contentEl.createEl('p', {
      text: this.item.type === 'journal'
        ? 'Записи, которые уже были добавлены в дневные заметки, сохраняются независимо от того, что ты сделаешь с этой темой журнала.'
        : 'Файлы этой базы знаний сейчас находятся в Архиве.',
      cls: 'setting-item-description'
    });

    const actions = contentEl.createDiv({ cls: 'compass-archive-item-actions' });
    const restore = actions.createEl('button', { text: '↩️ Восстановить', cls: 'mod-cta' });
    restore.onclick = async () => {
      const ok = await this.plugin.restoreArchivedSection(this.item);
      if (ok) {
        this.close();
        if (this.onDone) this.onDone();
      }
    };

    const remove = actions.createEl('button', { text: '🗑 Удалить окончательно', cls: 'compass-danger-action' });
    remove.onclick = async () => {
      const confirmed = window.confirm(
        this.item.type === 'journal'
          ? 'Удалить тему журнала из Архива окончательно? Дневные заметки и текст внутри них останутся сохранены.'
          : 'Удалить эту базу знаний и все её файлы окончательно? Это действие нельзя отменить.'
      );
      if (!confirmed) return;
      const ok = await this.plugin.deleteArchivedSection(this.item);
      if (ok) {
        this.close();
        if (this.onDone) this.onDone();
      }
    };
  }

  onClose() { this.contentEl.empty(); }
}

class ArchiveModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() { this.render(); }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('compass-archive-modal');
    contentEl.createEl('h2', { text: '📦 Архив' });
    contentEl.createEl('p', {
      text: 'Здесь находятся убранные разделы. Журналы можно восстановить или удалить окончательно; записи в дневных заметках при этом не удаляются.',
      cls: 'setting-item-description'
    });

    if (!this.plugin.archivedSections.length) {
      contentEl.createEl('p', { text: 'Архив пока пуст.' });
      return;
    }

    const groups = [
      ['journal', '📒 Журналы'],
      ['library', '📚 Базы знаний']
    ];
    groups.forEach(([type, title]) => {
      const items = this.plugin.archivedSections.filter(item => item.type === type);
      if (!items.length) return;
      contentEl.createEl('h3', { text: title });
      const list = contentEl.createDiv({ cls: 'compass-archive-list' });
      items.forEach(item => {
        const button = list.createEl('button', { cls: 'compass-archive-row' });
        button.createSpan({ text: item.emoji || '📌' });
        const text = button.createSpan();
        text.createEl('strong', { text: item.name });
        if (item.archivedAt) text.createEl('small', { text: `Архивировано: ${moment(item.archivedAt).format('D MMM YYYY')}` });
        button.onclick = () => new ArchiveItemModal(this.app, this.plugin, item, () => this.render()).open();
      });
    });
  }

  onClose() { this.contentEl.empty(); }
}




function blurActiveEditable() {
  const el = document.activeElement;
  if (!el) return;
  const tag = (el.tagName || '').toLowerCase();
  const editable = tag === 'input' || tag === 'textarea' || el.isContentEditable;
  if (editable && typeof el.blur === 'function') el.blur();
}

function attachMobileKeyboardDismiss(rootEl) {
  if (!rootEl) return () => {};
  if (typeof rootEl.__compassKeyboardCleanup === 'function') {
    rootEl.__compassKeyboardCleanup();
  }

  const isEditable = (target) => {
    if (!(target instanceof Element)) return false;
    return !!target.closest('input, textarea, [contenteditable="true"]');
  };

  // Important on iOS: do not blur on pointerdown/touchstart or scroll.
  // Those events may fire while the system keyboard is opening and can
  // immediately cancel focus, making the keyboard appear to "twitch".
  const dismissOutside = (event) => {
    if (!isEditable(event.target)) blurActiveEditable();
  };

  rootEl.addEventListener('click', dismissOutside, false);

  const cleanup = () => {
    rootEl.removeEventListener('click', dismissOutside, false);
    if (rootEl.__compassKeyboardCleanup === cleanup) rootEl.__compassKeyboardCleanup = null;
  };
  rootEl.__compassKeyboardCleanup = cleanup;
  return cleanup;
}

function attachMobileKeyboardAvoidance(rootEl) {
  if (!rootEl) return () => {};
  if (typeof rootEl.__compassKeyboardAvoidCleanup === 'function') rootEl.__compassKeyboardAvoidCleanup();

  const viewport = window.visualViewport;
  const modal = rootEl.closest?.('.modal') || null;
  const modalContainer = rootEl.closest?.('.modal-container') || null;
  let focusTimers = [];

  const clearFocusTimers = () => {
    focusTimers.forEach(id => window.clearTimeout(id));
    focusTimers = [];
  };

  const keepVisible = (element) => {
    if (!(element instanceof Element) || !rootEl.contains(element)) return;
    if (!element.matches('input, textarea, [contenteditable="true"]')) return;
    const scrollHost = rootEl.closest?.('.modal-content') || rootEl;
    clearFocusTimers();
    [40, 140, 300, 520, 800].forEach(delay => {
      focusTimers.push(window.setTimeout(() => {
        try {
          const vv = window.visualViewport;
          const visibleTop = (vv ? vv.offsetTop : 0) + 76;
          const visibleBottom = (vv ? vv.offsetTop + vv.height : window.innerHeight) - 36;
          const rect = element.getBoundingClientRect();
          if (rect.bottom > visibleBottom) scrollHost.scrollTop += rect.bottom - visibleBottom + 44;
          if (rect.top < visibleTop) scrollHost.scrollTop -= visibleTop - rect.top + 24;
          element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
          if (rootEl.classList.contains('compass-add-section-modal')) {
            const item = element.closest('.setting-item') || element;
            item.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
            scrollHost.scrollTop = Math.max(0, scrollHost.scrollTop - 18);
          }
        } catch (_) {}
      }, delay));
    });
  };

  const update = () => {
    const vvHeight = viewport ? viewport.height : window.innerHeight;
    const vvTop = viewport ? viewport.offsetTop : 0;
    const keyboardOpen = viewport ? vvHeight < window.innerHeight * 0.82 : false;

    const keyboardHeight = viewport ? Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop)) : 0;
    rootEl.style.setProperty('--compass-vv-height', `${Math.max(240, Math.round(vvHeight))}px`);
    rootEl.style.setProperty('--compass-keyboard-offset', keyboardOpen ? `${Math.max(24, Math.round(keyboardHeight))}px` : '0px');
    rootEl.classList.toggle('is-keyboard-open', keyboardOpen);

    if (modal) {
      modal.classList.add('compass-keyboard-safe-modal');
      modal.style.maxHeight = `${Math.max(220, Math.round(vvHeight - 16))}px`;
    }
    if (modalContainer) {
      modalContainer.classList.add('compass-keyboard-safe-container');
      modalContainer.style.height = `${Math.max(240, Math.round(vvHeight))}px`;
      modalContainer.style.top = `${Math.max(0, Math.round(vvTop))}px`;
      modalContainer.style.bottom = 'auto';
      modalContainer.style.alignItems = 'flex-start';
      modalContainer.style.paddingTop = '8px';
      modalContainer.style.boxSizing = 'border-box';
    }

    if (keyboardOpen) keepVisible(document.activeElement);
  };

  const onFocus = event => {
    const target = event.target;
    if (target instanceof Element && target.matches('input, textarea, [contenteditable="true"]')) {
      update();
      keepVisible(target);
    }
  };

  rootEl.addEventListener('focusin', onFocus, true);
  if (viewport) {
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
  }
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  update();

  const cleanup = () => {
    clearFocusTimers();
    rootEl.removeEventListener('focusin', onFocus, true);
    if (viewport) {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    }
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
    rootEl.style.removeProperty('--compass-vv-height');
    rootEl.style.removeProperty('--compass-keyboard-offset');
    rootEl.classList.remove('is-keyboard-open');
    if (modal) {
      modal.classList.remove('compass-keyboard-safe-modal');
      modal.style.removeProperty('max-height');
    }
    if (modalContainer) {
      modalContainer.classList.remove('compass-keyboard-safe-container');
      for (const prop of ['height','top','bottom','align-items','padding-top','box-sizing']) modalContainer.style.removeProperty(prop);
    }
    if (rootEl.__compassKeyboardAvoidCleanup === cleanup) rootEl.__compassKeyboardAvoidCleanup = null;
  };
  rootEl.__compassKeyboardAvoidCleanup = cleanup;
  return cleanup;
}

function attachSpeechDictation(button, textarea, locale = 'ru-RU') {
  if (!button || !textarea) return () => {};
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let running = false;
  let destroyed = false;

  const setIdle = () => {
    running = false;
    button.removeClass('is-listening');
    button.setText('🎙️ Диктовать');
  };

  const insertTranscript = text => {
    const transcript = String(text || '').trim();
    if (!transcript) return;
    const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const space = before && !/\s$/.test(before) ? ' ' : '';
    textarea.value = `${before}${space}${transcript}${after}`;
    const caret = (before + space + transcript).length;
    try { textarea.setSelectionRange(caret, caret); } catch (_) {}
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  };

  button.onclick = () => {
    if (!Recognition) {
      textarea.focus();
      new Notice('Отдельное распознавание речи недоступно на этом устройстве. Поле ввода открыто — используй микрофон системной клавиатуры для диктовки.');
      return;
    }
    if (running && recognition) {
      try { recognition.stop(); } catch (_) {}
      return;
    }
    recognition = new Recognition();
    recognition.lang = locale;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      running = true;
      button.addClass('is-listening');
      button.setText('⏹ Остановить');
    };
    recognition.onresult = event => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (event.results[i].isFinal) insertTranscript(event.results[i][0]?.transcript || '');
      }
    };
    recognition.onerror = event => {
      const code = event?.error || 'unknown';
      if (code !== 'aborted' && code !== 'no-speech') new Notice(`Диктовка: ${code}`);
      setIdle();
    };
    recognition.onend = () => { if (!destroyed) setIdle(); };
    try { recognition.start(); }
    catch (e) {
      setIdle();
      new Notice(`Не удалось запустить диктовку: ${e.message || e}`);
    }
  };

  return () => {
    destroyed = true;
    if (recognition) { try { recognition.abort(); } catch (_) {} }
    setIdle();
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class RelationshipSessionModal extends Modal {
  constructor(app, plugin, onReady) {
    super(app);
    this.plugin = plugin;
    this.onReady = onReady;
    this.password = '';
    this.encryptionSecret = '';
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
    this.cleanupDictation = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
    contentEl.addClass('compass-relationship-login');
    contentEl.createEl('h2', { text: '❤️ Общее пространство' });
    new Setting(contentEl)
      .setName('Пароль пользователя')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Пароль Supabase Auth');
        text.onChange(value => { this.password = value; });
      });

    new Setting(contentEl)
      .setName('Ключ шифрования')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Encryption key');
        text.onChange(value => { this.encryptionSecret = value; });
      });

    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    const cancel = actions.createEl('button', { text: 'Отмена' });
    cancel.onclick = () => this.close();
    const login = actions.createEl('button', { text: 'Войти', cls: 'mod-cta' });
    login.onclick = async () => {
      if (!this.password || !this.encryptionSecret) {
        new Notice('Введите пароль и ключ шифрования');
        return;
      }
      login.disabled = true;
      login.setText('Подключаюсь…');
      try {
        await this.plugin.startRelationshipSession(this.password, this.encryptionSecret);
        this.close();
        if (this.onReady) this.onReady();
      } catch (e) {
        console.error('Compass relationships login', e);
        new Notice(`Не удалось войти: ${e.message || e}`);
        login.disabled = false;
        login.setText('Войти');
      }
    };
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}

class NewRelationshipSituationModal extends Modal {
  constructor(app, plugin, onDone, existingSituation = null) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
    this.existingSituation = existingSituation;
    this.title = '';
    this.text = '';
    this.cleanupKeyboardDismiss = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
    contentEl.addClass('compass-situation-editor');
    const header = contentEl.createDiv({ cls: 'compass-situation-editor-header' });
    header.createEl('h2', { text: this.existingSituation ? 'Моя позиция' : 'Новая тема' });
    header.createEl('small', { text: moment().format('D MMMM YYYY · HH:mm') });

    if (!this.existingSituation) {
      new Setting(contentEl)
        .setName('Название темы')
        .setDesc('Например: Отпуск, Бюджет, Покупка машины. Название также шифруется.')
        .addText(text => {
          text.setPlaceholder('Название темы');
          text.onChange(value => { this.title = value.trim(); });
        });
    }

    const textarea = contentEl.createEl('textarea', {
      cls: 'compass-situation-textarea compass-relationship-mobile-editor',
      attr: { placeholder: 'Пиши всё, что считаешь важным…' }
    });
    textarea.addEventListener('input', () => { this.text = textarea.value; });
    setTimeout(() => textarea.focus(), 50);

    const hint = contentEl.createEl('details', { cls: 'compass-situation-hint' });
    hint.createEl('summary', { text: 'Не знаю, с чего начать' });
    hint.createEl('p', { text: 'Что произошло? Что ты почувствовал? Что тебя задело? Чего ожидал? Как понял поведение другого человека?' });

    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    const cancel = actions.createEl('button', { text: 'Отмена' });
    cancel.onclick = () => this.close();
    const finish = actions.createEl('button', { text: 'Завершить 🔒', cls: 'mod-cta' });
    finish.onclick = async () => {
      if (!this.existingSituation && !this.title) {
        new Notice('Введите название темы');
        return;
      }
      if (!this.text.trim()) {
        new Notice('Запись пока пустая');
        return;
      }
      if (!window.confirm('Завершить первоначальную позицию? Текст партнёра откроется только после завершения обеими сторонами.')) return;
      finish.disabled = true;
      finish.setText('Сохраняю…');
      try {
        if (this.existingSituation) await this.plugin.addRelationshipEntry(this.existingSituation.id, this.text.trim());
        else await this.plugin.createRelationshipSituation(this.title, this.text.trim());
        this.close();
        new Notice('Запись завершена и зашифрована 🔒');
        if (this.onDone) this.onDone();
      } catch (e) {
        console.error('Compass create relationship situation', e);
        new Notice(`Не удалось сохранить: ${e.message || e}`);
        finish.disabled = false;
        finish.setText('Завершить 🔒');
      }
    };
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupDictation) this.cleanupDictation();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}

class RelationshipEditTextModal extends Modal {
  constructor(app, plugin, title, initialText, onSave) {
    super(app);
    this.plugin = plugin;
    this.title = title;
    this.value = initialText || '';
    this.onSave = onSave;
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
    this.cleanupDictation = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
    contentEl.createEl('h2', { text: this.title });
    const textarea = contentEl.createEl('textarea', { cls: 'compass-situation-textarea compass-relationship-mobile-editor' });
    textarea.value = this.value;
    textarea.addEventListener('input', () => { this.value = textarea.value; });
    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    const cancel = actions.createEl('button', { text: 'Отмена' });
    cancel.onclick = () => this.close();
    const save = actions.createEl('button', { text: 'Сохранить', cls: 'mod-cta' });
    save.onclick = async () => {
      if (!this.value.trim()) return new Notice('Текст не может быть пустым');
      save.disabled = true;
      try {
        await this.onSave(this.value.trim());
        this.close();
      } catch (e) {
        new Notice(`Не удалось сохранить: ${e.message || e}`);
        save.disabled = false;
      }
    };
    setTimeout(() => textarea.focus(), 50);
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupDictation) this.cleanupDictation();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}


class RelationshipReplyModal extends Modal {
  constructor(app, plugin, situationId, onSent) {
    super(app);
    this.plugin = plugin;
    this.situationId = situationId;
    this.onSent = onSent;
    this.value = '';
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
    contentEl.addClass('compass-relationship-reply-modal');

    contentEl.createEl('h2', { text: 'Ответить' });

    const textarea = contentEl.createEl('textarea', {
      cls: 'compass-situation-textarea',
      attr: { placeholder: 'Напиши ответ…' }
    });
    textarea.addEventListener('input', () => { this.value = textarea.value; });

    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    const cancel = actions.createEl('button', { text: 'Отмена' });
    cancel.onclick = () => this.close();

    const send = actions.createEl('button', { text: 'Отправить', cls: 'mod-cta' });
    send.onclick = async () => {
      const value = this.value.trim();
      if (!value) return new Notice('Напиши сообщение');
      send.disabled = true;
      send.setText('Отправляю…');
      try {
        await this.plugin.addRelationshipMessage(this.situationId, value);
        this.close();
        if (this.onSent) await this.onSent();
      } catch (e) {
        new Notice(`Не удалось отправить: ${e.message || e}`);
        send.disabled = false;
        send.setText('Отправить');
      }
    };

    setTimeout(() => textarea.focus(), 80);
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}

class RelationshipRenameModal extends Modal {
  constructor(app, plugin, situation, currentTitle, onDone) {
    super(app);
    this.plugin = plugin;
    this.situation = situation;
    this.value = currentTitle || '';
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Переименовать тему' });
    new Setting(contentEl).setName('Название').addText(text => {
      text.setValue(this.value);
      text.onChange(value => { this.value = value.trim(); });
      setTimeout(() => text.inputEl.focus(), 50);
    });
    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    actions.createEl('button', { text: 'Отмена' }).onclick = () => this.close();
    const save = actions.createEl('button', { text: 'Сохранить', cls: 'mod-cta' });
    save.onclick = async () => {
      if (!this.value) return new Notice('Название не может быть пустым');
      try {
        await this.plugin.renameRelationshipTopic(this.situation.id, this.value);
        this.close();
        if (this.onDone) this.onDone();
      } catch (e) { new Notice(`Не удалось переименовать: ${e.message || e}`); }
    };
  }
}

class RelationshipSituationModal extends Modal {
  constructor(app, plugin, situation) {
    super(app);
    this.plugin = plugin;
    this.situation = situation;
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
    this.cleanupDictation = null;
  }

  async onOpen() {
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(this.contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(this.contentEl);
    await this.render();
  }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('compass-relationship-situation');
    const loading = contentEl.createEl('p', { text: 'Открываю тему…' });
    try {
      const fresh = await this.plugin.getRelationshipSituation(this.situation.id);
      if (fresh) this.situation = fresh;
      const [entries, messages, prefs] = await Promise.all([
        this.plugin.getRelationshipEntries(this.situation.id),
        this.plugin.getRelationshipMessages(this.situation.id).catch(() => []),
        this.plugin.getRelationshipPreferences().catch(() => [])
      ]);
      loading.remove();
      const me = this.plugin.relationshipSession.user.id;
      const own = entries.find(e => e.author_id === me);
      const other = entries.find(e => e.author_id !== me);
      const bothReady = Boolean(own && other);
      const title = await this.plugin.decodeRelationshipTitle(this.situation.title, this.situation);
      const header = contentEl.createDiv({ cls: 'compass-topic-header' });
      const heading = header.createDiv();
      heading.createEl('h2', { text: `❤️ ${title || 'Без названия'}` });
      heading.createEl('small', { text: moment(this.situation.created_at).format('D MMMM YYYY · HH:mm') });
      if (this.situation.status === 'open') {
        const rename = header.createEl('button', { text: '✎ Название' });
        rename.onclick = () => new RelationshipRenameModal(this.app, this.plugin, this.situation, title, async () => this.render()).open();
      }

      const status = contentEl.createDiv({ cls: `compass-topic-status status-${this.situation.status || 'open'}` });
      status.setText(this.plugin.relationshipStatusLabel(this.situation, entries, messages));

      if (own) await this.renderEntryCard(contentEl, own, 'Моя первоначальная позиция', true, bothReady, messages);
      else {
        const empty = contentEl.createDiv({ cls: 'compass-waiting-card' });
        empty.createEl('strong', { text: 'Твоя первоначальная позиция ещё не написана' });
        empty.createEl('p', { text: 'Позиция партнёра останется скрытой, пока ты не завершишь свою.' });
        const addMine = empty.createEl('button', { text: 'Написать свою позицию', cls: 'mod-cta' });
        addMine.onclick = () => {
          this.close();
          new NewRelationshipSituationModal(this.app, this.plugin, () => new RelationshipSituationModal(this.app, this.plugin, this.situation).open(), this.situation).open();
        };
      }

      if (other) await this.renderEntryCard(contentEl, other, 'Позиция партнёра', false, bothReady, messages);
      else {
        const wait = contentEl.createDiv({ cls: 'compass-waiting-card' });
        wait.createEl('strong', { text: 'Ожидание второй стороны' });
        wait.createEl('p', { text: 'Чужая позиция откроется только после того, как обе стороны завершат первоначальные тексты.' });
        const refresh = wait.createEl('button', { text: 'Обновить' });
        refresh.onclick = () => this.render();
      }

      if (bothReady) {
        const discussionBar = contentEl.createDiv({ cls: 'compass-discussion-bar' });
        discussionBar.createEl('h3', { text: 'Обсуждение', cls: 'compass-discussion-title' });
        this.renderColorPicker(discussionBar, prefs, true);
        await this.renderMessages(contentEl, messages, prefs);
        await this.renderDiscussionActions(contentEl, messages);
      }
    } catch (e) {
      loading.setText(`Не удалось открыть: ${e.message || e}`);
    }
  }

  async renderEntryCard(container, entry, label, isOwn, bothReady, messages = []) {
    const text = await this.plugin.decryptRelationshipText(entry);
    const color = isOwn ? (await this.plugin.getMyRelationshipColor()) : (await this.plugin.getPartnerRelationshipColor());
    const edited = entry.updated_at && Math.abs(new Date(entry.updated_at) - new Date(entry.created_at)) > 3000;
    const me = this.plugin.relationshipSession.user.id;
    const lastOwnReplyAt = messages.filter(m => m.author_id === me).reduce((max, m) => Math.max(max, +new Date(m.created_at)), 0);
    const partnerEditAwaiting = !isOwn && edited && (+new Date(entry.updated_at) > lastOwnReplyAt);
    const card = container.createDiv({ cls: `compass-perspective-card compass-author-${color || (isOwn ? 'blue' : 'green')}${partnerEditAwaiting ? ' is-awaiting-response' : ''}` });
    const h = card.createDiv({ cls: 'compass-message-head' });
    h.createEl('h3', { text: label });
    if (edited) h.createEl('small', { text: `Изменено ${moment(entry.updated_at).format('DD.MM.YYYY HH:mm')}` });
    card.createEl('div', { text, cls: 'compass-perspective-text' });
    if (isOwn && bothReady && this.situation.status === 'open') {
      const edit = card.createEl('button', { text: '✎ Изменить', cls: 'compass-inline-action' });
      edit.onclick = () => new RelationshipEditTextModal(this.app, this.plugin, 'Изменить первоначальную позицию', text, async value => {
        await this.plugin.updateRelationshipEntry(entry.id, value);
        await this.render();
      }).open();
    }
  }

  renderColorPicker(container, prefs, compact = false) {
    const me = this.plugin.relationshipSession.user.id;
    const mine = prefs.find(p => p.user_id === me)?.accent_color || 'blue';
    const wrap = container.createDiv({ cls: `compass-color-picker${compact ? ' is-compact' : ''}` });
    if (!compact) wrap.createSpan({ text: 'Мой цвет:' });
    ['blue', 'green', 'purple', 'orange'].forEach(color => {
      const b = wrap.createEl('button', { cls: `compass-color-dot color-${color}${mine === color ? ' is-active' : ''}`, attr: { 'aria-label': color } });
      b.onclick = async () => {
        try {
          await this.plugin.setRelationshipAccentColor(color);
          await this.render();
        } catch (e) { new Notice(`Не удалось изменить цвет: ${e.message || e}`); }
      };
    });
    if (!compact) {
      const minePref = prefs.find(p => p.user_id === me);
      const emailEnabled = Boolean(minePref?.email_notifications_enabled);
      const emailButton = wrap.createEl('button', {
        text: emailEnabled ? '📩 Email: вкл' : '📩 Email: выкл',
        cls: `compass-email-toggle${emailEnabled ? ' is-active' : ''}`
      });
      emailButton.onclick = async () => {
        try {
          await this.plugin.setRelationshipEmailNotificationsEnabled(!emailEnabled);
          new Notice(!emailEnabled ? 'Email-уведомления включены' : 'Email-уведомления выключены');
          await this.render();
        } catch (e) { new Notice(`Не удалось изменить email-уведомления: ${e.message || e}`); }
      };
    }
  }

  async renderMessages(container, messages, prefs) {
    const me = this.plugin.relationshipSession.user.id;
    const prefMap = new Map(prefs.map(p => [p.user_id, p.accent_color]));
    const lastOwnNewReplyAt = messages.filter(m => m.author_id === me).reduce((max, m) => Math.max(max, +new Date(m.created_at)), 0);
    const list = container.createDiv({ cls: 'compass-message-list' });
    if (!messages.length) list.createEl('p', { text: 'Продолжения пока нет. Можно написать первый комментарий.', cls: 'setting-item-description' });
    for (const msg of messages) {
      const isOwn = msg.author_id === me;
      const text = await this.plugin.decryptRelationshipText(msg);
      const color = prefMap.get(msg.author_id) || (isOwn ? 'blue' : 'green');
      const effectiveAt = Math.max(+new Date(msg.created_at), +new Date(msg.updated_at || msg.created_at));
      const waitingForMe = !isOwn && effectiveAt > lastOwnNewReplyAt;
      const edited = msg.updated_at && Math.abs(new Date(msg.updated_at) - new Date(msg.created_at)) > 3000;
      const card = list.createDiv({ cls: `compass-message-card compass-author-${color}${waitingForMe ? ' is-awaiting-response' : ''}` });
      const head = card.createDiv({ cls: 'compass-message-head' });
      head.createEl('strong', { text: isOwn ? 'Я' : 'Партнёр' });
      head.createEl('small', { text: moment(msg.created_at).format('DD.MM.YYYY HH:mm') + (edited ? ` · изменено ${moment(msg.updated_at).format('DD.MM.YYYY HH:mm')}` : '') });
      card.createEl('div', { text, cls: 'compass-perspective-text' });
      if (isOwn && this.situation.status === 'open') {
        const edit = card.createEl('button', { text: '✎ Изменить', cls: 'compass-inline-action' });
        edit.onclick = () => new RelationshipEditTextModal(this.app, this.plugin, 'Изменить сообщение', text, async value => {
          await this.plugin.updateRelationshipMessage(msg.id, value);
          await this.render();
        }).open();
      }
    }
  }

  async renderDiscussionActions(container, messages) {
    const me = this.plugin.relationshipSession.user.id;
    if (this.situation.status === 'closed') {
      const closed = container.createDiv({ cls: 'compass-closed-card' });
      closed.createEl('strong', { text: '🔒 Тема закрыта' });
      closed.createEl('p', { text: 'Обсуждение зафиксировано. Новые сообщения и изменения больше недоступны.' });
      return;
    }

    if (this.situation.status === 'close_requested') {
      const requesterIsMe = this.situation.close_requested_by === me;
      const closeCard = container.createDiv({ cls: 'compass-close-request-card' });
      closeCard.createEl('strong', { text: requesterIsMe ? 'Закрытие предложено' : 'Партнёр предлагает закрыть тему' });
      closeCard.createEl('p', { text: requesterIsMe ? 'Ждём решения партнёра.' : 'Если разговор завершён, подтверди закрытие. Иначе продолжи обсуждение.' });
      const actions = closeCard.createDiv({ cls: 'compass-section-actions' });
      if (!requesterIsMe) {
        const confirm = actions.createEl('button', { text: '🔒 Закрыть тему', cls: 'mod-cta' });
        confirm.onclick = async () => {
          if (!window.confirm('После закрытия тему нельзя будет редактировать или продолжать. Закрыть?')) return;
          try { await this.plugin.confirmCloseRelationshipTopic(this.situation.id); await this.render(); }
          catch (e) { new Notice(`Не удалось закрыть: ${e.message || e}`); }
        };
      }
      const cancel = actions.createEl('button', { text: requesterIsMe ? 'Отменить предложение' : 'Продолжить обсуждение' });
      cancel.onclick = async () => {
        try { await this.plugin.cancelCloseRelationshipTopic(this.situation.id); await this.render(); }
        catch (e) { new Notice(`Не удалось продолжить: ${e.message || e}`); }
      };
      return;
    }

    const actions = container.createDiv({ cls: 'compass-section-actions compass-discussion-actions' });
    const reply = actions.createEl('button', { text: 'Ответить', cls: 'mod-cta' });
    reply.onclick = () => {
      new RelationshipReplyModal(this.app, this.plugin, this.situation.id, async () => {
        await this.render();
      }).open();
    };

    const requestClose = actions.createEl('button', { text: '🔒 Предложить закрыть тему' });
    requestClose.onclick = async () => {
      if (!window.confirm('Предложить партнёру закрыть эту тему?')) return;
      try { await this.plugin.requestCloseRelationshipTopic(this.situation.id); await this.render(); }
      catch (e) { new Notice(`Не удалось предложить закрытие: ${e.message || e}`); }
    };
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupDictation) this.cleanupDictation();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}


class SharedCalendarItemModal extends Modal {
  constructor(app, plugin, dateString, onDone, existingItem = null, initialText = '') {
    super(app);
    this.plugin = plugin;
    this.dateString = dateString;
    this.onDone = onDone;
    this.existingItem = existingItem;
    this.value = initialText || '';
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
    contentEl.addClass('compass-shared-calendar-editor');
    contentEl.createEl('h2', { text: this.existingItem ? 'Изменить план' : 'Добавить в план' });
    contentEl.createEl('div', { text: moment(this.dateString, 'YYYY-MM-DD').format('D MMMM YYYY'), cls: 'compass-shared-calendar-editor-date' });

    const textarea = contentEl.createEl('textarea', {
      cls: 'compass-situation-textarea',
      attr: { placeholder: 'Что нужно сделать?' }
    });
    textarea.value = this.value;
    textarea.addEventListener('input', () => { this.value = textarea.value; });

    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    actions.createEl('button', { text: 'Отмена' }).onclick = () => this.close();
    const save = actions.createEl('button', { text: this.existingItem ? 'Сохранить' : 'Добавить', cls: 'mod-cta' });
    save.onclick = async () => {
      const value = this.value.trim();
      if (!value) return new Notice('Напиши пункт плана');
      save.disabled = true;
      try {
        if (this.existingItem) await this.plugin.updateSharedCalendarItem(this.existingItem.id, value);
        else await this.plugin.addSharedCalendarItem(this.dateString, value);
        this.close();
        if (this.onDone) await this.onDone();
      } catch (e) {
        new Notice(`Не удалось сохранить: ${e.message || e}`);
        save.disabled = false;
      }
    };
    setTimeout(() => textarea.focus(), 80);
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}

class SharedCalendarModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.visibleMonth = moment().startOf('month');
    this.selectedDate = moment().format('YYYY-MM-DD');
  }

  async onOpen() { await this.render(); }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('compass-shared-calendar-modal');

    const header = contentEl.createDiv({ cls: 'compass-shared-calendar-top' });
    header.createEl('h2', { text: '📅 Общий календарь' });
    const refresh = header.createEl('button', { text: '↻', attr: { 'aria-label': 'Обновить календарь' } });
    refresh.onclick = () => this.render();

    const loading = contentEl.createEl('p', { text: 'Загружаю календарь…', cls: 'setting-item-description' });
    try {
      const monthStart = this.visibleMonth.clone().startOf('month').format('YYYY-MM-DD');
      const monthEnd = this.visibleMonth.clone().endOf('month').format('YYYY-MM-DD');
      const items = await this.plugin.getSharedCalendarItems(monthStart, monthEnd);
      loading.remove();

      const itemsByDate = new Map();
      for (const item of items) {
        if (!itemsByDate.has(item.calendar_date)) itemsByDate.set(item.calendar_date, []);
        itemsByDate.get(item.calendar_date).push(item);
      }

      const calendar = contentEl.createDiv({ cls: 'compass-shared-calendar-grid-wrap' });
      const monthHeader = calendar.createDiv({ cls: 'compass-calendar-header' });
      const prev = monthHeader.createEl('button', { cls: 'compass-calendar-nav', attr: { 'aria-label': 'Предыдущий месяц' } });
      setIcon(prev, 'chevron-left');
      prev.onclick = async () => { this.visibleMonth.subtract(1, 'month'); this.selectedDate = this.visibleMonth.clone().startOf('month').format('YYYY-MM-DD'); await this.render(); };
      monthHeader.createEl('strong', { text: this.visibleMonth.format('MMMM YYYY') });
      const next = monthHeader.createEl('button', { cls: 'compass-calendar-nav', attr: { 'aria-label': 'Следующий месяц' } });
      setIcon(next, 'chevron-right');
      next.onclick = async () => { this.visibleMonth.add(1, 'month'); this.selectedDate = this.visibleMonth.clone().startOf('month').format('YYYY-MM-DD'); await this.render(); };

      const weekdays = calendar.createDiv({ cls: 'compass-weekdays' });
      moment.localeData().weekdaysMin(true).forEach(day => weekdays.createSpan({ text: day }));
      const grid = calendar.createDiv({ cls: 'compass-days-grid' });
      const start = this.visibleMonth.clone().startOf('month').startOf('week');
      const today = moment().format('YYYY-MM-DD');
      for (let i = 0; i < 42; i += 1) {
        const date = start.clone().add(i, 'day');
        const ds = date.format('YYYY-MM-DD');
        const button = grid.createEl('button', { text: String(date.date()), cls: 'compass-day-button compass-shared-calendar-day' });
        if (date.month() !== this.visibleMonth.month()) button.addClass('is-outside-month');
        if (ds === today) button.addClass('is-today');
        if (ds === this.selectedDate) button.addClass('is-selected');
        if ((itemsByDate.get(ds) || []).length) button.addClass('has-shared-items');
        button.onclick = async () => {
          this.selectedDate = ds;
          if (date.month() !== this.visibleMonth.month()) this.visibleMonth = date.clone().startOf('month');
          await this.render();
        };
      }

      const dayItems = itemsByDate.get(this.selectedDate) || [];
      const dayHeader = contentEl.createDiv({ cls: 'compass-shared-calendar-day-header' });
      const dayTitle = dayHeader.createDiv();
      dayTitle.createEl('strong', { text: moment(this.selectedDate, 'YYYY-MM-DD').format('D MMMM') });
      dayTitle.createEl('small', { text: moment(this.selectedDate, 'YYYY-MM-DD').format('dddd') });
      const add = dayHeader.createEl('button', { text: '＋ Добавить', cls: 'mod-cta' });
      add.onclick = () => new SharedCalendarItemModal(this.app, this.plugin, this.selectedDate, () => this.render()).open();

      const list = contentEl.createDiv({ cls: 'compass-shared-calendar-list' });
      if (!dayItems.length) {
        list.createEl('p', { text: 'На этот день общего плана пока нет.', cls: 'setting-item-description' });
      }

      const me = this.plugin.relationshipSession?.user?.id;
      for (const item of dayItems) {
        let decoded = '';
        try { decoded = await this.plugin.decryptRelationshipText(item); }
        catch (_) { decoded = 'Не удалось расшифровать запись'; }
        const row = list.createDiv({ cls: `compass-shared-calendar-item${item.is_completed ? ' is-completed' : ''}` });
        const check = row.createEl('button', { text: item.is_completed ? '☑' : '☐', cls: 'compass-shared-calendar-check', attr: { 'aria-label': item.is_completed ? 'Вернуть в план' : 'Отметить выполненным' } });
        check.onclick = async () => {
          try { await this.plugin.setSharedCalendarItemCompleted(item.id, !item.is_completed); await this.render(); }
          catch (e) { new Notice(`Не удалось изменить: ${e.message || e}`); }
        };
        const body = row.createDiv({ cls: 'compass-shared-calendar-item-body' });
        body.createDiv({ text: decoded, cls: 'compass-shared-calendar-item-text' });
        body.createEl('small', { text: item.created_by === me ? 'Добавил(а): я' : 'Добавил(а): партнёр' });
        const itemActions = row.createDiv({ cls: 'compass-shared-calendar-item-actions' });
        const edit = itemActions.createEl('button', { text: '✎', attr: { 'aria-label': 'Изменить' } });
        edit.onclick = () => new SharedCalendarItemModal(this.app, this.plugin, this.selectedDate, () => this.render(), item, decoded).open();
        const remove = itemActions.createEl('button', { text: '×', attr: { 'aria-label': 'Удалить' } });
        remove.onclick = async () => {
          if (!window.confirm('Удалить этот пункт из общего календаря?')) return;
          try { await this.plugin.deleteSharedCalendarItem(item.id); await this.render(); }
          catch (e) { new Notice(`Не удалось удалить: ${e.message || e}`); }
        };
      }
    } catch (e) {
      loading.setText(`Не удалось открыть календарь: ${e.message || e}`);
    }
  }

  onClose() { this.contentEl.empty(); }
}

class RelationshipsModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() { await this.render(); }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('compass-relationships-modal');

    const header = contentEl.createDiv({ cls: 'compass-library-header' });
    header.createEl('h2', { text: '❤️ Отношения' });
    const add = header.createEl('button', { text: '＋ Новая тема', cls: 'mod-cta' });
    add.onclick = () => new NewRelationshipSituationModal(this.app, this.plugin, () => this.render()).open();

    contentEl.createEl('p', {
      text: 'Несколько параллельных тем. Первые позиции скрыты до завершения обеими сторонами, затем разговор можно продолжать.',
      cls: 'setting-item-description'
    });

    const loading = contentEl.createEl('p', { text: 'Загружаю…' });
    try {
      const situations = await this.plugin.getRelationshipSituations();
      const summaries = [];
      for (const situation of situations) summaries.push(await this.plugin.getRelationshipSituationSummary(situation));
      summaries.sort((a, b) => (a.priority - b.priority) || (b.activityAt - a.activityAt));
      loading.remove();
      if (!summaries.length) {
        contentEl.createEl('p', { text: 'Здесь пока нет тем.' });
        return;
      }
      const waitingCount = summaries.filter(s => s.priority === 0).length;
      if (waitingCount) contentEl.createEl('div', { text: `● Ждут твоего ответа: ${waitingCount}`, cls: 'compass-waiting-count' });
      const list = contentEl.createDiv({ cls: 'compass-situations-list' });
      for (const summary of summaries) {
        const { situation, statusText, priority } = summary;
        const title = await this.plugin.decodeRelationshipTitle(situation.title, situation);
        const row = list.createEl('button', { cls: `compass-situation-row priority-${priority}` });
        const top = row.createDiv({ cls: 'compass-topic-row-top' });
        top.createEl('strong', { text: title || `Тема от ${moment(situation.created_at).format('DD.MM.YYYY')}` });
        top.createEl('span', { text: moment(situation.created_at).format('DD.MM.YYYY') });
        row.createEl('small', { text: statusText });
        row.onclick = () => new RelationshipSituationModal(this.app, this.plugin, situation).open();
      }
    } catch (e) {
      loading.setText(`Ошибка подключения: ${e.message || e}`);
    }
  }

  onClose() { this.contentEl.empty(); }
}


class CompassUpdateModal extends Modal {
  constructor(app, plugin, manifest) {
    super(app);
    this.plugin = plugin;
    this.manifest = manifest;
    this.busy = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('compass-update-modal');
    contentEl.createEl('h2', { text: `Обновление Compass ${this.manifest.version}` });
    const notes = Array.isArray(this.manifest.releaseNotes) ? this.manifest.releaseNotes : [];
    if (notes.length) {
      const list = contentEl.createEl('ul');
      notes.forEach(note => list.createEl('li', { text: String(note) }));
    }
    contentEl.createEl('p', {
      text: this.manifest.touchesUserData
        ? 'Это обновление заявляет изменение пользовательских данных. Автоматическая установка заблокирована до отдельной безопасной миграции.'
        : 'Обновятся только системные файлы Compass. Заметки, дневники, вложения и данные «Отношений» не входят в пакет обновления.',
      cls: 'setting-item-description'
    });
    if (this.manifest.requiresSupabaseMigration) {
      contentEl.createEl('p', { text: '⚠️ Для этой версии также требуется миграция Supabase. Автоматически она не выполняется.', cls: 'setting-item-description' });
    }
    const actions = contentEl.createDiv({ cls: 'compass-update-actions' });
    const cancel = actions.createEl('button', { text: 'Отмена' });
    cancel.onclick = () => this.close();
    if (!this.manifest.touchesUserData && !this.manifest.requiresSupabaseMigration) {
      const noBackup = actions.createEl('button', { text: 'Обновить без копии' });
      noBackup.onclick = () => this.install(false);
      const withBackup = actions.createEl('button', { text: 'Создать копию и обновить', cls: 'mod-cta' });
      withBackup.onclick = () => this.install(true);
    }
  }

  async install(createBackup) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.plugin.installCompassUpdate(this.manifest, createBackup);
      this.close();
    } catch (e) {
      console.error('Compass update failed', e);
      new Notice(`Обновление не установлено: ${e.message || e}`);
      this.busy = false;
    }
  }

  onClose() { this.contentEl.empty(); }
}

class CompassSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    attachMobileKeyboardDismiss(containerEl);
    containerEl.createEl('h2', { text: 'Compass' });
    containerEl.createEl('h3', { text: '🧭 Система и обновления' });
    containerEl.createEl('p', {
      text: 'Начиная с Compass 1.5 код плагина и пользовательские данные разделены. Обновление Compass не требует нового vault и не должно затрагивать заметки, дневники, вложения или созданные тобой разделы.',
      cls: 'setting-item-description'
    });

    new Setting(containerEl)
      .setName('Версия Compass')
      .setDesc(`Плагин ${COMPASS_PLUGIN_VERSION} · схема данных ${this.plugin.dataSchemaVersion || COMPASS_DATA_SCHEMA_VERSION}`);

    new Setting(containerEl)
      .setName('Канал обновлений')
      .setDesc('Проверяет публичный GitHub-канал Campass-update. В обновления не входят пользовательские заметки, вложения, пароли или ключ шифрования.')
      .addButton(button => button
        .setButtonText('Проверить обновления')
        .onClick(async () => {
          button.setDisabled(true).setButtonText('Проверяю…');
          try { await this.plugin.checkForCompassUpdates({ openModal: true, silent: false }); }
          finally { button.setDisabled(false).setButtonText('Проверить обновления'); }
        }));

    new Setting(containerEl)
      .setName('Автопроверка обновлений')
      .setDesc('Только проверяет наличие новой версии при запуске. Установка всегда требует твоего подтверждения.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.updateSettings?.autoCheck !== false)
        .onChange(async value => {
          this.plugin.updateSettings.autoCheck = value;
          await this.plugin.saveCompassData();
        }));

    new Setting(containerEl)
      .setName('Формат дат в журналах')
      .setDesc('Новые ссылки показываются как ДД.ММ.ГГГГ, при этом техническое имя дневного файла остаётся YYYY-MM-DD.')
      .addButton(button => button
        .setButtonText('Обновить старые ссылки')
        .onClick(async () => {
          const changed = await this.plugin.migrateJournalDateAliases();
          new Notice(changed ? `Обновлено журналов: ${changed}` : 'Старых дат для изменения не найдено');
        }));

    containerEl.createEl('h3', { text: '❤️ Общее пространство' });
    containerEl.createEl('p', {
      text: 'Здесь сохраняются только технические данные подключения. Пароль и ключ шифрования Compass на диск не сохраняет.',
      cls: 'setting-item-description'
    });

    new Setting(containerEl)
      .setName('Supabase Project URL')
      .setDesc('Адрес вида https://xxxxx.supabase.co')
      .addText(text => text
        .setPlaceholder('https://…supabase.co')
        .setValue(this.plugin.relationshipSettings.projectUrl || '')
        .onChange(async value => {
          this.plugin.relationshipSettings.projectUrl = value.trim().replace(/\/$/, '');
          await this.plugin.saveCompassData();
        }));

    new Setting(containerEl)
      .setName('Publishable key')
      .setDesc('Только sb_publishable_… Не вставляй secret/service_role key.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('sb_publishable_…');
        text.setValue(this.plugin.relationshipSettings.publishableKey || '');
        text.onChange(async value => {
          this.plugin.relationshipSettings.publishableKey = value.trim();
          await this.plugin.saveCompassData();
        });
      });

    new Setting(containerEl)
      .setName('Email пользователя')
      .setDesc('Email твоего User 1 в Supabase Auth.')
      .addText(text => text
        .setPlaceholder('you@example.com')
        .setValue(this.plugin.relationshipSettings.email || '')
        .onChange(async value => {
          this.plugin.relationshipSettings.email = value.trim();
          await this.plugin.saveCompassData();
        }));

    new Setting(containerEl)
      .setName('Завершить текущий сеанс')
      .setDesc('Удаляет пароль, access token и ключ шифрования из памяти приложения.')
      .addButton(button => button.setButtonText('Выйти').onClick(() => {
        this.plugin.clearSharedSessionCache();
        new Notice('Сеанс общего пространства завершён');
      }));
  }
}

class CompassSidebarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.visibleMonth = moment().startOf('month');
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Компас'; }
  getIcon() { return 'compass'; }
  async onOpen() {
    this.principleIndex = 0;
    this.render();
    this.principleTimer = window.setInterval(() => this.showNextPrinciple(), 60000);
  }

  async onClose() {
    if (this.principleTimer) window.clearInterval(this.principleTimer);
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('compass-sidebar');

    const title = container.createDiv({ cls: 'compass-sidebar-title' });
    const icon = title.createSpan({ cls: 'compass-logo' });
    setIcon(icon, 'compass');
    title.createSpan({ text: 'Компас' });

    const principleCard = container.createDiv({ cls: 'compass-principle-card' });
    principleCard.createDiv({ text: '🧭 Принцип', cls: 'compass-principle-label' });
    this.principleTextEl = principleCard.createDiv({ text: 'Загружаю принципы…', cls: 'compass-principle-text' });
    principleCard.onclick = () => this.plugin.openTarget('03 Журналы/Принципы.md');
    this.refreshPrinciple();

    const todayButton = container.createEl('button', { text: 'Открыть сегодня', cls: 'compass-today-button' });
    todayButton.onclick = () => this.plugin.openDate(moment());

    const calendar = container.createDiv({ cls: 'compass-calendar' });
    const header = calendar.createDiv({ cls: 'compass-calendar-header' });
    const previous = header.createEl('button', { cls: 'compass-calendar-nav', attr: { 'aria-label': 'Предыдущий месяц' } });
    setIcon(previous, 'chevron-left');
    previous.onclick = () => { this.visibleMonth.subtract(1, 'month'); this.render(); };
    header.createEl('strong', { text: this.visibleMonth.format('MMMM YYYY') });
    const next = header.createEl('button', { cls: 'compass-calendar-nav', attr: { 'aria-label': 'Следующий месяц' } });
    setIcon(next, 'chevron-right');
    next.onclick = () => { this.visibleMonth.add(1, 'month'); this.render(); };

    const weekdays = calendar.createDiv({ cls: 'compass-weekdays' });
    moment.localeData().weekdaysMin(true).forEach(day => weekdays.createSpan({ text: day }));

    const grid = calendar.createDiv({ cls: 'compass-days-grid' });
    const start = this.visibleMonth.clone().startOf('month').startOf('week');
    const today = moment().format('YYYY-MM-DD');
    for (let i = 0; i < 42; i += 1) {
      const date = start.clone().add(i, 'day');
      const dateString = date.format('YYYY-MM-DD');
      const button = grid.createEl('button', { text: String(date.date()), cls: 'compass-day-button' });
      if (date.month() !== this.visibleMonth.month()) button.addClass('is-outside-month');
      if (dateString === today) button.addClass('is-today');
      if (this.plugin.hasDaily(dateString)) button.addClass('has-note');
      button.onclick = () => this.plugin.openDate(date);
    }

    this.addDivider(container, 'Журналы');
    const journalNav = container.createDiv({ cls: 'compass-nav' });
    this.addNavButton(journalNav, '🏠', 'Главная', () => this.plugin.openTarget('Главная.md'));
    BUILTIN_JOURNALS.forEach(([emoji, name]) => {
      const id = `journal:${name}`;
      if (this.plugin.isBuiltinHidden(id)) return;
      const section = { source: 'builtin', builtinId: id, type: 'journal', emoji, name, journal: name };
      this.addNavButton(journalNav, emoji, name, () => this.plugin.openTarget(`03 Журналы/${name}.md`), () => this.plugin.manageSection(section));
    });
    this.plugin.getCustomJournals().forEach(section => {
      const descriptor = { ...section, source: 'custom' };
      this.addNavButton(journalNav, section.emoji, section.name, () => this.plugin.openTarget(`03 Журналы/${section.journal}.md`), () => this.plugin.manageSection(descriptor));
    });

    this.addDivider(container, 'Общее');
    const sharedNav = container.createDiv({ cls: 'compass-nav compass-shared-nav' });
    this.addNavButton(sharedNav, '❤️', 'Отношения', () => this.plugin.openRelationships());
    this.addNavButton(sharedNav, '📅', 'Календарь', () => this.plugin.openSharedCalendar());

    this.addDivider(container, 'Базы знаний');
    const libraryNav = container.createDiv({ cls: 'compass-nav' });
    const libraryId = 'library:Книги и видео';
    if (!this.plugin.isBuiltinHidden(libraryId)) {
      const section = { source: 'builtin', builtinId: libraryId, type: 'library', emoji: '📚', name: 'Книги и видео', folder: '02 Книги и видео' };
      this.addNavButton(libraryNav, '📚', 'Книги и видео', () => this.plugin.openLibrary('02 Книги и видео', '📚', 'Книги и видео'), () => this.plugin.manageSection(section));
    }
    this.plugin.getCustomLibraries().forEach(section => {
      const descriptor = { ...section, source: 'custom' };
      this.addNavButton(libraryNav, section.emoji, section.name, () => this.plugin.openLibrary(section.folder, section.emoji, section.name), () => this.plugin.manageSection(descriptor));
    });
    this.addNavButton(libraryNav, '📦', 'Архив', () => this.plugin.openArchive());

    const addSectionButton = container.createEl('button', { text: '＋ Добавить раздел', cls: 'compass-sidebar-add' });
    addSectionButton.onclick = () => this.plugin.openAddSection();
    const hint = container.createEl('div', { text: 'Удерживай раздел, чтобы перенести его в Архив.', cls: 'compass-sidebar-hint' });
  }

  async refreshPrinciple() {
    const principles = await this.plugin.getPrinciples();
    if (!this.principleTextEl) return;
    if (!principles.length) {
      this.principleTextEl.setText('Добавь первый принцип, и он появится здесь.');
      return;
    }
    this.principleIndex = Math.min(this.principleIndex || 0, principles.length - 1);
    this.principleTextEl.setText(principles[this.principleIndex]);
  }

  async showNextPrinciple() {
    const principles = await this.plugin.getPrinciples();
    if (!this.principleTextEl || !principles.length) return;
    this.principleIndex = ((this.principleIndex || 0) + 1) % principles.length;
    this.principleTextEl.addClass('is-changing');
    window.setTimeout(() => {
      if (!this.principleTextEl) return;
      this.principleTextEl.setText(principles[this.principleIndex]);
      this.principleTextEl.removeClass('is-changing');
    }, 180);
  }

  addDivider(container, text) {
    const divider = container.createDiv({ cls: 'compass-divider' });
    divider.createSpan({ text });
  }

  addNavButton(parent, emoji, label, onClick, onManage = null) {
    const button = parent.createEl('button', { cls: 'compass-nav-button' });
    button.createSpan({ text: emoji, cls: 'compass-nav-emoji' });
    button.createSpan({ text: label });

    let longPressTimer = null;
    let suppressClick = false;
    const cancelLongPress = () => {
      if (longPressTimer) window.clearTimeout(longPressTimer);
      longPressTimer = null;
    };

    button.onclick = event => {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        return;
      }
      onClick();
    };

    if (onManage) {
      button.addEventListener('contextmenu', event => {
        event.preventDefault();
        onManage();
      });
      button.addEventListener('touchstart', () => {
        cancelLongPress();
        longPressTimer = window.setTimeout(() => {
          suppressClick = true;
          onManage();
        }, 600);
      }, { passive: true });
      button.addEventListener('touchend', cancelLongPress, { passive: true });
      button.addEventListener('touchcancel', cancelLongPress, { passive: true });
      button.addEventListener('touchmove', cancelLongPress, { passive: true });
    }
  }
}


/* Compass 2.2.0: configurable knowledge-base workflows */
class CompassRenameModal extends Modal {
  constructor(app, plugin, title, initialValue, onSave) {
    super(app); this.plugin = plugin; this.title = title; this.value = initialValue || ''; this.onSave = onSave;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.title });
    new Setting(contentEl).setName('Название').addText(input => {
      input.setValue(this.value); input.onChange(v => { this.value = v.trim(); });
      setTimeout(() => input.inputEl.focus(), 50);
    });
    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    actions.createEl('button', { text: 'Отмена' }).onclick = () => this.close();
    const save = actions.createEl('button', { text: 'Сохранить', cls: 'mod-cta' });
    save.onclick = async () => {
      if (!this.value) return new Notice('Название не может быть пустым');
      try { await this.onSave(this.value); this.close(); } catch (e) { new Notice(`Не удалось сохранить: ${e.message || e}`); }
    };
  }
}

class CompassLibraryFolderSettingsModal extends Modal {
  constructor(app, plugin, folderPath, label, onDone) {
    super(app); this.plugin = plugin; this.folderPath = folderPath; this.label = label; this.onDone = onDone;
  }
  onOpen() { this.render(); }
  render() {
    const { contentEl } = this; contentEl.empty();
    const feature = this.plugin.getLibraryFeature(this.folderPath);
    contentEl.createEl('h2', { text: `⚙️ ${this.label}` });
    contentEl.createEl('p', { text: 'Все функции ниже необязательны и действуют только для этой папки.', cls: 'setting-item-description' });
    new Setting(contentEl).setName('Показывать в ежедневнике').setDesc('Позволяет выбрать эту папку через «＋ Добавить блок → 📚 База знаний».').addToggle(t => t.setValue(!!feature.showInDaily).onChange(v => this.plugin.setLibraryFeature(this.folderPath, { showInDaily: v })));
    new Setting(contentEl).setName('Собирать записи из дней').setDesc('В папке появятся ссылки на записи, созданные из ежедневника. Исходный текст остаётся в дневной заметке.').addToggle(t => t.setValue(!!feature.collectDaily).onChange(v => this.plugin.setLibraryFeature(this.folderPath, { collectDaily: v })));
    new Setting(contentEl).setName('Показывать чекбоксы').setDesc('Удобно для «Для хендовера»: пункт можно отметить выполненным, не удаляя дневную запись.').addToggle(t => t.setValue(!!feature.checklistMode).onChange(v => this.plugin.setLibraryFeature(this.folderPath, { checklistMode: v })));
    new Setting(contentEl).setName('Формировать папки по периодам').setDesc('Добавляет кнопку, которая собирает связанные записи за выбранный диапазон дат в отдельную подпапку.').addToggle(t => t.setValue(!!feature.periodGrouping).onChange(v => this.plugin.setLibraryFeature(this.folderPath, { periodGrouping: v })));
    const done = contentEl.createEl('button', { text: 'Готово', cls: 'mod-cta' });
    done.onclick = () => { this.close(); if (this.onDone) this.onDone(); };
  }
}

class CompassLibraryItemActionsModal extends Modal {
  constructor(app, plugin, item, onDone) { super(app); this.plugin = plugin; this.item = item; this.onDone = onDone; }
  onOpen() {
    const { contentEl } = this; const isFolder = Array.isArray(this.item.children); const name = isFolder ? this.item.name : this.item.basename;
    contentEl.createEl('h2', { text: `${isFolder ? '📁' : '📄'} ${name}` });
    const rename = contentEl.createEl('button', { text: '✏️ Переименовать', cls: 'compass-secondary-action' });
    rename.onclick = () => new CompassRenameModal(this.app, this.plugin, 'Переименовать', name, async value => {
      await this.plugin.renameLibraryItem(this.item, value); this.close(); if (this.onDone) this.onDone();
    }).open();
    if (isFolder) {
      const settings = contentEl.createEl('button', { text: '⚙️ Настройки папки', cls: 'compass-secondary-action' });
      settings.onclick = () => new CompassLibraryFolderSettingsModal(this.app, this.plugin, this.item.path, this.item.name, () => { this.close(); if (this.onDone) this.onDone(); }).open();
    } else {
      const convert = contentEl.createEl('button', { text: '📁 Превратить заметку в папку', cls: 'compass-secondary-action' });
      convert.onclick = async () => {
        if (!window.confirm('Создать папку с этим названием? Текст заметки, если он есть, будет сохранён внутри новой папки.')) return;
        try { await this.plugin.convertLibraryNoteToFolder(this.item); this.close(); if (this.onDone) this.onDone(); } catch (e) { new Notice(`Не удалось преобразовать: ${e.message || e}`); }
      };
    }
    const remove = contentEl.createEl('button', { text: isFolder ? '🗑 Удалить папку' : '🗑 Удалить заметку', cls: 'compass-danger-action' });
    remove.onclick = async () => {
      const children = isFolder && Array.isArray(this.item.children) ? this.item.children.length : 0;
      const warning = children ? `Внутри папки ${children} элемент(ов). Удалить папку вместе со всем содержимым? Дневные записи останутся.` : `Удалить «${name}»?`;
      if (!window.confirm(warning)) return;
      try { await this.plugin.deleteLibraryItem(this.item); this.close(); if (this.onDone) this.onDone(); } catch (e) { new Notice(`Не удалось удалить: ${e.message || e}`); }
    };
    contentEl.createEl('button', { text: 'Отмена', cls: 'compass-secondary-action' }).onclick = () => this.close();
  }
}

class CompassPeriodModal extends Modal {
  constructor(app, plugin, path, onDone) { super(app); this.plugin = plugin; this.path = path; this.onDone = onDone; this.start = ''; this.end = ''; }
  onOpen() {
    const { contentEl } = this; contentEl.createEl('h2', { text: '🗓 Сформировать период' });
    contentEl.createEl('p', { text: 'Создаст подпапку с диапазоном дат и перенесёт туда только ссылки на связанные записи. Сами дневные заметки останутся на месте.', cls: 'setting-item-description' });
    new Setting(contentEl).setName('Начало').addText(i => { i.inputEl.type = 'date'; i.onChange(v => this.start = v); });
    new Setting(contentEl).setName('Конец').addText(i => { i.inputEl.type = 'date'; i.onChange(v => this.end = v); });
    const actions = contentEl.createDiv({ cls: 'compass-section-actions' }); actions.createEl('button', { text: 'Отмена' }).onclick = () => this.close();
    const create = actions.createEl('button', { text: 'Сформировать', cls: 'mod-cta' });
    create.onclick = async () => {
      if (!this.start || !this.end) return new Notice('Укажи обе даты');
      if (this.end < this.start) return new Notice('Конец периода раньше начала');
      try { const count = await this.plugin.formLibraryPeriod(this.path, this.start, this.end); this.close(); new Notice(`Период создан · записей: ${count}`); if (this.onDone) this.onDone(); } catch (e) { new Notice(`Ошибка: ${e.message || e}`); }
    };
  }
}

class CompassDailyLibraryEntryModal extends Modal {
  constructor(app, plugin, targetPath) { super(app); this.plugin = plugin; this.targetPath = targetPath; this.value = ''; this.cleanupKeyboardAvoidance = null; }
  onOpen() {
    const { contentEl } = this; this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl); const name = this.targetPath.split('/').pop();
    contentEl.createEl('h2', { text: `📚 ${name}` });
    const textarea = contentEl.createEl('textarea', { cls: 'compass-situation-textarea', attr: { placeholder: 'Запиши мысль, задачу или наблюдение…' } });
    textarea.addEventListener('input', () => this.value = textarea.value); setTimeout(() => textarea.focus(), 50);
    const actions = contentEl.createDiv({ cls: 'compass-section-actions' }); actions.createEl('button', { text: 'Отмена' }).onclick = () => this.close();
    const save = actions.createEl('button', { text: 'Добавить в день', cls: 'mod-cta' });
    save.onclick = async () => { if (!this.value.trim()) return new Notice('Запись пока пустая'); save.disabled = true; try { await this.plugin.addLibraryDailyEntry(this.targetPath, this.value.trim()); this.close(); } catch (e) { save.disabled = false; new Notice(`Ошибка: ${e.message || e}`); } };
  }
  onClose() { blurActiveEditable(); if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance(); this.contentEl.empty(); }
}

class CompassLibraryTargetModal extends Modal {
  constructor(app, plugin, currentPath = null, root = null) { super(app); this.plugin = plugin; this.currentPath = currentPath; this.root = root; }
  onOpen() { this.render(); }
  render() {
    const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: '📚 Куда добавить запись?' });
    if (!this.currentPath) {
      const roots = this.plugin.getDailyLibraryRoots();
      if (!roots.length) { contentEl.createEl('p', { text: 'Сначала включи «Показывать в ежедневнике» в настройках нужной папки.' }); return; }
      const list = contentEl.createDiv({ cls: 'compass-library-list' });
      roots.forEach(section => { const b = list.createEl('button', { cls: 'compass-library-entry compass-library-folder' }); b.createSpan({ text: section.emoji || '📚' }); b.createSpan({ text: section.name, cls: 'compass-library-entry-name' }); b.createSpan({ text: '›' }); b.onclick = () => { this.root = section; this.currentPath = section.folder; this.render(); }; });
      return;
    }
    const currentName = this.currentPath.split('/').pop();
    const nav = contentEl.createDiv({ cls: 'compass-library-target-nav' }); const back = nav.createEl('button', { text: '← Назад' }); nav.createSpan({ text: currentName });
    back.onclick = () => { if (this.currentPath === this.root.folder) { this.currentPath = null; this.root = null; } else this.currentPath = this.currentPath.split('/').slice(0, -1).join('/'); this.render(); };
    if (this.plugin.getLibraryFeature(this.currentPath).showInDaily) {
      const choose = contentEl.createEl('button', { text: `✓ Выбрать «${currentName}»`, cls: 'mod-cta compass-library-target-choose' });
      choose.onclick = () => { const p = this.currentPath; this.close(); new CompassDailyLibraryEntryModal(this.app, this.plugin, p).open(); };
    }
    const folder = this.app.vault.getAbstractFileByPath(this.currentPath); const folders = folder && Array.isArray(folder.children) ? folder.children.filter(x => Array.isArray(x.children) && this.plugin.libraryHasDailyTargets(x.path)).sort((a,b) => a.name.localeCompare(b.name,'ru')) : [];
    const list = contentEl.createDiv({ cls: 'compass-library-list' });
    folders.forEach(item => { const b = list.createEl('button', { cls: 'compass-library-entry compass-library-folder' }); b.createSpan({ text: '📁' }); b.createSpan({ text: item.name, cls: 'compass-library-entry-name' }); b.createSpan({ text: '›' }); b.onclick = () => { this.currentPath = item.path; this.render(); }; });
  }
}

class CompassPrincipleManagerModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  async onOpen() { await this.render(); }
  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('compass-principle-manager-modal');
    contentEl.createEl('h2', { text: '🧭 Принципы над календарём' });
    contentEl.createEl('p', { text: 'Крестик убирает запись только из прокрутки над календарём. Исходная запись остаётся на своём месте.', cls: 'setting-item-description' });
    const visible = await this.plugin.getPrinciples();
    if (!visible.length) {
      contentEl.createEl('p', { text: 'В прокрутке сейчас нет записей.', cls: 'setting-item-description' });
      return;
    }
    for (const principle of visible) {
      const row = contentEl.createDiv({ cls: 'compass-principle-manager-row' });
      row.createDiv({ text: principle, cls: 'compass-principle-manager-text' });
      const remove = row.createEl('button', { text: '✕', cls: 'compass-principle-remove', attr: { 'aria-label': 'Убрать из показа' } });
      remove.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.plugin.setPrincipleVisible(principle, false);
        await this.render();
        this.plugin.refreshSidebar();
      };
    }
  }
}

// Extra entry in the daily chooser.
const compassChoiceBaseOnOpen = ChoiceModal.prototype.onOpen;
ChoiceModal.prototype.onOpen = function() {
  compassChoiceBaseOnOpen.call(this);
  if (!this.plugin.hasDailyLibraryTargets()) return;
  const grid = this.contentEl.querySelector('.compass-grid'); if (!grid) return;
  const button = grid.createEl('button', { text: '📚 База знаний', cls: 'compass-choice' });
  button.onclick = () => { this.close(); new CompassLibraryTargetModal(this.app, this.plugin).open(); };
};

// Keyboard protection for forms that were still hidden behind iOS keyboard.
for (const Klass of [AddSectionModal, NewDocumentModal, NewLibraryFolderModal, RelationshipSessionModal]) {
  const oldOpen = Klass.prototype.onOpen; const oldClose = Klass.prototype.onClose;
  Klass.prototype.onOpen = function() { oldOpen.call(this); this.__compass220KeyboardAvoid = attachMobileKeyboardAvoidance(this.contentEl); };
  Klass.prototype.onClose = function() { if (this.__compass220KeyboardAvoid) this.__compass220KeyboardAvoid(); if (oldClose) oldClose.call(this); };
}

// Open principle visibility manager from the rotating card.
const compassSidebarBaseRender = CompassSidebarView.prototype.render;
CompassSidebarView.prototype.render = function() {
  compassSidebarBaseRender.call(this);
  const card = this.containerEl.querySelector('.compass-principle-card');
  if (card) card.onclick = () => new CompassPrincipleManagerModal(this.app, this.plugin).open();
};

// Knowledge-base browser with per-item management and linked daily entries.
LibraryModal.prototype.render = function() {
  const { contentEl } = this; contentEl.empty(); contentEl.addClass('compass-library-modal');
  const header = contentEl.createDiv({ cls: 'compass-library-header compass-library-browser-header' }); const titleWrap = header.createDiv({ cls: 'compass-library-title-wrap' });
  titleWrap.createEl('h2', { text: `${this.emoji} ${this.currentPath === this.rootPath ? this.label : this.currentPath.split('/').pop()}` });
  if (this.currentPath !== this.rootPath) { const up = header.createEl('button', { text: '← Назад', cls: 'compass-library-back' }); up.onclick = () => { const parent = this.currentPath.split('/').slice(0,-1).join('/'); this.openFolder(parent.startsWith(this.rootPath) ? parent : this.rootPath); }; }
  this.renderBreadcrumbs(contentEl);
  const createBar = contentEl.createDiv({ cls: 'compass-library-create-bar' });
  createBar.createEl('button', { text: '＋ Папка', cls: 'mod-cta' }).onclick = () => new NewLibraryFolderModal(this.app, this.plugin, this.currentPath, () => this.render()).open();
  createBar.createEl('button', { text: '＋ Заметка' }).onclick = () => new NewDocumentModal(this.app, this.plugin, this.currentPath, async file => await this.app.workspace.getLeaf(false).openFile(file)).open();
  createBar.createEl('button', { text: '⚙️ Папка' }).onclick = () => new CompassLibraryFolderSettingsModal(this.app, this.plugin, this.currentPath, this.currentPath.split('/').pop(), () => this.render()).open();
  if (this.plugin.getLibraryFeature(this.currentPath).periodGrouping) createBar.createEl('button', { text: '🗓 Период' }).onclick = () => new CompassPeriodModal(this.app, this.plugin, this.currentPath, () => this.render()).open();
  const folder = this.app.vault.getAbstractFileByPath(this.currentPath); const children = folder && Array.isArray(folder.children) ? [...folder.children] : [];
  const folders = children.filter(i => Array.isArray(i.children)).sort((a,b)=>a.name.localeCompare(b.name,'ru')); const files = children.filter(i => i.extension === 'md' && !/^README$/i.test(i.basename)).sort((a,b)=>a.basename.localeCompare(b.basename,'ru')); const linked = this.plugin.getLibraryDailyLinks(this.currentPath);
  if (!folders.length && !files.length && !linked.length) { contentEl.createEl('p', { text: 'Папка пока пустая.', cls: 'setting-item-description' }); return; }
  const list = contentEl.createDiv({ cls: 'compass-library-list compass-library-tree-list' });
  const attachManage = (button, item) => { let timer=null, suppress=false; const clear=()=>{ if(timer) window.clearTimeout(timer); timer=null; }; button.addEventListener('contextmenu', e=>{e.preventDefault(); new CompassLibraryItemActionsModal(this.app,this.plugin,item,()=>this.render()).open();}); button.addEventListener('touchstart',()=>{clear();timer=window.setTimeout(()=>{suppress=true;new CompassLibraryItemActionsModal(this.app,this.plugin,item,()=>this.render()).open();},600);},{passive:true}); for(const ev of ['touchend','touchcancel','touchmove']) button.addEventListener(ev,clear,{passive:true}); return ()=>{if(suppress){suppress=false;return true;}return false;}; };
  folders.forEach(item=>{ const b=list.createEl('button',{cls:'compass-library-entry compass-library-folder'}); b.createSpan({text:'📁',cls:'compass-library-entry-icon'}); b.createSpan({text:item.name,cls:'compass-library-entry-name'}); b.createSpan({text:'›',cls:'compass-library-entry-chevron'}); const sup=attachManage(b,item); b.onclick=()=>{if(!sup())this.openFolder(item.path);}; });
  files.forEach(file=>{ const b=list.createEl('button',{cls:'compass-library-entry compass-library-note'}); b.createSpan({text:'📄',cls:'compass-library-entry-icon'}); b.createSpan({text:file.basename,cls:'compass-library-entry-name'}); const sup=attachManage(b,file); b.onclick=async()=>{if(sup())return;this.close();await this.app.workspace.getLeaf(false).openFile(file);}; });
  if (linked.length) { contentEl.createEl('h3',{text:'Записи из дней',cls:'compass-library-linked-title'}); const feature=this.plugin.getLibraryFeature(this.currentPath); const linkedList=contentEl.createDiv({cls:`compass-library-linked-list${feature.checklistMode ? ' is-checklist' : ''}`}); linked.forEach(link=>{ const row=linkedList.createDiv({cls:`compass-library-linked-row${link.checked?' is-checked':''}`}); if(feature.checklistMode){const c=row.createEl('input',{type:'checkbox'});c.checked=!!link.checked;c.onchange=async()=>{await this.plugin.setLibraryDailyLinkChecked(link.id,c.checked);this.render();};} const b=row.createEl('button',{cls:'compass-library-linked-open'});b.createDiv({text:link.text||link.heading,cls:'compass-library-linked-text'});if(!feature.checklistMode)b.createEl('small',{text:formatJournalDate((link.dailyPath.split('/').pop()||'').replace(/\.md$/,''))});b.createSpan({text:'↗',cls:'compass-library-linked-arrow'});b.onclick=()=>this.plugin.openLibraryDailyLink(link); }); }
};

// Section actions: rename custom sections, configure knowledge bases, and close cleanly after archive.
SectionActionsModal.prototype.onOpen = function() {
  const { contentEl } = this; contentEl.addClass('compass-section-actions-modal'); contentEl.createEl('h2',{text:`${this.section.emoji} ${this.section.name}`});
  if (this.section.source === 'custom') { const r=contentEl.createEl('button',{text:'✏️ Переименовать',cls:'compass-secondary-action'}); r.onclick=()=>new CompassRenameModal(this.app,this.plugin,'Переименовать раздел',this.section.name,async value=>{await this.plugin.renameCustomSection(this.section,value);this.close();}).open(); }
  if (this.section.type === 'library') { const s=contentEl.createEl('button',{text:'⚙️ Настройки базы знаний',cls:'compass-secondary-action'}); s.onclick=()=>new CompassLibraryFolderSettingsModal(this.app,this.plugin,this.section.folder,this.section.name,()=>this.close()).open(); }
  const a=contentEl.createEl('button',{text:'📦 Перенести в архив',cls:'compass-danger-action'}); a.onclick=async()=>{const ok=await this.plugin.archiveSection(this.section);if(ok){blurActiveEditable();this.close();window.setTimeout(()=>this.plugin.refreshSidebar(),0);}};
  contentEl.createEl('button',{text:'Отмена',cls:'compass-secondary-action'}).onclick=()=>this.close();
};

module.exports = class CompassPlugin extends Plugin {
  async onload() {
    moment.locale('ru');
    const data = await this.loadAndMigrateCompassData();
    const raw = Array.isArray(data?.customSections) ? data.customSections : [];
    this.customSections = raw.map(section => ({
      ...section,
      type: section.type || 'journal',
      journal: section.journal || (section.type !== 'library' ? section.name : undefined),
      folder: section.folder || (section.type === 'library' ? `02 Базы знаний/${section.name}` : undefined)
    }));
    this.hiddenBuiltins = Array.isArray(data?.hiddenBuiltins) ? data.hiddenBuiltins : [];
    this.archivedSections = Array.isArray(data?.archivedSections) ? data.archivedSections : [];
    this.relationshipSettings = {
      projectUrl: data?.relationshipSettings?.projectUrl || '',
      publishableKey: data?.relationshipSettings?.publishableKey || '',
      email: data?.relationshipSettings?.email || ''
    };
    this.relationshipSession = null;
    this.sharedUnlockExpiresAt = Number(data?.sharedUnlockExpiresAt || 0);
    this.updateSettings = {
      autoCheck: data?.updateSettings?.autoCheck !== false,
      lastCheckedAt: data?.updateSettings?.lastCheckedAt || null
    };

    this.registerView(VIEW_TYPE, leaf => new CompassSidebarView(leaf, this));
    this.addRibbonIcon('compass', 'Открыть Компас', () => this.activateSidebar());
    this.addRibbonIcon('plus-circle', 'Компас: добавить блок', () => this.openChoice());

    this.addCommand({ id: 'compass-open-sidebar', name: 'Открыть календарь и разделы Компаса', callback: () => this.activateSidebar() });
    this.addCommand({ id: 'compass-add-entry', name: 'Добавить блок в сегодняшний день', callback: () => this.openChoice() });
    this.addCommand({ id: 'compass-add-section', name: 'Добавить новый раздел', callback: () => this.openAddSection() });
    this.addCommand({ id: 'compass-open-today', name: 'Открыть сегодняшний день', callback: () => this.openDate(moment()) });
    this.addCommand({ id: 'compass-open-relationships', name: 'Открыть раздел Отношения', callback: () => this.openRelationships() });
    this.addCommand({ id: 'compass-open-shared-calendar', name: 'Открыть общий календарь', callback: () => this.openSharedCalendar() });
    this.addSettingTab(new CompassSettingTab(this.app, this));

    this.registerMarkdownPostProcessor((element, context) => {
      if (!context.sourcePath.startsWith('01 Дни/')) return;
      if (element.querySelector('.compass-add-button')) return;
      const wrap = element.createDiv({ cls: 'compass-add-wrap' });
      const button = wrap.createEl('button', { text: '＋ Добавить блок', cls: 'compass-add-button' });
      button.onclick = () => this.openChoice();
    });

    this.app.workspace.onLayoutReady(() => {
      this.activateSidebar();
      if (this.updateSettings.autoCheck) {
        window.setTimeout(() => this.checkForCompassUpdates({ openModal: false, silent: true }).catch(() => {}), 4000);
      }
    });
  }

  async onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }

  async loadAndMigrateCompassData() {
    const original = (await this.loadData()) || {};
    const data = { ...original };
    let version = Number.isInteger(data.schemaVersion) ? data.schemaVersion : 1;
    let changed = false;

    // v1 -> v2: normalize plugin-owned settings only.
    // IMPORTANT: migrations never rewrite Markdown notes, journal files,
    // attachments, folders or any other user content in the vault.
    if (version < 2) {
      if (!Array.isArray(data.customSections)) data.customSections = [];
      if (!Array.isArray(data.hiddenBuiltins)) data.hiddenBuiltins = [];
      if (!Array.isArray(data.archivedSections)) data.archivedSections = [];
      data.relationshipSettings = {
        projectUrl: data.relationshipSettings?.projectUrl || '',
        publishableKey: data.relationshipSettings?.publishableKey || '',
        email: data.relationshipSettings?.email || ''
      };
      version = 2;
      changed = true;
    }

    // v2 -> v3: updater preferences only. No Markdown/user files are touched.
    if (version < 3) {
      data.updateSettings = {
        autoCheck: data.updateSettings?.autoCheck !== false,
        lastCheckedAt: data.updateSettings?.lastCheckedAt || null
      };
      version = 3;
      changed = true;
    }

    if (data.schemaVersion !== version) {
      data.schemaVersion = version;
      changed = true;
    }
    if (data.lastPluginVersion !== COMPASS_PLUGIN_VERSION) {
      data.lastPluginVersion = COMPASS_PLUGIN_VERSION;
      changed = true;
    }

    this.dataSchemaVersion = version;
    if (changed) await this.saveData(data);
    return data;
  }

  async getPrinciples() {
    const results = [];
    const seen = new Set();
    const add = value => {
      const text = String(value || '').replace(/^[-*\s]+/, '').replace(/^>\s*/, '').trim();
      if (!text || text.length < 3 || seen.has(text)) return;
      seen.add(text);
      results.push(text);
    };

    // Базовые принципы из «Конституции Компаса».
    const constitution = this.app.vault.getAbstractFileByPath('Конституция Компаса.md');
    if (constitution && constitution.extension === 'md') {
      try {
        const content = await this.app.vault.cachedRead(constitution);
        const marker = '## Мои первые принципы';
        const start = content.indexOf(marker);
        if (start >= 0) {
          const section = content.slice(start + marker.length);
          section.split('\n').forEach(line => {
            if (/^>\s+/.test(line.trim())) add(line.trim());
          });
        }
      } catch (e) { console.error('Compass: cannot read constitution principles', e); }
    }

    // Все новые принципы, которые пользователь добавляет в дневные заметки.
    const dailyFiles = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith('01 Дни/'));
    for (const file of dailyFiles) {
      try {
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        let collecting = false;
        let buffer = [];
        const flush = () => {
          if (!buffer.length) return;
          const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
          add(text);
          buffer = [];
        };
        for (const line of lines) {
          if (/^##\s+🧭\s*Принцип\s*$/.test(line.trim())) {
            flush();
            collecting = true;
            continue;
          }
          if (collecting && /^#{1,6}\s+/.test(line.trim())) {
            flush();
            collecting = false;
            continue;
          }
          if (collecting && line.trim()) buffer.push(line.trim());
        }
        flush();
      } catch (e) { console.error('Compass: cannot read daily principle', file.path, e); }
    }
    return results;
  }

  getCustomJournals() { return this.customSections.filter(section => section.type === 'journal'); }
  getCustomLibraries() { return this.customSections.filter(section => section.type === 'library'); }
  isBuiltinHidden(id) { return this.hiddenBuiltins.includes(id); }

  getAllTypes() {
    const builtins = BUILTIN_TYPES.filter(type => !type.journal || !this.isBuiltinHidden(`journal:${type.journal}`));
    const custom = this.getCustomJournals().map(section => ({
      key: `custom-${section.journal}`,
      label: `${section.emoji} ${section.name}`,
      journal: section.journal
    }));
    return [...builtins, ...custom];
  }

  async saveCompassData() {
    const current = (await this.loadData()) || {};
    await this.saveData({
      ...current,
      schemaVersion: this.dataSchemaVersion || COMPASS_DATA_SCHEMA_VERSION,
      lastPluginVersion: COMPASS_PLUGIN_VERSION,
      customSections: this.customSections,
      hiddenBuiltins: this.hiddenBuiltins,
      archivedSections: this.archivedSections,
      relationshipSettings: this.relationshipSettings,
      sharedUnlockExpiresAt: Number(this.sharedUnlockExpiresAt || 0),
      updateSettings: this.updateSettings || { autoCheck: true, lastCheckedAt: null }
    });
  }


  async fetchUpdateManifest() {
    const response = await requestUrl({ url: COMPASS_UPDATE_MANIFEST_URL, method: 'GET' });
    const manifest = response.json || JSON.parse(response.text || '{}');
    if (!manifest || typeof manifest !== 'object') throw new Error('Некорректный файл обновления');
    if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) throw new Error('Некорректная версия обновления');
    if (!Array.isArray(manifest.files) || manifest.files.length !== 3) throw new Error('Неполный пакет обновления');
    const names = manifest.files.map(f => f.path).sort();
    if (names.join('|') !== [...COMPASS_UPDATE_ALLOWED_FILES].sort().join('|')) throw new Error('Пакет содержит недопустимые системные файлы');
    for (const file of manifest.files) {
      if (!file.url || !/^[a-f0-9]{64}$/i.test(String(file.sha256 || ''))) throw new Error(`Нет контрольной суммы для ${file.path}`);
    }
    return manifest;
  }

  async checkForCompassUpdates({ openModal = true, silent = false } = {}) {
    try {
      const manifest = await this.fetchUpdateManifest();
      this.updateSettings.lastCheckedAt = new Date().toISOString();
      await this.saveCompassData();
      if (compareVersions(manifest.version, COMPASS_PLUGIN_VERSION) <= 0) {
        if (!silent) new Notice(`Compass ${COMPASS_PLUGIN_VERSION}: обновлений нет`);
        return null;
      }
      if (manifest.minInstalledVersion && compareVersions(COMPASS_PLUGIN_VERSION, manifest.minInstalledVersion) < 0) {
        throw new Error(`Для прямого обновления нужна версия не ниже ${manifest.minInstalledVersion}`);
      }
      if (openModal) new CompassUpdateModal(this.app, this, manifest).open();
      else new Notice(`Доступно обновление Compass ${manifest.version}`);
      return manifest;
    } catch (e) {
      if (!silent) new Notice(`Не удалось проверить обновления: ${e.message || e}`);
      throw e;
    }
  }

  async createSystemBackup() {
    const adapter = this.app.vault.adapter;
    const stamp = moment().format('YYYY-MM-DD_HHmmss');
    const backupRoot = `05 Архив/Резервные копии Compass/${stamp}`;
    await this.ensureFolder('05 Архив/Резервные копии Compass');
    await this.ensureFolder(backupRoot);
    const pluginRoot = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    for (const name of [...COMPASS_UPDATE_ALLOWED_FILES, 'data.json']) {
      const source = `${pluginRoot}/${name}`;
      if (await adapter.exists(source)) {
        const content = await adapter.read(source);
        await adapter.write(`${backupRoot}/${name}`, content);
      }
    }
    await this.app.vault.adapter.write(`${backupRoot}/README.txt`, `Резервная копия системных файлов Compass перед обновлением с версии ${COMPASS_PLUGIN_VERSION}. Пользовательские заметки не копировались, потому что пакет обновления не имеет права их изменять.\n`);
    return backupRoot;
  }

  async installCompassUpdate(manifest, createBackup) {
    if (manifest.touchesUserData) throw new Error('Автообновление остановлено: пакет затрагивает пользовательские данные');
    if (manifest.requiresSupabaseMigration) throw new Error('Сначала требуется отдельная миграция Supabase');
    const adapter = this.app.vault.adapter;
    const pluginRoot = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const downloaded = {};

    // 1. Download and verify everything before touching installed files.
    for (const item of manifest.files) {
      const response = await requestUrl({ url: item.url, method: 'GET' });
      const text = response.text;
      const hash = await sha256Text(text);
      if (hash.toLowerCase() !== String(item.sha256).toLowerCase()) throw new Error(`Проверка целостности не пройдена: ${item.path}`);
      downloaded[item.path] = text;
    }
    const nextManifest = JSON.parse(downloaded['manifest.json']);
    if (nextManifest.id !== this.manifest.id || nextManifest.version !== manifest.version) throw new Error('manifest.json не соответствует пакету обновления');

    if (createBackup) {
      const backup = await this.createSystemBackup();
      new Notice(`Резервная копия: ${backup}`);
    }

    // 2. Stage all files.
    for (const name of COMPASS_UPDATE_ALLOWED_FILES) await adapter.write(`${pluginRoot}/${name}.next`, downloaded[name]);

    // 3. Atomic-ish swap with rollback copies.
    const swapped = [];
    try {
      for (const name of COMPASS_UPDATE_ALLOWED_FILES) {
        const current = `${pluginRoot}/${name}`;
        const previous = `${pluginRoot}/${name}.prev`;
        const next = `${pluginRoot}/${name}.next`;
        if (await adapter.exists(previous)) await adapter.remove(previous);
        if (await adapter.exists(current)) await adapter.rename(current, previous);
        await adapter.rename(next, current);
        swapped.push(name);
      }
      for (const name of COMPASS_UPDATE_ALLOWED_FILES) {
        const previous = `${pluginRoot}/${name}.prev`;
        if (await adapter.exists(previous)) await adapter.remove(previous);
      }
    } catch (e) {
      for (const name of [...swapped].reverse()) {
        const current = `${pluginRoot}/${name}`;
        const previous = `${pluginRoot}/${name}.prev`;
        try {
          if (await adapter.exists(current)) await adapter.remove(current);
          if (await adapter.exists(previous)) await adapter.rename(previous, current);
        } catch (_) {}
      }
      for (const name of COMPASS_UPDATE_ALLOWED_FILES) {
        const next = `${pluginRoot}/${name}.next`;
        try { if (await adapter.exists(next)) await adapter.remove(next); } catch (_) {}
      }
      throw e;
    }
    new Notice(`Compass ${manifest.version} установлен. Полностью перезапусти Obsidian.`);
  }

  async migrateJournalDateAliases() {
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith('03 Журналы/'));
    let changedFiles = 0;
    const pattern = /\[\[([^\]|]+)#([^\]|]+)\|(\d{4})-(\d{2})-(\d{2})(\s+—\s+[^\]]+)\]\]/g;
    for (const file of files) {
      const original = await this.app.vault.read(file);
      const updated = original.replace(pattern, (full, target, heading, y, m, d, rest) => `[[${target}#${heading}|${d}.${m}.${y}${rest}]]`);
      if (updated !== original) {
        await this.app.vault.modify(file, updated);
        changedFiles += 1;
      }
    }
    return changedFiles;
  }


  relationshipConfigured() {
    const s = this.relationshipSettings || {};
    return Boolean(s.projectUrl && s.publishableKey && s.email);
  }

  sharedSessionIsUnlocked() {
    return Boolean(
      this.relationshipSession?.accessToken &&
      this.relationshipSession?.encryptionSecret &&
      Date.now() < Number(this.sharedUnlockExpiresAt || 0)
    );
  }

  clearSharedSessionCache() {
    this.relationshipSession = null;
    this.sharedUnlockExpiresAt = 0;
    try {
      if (this.app?.secretStorage?.setSecret) {
        this.app.secretStorage.setSecret(COMPASS_SHARED_SESSION_SECRET_ID, '');
      }
    } catch (e) {
      console.warn('Compass: cannot clear shared session secret', e);
    }
    this.saveCompassData().catch(() => {});
  }

  saveSharedSessionCache(refreshToken, encryptionSecret) {
    if (!refreshToken || !encryptionSecret) return;
    try {
      if (!this.app?.secretStorage?.setSecret) return;
      this.app.secretStorage.setSecret(
        COMPASS_SHARED_SESSION_SECRET_ID,
        JSON.stringify({
          refreshToken,
          encryptionSecret
        })
      );
    } catch (e) {
      console.warn('Compass: cannot persist shared session secret', e);
    }
  }

  getSharedSessionCache() {
    try {
      if (!this.app?.secretStorage?.getSecret) return null;
      const raw = this.app.secretStorage.getSecret(COMPASS_SHARED_SESSION_SECRET_ID);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.refreshToken || !parsed?.encryptionSecret) return null;
      return parsed;
    } catch (e) {
      console.warn('Compass: cannot read shared session secret', e);
      return null;
    }
  }

  async restoreSharedSessionFromCache() {
    const expiresAt = Number(this.sharedUnlockExpiresAt || 0);
    if (!expiresAt || Date.now() >= expiresAt) {
      this.clearSharedSessionCache();
      return false;
    }

    const cached = this.getSharedSessionCache();
    if (!cached) return false;

    try {
      const auth = await this.supabaseRequest('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: cached.refreshToken })
      }, false);

      if (!auth?.access_token || !auth?.user?.id) throw new Error('Не удалось восстановить сеанс');

      this.relationshipSession = {
        accessToken: auth.access_token,
        refreshToken: auth.refresh_token || cached.refreshToken,
        user: auth.user,
        encryptionSecret: cached.encryptionSecret
      };

      const memberships = await this.supabaseRequest(
        `/rest/v1/space_members?select=space_id,user_id&user_id=eq.${encodeURIComponent(auth.user.id)}`
      );
      if (!Array.isArray(memberships) || !memberships.length) {
        throw new Error('Пользователь не добавлен в общее пространство');
      }

      this.relationshipSession.spaceId = memberships[0].space_id;

      // Supabase rotates refresh tokens. Store the newest token without
      // extending the original 12-hour Compass unlock window.
      this.saveSharedSessionCache(
        this.relationshipSession.refreshToken,
        cached.encryptionSecret
      );
      return true;
    } catch (e) {
      console.warn('Compass: shared session restore failed', e);
      this.clearSharedSessionCache();
      return false;
    }
  }

  async ensureSharedSession(onReady) {
    if (!this.relationshipConfigured()) {
      new Notice('Сначала заполни Supabase URL, Publishable key и email в Настройки → Compass');
      return;
    }

    if (this.sharedSessionIsUnlocked()) {
      onReady();
      return;
    }

    if (Date.now() < Number(this.sharedUnlockExpiresAt || 0)) {
      const restored = await this.restoreSharedSessionFromCache();
      if (restored) {
        onReady();
        return;
      }
    }

    this.relationshipSession = null;
    if (Date.now() >= Number(this.sharedUnlockExpiresAt || 0)) {
      this.clearSharedSessionCache();
    }
    new RelationshipSessionModal(this.app, this, onReady).open();
  }

  async openRelationships() {
    await this.ensureSharedSession(() => new RelationshipsModal(this.app, this).open());
  }

  async openSharedCalendar() {
    await this.ensureSharedSession(() => new SharedCalendarModal(this.app, this).open());
  }

  async supabaseRequest(path, options = {}, authenticated = true) {
    const url = `${this.relationshipSettings.projectUrl}${path}`;
    const headers = Object.assign({
      'apikey': this.relationshipSettings.publishableKey,
      'Content-Type': 'application/json'
    }, options.headers || {});
    if (authenticated) {
      if (!this.relationshipSession?.accessToken) throw new Error('Сеанс не открыт');
      headers.Authorization = `Bearer ${this.relationshipSession.accessToken}`;
    }
    const response = await fetch(url, { ...options, headers });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (_) { body = text; }
    }
    if (!response.ok) {
      const message = body?.msg || body?.message || body?.error_description || body?.error || `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return body;
  }

  async startRelationshipSession(password, encryptionSecret) {
    const auth = await this.supabaseRequest('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email: this.relationshipSettings.email, password })
    }, false);
    if (!auth?.access_token || !auth?.user?.id) throw new Error('Supabase не вернул пользовательский сеанс');
    const session = {
      accessToken: auth.access_token,
      refreshToken: auth.refresh_token || null,
      user: auth.user,
      encryptionSecret
    };
    this.relationshipSession = session;
    const memberships = await this.supabaseRequest(`/rest/v1/space_members?select=space_id,user_id&user_id=eq.${encodeURIComponent(auth.user.id)}`);
    if (!Array.isArray(memberships) || !memberships.length) {
      this.relationshipSession = null;
      throw new Error('Пользователь не добавлен в общее пространство');
    }
    this.relationshipSession.spaceId = memberships[0].space_id;
    this.sharedUnlockExpiresAt = Date.now() + (12 * 60 * 60 * 1000);
    this.saveSharedSessionCache(this.relationshipSession.refreshToken, encryptionSecret);
    await this.saveCompassData();
  }

  async deriveRelationshipKey(secret, salt) {
    if (!window.crypto?.subtle) throw new Error('На этом устройстве недоступно Web Crypto');
    const material = await window.crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']
    );
    return window.crypto.subtle.deriveKey({
      name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256'
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async encryptRelationshipText(text) {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveRelationshipKey(this.relationshipSession.encryptionSecret, salt);
    const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return {
      encrypted_content: bytesToBase64(new Uint8Array(encrypted)),
      encryption_iv: `${bytesToBase64(salt)}.${bytesToBase64(iv)}`
    };
  }

  async decryptRelationshipText(entry) {
    const [saltB64, ivB64] = String(entry.encryption_iv || '').split('.');
    if (!saltB64 || !ivB64) throw new Error('Некорректные параметры шифрования');
    const salt = base64ToBytes(saltB64);
    const iv = base64ToBytes(ivB64);
    const key = await this.deriveRelationshipKey(this.relationshipSession.encryptionSecret, salt);
    const plain = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBytes(entry.encrypted_content));
    return new TextDecoder().decode(plain);
  }

  async encodeRelationshipTitle(title) {
    const encrypted = await this.encryptRelationshipText(String(title || '').trim());
    return `enc1:${encrypted.encryption_iv}:${encrypted.encrypted_content}`;
  }

  async decodeRelationshipTitle(value, situation = null) {
    const raw = String(value || '');
    if (!raw) return situation ? `Тема от ${moment(situation.created_at).format('DD.MM.YYYY')}` : '';
    if (!raw.startsWith('enc1:')) return raw;
    const rest = raw.slice(5);
    const idx = rest.indexOf(':');
    if (idx < 0) return 'Зашифрованная тема';
    try {
      return await this.decryptRelationshipText({ encryption_iv: rest.slice(0, idx), encrypted_content: rest.slice(idx + 1) });
    } catch (_) { return 'Зашифрованная тема'; }
  }

  async createRelationshipSituation(title, text) {
    const session = this.relationshipSession;
    if (!session?.spaceId) throw new Error('Нет активного пространства');
    const encryptedTitle = await this.encodeRelationshipTitle(title);
    const situations = await this.supabaseRequest('/rest/v1/situations?select=id,space_id,created_by,title,status,created_at,updated_at,close_requested_by,close_requested_at,closed_at', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ space_id: session.spaceId, created_by: session.user.id, title: encryptedTitle })
    });
    const situation = Array.isArray(situations) ? situations[0] : null;
    if (!situation?.id) throw new Error('Не удалось создать тему');
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest('/rest/v1/entries', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        situation_id: situation.id,
        author_id: session.user.id,
        encrypted_content: encrypted.encrypted_content,
        encryption_iv: encrypted.encryption_iv,
        is_finished: true
      })
    });
    this.sendRelationshipEmailNotification('new_topic', situation.id).catch(e => console.warn('Compass email notification', e));
    return situation;
  }

  async addRelationshipEntry(situationId, text) {
    const session = this.relationshipSession;
    if (!session?.user?.id) throw new Error('Нет активного сеанса');
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest('/rest/v1/entries', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        situation_id: situationId,
        author_id: session.user.id,
        encrypted_content: encrypted.encrypted_content,
        encryption_iv: encrypted.encryption_iv,
        is_finished: true
      })
    });
    this.sendRelationshipEmailNotification('initial_response', situationId).catch(e => console.warn('Compass email notification', e));
  }

  async getRelationshipSituations() {
    const spaceId = this.relationshipSession?.spaceId;
    if (!spaceId) return [];
    const fields = 'id,space_id,created_by,title,status,created_at,updated_at,close_requested_by,close_requested_at,closed_at';
    const rows = await this.supabaseRequest(`/rest/v1/situations?select=${fields}&space_id=eq.${encodeURIComponent(spaceId)}&order=updated_at.desc`);
    return Array.isArray(rows) ? rows : [];
  }

  async getRelationshipSituation(situationId) {
    const fields = 'id,space_id,created_by,title,status,created_at,updated_at,close_requested_by,close_requested_at,closed_at';
    const rows = await this.supabaseRequest(`/rest/v1/situations?select=${fields}&id=eq.${encodeURIComponent(situationId)}&limit=1`);
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async getRelationshipEntries(situationId) {
    const rows = await this.supabaseRequest(`/rest/v1/entries?select=id,situation_id,author_id,encrypted_content,encryption_iv,is_finished,created_at,finished_at,updated_at&situation_id=eq.${encodeURIComponent(situationId)}&order=created_at.asc`);
    return Array.isArray(rows) ? rows : [];
  }

  async getRelationshipMessages(situationId) {
    const rows = await this.supabaseRequest(`/rest/v1/relationship_messages?select=id,situation_id,author_id,encrypted_content,encryption_iv,created_at,updated_at&situation_id=eq.${encodeURIComponent(situationId)}&order=created_at.asc`);
    return Array.isArray(rows) ? rows : [];
  }

  async addRelationshipMessage(situationId, text) {
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest('/rest/v1/relationship_messages', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        situation_id: situationId,
        author_id: this.relationshipSession.user.id,
        encrypted_content: encrypted.encrypted_content,
        encryption_iv: encrypted.encryption_iv
      })
    });
    this.sendRelationshipEmailNotification('new_message', situationId).catch(e => console.warn('Compass email notification', e));
  }

  async updateRelationshipEntry(entryId, text) {
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest(`/rest/v1/entries?id=eq.${encodeURIComponent(entryId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ encrypted_content: encrypted.encrypted_content, encryption_iv: encrypted.encryption_iv })
    });
  }

  async updateRelationshipMessage(messageId, text) {
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest(`/rest/v1/relationship_messages?id=eq.${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ encrypted_content: encrypted.encrypted_content, encryption_iv: encrypted.encryption_iv })
    });
  }

  async getRelationshipPreferences() {
    const spaceId = this.relationshipSession?.spaceId;
    if (!spaceId) return [];
    const rows = await this.supabaseRequest(`/rest/v1/relationship_member_preferences?select=space_id,user_id,accent_color,email_notifications_enabled,updated_at&space_id=eq.${encodeURIComponent(spaceId)}`);
    return Array.isArray(rows) ? rows : [];
  }

  async getMyRelationshipColor() {
    const prefs = await this.getRelationshipPreferences().catch(() => []);
    return prefs.find(p => p.user_id === this.relationshipSession?.user?.id)?.accent_color || 'blue';
  }

  async getPartnerRelationshipColor() {
    const prefs = await this.getRelationshipPreferences().catch(() => []);
    return prefs.find(p => p.user_id !== this.relationshipSession?.user?.id)?.accent_color || 'green';
  }

  async setRelationshipAccentColor(color) {
    if (!['blue', 'green', 'purple', 'orange'].includes(color)) throw new Error('Недопустимый цвет');
    const spaceId = this.relationshipSession?.spaceId;
    const userId = this.relationshipSession?.user?.id;
    if (!spaceId || !userId) throw new Error('Нет активного сеанса');
    const existing = await this.supabaseRequest(`/rest/v1/relationship_member_preferences?select=space_id,user_id&space_id=eq.${encodeURIComponent(spaceId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (Array.isArray(existing) && existing.length) {
      await this.supabaseRequest(`/rest/v1/relationship_member_preferences?space_id=eq.${encodeURIComponent(spaceId)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ accent_color: color, updated_at: new Date().toISOString() })
      });
    } else {
      await this.supabaseRequest('/rest/v1/relationship_member_preferences', {
        method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ space_id: spaceId, user_id: userId, accent_color: color })
      });
    }
  }

  async setRelationshipEmailNotificationsEnabled(enabled) {
    const spaceId = this.relationshipSession?.spaceId;
    const userId = this.relationshipSession?.user?.id;
    if (!spaceId || !userId) throw new Error('Нет активного сеанса');
    const existing = await this.supabaseRequest(`/rest/v1/relationship_member_preferences?select=space_id,user_id&space_id=eq.${encodeURIComponent(spaceId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (Array.isArray(existing) && existing.length) {
      await this.supabaseRequest(`/rest/v1/relationship_member_preferences?space_id=eq.${encodeURIComponent(spaceId)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ email_notifications_enabled: Boolean(enabled), updated_at: new Date().toISOString() })
      });
    } else {
      await this.supabaseRequest('/rest/v1/relationship_member_preferences', {
        method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ space_id: spaceId, user_id: userId, accent_color: 'blue', email_notifications_enabled: Boolean(enabled) })
      });
    }
  }

  async sendRelationshipEmailNotification(eventType, situationId) {
    if (!this.relationshipSession?.accessToken) return;
    const allowed = ['new_topic', 'initial_response', 'new_message', 'close_request'];
    if (!allowed.includes(eventType)) return;
    try {
      await this.supabaseRequest('/functions/v1/relationship-email', {
        method: 'POST',
        body: JSON.stringify({ event_type: eventType, situation_id: situationId })
      });
    } catch (e) {
      // Email is intentionally non-blocking: a mail outage must never prevent the conversation itself.
      console.warn('Compass relationship email unavailable', e);
    }
  }

  async getSharedCalendarItems(dateFrom, dateTo) {
    const spaceId = this.relationshipSession?.spaceId;
    if (!spaceId) throw new Error('Нет активного общего пространства');
    const fields = 'id,space_id,calendar_date,created_by,encrypted_content,encryption_iv,is_completed,created_at,updated_at';
    const path = `/rest/v1/shared_calendar_items?select=${fields}&space_id=eq.${encodeURIComponent(spaceId)}&calendar_date=gte.${encodeURIComponent(dateFrom)}&calendar_date=lte.${encodeURIComponent(dateTo)}&order=calendar_date.asc,created_at.asc`;
    const rows = await this.supabaseRequest(path);
    return Array.isArray(rows) ? rows : [];
  }

  async addSharedCalendarItem(dateString, text) {
    const session = this.relationshipSession;
    if (!session?.spaceId || !session?.user?.id) throw new Error('Нет активного общего пространства');
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest('/rest/v1/shared_calendar_items', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        space_id: session.spaceId,
        calendar_date: dateString,
        created_by: session.user.id,
        encrypted_content: encrypted.encrypted_content,
        encryption_iv: encrypted.encryption_iv,
        is_completed: false
      })
    });
  }

  async updateSharedCalendarItem(itemId, text) {
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest(`/rest/v1/shared_calendar_items?id=eq.${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        encrypted_content: encrypted.encrypted_content,
        encryption_iv: encrypted.encryption_iv,
        updated_at: new Date().toISOString()
      })
    });
  }

  async setSharedCalendarItemCompleted(itemId, completed) {
    await this.supabaseRequest(`/rest/v1/shared_calendar_items?id=eq.${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ is_completed: Boolean(completed), updated_at: new Date().toISOString() })
    });
  }

  async deleteSharedCalendarItem(itemId) {
    await this.supabaseRequest(`/rest/v1/shared_calendar_items?id=eq.${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
  }

  async relationshipRpc(name, args) {
    return this.supabaseRequest(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args || {}) });
  }

  async renameRelationshipTopic(situationId, title) {
    const encryptedTitle = await this.encodeRelationshipTitle(title);
    await this.relationshipRpc('rename_relationship_topic', { target_situation: situationId, new_title: encryptedTitle });
  }

  async requestCloseRelationshipTopic(situationId) {
    await this.relationshipRpc('request_close_relationship_topic', { target_situation: situationId });
    this.sendRelationshipEmailNotification('close_request', situationId).catch(e => console.warn('Compass email notification', e));
  }

  async cancelCloseRelationshipTopic(situationId) {
    await this.relationshipRpc('cancel_close_relationship_topic', { target_situation: situationId });
  }

  async confirmCloseRelationshipTopic(situationId) {
    await this.relationshipRpc('confirm_close_relationship_topic', { target_situation: situationId });
  }

  relationshipStatusLabel(situation, entries, messages) {
    const me = this.relationshipSession?.user?.id;
    if (situation.status === 'closed') return '🔒 Закрыта';
    if (situation.status === 'close_requested') {
      return situation.close_requested_by === me ? 'Закрытие предложено · ждём партнёра' : 'Партнёр предлагает закрыть · нужен твой ответ';
    }
    const own = entries.find(e => e.author_id === me);
    const other = entries.find(e => e.author_id !== me);
    if (!own) return 'Нужна твоя первоначальная позиция';
    if (!other) return 'Твоя позиция готова · ждём партнёра';
    if (!messages.length) return 'Обсуждение открыто';
    const latest = messages[messages.length - 1];
    return latest.author_id === me ? 'Ждём ответ партнёра' : '● Новый ответ · твой ход';
  }

  async getRelationshipSituationSummary(situation) {
    const me = this.relationshipSession?.user?.id;
    const entries = await this.getRelationshipEntries(situation.id);
    const own = entries.find(e => e.author_id === me);
    const other = entries.find(e => e.author_id !== me);
    let messages = [];
    if (own && other) messages = await this.getRelationshipMessages(situation.id).catch(() => []);
    let priority = 1;
    let statusText = this.relationshipStatusLabel(situation, entries, messages);
    if (situation.status === 'closed') priority = 2;
    else if (!own) priority = 0;
    else if (situation.status === 'close_requested' && situation.close_requested_by !== me) priority = 0;
    else if (own && other) {
      const latestOwnReplyAt = messages.filter(m => m.author_id === me).reduce((max, m) => Math.max(max, +new Date(m.created_at)), 0);
      const partnerMessageActivity = messages.filter(m => m.author_id !== me).reduce((max, m) => Math.max(max, +new Date(m.updated_at || m.created_at)), 0);
      const partnerEntryEdited = other.updated_at && Math.abs(new Date(other.updated_at) - new Date(other.created_at)) > 3000;
      const partnerEntryActivity = partnerEntryEdited ? +new Date(other.updated_at) : 0;
      if (Math.max(partnerMessageActivity, partnerEntryActivity) > latestOwnReplyAt) {
        priority = 0;
        statusText = '● Новый ответ или изменение · твой ход';
      }
    }
    const activityCandidates = [situation.updated_at, situation.created_at, ...entries.map(e => e.updated_at || e.created_at), ...messages.map(m => m.updated_at || m.created_at)].filter(Boolean);
    const activityAt = Math.max(...activityCandidates.map(v => +new Date(v)), 0);
    return { situation, entries, messages, priority, activityAt, statusText };
  }

  async archiveCompletedRelationshipSituation() {
    // Начиная с 2.1.0 серверная тема является источником истины.
    // Автоматически создавать локальную незашифрованную копию обсуждения больше не нужно.
    return;
  }

  manageSection(section) { new SectionActionsModal(this.app, this, section).open(); }
  openArchive() { new ArchiveModal(this.app, this).open(); }

  async archiveSection(section) {
    const archivedAt = new Date().toISOString();
    let originalPath;
    let archivedPath;

    if (section.type === 'journal') {
      originalPath = `03 Журналы/${section.journal}.md`;
      await this.ensureFolder('05 Архив/Журналы');
      archivedPath = `05 Архив/Журналы/${section.journal}.md`;
    } else {
      originalPath = section.folder;
      await this.ensureFolder('05 Архив/Базы знаний');
      archivedPath = `05 Архив/Базы знаний/${section.name}`;
    }

    const existingArchive = this.app.vault.getAbstractFileByPath(archivedPath);
    if (existingArchive) {
      new Notice('В Архиве уже есть раздел с таким названием');
      return false;
    }

    const source = this.app.vault.getAbstractFileByPath(originalPath);
    if (source) await this.app.vault.rename(source, archivedPath);

    if (section.source === 'builtin') {
      if (!this.hiddenBuiltins.includes(section.builtinId)) this.hiddenBuiltins.push(section.builtinId);
    } else {
      this.customSections = this.customSections.filter(item => !(item.type === section.type && item.name === section.name));
    }

    this.archivedSections.push({
      source: section.source,
      builtinId: section.builtinId || null,
      type: section.type,
      name: section.name,
      emoji: section.emoji || '📌',
      journal: section.journal || null,
      folder: section.folder || null,
      originalPath,
      archivedPath,
      archivedAt
    });

    await this.saveCompassData();
    this.refreshSidebar();
    new Notice(`Перенесено в Архив: ${section.emoji || '📌'} ${section.name}`);
    return true;
  }

  async restoreArchivedSection(item) {
    if (this.app.vault.getAbstractFileByPath(item.originalPath)) {
      new Notice('Невозможно восстановить: активный раздел с таким названием уже существует');
      return false;
    }

    const archived = this.app.vault.getAbstractFileByPath(item.archivedPath);
    if (archived) {
      const parentPath = item.originalPath.split('/').slice(0, -1).join('/');
      if (parentPath) await this.ensureFolder(parentPath);
      await this.app.vault.rename(archived, item.originalPath);
    } else if (item.type === 'journal') {
      const content = `# ${item.emoji || '📌'} ${item.name}\n\n`;
      await this.app.vault.create(item.originalPath, content);
    } else {
      await this.ensureFolder(item.originalPath);
    }

    if (item.source === 'builtin') {
      this.hiddenBuiltins = this.hiddenBuiltins.filter(id => id !== item.builtinId);
    } else {
      const restored = item.type === 'journal'
        ? { type: 'journal', name: item.name, emoji: item.emoji || '📌', journal: item.journal || item.name }
        : { type: 'library', name: item.name, emoji: item.emoji || '📌', folder: item.folder || item.originalPath };
      if (!this.customSections.some(section => section.type === restored.type && section.name === restored.name)) this.customSections.push(restored);
    }

    this.archivedSections = this.archivedSections.filter(entry => entry !== item);
    await this.saveCompassData();
    this.refreshSidebar();
    new Notice(`Восстановлено: ${item.emoji || '📌'} ${item.name}`);
    return true;
  }

  async deleteArchivedSection(item) {
    const archived = this.app.vault.getAbstractFileByPath(item.archivedPath);
    if (archived) await this.app.vault.delete(archived, true);
    this.archivedSections = this.archivedSections.filter(entry => entry !== item);
    await this.saveCompassData();
    this.refreshSidebar();
    new Notice(item.type === 'journal'
      ? `Тема журнала удалена. Дневные записи сохранены: ${item.name}`
      : `База знаний удалена: ${item.name}`);
    return true;
  }

  sanitizeName(name) {
    return name.replace(/[\\/:*?"<>|#\[\]^]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  async ensureFolder(path) {
    if (this.app.vault.getAbstractFileByPath(path)) return;
    const parts = path.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  async addCustomSection(name, emoji, type) {
    const clean = this.sanitizeName(name);
    if (!clean) {
      new Notice('Название содержит только недопустимые символы');
      return false;
    }
    const normalized = clean.toLocaleLowerCase('ru');
    const existingNames = [
      ...BUILTIN_JOURNALS.map(([, n]) => n.toLocaleLowerCase('ru')),
      'книги и видео',
      ...this.customSections.map(s => s.name.toLocaleLowerCase('ru'))
    ];
    if (existingNames.includes(normalized)) {
      new Notice('Такой раздел уже существует');
      return false;
    }

    if (type === 'library') {
      const folder = `02 Базы знаний/${clean}`;
      await this.ensureFolder(folder);
      this.customSections.push({ type: 'library', name: clean, emoji: emoji || '📌', folder });
    } else {
      const journal = clean;
      const path = `03 Журналы/${journal}.md`;
      if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.create(path, `# ${emoji || '📌'} ${journal}\n\n`);
      this.customSections.push({ type: 'journal', name: clean, emoji: emoji || '📌', journal });
    }

    await this.saveCompassData();
    this.refreshSidebar();
    new Notice(type === 'library' ? `База знаний создана: ${emoji || '📌'} ${clean}` : `Журнал создан: ${emoji || '📌'} ${clean}`);
    return true;
  }

  openAddSection() { new AddSectionModal(this.app, this).open(); }

  refreshSidebar() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
      if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
    });
  }

  hasDaily(dateString) { return Boolean(this.app.vault.getAbstractFileByPath(`01 Дни/${dateString}.md`)); }

  async activateSidebar() {
    let leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (!leaves.length) {
      const leaf = this.app.workspace.getLeftLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      leaves = [leaf];
    }
    this.app.workspace.revealLeaf(leaves[0]);
  }

  async openTarget(target) {
    const abstract = this.app.vault.getAbstractFileByPath(target);
    if (abstract && abstract.extension === 'md') {
      await this.app.workspace.getLeaf(false).openFile(abstract);
      return;
    }
    if (abstract && Array.isArray(abstract.children)) {
      const firstMarkdown = abstract.children.find(file => file.extension === 'md');
      if (firstMarkdown) {
        await this.app.workspace.getLeaf(false).openFile(firstMarkdown);
        return;
      }
    }
    new Notice(`Раздел пока пуст: ${target}`);
  }

  openLibrary(folderPath, emoji, label) {
    new LibraryModal(this.app, this, folderPath, emoji, label).open();
  }

  async createLibraryFolder(parentPath, name) {
    const clean = this.sanitizeName(name);
    if (!clean) {
      new Notice('Недопустимое название папки');
      return null;
    }
    await this.ensureFolder(parentPath);
    const path = `${parentPath}/${clean}`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      new Notice('Папка или файл с таким названием уже существует');
      return null;
    }
    await this.app.vault.createFolder(path);
    new Notice(`Папка создана: ${clean}`);
    return this.app.vault.getAbstractFileByPath(path);
  }

  async createLibraryDocument(folderPath, name) {
    const clean = this.sanitizeName(name);
    if (!clean) {
      new Notice('Недопустимое название файла');
      return null;
    }
    await this.ensureFolder(folderPath);
    const path = `${folderPath}/${clean}.md`;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) file = await this.app.vault.create(path, '');
    else new Notice('Файл с таким названием уже существует');
    return file;
  }

  async ensureDate(dateMoment) {
    const date = dateMoment.format('YYYY-MM-DD');
    const path = `01 Дни/${date}.md`;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      const template = this.app.vault.getAbstractFileByPath('04 Шаблоны/Шаблон дня.md');
      let content = `# ${date}\n\n`;
      if (template) {
        content = await this.app.vault.read(template);
        content = content.replace(/{{date}}/g, date).replace(/{{dateLong}}/g, dateMoment.format('D MMMM YYYY'));
      }
      file = await this.app.vault.create(path, content);
    }
    return file;
  }

  async openDate(dateMoment) {
    const file = await this.ensureDate(dateMoment);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  openChoice() { new ChoiceModal(this.app, this, type => this.addEntry(type)).open(); }

  async addEntry(type) {
    let view = this.app.workspace.getActiveViewOfType(MarkdownView);
    let file = view && view.file && view.file.path.startsWith('01 Дни/') ? view.file : null;
    if (!file) file = await this.ensureDate(moment());

    await this.app.workspace.getLeaf(false).openFile(file);
    view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const date = file.basename;
    const heading = type.label;
    const block = `\n## ${heading}\n\n`;

    if (view && view.file && view.file.path === file.path) {
      const editor = view.editor;
      editor.setCursor(editor.lineCount(), 0);
      editor.replaceSelection(block);
      editor.focus();
    } else {
      await this.app.vault.append(file, block);
    }

    if (type.journal) await this.appendJournal(type.journal, date, heading, file.path);
    new Notice(`Добавлено: ${type.label}`);
  }

  async appendJournal(journal, date, heading, dailyPath) {
    const path = `03 Журналы/${journal}.md`;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) file = await this.app.vault.create(path, `# ${journal}\n\n`);
    const target = dailyPath.replace(/\.md$/, '');
    const line = `- [[${target}#${heading}|${formatJournalDate(date)} — ${heading}]]\n`;
    const existing = await this.app.vault.read(file);
    if (!existing.includes(line.trim())) await this.app.vault.append(file, line);
  }
};

/* Compass 2.2.0 prototype extensions */
const CompassPlugin220 = module.exports;

const compass220BaseOnload = CompassPlugin220.prototype.onload;
CompassPlugin220.prototype.onload = async function() {
  await compass220BaseOnload.call(this);
  const data = (await this.loadData()) || {};
  this.libraryFeatures = data.libraryFeatures && typeof data.libraryFeatures === 'object' ? data.libraryFeatures : {};
  this.libraryDailyLinks = Array.isArray(data.libraryDailyLinks) ? data.libraryDailyLinks : [];
  this.hiddenPrinciples = Array.isArray(data.hiddenPrinciples) ? data.hiddenPrinciples : [];
};

CompassPlugin220.prototype.saveCompassData = async function() {
  const current = (await this.loadData()) || {};
  await this.saveData({
    ...current,
    schemaVersion: current.schemaVersion || COMPASS_DATA_SCHEMA_VERSION,
    lastPluginVersion: COMPASS_PLUGIN_VERSION,
    customSections: this.customSections,
    hiddenBuiltins: this.hiddenBuiltins,
    archivedSections: this.archivedSections,
    relationshipSettings: this.relationshipSettings,
    updateSettings: this.updateSettings || { autoCheck: true, lastCheckedAt: null },
    libraryFeatures: this.libraryFeatures || {},
    libraryDailyLinks: this.libraryDailyLinks || [],
    hiddenPrinciples: this.hiddenPrinciples || []
  });
};

CompassPlugin220.prototype.getLibraryFeature = function(path) {
  return { showInDaily:false, collectDaily:false, checklistMode:false, periodGrouping:false, ...((this.libraryFeatures||{})[path]||{}) };
};
CompassPlugin220.prototype.setLibraryFeature = async function(path, patch) {
  this.libraryFeatures = this.libraryFeatures || {};
  this.libraryFeatures[path] = { ...this.getLibraryFeature(path), ...(patch||{}) };
  await this.saveCompassData();
};
CompassPlugin220.prototype.libraryHasDailyTargets = function(rootPath) {
  return Object.entries(this.libraryFeatures||{}).some(([p,f]) => (p===rootPath || p.startsWith(`${rootPath}/`)) && !!f?.showInDaily);
};
CompassPlugin220.prototype.getDailyLibraryRoots = function() {
  const roots=[];
  if (this.libraryHasDailyTargets('02 Книги и видео')) roots.push({source:'builtin',name:'Книги и видео',emoji:'📚',folder:'02 Книги и видео'});
  for (const section of this.getCustomLibraries()) if (this.libraryHasDailyTargets(section.folder)) roots.push(section);
  return roots;
};
CompassPlugin220.prototype.hasDailyLibraryTargets = function() { return this.getDailyLibraryRoots().length>0; };
CompassPlugin220.prototype.getLibraryDailyLinks = function(path) { return (this.libraryDailyLinks||[]).filter(x=>x.targetPath===path).sort((a,b)=>+new Date(b.createdAt||0)-+new Date(a.createdAt||0)); };

CompassPlugin220.prototype.addLibraryDailyEntry = async function(targetPath, value) {
  const feature=this.getLibraryFeature(targetPath); let view=this.app.workspace.getActiveViewOfType(MarkdownView); let file=view&&view.file&&view.file.path.startsWith('01 Дни/')?view.file:null; if(!file)file=await this.ensureDate(moment());
  const id=`lib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; const name=targetPath.split('/').pop(); const heading=`📚 ${name}`;
  // The technical relation lives only in Compass data.json. Nothing service-like is written into the visible Markdown note.
  const block=`\n## ${heading}\n\n${value}\n`;
  await this.app.vault.append(file,block);
  if(feature.collectDaily){ this.libraryDailyLinks=this.libraryDailyLinks||[]; this.libraryDailyLinks.push({id,targetPath,dailyPath:file.path,heading,text:value,createdAt:new Date().toISOString(),checked:false}); await this.saveCompassData(); }
  await this.app.workspace.getLeaf(false).openFile(file); new Notice(feature.collectDaily?`Добавлено в день и связано с «${name}»`:`Добавлено в день: ${name}`);
};
CompassPlugin220.prototype.openLibraryDailyLink = async function(link) {
  const file=this.app.vault.getAbstractFileByPath(link.dailyPath); if(!file||file.extension!=='md')return new Notice('Исходная дневная запись не найдена'); await this.app.workspace.getLeaf(false).openFile(file); const view=this.app.workspace.getActiveViewOfType(MarkdownView); if(!view||view.file?.path!==file.path)return;
  const lines=view.editor.getValue().split('\n');
  const firstTextLine=String(link.text||'').split('\n').map(x=>x.trim()).find(Boolean)||'';
  let anchor=-1;
  if(firstTextLine) anchor=lines.findIndex(line=>line.trim()===firstTextLine || line.includes(firstTextLine));
  if(anchor<0){ for(let i=lines.length-1;i>=0;i-=1){ if(lines[i].trim()===`## ${link.heading}` || lines[i].trim()===`## 📚 ${(link.targetPath||'').split('/').pop()}`){anchor=i;break;} } }
  if(anchor>=0){let hl=anchor;while(hl>0&&!/^##\s+/.test(lines[hl]))hl-=1;view.editor.setCursor({line:hl,ch:0});try{view.editor.scrollIntoView({from:{line:hl,ch:0},to:{line:anchor,ch:0}},true);}catch(_){} }
};
CompassPlugin220.prototype.setLibraryDailyLinkChecked = async function(id,checked){const l=(this.libraryDailyLinks||[]).find(x=>x.id===id);if(!l)return;l.checked=!!checked;await this.saveCompassData();};
CompassPlugin220.prototype.formLibraryPeriod = async function(path,startDate,endDate){const start=moment(startDate,'YYYY-MM-DD',true),end=moment(endDate,'YYYY-MM-DD',true);if(!start.isValid()||!end.isValid())throw new Error('Некорректные даты');const name=`${start.format('DD.MM.YYYY')}–${end.format('DD.MM.YYYY')}`,periodPath=`${path}/${name}`;if(!this.app.vault.getAbstractFileByPath(periodPath))await this.app.vault.createFolder(periodPath);let n=0;for(const l of this.libraryDailyLinks||[]){if(l.targetPath!==path)continue;const d=moment((l.dailyPath.split('/').pop()||'').replace(/\.md$/,''),'YYYY-MM-DD',true);if(d.isValid()&&!d.isBefore(start,'day')&&!d.isAfter(end,'day')){l.targetPath=periodPath;n++;}}this.libraryFeatures=this.libraryFeatures||{};if(!this.libraryFeatures[periodPath])this.libraryFeatures[periodPath]={...this.getLibraryFeature(path),showInDaily:false,periodGrouping:false};await this.saveCompassData();return n;};

CompassPlugin220.prototype.rewriteLibraryPathPrefix = function(oldPath,newPath){const next={};for(const [p,f] of Object.entries(this.libraryFeatures||{})){const np=p===oldPath?newPath:(p.startsWith(`${oldPath}/`)?`${newPath}${p.slice(oldPath.length)}`:p);next[np]=f;}this.libraryFeatures=next;for(const l of this.libraryDailyLinks||[]){if(l.targetPath===oldPath)l.targetPath=newPath;else if(l.targetPath.startsWith(`${oldPath}/`))l.targetPath=`${newPath}${l.targetPath.slice(oldPath.length)}`;}};
CompassPlugin220.prototype.renameLibraryItem = async function(item,newName){const clean=this.sanitizeName(newName);if(!clean)throw new Error('Недопустимое название');const isFolder=Array.isArray(item.children),parent=item.path.split('/').slice(0,-1).join('/'),target=isFolder?`${parent}/${clean}`:`${parent}/${clean}.md`;if(target===item.path)return;if(this.app.vault.getAbstractFileByPath(target))throw new Error('Такое название уже существует');const old=item.path;await this.app.vault.rename(item,target);if(isFolder)this.rewriteLibraryPathPrefix(old,target);await this.saveCompassData();new Notice(`Переименовано: ${clean}`);};
CompassPlugin220.prototype.renameCustomSection = async function(section,newName){if(!section||section.source!=='custom')throw new Error('Системный раздел нельзя переименовать');const clean=this.sanitizeName(newName);const record=this.customSections.find(x=>x.type===section.type&&x.name===section.name);if(!record)throw new Error('Раздел не найден');if(section.type==='library'){const old=record.folder,parent=old.split('/').slice(0,-1).join('/'),target=`${parent}/${clean}`;if(target!==old&&this.app.vault.getAbstractFileByPath(target))throw new Error('Такой раздел уже существует');const folder=this.app.vault.getAbstractFileByPath(old);if(folder&&target!==old)await this.app.vault.rename(folder,target);record.name=clean;record.folder=target;this.rewriteLibraryPathPrefix(old,target);}else{const old=`03 Журналы/${record.journal}.md`,target=`03 Журналы/${clean}.md`;if(target!==old&&this.app.vault.getAbstractFileByPath(target))throw new Error('Такой журнал уже существует');const file=this.app.vault.getAbstractFileByPath(old);if(file&&target!==old)await this.app.vault.rename(file,target);record.name=clean;record.journal=clean;}await this.saveCompassData();this.refreshSidebar();new Notice(`Раздел переименован: ${clean}`);};
CompassPlugin220.prototype.deleteLibraryItem = async function(item){const isFolder=Array.isArray(item.children),old=item.path;await this.app.vault.delete(item,true);if(isFolder){const next={};for(const [p,f] of Object.entries(this.libraryFeatures||{}))if(!(p===old||p.startsWith(`${old}/`)))next[p]=f;this.libraryFeatures=next;this.libraryDailyLinks=(this.libraryDailyLinks||[]).filter(l=>!(l.targetPath===old||l.targetPath.startsWith(`${old}/`)));await this.saveCompassData();}new Notice('Удалено');};
CompassPlugin220.prototype.convertLibraryNoteToFolder = async function(file){if(!file||file.extension!=='md')throw new Error('Это не заметка');const parent=file.path.split('/').slice(0,-1).join('/'),folderPath=`${parent}/${file.basename}`;if(this.app.vault.getAbstractFileByPath(folderPath))throw new Error('Папка с таким названием уже существует');const content=await this.app.vault.read(file);await this.app.vault.createFolder(folderPath);if(content.trim())await this.app.vault.rename(file,`${folderPath}/Заметка.md`);else await this.app.vault.delete(file);new Notice(`Создана папка: ${file.basename}`);};

const compass220BasePrinciples = CompassPlugin220.prototype.getPrinciples;
CompassPlugin220.prototype.getPrinciples = async function(options={}) { const all=await compass220BasePrinciples.call(this); if(options.includeHidden)return all; return all.filter(x=>!(this.hiddenPrinciples||[]).includes(x)); };
CompassPlugin220.prototype.setPrincipleVisible = async function(principle,visible){this.hiddenPrinciples=this.hiddenPrinciples||[];if(visible)this.hiddenPrinciples=this.hiddenPrinciples.filter(x=>x!==principle);else if(!this.hiddenPrinciples.includes(principle))this.hiddenPrinciples.push(principle);await this.saveCompassData();};

// Future daily notes get a proper visual heading even if the old template still contains plain text.
CompassPlugin220.prototype.ensureDate = async function(dateMoment){const date=dateMoment.format('YYYY-MM-DD'),path=`01 Дни/${date}.md`;let file=this.app.vault.getAbstractFileByPath(path);if(!file){const template=this.app.vault.getAbstractFileByPath('04 Шаблоны/Шаблон дня.md');let content=`# ${date}\n\n`;if(template){content=await this.app.vault.read(template);content=content.replace(/{{date}}/g,date).replace(/{{dateLong}}/g,dateMoment.format('D MMMM YYYY'));content=content.replace(/^\s*Привет👋\s*что расскажешь нового сегодня\?\s*$/mi,'## Привет👋 что расскажешь нового сегодня?').replace(/^\s*Привет,?\s*что нового расскажешь сегодня\?\s*$/mi,'## Привет, что нового расскажешь сегодня?');}file=await this.app.vault.create(path,content);}return file;};


/* Compass 2.2.1: clean technical library markers left by earlier prototypes. */
const CompassPlugin221 = module.exports;
const compass221BaseOnload = CompassPlugin221.prototype.onload;
CompassPlugin221.prototype.onload = async function() {
  await compass221BaseOnload.call(this);
  window.setTimeout(() => this.cleanupLegacyLibraryMarkers221().catch(e => console.warn('Compass 2.2.1 marker cleanup', e)), 1200);
};

CompassPlugin221.prototype.cleanupLegacyLibraryMarkers221 = async function() {
  const data = (await this.loadData()) || {};
  if (data.cleanupTechnicalLibraryMarkersV221) return 0;
  let changed = 0;
  const files = this.app.vault.getMarkdownFiles();
  // Remove only Compass technical marker comments. User text is never touched.
  const markerLine = /^\s*<!--\s*compass-library:[^\n]*?-->\s*\n?/gmi;
  for (const file of files) {
    const original = await this.app.vault.read(file);
    const cleaned = original.replace(markerLine, '');
    if (cleaned !== original) {
      await this.app.vault.modify(file, cleaned);
      changed += 1;
    }
  }
  const current = (await this.loadData()) || {};
  current.cleanupTechnicalLibraryMarkersV221 = true;
  await this.saveData(current);
  if (changed) new Notice(`Compass убрал технические строки из заметок: ${changed}`);
  return changed;
};


/* Compass 2.2.2: adaptive handover cards + source-of-truth sync for daily-linked library entries. */
const CompassPlugin222 = module.exports;
const compass222BaseOnload = CompassPlugin222.prototype.onload;
CompassPlugin222.prototype.onload = async function() {
  await compass222BaseOnload.call(this);
  this._libraryDailySyncTimers222 = new Map();
  this.registerEvent(this.app.vault.on('modify', file => {
    if (!file || file.extension !== 'md' || !String(file.path || '').startsWith('01 Дни/')) return;
    const key = file.path;
    const previous = this._libraryDailySyncTimers222.get(key);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      this._libraryDailySyncTimers222.delete(key);
      this.reconcileLibraryDailyLinksForFile222(file).catch(e => console.warn('Compass 2.2.2 daily link sync', e));
    }, 700);
    this._libraryDailySyncTimers222.set(key, timer);
  }));
  window.setTimeout(() => this.reconcileAllLibraryDailyLinks222().catch(e => console.warn('Compass 2.2.2 initial daily link sync', e)), 1600);
};

CompassPlugin222.prototype._normalizeLinkedText222 = function(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
};

CompassPlugin222.prototype._textSimilarity222 = function(a, b) {
  const left = new Set(this._normalizeLinkedText222(a).toLocaleLowerCase('ru').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const right = new Set(this._normalizeLinkedText222(b).toLocaleLowerCase('ru').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (!left.size || !right.size) return 0;
  let same = 0;
  for (const token of left) if (right.has(token)) same += 1;
  return same / Math.max(left.size, right.size);
};

CompassPlugin222.prototype._extractDailyLibrarySections222 = function(content) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!match) continue;
    let end = i + 1;
    while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
    const body = lines.slice(i + 1, end).join('\n').trim();
    sections.push({ heading: match[1].trim(), body, startLine: i });
    i = end - 1;
  }
  return sections;
};

CompassPlugin222.prototype.reconcileLibraryDailyLinksForFile222 = async function(file) {
  if (!file || file.extension !== 'md' || !String(file.path || '').startsWith('01 Дни/')) return 0;
  const allLinks = this.libraryDailyLinks || [];
  const links = allLinks.filter(link => link.dailyPath === file.path);
  if (!links.length) return 0;

  const content = await this.app.vault.read(file);
  const sections = this._extractDailyLibrarySections222(content);
  const byHeading = new Map();
  for (const section of sections) {
    if (!byHeading.has(section.heading)) byHeading.set(section.heading, []);
    byHeading.get(section.heading).push(section);
  }

  const keepIds = new Set();
  let changed = false;
  const groups = new Map();
  for (const link of links) {
    const heading = String(link.heading || `📚 ${(link.targetPath || '').split('/').pop() || ''}`).trim();
    if (!groups.has(heading)) groups.set(heading, []);
    groups.get(heading).push(link);
  }

  for (const [heading, groupLinks] of groups.entries()) {
    const candidates = [...(byHeading.get(heading) || [])].map((section, index) => ({ ...section, index, used: false }));
    const orderedLinks = [...groupLinks].sort((a, b) => +new Date(a.createdAt || 0) - +new Date(b.createdAt || 0));

    // First pass: exact content match. This preserves checklist state even when other items are deleted.
    for (const link of orderedLinks) {
      const oldText = this._normalizeLinkedText222(link.text);
      if (!oldText) continue;
      const exact = candidates.find(c => !c.used && this._normalizeLinkedText222(c.body) === oldText);
      if (exact) {
        exact.used = true;
        keepIds.add(link.id);
      }
    }

    // Second pass: strong similarity means the user edited the source text rather than deleting it.
    for (const link of orderedLinks) {
      if (keepIds.has(link.id)) continue;
      let best = null;
      let bestScore = 0;
      for (const candidate of candidates) {
        if (candidate.used || !candidate.body.trim()) continue;
        const score = this._textSimilarity222(link.text, candidate.body);
        if (score > bestScore) { bestScore = score; best = candidate; }
      }
      if (best && bestScore >= 0.55) {
        best.used = true;
        keepIds.add(link.id);
        const nextText = best.body.trim();
        if (this._normalizeLinkedText222(link.text) !== this._normalizeLinkedText222(nextText)) {
          link.text = nextText;
          link.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
    }

    // Final conservative pass: pair the remaining source sections and links in order only when counts match.
    const remainingLinks = orderedLinks.filter(link => !keepIds.has(link.id));
    const remainingSections = candidates.filter(c => !c.used && c.body.trim());
    if (remainingLinks.length && remainingLinks.length === remainingSections.length) {
      for (let i = 0; i < remainingLinks.length; i += 1) {
        const link = remainingLinks[i];
        const section = remainingSections[i];
        section.used = true;
        keepIds.add(link.id);
        const nextText = section.body.trim();
        if (this._normalizeLinkedText222(link.text) !== this._normalizeLinkedText222(nextText)) {
          link.text = nextText;
          link.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
    }
  }

  const before = allLinks.length;
  this.libraryDailyLinks = allLinks.filter(link => link.dailyPath !== file.path || keepIds.has(link.id));
  const removed = before - this.libraryDailyLinks.length;
  if (removed || changed) await this.saveCompassData();
  return removed;
};

CompassPlugin222.prototype.reconcileAllLibraryDailyLinks222 = async function() {
  const paths = [...new Set((this.libraryDailyLinks || []).map(link => link.dailyPath).filter(Boolean))];
  let removed = 0;
  for (const path of paths) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || file.extension !== 'md') {
      const before = (this.libraryDailyLinks || []).length;
      this.libraryDailyLinks = (this.libraryDailyLinks || []).filter(link => link.dailyPath !== path);
      removed += before - this.libraryDailyLinks.length;
      continue;
    }
    removed += await this.reconcileLibraryDailyLinksForFile222(file);
  }
  if (removed) await this.saveCompassData();
  return removed;
};


/* Compass 2.2.3: focused iOS form visibility + daily greeting formatting. */
CompassPlugin222.prototype.formatDailyGreetings223 = async function() {
  const exact = [
    'Привет👋 что расскажешь нового сегодня?',
    'Привет 👋 что расскажешь нового сегодня?',
    'Привет, что нового расскажешь сегодня?',
    'Привет что нового расскажешь сегодня?'
  ];
  const fix = (content) => {
    const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
    let changed = false;
    const out = lines.map(line => {
      const trimmed = line.trim();
      if (/^#{1,6}\s+/.test(trimmed)) return line;
      if (exact.includes(trimmed)) { changed = true; return `## ${trimmed}`; }
      return line;
    });
    return { changed, content: out.join('\n') };
  };

  const paths = ['04 Шаблоны/Шаблон дня.md'];
  for (const file of this.app.vault.getMarkdownFiles()) if (file.path.startsWith('01 Дни/')) paths.push(file.path);
  let count = 0;
  for (const path of paths) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || file.extension !== 'md') continue;
    const original = await this.app.vault.read(file);
    const result = fix(original);
    if (result.changed) { await this.app.vault.modify(file, result.content); count += 1; }
  }
  return count;
};

const compass223BaseOnload = CompassPlugin222.prototype.onload;
CompassPlugin222.prototype.onload = async function() {
  await compass223BaseOnload.call(this);
  this.app.workspace.onLayoutReady(() => {
    window.setTimeout(() => this.formatDailyGreetings223().catch(e => console.warn('Compass greeting migration', e)), 1200);
  });
};
