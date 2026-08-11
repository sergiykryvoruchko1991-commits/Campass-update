const { Plugin, Modal, Notice, ItemView, MarkdownView, moment, setIcon, Setting, PluginSettingTab, requestUrl } = require('obsidian');

const VIEW_TYPE = 'compass-sidebar-view';
const COMPASS_PLUGIN_VERSION = '2.2.0';
const COMPASS_DATA_SCHEMA_VERSION = 4;

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
        if (type.libraryPicker) this.plugin.openLibraryTargetPicker();
        else this.onChoose(type);
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
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
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
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
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

  onClose() {
    blurActiveEditable();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
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

  onClose() {
    blurActiveEditable();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}

class NewLibraryFolderModal extends Modal {
  constructor(app, plugin, parentPath, onCreated) {
    super(app);
    this.plugin = plugin;
    this.parentPath = parentPath;
    this.onCreated = onCreated;
    this.name = '';
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
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

  onClose() {
    blurActiveEditable();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}


class LibraryFolderSettingsModal extends Modal {
  constructor(app, plugin, folderPath, label, onDone) {
    super(app);
    this.plugin = plugin;
    this.folderPath = folderPath;
    this.label = label || folderPath.split('/').pop();
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('compass-library-settings-modal');
    contentEl.createEl('h2', { text: `⚙️ ${this.label}` });
    contentEl.createEl('p', {
      text: 'Эти функции включаются только для этой папки. Обновление Compass ничего не включает автоматически.',
      cls: 'setting-item-description'
    });
    const current = this.plugin.getLibraryFolderSetting(this.folderPath);

    new Setting(contentEl)
      .setName('Добавлять из ежедневной заметки')
      .setDesc('Показывает «📚 База знаний» в меню добавления блока. После выбора можно пройти по подпапкам и выбрать место записи.')
      .addToggle(toggle => toggle.setValue(Boolean(current.dailyEnabled)).onChange(async value => {
        await this.plugin.setLibraryFolderSetting(this.folderPath, { dailyEnabled: value });
      }));

    new Setting(contentEl)
      .setName('Чекбоксы у собранных записей')
      .setDesc('Удобно для хендовера и других рабочих списков. Исходные записи в ежедневнике не удаляются.')
      .addToggle(toggle => toggle.setValue(Boolean(current.checkboxMode)).onChange(async value => {
        await this.plugin.setLibraryFolderSetting(this.folderPath, { checkboxMode: value });
      }));

    new Setting(contentEl)
      .setName('Скрывать дату в списке')
      .setDesc('Текст записи показывается без даты, но по нажатию всё равно открывается исходный день.')
      .addToggle(toggle => toggle.setValue(Boolean(current.hideDates)).onChange(async value => {
        await this.plugin.setLibraryFolderSetting(this.folderPath, { hideDates: value });
      }));

    new Setting(contentEl)
      .setName('Папки по периодам')
      .setDesc('Разрешает вручную сформировать папку за выбранный период, например 12.03.2025–05.04.2025.')
      .addToggle(toggle => toggle.setValue(Boolean(current.periodMode)).onChange(async value => {
        await this.plugin.setLibraryFolderSetting(this.folderPath, { periodMode: value });
      }));

    if (current.periodMode) {
      new Setting(contentEl)
        .setName('Сформировать период')
        .setDesc('Создаёт обычную папку и показывает в ней связанные дневные записи за выбранные даты.')
        .addButton(button => button.setButtonText('Выбрать даты').onClick(() => {
          new CreateLibraryPeriodModal(this.app, this.plugin, this.folderPath, async () => {
            if (this.onDone) this.onDone();
          }).open();
        }));
    }

    const close = contentEl.createEl('button', { text: 'Готово', cls: 'mod-cta compass-full-button' });
    close.onclick = () => { this.close(); if (this.onDone) this.onDone(); };
  }

  onClose() { this.contentEl.empty(); }
}

class CreateLibraryPeriodModal extends Modal {
  constructor(app, plugin, rootPath, onDone) {
    super(app);
    this.plugin = plugin;
    this.rootPath = rootPath;
    this.onDone = onDone;
    this.start = '';
    this.end = '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Сформировать папку периода' });
    contentEl.createEl('p', { text: 'Укажи начало и конец периода. Исходные записи останутся в своих ежедневных заметках.', cls: 'setting-item-description' });

    new Setting(contentEl).setName('Начало').addText(text => {
      text.inputEl.type = 'date';
      text.onChange(value => { this.start = value; });
    });
    new Setting(contentEl).setName('Конец').addText(text => {
      text.inputEl.type = 'date';
      text.onChange(value => { this.end = value; });
    });

    const actions = contentEl.createDiv({ cls: 'compass-section-actions' });
    actions.createEl('button', { text: 'Отмена' }).onclick = () => this.close();
    const create = actions.createEl('button', { text: 'Сформировать', cls: 'mod-cta' });
    create.onclick = async () => {
      if (!this.start || !this.end) return new Notice('Укажи обе даты');
      if (this.start > this.end) return new Notice('Дата начала должна быть раньше даты окончания');
      create.disabled = true;
      try {
        await this.plugin.createLibraryPeriod(this.rootPath, this.start, this.end);
        this.close();
        if (this.onDone) this.onDone();
      } catch (e) {
        new Notice(`Не удалось создать период: ${e.message || e}`);
        create.disabled = false;
      }
    };
  }

  onClose() { this.contentEl.empty(); }
}

class RenameLibraryItemModal extends Modal {
  constructor(app, plugin, item, onDone) {
    super(app);
    this.plugin = plugin;
    this.item = item;
    this.onDone = onDone;
    this.value = item.extension === 'md' ? item.basename : item.name;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Переименовать' });
    new Setting(contentEl).setName('Новое название').addText(text => {
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
        await this.plugin.renameLibraryItem(this.item, this.value);
        this.close();
        if (this.onDone) this.onDone();
      } catch (e) { new Notice(`Не удалось переименовать: ${e.message || e}`); }
    };
  }
}

class LibraryItemActionsModal extends Modal {
  constructor(app, plugin, item, onDone) {
    super(app);
    this.plugin = plugin;
    this.item = item;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    const isFolder = Array.isArray(this.item.children);
    contentEl.createEl('h2', { text: `${isFolder ? '📁' : '📄'} ${isFolder ? this.item.name : this.item.basename}` });

    if (isFolder) {
      const settings = contentEl.createEl('button', { text: '⚙️ Настройки папки', cls: 'compass-full-button' });
      settings.onclick = () => new LibraryFolderSettingsModal(this.app, this.plugin, this.item.path, this.item.name, this.onDone).open();
    }

    const rename = contentEl.createEl('button', { text: '✏️ Переименовать', cls: 'compass-full-button' });
    rename.onclick = () => new RenameLibraryItemModal(this.app, this.plugin, this.item, this.onDone).open();

    const remove = contentEl.createEl('button', { text: '🗑 Удалить', cls: 'compass-danger-action compass-full-button' });
    remove.onclick = async () => {
      const hasChildren = isFolder && this.item.children.length > 0;
      const message = hasChildren
        ? 'В этой папке есть файлы или подпапки. Удалить папку вместе со всем содержимым?'
        : `Удалить ${isFolder ? 'папку' : 'заметку'} «${isFolder ? this.item.name : this.item.basename}»?`;
      if (!window.confirm(message)) return;
      try {
        await this.plugin.deleteLibraryItem(this.item);
        this.close();
        if (this.onDone) this.onDone();
      } catch (e) { new Notice(`Не удалось удалить: ${e.message || e}`); }
    };

    contentEl.createEl('button', { text: 'Отмена', cls: 'compass-secondary-action compass-full-button' }).onclick = () => this.close();
  }

  onClose() { this.contentEl.empty(); }
}

class LibraryTargetPickerModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.root = null;
    this.currentPath = null;
  }

  onOpen() { this.render(); }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('compass-library-picker');
    contentEl.createEl('h2', { text: '📚 Куда добавить запись?' });

    if (!this.root) {
      const roots = this.plugin.getDailyLibraryRoots();
      if (!roots.length) {
        contentEl.createEl('p', { text: 'Сначала включи «Добавлять из ежедневной заметки» в настройках нужной базы знаний.' });
        return;
      }
      const list = contentEl.createDiv({ cls: 'compass-library-list' });
      roots.forEach(root => {
        const b = list.createEl('button', { cls: 'compass-library-entry' });
        b.createSpan({ text: root.emoji || '📚', cls: 'compass-library-entry-icon' });
        b.createSpan({ text: root.name, cls: 'compass-library-entry-name' });
        b.onclick = () => { this.root = root; this.currentPath = root.folder; this.render(); };
      });
      return;
    }

    const folder = this.app.vault.getAbstractFileByPath(this.currentPath);
    const title = this.currentPath === this.root.folder ? this.root.name : this.currentPath.split('/').pop();
    contentEl.createEl('p', { text: `Выбрано: ${this.root.name}${this.currentPath === this.root.folder ? '' : ' › ' + this.currentPath.slice(this.root.folder.length + 1).split('/').join(' › ')}`, cls: 'setting-item-description' });
    if (this.plugin.isLibraryDailySelectable(this.currentPath)) {
      const choose = contentEl.createEl('button', { text: `✓ Добавить сюда: ${title}`, cls: 'mod-cta compass-full-button' });
      choose.onclick = async () => {
        this.close();
        await this.plugin.addLibraryEntry(this.currentPath, title);
      };
    } else {
      contentEl.createEl('p', { text: 'Эта папка служит только для навигации. Выбери папку, для которой включено добавление из ежедневника.', cls: 'setting-item-description' });
    }

    const folders = folder && Array.isArray(folder.children)
      ? folder.children.filter(item => Array.isArray(item.children) && this.plugin.isLibraryDailyNavigable(item.path)).sort((a,b) => a.name.localeCompare(b.name, 'ru'))
      : [];
    if (folders.length) {
      contentEl.createEl('h3', { text: 'Подпапки' });
      const list = contentEl.createDiv({ cls: 'compass-library-list' });
      folders.forEach(item => {
        const b = list.createEl('button', { cls: 'compass-library-entry' });
        b.createSpan({ text: '📁', cls: 'compass-library-entry-icon' });
        b.createSpan({ text: item.name, cls: 'compass-library-entry-name' });
        b.createSpan({ text: '›', cls: 'compass-library-entry-chevron' });
        b.onclick = () => { this.currentPath = item.path; this.render(); };
      });
    }

    const nav = contentEl.createDiv({ cls: 'compass-section-actions' });
    if (this.currentPath !== this.root.folder) {
      nav.createEl('button', { text: '← Назад' }).onclick = () => {
        this.currentPath = this.currentPath.split('/').slice(0,-1).join('/');
        this.render();
      };
    } else {
      nav.createEl('button', { text: '← К списку баз' }).onclick = () => { this.root = null; this.currentPath = null; this.render(); };
    }
  }

  onClose() { this.contentEl.empty(); }
}

class PrinciplesManagerModal extends Modal {
  constructor(app, plugin, onDone) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
  }

  async onOpen() { await this.render(); }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('compass-principles-manager');
    contentEl.createEl('h2', { text: '🧭 Принципы над календарём' });
    contentEl.createEl('p', { text: 'Выключение убирает принцип только из ротации над календарём. Исходная запись остаётся в дневнике и журнале.', cls: 'setting-item-description' });
    const principles = await this.plugin.getPrinciples();
    if (!principles.length) return contentEl.createEl('p', { text: 'Принципов пока нет.' });
    principles.forEach(principle => {
      const row = new Setting(contentEl).setName(principle);
      row.addToggle(toggle => toggle
        .setValue(!this.plugin.hiddenPrinciples.includes(principle))
        .onChange(async visible => {
          await this.plugin.setPrincipleVisible(principle, visible);
          if (this.onDone) this.onDone();
        }));
    });
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

  async onOpen() { await this.render(); }

  getRelativeParts() {
    if (this.currentPath === this.rootPath) return [];
    return this.currentPath.slice(this.rootPath.length).replace(/^\//, '').split('/').filter(Boolean);
  }

  openFolder(path) {
    this.currentPath = path;
    this.render();
  }

  attachManagePress(button, item) {
    let timer = null;
    let suppress = false;
    const cancel = () => { if (timer) window.clearTimeout(timer); timer = null; };
    button.addEventListener('contextmenu', event => {
      event.preventDefault();
      new LibraryItemActionsModal(this.app, this.plugin, item, () => this.render()).open();
    });
    button.addEventListener('touchstart', () => {
      cancel();
      timer = window.setTimeout(() => {
        suppress = true;
        new LibraryItemActionsModal(this.app, this.plugin, item, () => this.render()).open();
      }, 600);
    }, { passive: true });
    button.addEventListener('touchend', cancel, { passive: true });
    button.addEventListener('touchcancel', cancel, { passive: true });
    button.addEventListener('touchmove', cancel, { passive: true });
    return () => { if (suppress) { suppress = false; return true; } return false; };
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

  async render() {
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

    const tools = contentEl.createDiv({ cls: 'compass-library-tools' });
    const folderSettings = tools.createEl('button', { text: '⚙️ Настройки этой папки' });
    folderSettings.onclick = () => new LibraryFolderSettingsModal(this.app, this.plugin, this.currentPath, this.currentPath === this.rootPath ? this.label : this.currentPath.split('/').pop(), () => this.render()).open();
    const currentSetting = this.plugin.getLibraryFolderSetting(this.currentPath);
    if (currentSetting.periodMode) {
      const period = tools.createEl('button', { text: '🗓 Сформировать период' });
      period.onclick = () => new CreateLibraryPeriodModal(this.app, this.plugin, this.currentPath, () => this.render()).open();
    }

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
    }

    const list = contentEl.createDiv({ cls: 'compass-library-list compass-library-tree-list' });
    folders.forEach(folderItem => {
      const button = list.createEl('button', { cls: 'compass-library-entry compass-library-folder' });
      button.createSpan({ text: '📁', cls: 'compass-library-entry-icon' });
      button.createSpan({ text: folderItem.name, cls: 'compass-library-entry-name' });
      button.createSpan({ text: '›', cls: 'compass-library-entry-chevron' });
      const wasManaged = this.attachManagePress(button, folderItem);
      button.onclick = event => { if (wasManaged()) { event.preventDefault(); return; } this.openFolder(folderItem.path); };
    });
    files.forEach(file => {
      const button = list.createEl('button', { cls: 'compass-library-entry compass-library-note' });
      button.createSpan({ text: '📄', cls: 'compass-library-entry-icon' });
      button.createSpan({ text: file.basename, cls: 'compass-library-entry-name' });
      const wasManaged = this.attachManagePress(button, file);
      button.onclick = async event => {
        if (wasManaged()) { event.preventDefault(); return; }
        this.close();
        await this.app.workspace.getLeaf(false).openFile(file);
      };
    });

    await this.renderCollectedEntries(contentEl);
  }

  async renderCollectedEntries(container) {
    const period = this.plugin.getLibraryPeriodForFolder(this.currentPath);
    const sourcePath = period ? period.rootPath : this.currentPath;
    const setting = this.plugin.getLibraryFolderSetting(sourcePath);
    const entries = await this.plugin.scanLibraryDailyEntries(sourcePath, period ? { start: period.start, end: period.end } : null);
    const visible = period ? entries : entries.filter(entry => !this.plugin.isEntryInsideLibraryPeriod(sourcePath, entry.date));
    if (!visible.length) return;
    container.createEl('h3', { text: setting.checkboxMode ? 'Задачи из ежедневника' : 'Записи из ежедневника', cls: 'compass-library-daily-title' });
    const list = container.createDiv({ cls: 'compass-library-daily-list' });
    for (const entry of visible) {
      const row = list.createDiv({ cls: `compass-library-daily-entry${this.plugin.isLibraryEntryCompleted(entry.key) ? ' is-complete' : ''}` });
      if (setting.checkboxMode) {
        const check = row.createEl('input', { attr: { type: 'checkbox' } });
        check.checked = this.plugin.isLibraryEntryCompleted(entry.key);
        check.onchange = async () => { await this.plugin.setLibraryEntryCompleted(entry.key, check.checked); await this.render(); };
      }
      const open = row.createEl('button', { cls: 'compass-library-daily-open' });
      open.createSpan({ text: entry.text || 'Запись', cls: 'compass-library-daily-text' });
      if (!setting.hideDates) open.createSpan({ text: formatJournalDate(entry.date), cls: 'compass-library-daily-date' });
      open.createSpan({ text: '↗', cls: 'compass-library-daily-jump' });
      open.onclick = async () => {
        this.close();
        const file = this.app.vault.getAbstractFileByPath(entry.filePath);
        if (file) await this.app.workspace.getLeaf(false).openFile(file);
      };
    }
  }

  onClose() { this.contentEl.empty(); }
}



class RenameSectionModal extends Modal {
  constructor(app, plugin, section, onDone) {
    super(app);
    this.plugin = plugin;
    this.section = section;
    this.onDone = onDone;
    this.value = section.name || '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Переименовать раздел' });
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
        await this.plugin.renameSection(this.section, this.value);
        this.close();
        if (this.onDone) this.onDone();
      } catch (e) { new Notice(`Не удалось переименовать: ${e.message || e}`); }
    };
  }
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

    if (this.section.type === 'library' && this.section.folder) {
      const settings = contentEl.createEl('button', { text: '⚙️ Настройки базы знаний', cls: 'compass-full-button' });
      settings.onclick = () => new LibraryFolderSettingsModal(this.app, this.plugin, this.section.folder, this.section.name).open();
    }

    if (this.section.source === 'custom') {
      const rename = contentEl.createEl('button', { text: '✏️ Переименовать', cls: 'compass-full-button' });
      rename.onclick = () => new RenameSectionModal(this.app, this.plugin, this.section, () => this.close()).open();
    }

    const archive = contentEl.createEl('button', { text: '📦 Перенести в архив', cls: 'compass-danger-action compass-full-button' });
    archive.onclick = async () => {
      const ok = await this.plugin.archiveSection(this.section);
      if (ok) {
        this.close();
        window.setTimeout(() => blurActiveEditable(), 0);
      }
    };

    if (this.section.source === 'custom') {
      const remove = contentEl.createEl('button', { text: '🗑 Удалить раздел', cls: 'compass-danger-action compass-full-button' });
      remove.onclick = async () => {
        const warning = this.section.type === 'library'
          ? 'Удалить эту базу знаний со всеми файлами и подпапками? Это действие нельзя отменить.'
          : 'Удалить этот журнал? Записи в ежедневных заметках останутся, но файл журнала будет удалён.';
        if (!window.confirm(warning)) return;
        const ok = await this.plugin.deleteSection(this.section);
        if (ok) this.close();
      };
    }

    const cancel = contentEl.createEl('button', { text: 'Отмена', cls: 'compass-secondary-action compass-full-button' });
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
  const update = () => {
    let occluded = 0;
    if (viewport) occluded = Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop));
    rootEl.style.setProperty('--compass-keyboard-offset', `${Math.round(occluded)}px`);
    rootEl.classList.toggle('is-keyboard-open', occluded > 80);
    if (occluded > 80) {
      const active = document.activeElement;
      if (active instanceof Element && rootEl.contains(active) && active.matches('input, textarea, [contenteditable="true"]')) {
        window.setTimeout(() => {
          try { active.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (_) {}
        }, 120);
      }
    }
  };
  const onFocus = event => {
    const target = event.target;
    if (target instanceof Element && target.matches('input, textarea, [contenteditable="true"]')) {
      window.setTimeout(update, 180);
    }
  };
  rootEl.addEventListener('focusin', onFocus, true);
  if (viewport) {
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
  }
  window.addEventListener('orientationchange', update);
  update();

  const cleanup = () => {
    rootEl.removeEventListener('focusin', onFocus, true);
    if (viewport) {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    }
    window.removeEventListener('orientationchange', update);
    rootEl.style.removeProperty('--compass-keyboard-offset');
    rootEl.classList.remove('is-keyboard-open');
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
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
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
      cls: 'compass-situation-textarea',
      attr: { placeholder: 'Пиши всё, что считаешь важным…' }
    });
    textarea.addEventListener('input', () => { this.text = textarea.value; });
    setTimeout(() => textarea.focus(), 50);

    const keyboardActions = contentEl.createDiv({ cls: 'compass-keyboard-actions' });
    const dictate = keyboardActions.createEl('button', { text: '🎙️ Диктовать', cls: 'compass-dictate-button' });
    this.cleanupDictation = attachSpeechDictation(dictate, textarea, 'ru-RU');
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
    const textarea = contentEl.createEl('textarea', { cls: 'compass-situation-textarea' });
    textarea.value = this.value;
    textarea.addEventListener('input', () => { this.value = textarea.value; });
    const keyboardActions = contentEl.createDiv({ cls: 'compass-keyboard-actions' });
    const dictate = keyboardActions.createEl('button', { text: '🎙️ Диктовать', cls: 'compass-dictate-button' });
    this.cleanupDictation = attachSpeechDictation(dictate, textarea, 'ru-RU');
    const hideKeyboard = keyboardActions.createEl('button', { text: '⌄ Скрыть клавиатуру', cls: 'compass-hide-keyboard' });
    hideKeyboard.onclick = () => blurActiveEditable();
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
        contentEl.createEl('h3', { text: 'Обсуждение', cls: 'compass-discussion-title' });
        this.renderColorPicker(contentEl, prefs);
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

  renderColorPicker(container, prefs) {
    const me = this.plugin.relationshipSession.user.id;
    const mine = prefs.find(p => p.user_id === me)?.accent_color || 'blue';
    const wrap = container.createDiv({ cls: 'compass-color-picker' });
    wrap.createSpan({ text: 'Мой цвет:' });
    ['blue', 'green', 'purple', 'orange'].forEach(color => {
      const b = wrap.createEl('button', { cls: `compass-color-dot color-${color}${mine === color ? ' is-active' : ''}`, attr: { 'aria-label': color } });
      b.onclick = async () => {
        try {
          await this.plugin.setRelationshipAccentColor(color);
          await this.render();
        } catch (e) { new Notice(`Не удалось изменить цвет: ${e.message || e}`); }
      };
    });
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

    const composer = container.createDiv({ cls: 'compass-message-composer' });
    const textarea = composer.createEl('textarea', { attr: { placeholder: 'Продолжить обсуждение…' } });
    const keyboardActions = composer.createDiv({ cls: 'compass-keyboard-actions' });
    const dictate = keyboardActions.createEl('button', { text: '🎙️ Диктовать', cls: 'compass-dictate-button' });
    if (this.cleanupDictation) this.cleanupDictation();
    this.cleanupDictation = attachSpeechDictation(dictate, textarea, 'ru-RU');
    const hideKeyboard = keyboardActions.createEl('button', { text: '⌄ Скрыть клавиатуру', cls: 'compass-hide-keyboard' });
    hideKeyboard.onclick = () => blurActiveEditable();
    const actions = composer.createDiv({ cls: 'compass-section-actions' });
    const send = actions.createEl('button', { text: 'Отправить', cls: 'mod-cta' });
    send.onclick = async () => {
      const value = textarea.value.trim();
      if (!value) return new Notice('Напиши сообщение');
      send.disabled = true;
      try { await this.plugin.addRelationshipMessage(this.situation.id, value); await this.render(); }
      catch (e) { new Notice(`Не удалось отправить: ${e.message || e}`); send.disabled = false; }
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
    principleCard.onclick = () => new PrinciplesManagerModal(this.app, this.plugin, () => this.refreshPrinciple()).open();
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
    const principles = await this.plugin.getVisiblePrinciples();
    if (!this.principleTextEl) return;
    if (!principles.length) {
      this.principleTextEl.setText('Нет принципов для показа. Нажми сюда, чтобы настроить.');
      return;
    }
    this.principleIndex = Math.min(this.principleIndex || 0, principles.length - 1);
    this.principleTextEl.setText(principles[this.principleIndex]);
  }

  async showNextPrinciple() {
    const principles = await this.plugin.getVisiblePrinciples();
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
    this.librarySettings = data?.librarySettings && typeof data.librarySettings === 'object' ? data.librarySettings : {};
    this.libraryPeriods = Array.isArray(data?.libraryPeriods) ? data.libraryPeriods : [];
    this.hiddenPrinciples = Array.isArray(data?.hiddenPrinciples) ? data.hiddenPrinciples : [];
    this.completedLibraryEntries = Array.isArray(data?.completedLibraryEntries) ? data.completedLibraryEntries : [];
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

    // v3 -> v4: optional knowledge-base behavior and principle visibility.
    // Only plugin settings are initialized; existing notes and folders are not rewritten.
    if (version < 4) {
      if (!data.librarySettings || typeof data.librarySettings !== 'object') data.librarySettings = {};
      if (!Array.isArray(data.libraryPeriods)) data.libraryPeriods = [];
      if (!Array.isArray(data.hiddenPrinciples)) data.hiddenPrinciples = [];
      if (!Array.isArray(data.completedLibraryEntries)) data.completedLibraryEntries = [];
      version = 4;
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
    const knowledge = this.hasDailyLibraryRoots()
      ? [{ key: 'knowledge-base', label: '📚 База знаний', libraryPicker: true }]
      : [];
    return [...builtins, ...custom, ...knowledge];
  }

  getLibraryRoots() {
    const roots = [];
    if (!this.isBuiltinHidden('library:Книги и видео')) roots.push({ source: 'builtin', name: 'Книги и видео', emoji: '📚', folder: '02 Книги и видео' });
    this.getCustomLibraries().forEach(section => roots.push({ ...section, source: 'custom' }));
    return roots;
  }

  getLibraryFolderSetting(path) {
    const raw = this.librarySettings?.[path] || {};
    return {
      dailyEnabled: Boolean(raw.dailyEnabled),
      checkboxMode: Boolean(raw.checkboxMode),
      hideDates: Boolean(raw.hideDates),
      periodMode: Boolean(raw.periodMode)
    };
  }

  async setLibraryFolderSetting(path, patch) {
    this.librarySettings = this.librarySettings || {};
    this.librarySettings[path] = { ...this.getLibraryFolderSetting(path), ...patch };
    await this.saveCompassData();
    this.refreshSidebar();
  }

  getDailyLibraryRoots() {
    return this.getLibraryRoots().filter(root => Object.entries(this.librarySettings || {}).some(([path, value]) =>
      Boolean(value?.dailyEnabled) && (path === root.folder || path.startsWith(`${root.folder}/`))
    ));
  }

  hasDailyLibraryRoots() { return this.getDailyLibraryRoots().length > 0; }

  isLibraryDailySelectable(path) {
    return Object.entries(this.librarySettings || {}).some(([enabledPath, value]) =>
      Boolean(value?.dailyEnabled) && (path === enabledPath || path.startsWith(`${enabledPath}/`))
    );
  }

  isLibraryDailyNavigable(path) {
    return this.isLibraryDailySelectable(path) || Object.entries(this.librarySettings || {}).some(([enabledPath, value]) =>
      Boolean(value?.dailyEnabled) && enabledPath.startsWith(`${path}/`)
    );
  }

  openLibraryTargetPicker() { new LibraryTargetPickerModal(this.app, this).open(); }

  async setPrincipleVisible(principle, visible) {
    const set = new Set(this.hiddenPrinciples || []);
    if (visible) set.delete(principle); else set.add(principle);
    this.hiddenPrinciples = [...set];
    await this.saveCompassData();
    this.refreshSidebar();
  }

  async getVisiblePrinciples() {
    const all = await this.getPrinciples();
    const hidden = new Set(this.hiddenPrinciples || []);
    return all.filter(item => !hidden.has(item));
  }

  getLibraryPeriodForFolder(path) {
    return (this.libraryPeriods || []).find(item => item.folderPath === path) || null;
  }

  isEntryInsideLibraryPeriod(rootPath, date) {
    return (this.libraryPeriods || []).some(item => item.rootPath === rootPath && date >= item.start && date <= item.end);
  }

  async createLibraryPeriod(rootPath, start, end) {
    const startM = moment(start, 'YYYY-MM-DD', true);
    const endM = moment(end, 'YYYY-MM-DD', true);
    if (!startM.isValid() || !endM.isValid()) throw new Error('Некорректные даты');
    const name = `${startM.format('DD.MM.YYYY')}–${endM.format('DD.MM.YYYY')}`;
    const folderPath = `${rootPath}/${name}`;
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (existing) throw new Error('Папка такого периода уже существует');
    await this.ensureFolder(rootPath);
    await this.app.vault.createFolder(folderPath);
    this.libraryPeriods = [...(this.libraryPeriods || []), { rootPath, folderPath, start, end, createdAt: new Date().toISOString() }];
    await this.saveCompassData();
    new Notice(`Период сформирован: ${name}`);
    return folderPath;
  }

  isLibraryEntryCompleted(key) { return (this.completedLibraryEntries || []).includes(key); }

  async setLibraryEntryCompleted(key, completed) {
    const set = new Set(this.completedLibraryEntries || []);
    if (completed) set.add(key); else set.delete(key);
    this.completedLibraryEntries = [...set];
    await this.saveCompassData();
  }

  async scanLibraryDailyEntries(folderPath, period = null) {
    const result = [];
    const encoded = encodeURIComponent(folderPath);
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith('01 Дни/'));
    for (const file of files) {
      const date = file.basename;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (period && (date < period.start || date > period.end)) continue;
      let content;
      try { content = await this.app.vault.cachedRead(file); } catch (_) { continue; }
      const lines = content.split('\n');
      let occurrence = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const marker = lines[i].match(/^<!--\s*compass-library:([^>]+)\s*-->\s*$/);
        if (!marker) continue;
        let path;
        try { path = decodeURIComponent(marker[1].trim()); } catch (_) { path = marker[1].trim(); }
        if (path !== folderPath) continue;
        occurrence += 1;
        let heading = '';
        for (let h = i - 1; h >= 0; h -= 1) {
          const hm = lines[h].match(/^##\s+(.+)$/);
          if (hm) { heading = hm[1].trim(); break; }
          if (/^#{1,6}\s+/.test(lines[h])) break;
        }
        const body = [];
        for (let j = i + 1; j < lines.length; j += 1) {
          if (/^#{1,6}\s+/.test(lines[j])) break;
          const line = lines[j].trim();
          if (line && !/^<!--/.test(line)) body.push(line);
        }
        const text = body.join(' ').replace(/\s+/g, ' ').trim() || heading.replace(/^📚\s*/, '') || folderPath.split('/').pop();
        result.push({
          key: `${folderPath}|${date}|${occurrence}`,
          date,
          filePath: file.path,
          text: text.length > 240 ? `${text.slice(0, 237)}…` : text
        });
      }
    }
    result.sort((a,b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
    return result;
  }

  async addLibraryEntry(folderPath, label) {
    let view = this.app.workspace.getActiveViewOfType(MarkdownView);
    let file = view && view.file && view.file.path.startsWith('01 Дни/') ? view.file : null;
    if (!file) file = await this.ensureDate(moment());
    await this.app.workspace.getLeaf(false).openFile(file);
    view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const heading = `📚 ${label || folderPath.split('/').pop()}`;
    const marker = `<!-- compass-library:${encodeURIComponent(folderPath)} -->`;
    const block = `\n## ${heading}\n${marker}\n\n`;
    if (view && view.file && view.file.path === file.path) {
      const editor = view.editor;
      editor.setCursor(editor.lineCount(), 0);
      editor.replaceSelection(block);
      editor.focus();
    } else {
      await this.app.vault.append(file, block);
    }
    new Notice(`Добавлено в день: ${label || folderPath.split('/').pop()}`);
  }

  async rewriteDailyLibraryPaths(oldPath, newPath) {
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith('01 Дни/'));
    for (const file of files) {
      const original = await this.app.vault.read(file);
      const updated = original.replace(/<!--\s*compass-library:([^>]+)\s*-->/g, (full, raw) => {
        let path;
        try { path = decodeURIComponent(String(raw).trim()); } catch (_) { return full; }
        if (path === oldPath || path.startsWith(`${oldPath}/`)) {
          const next = `${newPath}${path.slice(oldPath.length)}`;
          return `<!-- compass-library:${encodeURIComponent(next)} -->`;
        }
        return full;
      });
      if (updated !== original) await this.app.vault.modify(file, updated);
    }
  }

  migrateLibraryPathState(oldPath, newPath) {
    const nextSettings = {};
    for (const [path, value] of Object.entries(this.librarySettings || {})) {
      const key = path === oldPath || path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
      nextSettings[key] = value;
    }
    this.librarySettings = nextSettings;
    this.libraryPeriods = (this.libraryPeriods || []).map(period => ({
      ...period,
      rootPath: period.rootPath === oldPath || period.rootPath.startsWith(`${oldPath}/`) ? `${newPath}${period.rootPath.slice(oldPath.length)}` : period.rootPath,
      folderPath: period.folderPath === oldPath || period.folderPath.startsWith(`${oldPath}/`) ? `${newPath}${period.folderPath.slice(oldPath.length)}` : period.folderPath
    }));
    this.completedLibraryEntries = (this.completedLibraryEntries || []).map(key =>
      key.startsWith(`${oldPath}|`) ? `${newPath}${key.slice(oldPath.length)}` : key
    );
  }

  async renameLibraryItem(item, newName) {
    const clean = this.sanitizeName(newName);
    if (!clean) throw new Error('Недопустимое название');
    const isFolder = Array.isArray(item.children);
    const parent = item.path.split('/').slice(0,-1).join('/');
    const target = `${parent}/${clean}${isFolder ? '' : '.md'}`;
    if (target === item.path) return item;
    if (this.app.vault.getAbstractFileByPath(target)) throw new Error('Такое название уже существует');
    const oldPath = item.path;
    await this.app.vault.rename(item, target);
    if (isFolder) {
      this.migrateLibraryPathState(oldPath, target);
      await this.rewriteDailyLibraryPaths(oldPath, target);
      await this.saveCompassData();
    }
    new Notice(`Переименовано: ${clean}`);
    return this.app.vault.getAbstractFileByPath(target);
  }

  async deleteLibraryItem(item) {
    const path = item.path;
    try {
      if (this.app.fileManager?.trashFile) await this.app.fileManager.trashFile(item);
      else await this.app.vault.delete(item, true);
    } catch (_) { await this.app.vault.delete(item, true); }
    if (Array.isArray(item.children)) {
      const nextSettings = {};
      for (const [key, value] of Object.entries(this.librarySettings || {})) {
        if (!(key === path || key.startsWith(`${path}/`))) nextSettings[key] = value;
      }
      this.librarySettings = nextSettings;
      this.libraryPeriods = (this.libraryPeriods || []).filter(period => !(period.rootPath === path || period.rootPath.startsWith(`${path}/`) || period.folderPath === path || period.folderPath.startsWith(`${path}/`)));
      this.completedLibraryEntries = (this.completedLibraryEntries || []).filter(key => !key.startsWith(`${path}|`) && !key.startsWith(`${path}/`));
      await this.saveCompassData();
    }
    new Notice('Удалено');
  }

  async renameSection(section, newName) {
    if (section.source !== 'custom') throw new Error('Встроенный раздел нельзя переименовать');
    const clean = this.sanitizeName(newName);
    if (!clean) throw new Error('Недопустимое название');
    if (this.customSections.some(item => item !== section && item.name.toLocaleLowerCase('ru') === clean.toLocaleLowerCase('ru'))) throw new Error('Такой раздел уже существует');
    const found = this.customSections.find(item => item.type === section.type && item.name === section.name);
    if (!found) throw new Error('Раздел не найден');
    if (found.type === 'library') {
      const oldPath = found.folder;
      const parent = oldPath.split('/').slice(0,-1).join('/');
      const newPath = `${parent}/${clean}`;
      if (this.app.vault.getAbstractFileByPath(newPath)) throw new Error('Папка с таким названием уже существует');
      const folder = this.app.vault.getAbstractFileByPath(oldPath);
      if (folder) await this.app.vault.rename(folder, newPath);
      found.name = clean;
      found.folder = newPath;
      this.migrateLibraryPathState(oldPath, newPath);
      await this.rewriteDailyLibraryPaths(oldPath, newPath);
    } else {
      const oldPath = `03 Журналы/${found.journal}.md`;
      const newPath = `03 Журналы/${clean}.md`;
      if (this.app.vault.getAbstractFileByPath(newPath)) throw new Error('Журнал с таким названием уже существует');
      const file = this.app.vault.getAbstractFileByPath(oldPath);
      if (file) await this.app.vault.rename(file, newPath);
      found.name = clean;
      found.journal = clean;
    }
    await this.saveCompassData();
    this.refreshSidebar();
    new Notice(`Раздел переименован: ${clean}`);
  }

  async deleteSection(section) {
    if (section.source !== 'custom') return false;
    const found = this.customSections.find(item => item.type === section.type && item.name === section.name);
    if (!found) return false;
    const path = found.type === 'library' ? found.folder : `03 Журналы/${found.journal}.md`;
    const item = this.app.vault.getAbstractFileByPath(path);
    if (item) {
      try { if (this.app.fileManager?.trashFile) await this.app.fileManager.trashFile(item); else await this.app.vault.delete(item, true); }
      catch (_) { await this.app.vault.delete(item, true); }
    }
    this.customSections = this.customSections.filter(item => item !== found);
    if (found.type === 'library') {
      const nextSettings = {};
      for (const [key,value] of Object.entries(this.librarySettings || {})) if (!(key === path || key.startsWith(`${path}/`))) nextSettings[key] = value;
      this.librarySettings = nextSettings;
      this.libraryPeriods = (this.libraryPeriods || []).filter(period => !(period.rootPath === path || period.rootPath.startsWith(`${path}/`) || period.folderPath === path || period.folderPath.startsWith(`${path}/`)));
    }
    await this.saveCompassData();
    this.refreshSidebar();
    new Notice(`Удалено: ${section.name}`);
    return true;
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
      librarySettings: this.librarySettings || {},
      libraryPeriods: this.libraryPeriods || [],
      hiddenPrinciples: this.hiddenPrinciples || [],
      completedLibraryEntries: this.completedLibraryEntries || [],
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
        content = content.replace(/^\s*Привет, что нового расскажешь сегодня\?\s*$/m, '## Привет, что нового расскажешь сегодня?');
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
