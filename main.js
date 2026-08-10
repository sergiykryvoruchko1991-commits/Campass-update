const { Plugin, Modal, Notice, ItemView, MarkdownView, moment, setIcon, Setting, PluginSettingTab, requestUrl } = require('obsidian');

const VIEW_TYPE = 'compass-sidebar-view';
const COMPASS_PLUGIN_VERSION = '2.0.2';
const COMPASS_DATA_SCHEMA_VERSION = 3;

const COMPASS_UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/sergiykryvoruchko1991-commits/Campass-update/main/latest.json';
const COMPASS_UPDATE_ALLOWED_FILES = ['main.js', 'styles.css', 'manifest.json'];

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
    this.descriptionEl = null;
  }

  updateDescription() {
    if (!this.descriptionEl) return;
    this.descriptionEl.setText(
      this.sectionType === 'journal'
        ? 'Журнал подключается к дневнику: его можно выбрать при добавлении блока, а раздел будет собирать ссылки на дни.'
        : 'База знаний — обычная папка с отдельными файлами. Она не связана с ежедневными заметками и заполняется вручную.'
    );
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('compass-section-modal');
    contentEl.createEl('h2', { text: 'Новый раздел' });
    this.descriptionEl = contentEl.createEl('p', { cls: 'setting-item-description' });
    this.updateDescription();

    new Setting(contentEl)
      .setName('Тип раздела')
      .setDesc('Выбери, как этот раздел должен работать.')
      .addDropdown(dropdown => dropdown
        .addOption('journal', '📒 Журнал — связан с дневником')
        .addOption('library', '📚 База знаний — отдельные файлы')
        .setValue(this.sectionType)
        .onChange(value => {
          this.sectionType = value;
          this.updateDescription();
        }));

    new Setting(contentEl)
      .setName('Значок')
      .setDesc('Можно оставить 📌 или указать любой emoji.')
      .addText(text => text
        .setPlaceholder('📌')
        .setValue(this.emoji)
        .onChange(value => { this.emoji = value.trim() || '📌'; }));

    new Setting(contentEl)
      .setName('Название раздела')
      .setDesc('Например: Работа, Пароход, Спорт.')
      .addText(text => {
        text.setPlaceholder('Пароход');
        text.onChange(value => { this.name = value.trim(); });
        setTimeout(() => text.inputEl.focus(), 50);
      });

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
    contentEl.createEl('h2', { text: 'Новый документ' });
    new Setting(contentEl)
      .setName('Название')
      .setDesc('Будет создан отдельный файл внутри этой базы знаний.')
      .addText(text => {
        text.setPlaceholder('Название книги, узла, ремонта…');
        text.onChange(value => { this.name = value.trim(); });
        setTimeout(() => text.inputEl.focus(), 50);
      });

    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    const cancel = actions.createEl('button', { text: 'Отмена' });
    cancel.onclick = () => this.close();
    const create = actions.createEl('button', { text: 'Создать файл', cls: 'mod-cta' });
    create.onclick = async () => {
      if (!this.name) {
        new Notice('Введите название файла');
        return;
      }
      const file = await this.plugin.createLibraryDocument(this.folderPath, this.name);
      if (file) {
        this.close();
        if (this.onCreated) this.onCreated(file);
      }
    };
  }

  onClose() { this.contentEl.empty(); }
}

class LibraryModal extends Modal {
  constructor(app, plugin, folderPath, emoji, label) {
    super(app);
    this.plugin = plugin;
    this.folderPath = folderPath;
    this.emoji = emoji;
    this.label = label;
  }

  onOpen() { this.render(); }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('compass-library-modal');

    const header = contentEl.createDiv({ cls: 'compass-library-header' });
    header.createEl('h2', { text: `${this.emoji} ${this.label}` });
    const add = header.createEl('button', { text: '＋ Новый файл', cls: 'mod-cta' });
    add.onclick = () => {
      new NewDocumentModal(this.app, this.plugin, this.folderPath, async file => {
        this.close();
        await this.app.workspace.getLeaf(false).openFile(file);
      }).open();
    };

    const folder = this.app.vault.getAbstractFileByPath(this.folderPath);
    const files = folder && Array.isArray(folder.children)
      ? folder.children.filter(f => f.extension === 'md' && !/^README$/i.test(f.basename)).sort((a, b) => a.basename.localeCompare(b.basename, 'ru'))
      : [];

    if (!files.length) {
      contentEl.createEl('p', { text: 'Здесь пока нет файлов. Нажми «＋ Новый файл», чтобы создать первый.', cls: 'setting-item-description' });
      return;
    }

    const list = contentEl.createDiv({ cls: 'compass-library-list' });
    files.forEach(file => {
      const button = list.createEl('button', { text: file.basename, cls: 'compass-library-file' });
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
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    contentEl.addClass('compass-relationship-login');
    contentEl.createEl('h2', { text: '❤️ Общее пространство' });
    contentEl.createEl('p', {
      text: 'Пароль Supabase и ключ шифрования используются только в текущем сеансе и не сохраняются в файлах Vault.',
      cls: 'setting-item-description'
    });

    new Setting(contentEl)
      .setName('Пароль пользователя')
      .setDesc(this.plugin.relationshipSettings.email || 'Сначала укажи email в настройках Compass.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Пароль Supabase Auth');
        text.onChange(value => { this.password = value; });
      });

    new Setting(contentEl)
      .setName('Ключ шифрования')
      .setDesc('Тот отдельный секрет, который сохранён у тебя в приложении «Пароли». У обоих участников он должен быть одинаковым.')
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
    this.text = '';
    this.cleanupKeyboardDismiss = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    contentEl.addClass('compass-situation-editor');
    const header = contentEl.createDiv({ cls: 'compass-situation-editor-header' });
    header.createEl('h2', { text: this.existingSituation ? 'Моя сторона' : 'Новая ситуация' });
    header.createEl('small', { text: moment().format('D MMMM YYYY · HH:mm') });

    const textarea = contentEl.createEl('textarea', {
      cls: 'compass-situation-textarea',
      attr: { placeholder: 'Пиши всё, что считаешь важным…' }
    });
    textarea.addEventListener('input', () => { this.text = textarea.value; });
    setTimeout(() => textarea.focus(), 50);

    const keyboardActions = contentEl.createDiv({ cls: 'compass-keyboard-actions' });
    const hideKeyboard = keyboardActions.createEl('button', { text: '⌄ Скрыть клавиатуру', cls: 'compass-hide-keyboard' });
    hideKeyboard.onclick = () => blurActiveEditable();

    const hint = contentEl.createEl('details', { cls: 'compass-situation-hint' });
    hint.createEl('summary', { text: 'Не знаю, с чего начать' });
    hint.createEl('p', { text: 'Что произошло? Что ты почувствовал? Что тебя задело? Чего ожидал? Как понял поведение другого человека?' });

    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    const cancel = actions.createEl('button', { text: 'Отмена' });
    cancel.onclick = () => this.close();
    const finish = actions.createEl('button', { text: 'Завершить 🔒', cls: 'mod-cta' });
    finish.onclick = async () => {
      if (!this.text.trim()) {
        new Notice('Запись пока пустая');
        return;
      }
      if (!window.confirm('После завершения первоначальную запись нельзя будет изменить. Завершить?')) return;
      finish.disabled = true;
      finish.setText('Сохраняю…');
      try {
        if (this.existingSituation) await this.plugin.addRelationshipEntry(this.existingSituation.id, this.text.trim());
        else await this.plugin.createRelationshipSituation(this.text.trim());
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
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}

class RelationshipSituationModal extends Modal {
  constructor(app, plugin, situation) {
    super(app);
    this.plugin = plugin;
    this.situation = situation;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass('compass-relationship-situation');
    contentEl.createEl('h2', { text: '❤️ Ситуация' });
    contentEl.createEl('p', { text: moment(this.situation.created_at).format('D MMMM YYYY · HH:mm'), cls: 'setting-item-description' });
    const loading = contentEl.createEl('p', { text: 'Открываю записи…' });
    try {
      const entries = await this.plugin.getRelationshipEntries(this.situation.id);
      loading.remove();
      const own = entries.find(e => e.author_id === this.plugin.relationshipSession.user.id);
      const other = entries.find(e => e.author_id !== this.plugin.relationshipSession.user.id);

      if (own) {
        const section = contentEl.createDiv({ cls: 'compass-perspective-card' });
        section.createEl('h3', { text: 'Моя запись' });
        section.createEl('div', { text: await this.plugin.decryptRelationshipText(own), cls: 'compass-perspective-text' });
      } else {
        const empty = contentEl.createDiv({ cls: 'compass-waiting-card' });
        empty.createEl('strong', { text: 'Твоя сторона ещё пустая' });
        empty.createEl('p', { text: 'Напиши свою версию свободным текстом. Чужая запись до завершения обеими сторонами не откроется.' });
        const addMine = empty.createEl('button', { text: 'Написать свою сторону', cls: 'mod-cta' });
        addMine.onclick = () => {
          this.close();
          new NewRelationshipSituationModal(this.app, this.plugin, () => new RelationshipSituationModal(this.app, this.plugin, this.situation).open(), this.situation).open();
        };
      }

      if (other) {
        const section = contentEl.createDiv({ cls: 'compass-perspective-card' });
        section.createEl('h3', { text: 'Запись партнёра' });
        section.createEl('div', { text: await this.plugin.decryptRelationshipText(other), cls: 'compass-perspective-text' });
        await this.plugin.archiveCompletedRelationshipSituation(this.situation, entries);
      } else {
        const wait = contentEl.createDiv({ cls: 'compass-waiting-card' });
        wait.createEl('strong', { text: 'Ожидание второй стороны' });
        wait.createEl('p', { text: 'Чужая запись откроется только после того, как обе стороны завершат свои тексты.' });
        const refresh = wait.createEl('button', { text: 'Обновить записи' });
        refresh.onclick = () => { this.close(); setTimeout(() => new RelationshipSituationModal(this.app, this.plugin, this.situation).open(), 150); };
      }
    } catch (e) {
      loading.setText(`Не удалось открыть: ${e.message || e}`);
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
    const add = header.createEl('button', { text: '＋ Новая ситуация', cls: 'mod-cta' });
    add.onclick = () => new NewRelationshipSituationModal(this.app, this.plugin, () => this.render()).open();

    contentEl.createEl('p', {
      text: 'Свободные записи двух сторон. Пока оба не завершат текст, вы не видите запись друг друга.',
      cls: 'setting-item-description'
    });

    const loading = contentEl.createEl('p', { text: 'Загружаю…' });
    try {
      const situations = await this.plugin.getRelationshipSituations();
      loading.remove();
      if (!situations.length) {
        contentEl.createEl('p', { text: 'Здесь пока нет ситуаций.' });
        return;
      }
      const list = contentEl.createDiv({ cls: 'compass-situations-list' });
      for (const situation of situations) {
        const row = list.createEl('button', { cls: 'compass-situation-row' });
        row.createEl('strong', { text: moment(situation.created_at).format('D MMMM YYYY · HH:mm') });
        const status = row.createEl('small', { text: 'Проверяю статус…' });
        try {
          const entries = await this.plugin.getRelationshipEntries(situation.id);
          if (entries.length >= 2) status.setText('Обе стороны готовы · открыть');
          else if (entries.some(e => e.author_id === this.plugin.relationshipSession.user.id)) status.setText('Моя запись завершена · ждём вторую сторону');
          else status.setText('Нужна моя запись');
        } catch (_) { status.setText('Открыть'); }
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
        this.plugin.relationshipSession = null;
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

    this.addDivider(container, 'Базы знаний');
    const libraryNav = container.createDiv({ cls: 'compass-nav' });
    this.addNavButton(libraryNav, '❤️', 'Отношения', () => this.plugin.openRelationships());
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
        const content = await this.app.vault.cachedRead(file);
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

  async openRelationships() {
    if (!this.relationshipConfigured()) {
      new Notice('Сначала заполни Supabase URL, Publishable key и email в Настройки → Compass');
      return;
    }
    if (!this.relationshipSession) {
      new RelationshipSessionModal(this.app, this, () => new RelationshipsModal(this.app, this).open()).open();
      return;
    }
    new RelationshipsModal(this.app, this).open();
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

  async createRelationshipSituation(text) {
    const session = this.relationshipSession;
    if (!session?.spaceId) throw new Error('Нет активного пространства');
    const situations = await this.supabaseRequest('/rest/v1/situations?select=id,space_id,created_by,created_at', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ space_id: session.spaceId, created_by: session.user.id, title: null })
    });
    const situation = Array.isArray(situations) ? situations[0] : null;
    if (!situation?.id) throw new Error('Не удалось создать ситуацию');
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
  }

  async getRelationshipSituations() {
    const spaceId = this.relationshipSession?.spaceId;
    if (!spaceId) return [];
    const rows = await this.supabaseRequest(`/rest/v1/situations?select=id,space_id,created_by,created_at&space_id=eq.${encodeURIComponent(spaceId)}&order=created_at.desc`);
    return Array.isArray(rows) ? rows : [];
  }

  async getRelationshipEntries(situationId) {
    const rows = await this.supabaseRequest(`/rest/v1/entries?select=id,situation_id,author_id,encrypted_content,encryption_iv,is_finished,created_at,finished_at&situation_id=eq.${encodeURIComponent(situationId)}&order=created_at.asc`);
    return Array.isArray(rows) ? rows : [];
  }

  async archiveCompletedRelationshipSituation(situation, entries) {
    if (!Array.isArray(entries) || entries.length < 2) return;
    await this.ensureFolder('02 Базы знаний/Отношения');
    const path = `02 Базы знаний/Отношения/${moment(situation.created_at).format('YYYY-MM-DD HHmm')} - ${situation.id.slice(0, 8)}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) return;
    const own = entries.find(e => e.author_id === this.relationshipSession.user.id);
    const other = entries.find(e => e.author_id !== this.relationshipSession.user.id);
    if (!own || !other) return;
    const ownText = await this.decryptRelationshipText(own);
    const otherText = await this.decryptRelationshipText(other);
    const content = `# ❤️ Ситуация — ${moment(situation.created_at).format('D MMMM YYYY · HH:mm')}\n\n## Моя запись\n\n${ownText}\n\n## Запись партнёра\n\n${otherText}\n`;
    await this.app.vault.create(path, content);
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
