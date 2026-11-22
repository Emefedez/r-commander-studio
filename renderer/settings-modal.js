(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    menuAction: 'both',
    dialogStyle: 'form',
    closeMenusAfterChoice: false,
    hoverPeekSidebars: true,
    editorWordWrap: true,
    autoSave: 'afterDelay',
    autoSaveDelayMs: 1500,
    showProblemErrors: true,
    showProblemWarnings: true,
    limitOutput: true,
    maxOutputItems: 24,
    fixedNotation: false,
    syntaxColors: true,
    skipHelp: true,
    skipCommands: '',
    consoleWrap: true,
    consoleScroll: true,
    dockPosition: 'bottom',
    runTarget: 'auto',
    loadRcmdrFunctions: true,
    rcmdrPlugins: '',
    cranMirror: 'https://cloud.r-project.org',
    packageDownloads: '~/.cache/r-commander-play/packages',
    themePreset: 'dracula',
    lastDarkPreset: 'dracula',
    lastLightPreset: 'vscode-light',
    themeOverrides: {}
  };

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('rcs-settings') || '{}');
      return { ...DEFAULT_SETTINGS, ...saved, themeOverrides: { ...(saved.themeOverrides || {}) } };
    } catch {
      return { ...DEFAULT_SETTINGS, themeOverrides: {} };
    }
  }

  function saveSettings(settings) {
    localStorage.setItem('rcs-settings', JSON.stringify(settings));
  }

  class StudioSettingsModal {
    constructor({ getSettings, onSave, onPreviewTheme, getLang, onSetLang }) {
      this.getSettings = getSettings;
      this.onSave = onSave;
      this.onPreviewTheme = onPreviewTheme;
      this.getLang = getLang;
      this.onSetLang = onSetLang;

      this.backdrop = document.getElementById('settingsBackdrop');
      this.body = document.getElementById('settingsBody');
      this.btnClose = document.getElementById('settingsClose');
      this.btnCancel = document.getElementById('settingsCancel');
      this.btnReset = document.getElementById('settingsReset');
      this.btnSave = document.getElementById('settingsSave');
      this._draftPreset = 'dracula';
      this._draftOverrides = {};
      this._origSnapshot = null;

      this.btnClose.addEventListener('click', () => this.cancel());
      this.btnCancel.addEventListener('click', () => this.cancel());
      this.btnReset.addEventListener('click', () => this._resetDefaults());
      this.btnSave.addEventListener('click', () => this._commit());
      this.backdrop.addEventListener('click', (e) => {
        if (e.target === this.backdrop) this.cancel();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.backdrop.hidden) this.cancel();
      });
    }

    open() {
      const cur = this.getSettings();
      this._origSnapshot = { preset: cur.themePreset, overrides: { ...(cur.themeOverrides || {}) } };
      this._draftPreset = cur.themePreset || 'dracula';
      this._draftOverrides = { ...(cur.themeOverrides || {}) };
      this._render(cur);
      this.backdrop.hidden = false;
    }

    cancel() {
      if (this._origSnapshot && this.onPreviewTheme) {
        this.onPreviewTheme(this._origSnapshot.preset, this._origSnapshot.overrides);
      }
      this.close();
    }

    close() {
      this.backdrop.hidden = true;
    }

    _resetDefaults() {
      this._draftPreset = DEFAULT_SETTINGS.themePreset;
      this._draftOverrides = {};
      this.onPreviewTheme?.(this._draftPreset, this._draftOverrides);
      this._render({ ...DEFAULT_SETTINGS });
    }

    _renderThemeTokenGrid() {
      const { THEME_TOKEN_KEYS, resolveTheme } = window.StudioThemes;
      const lang = this.getLang();
      const resolved = resolveTheme(this._draftPreset, this._draftOverrides);
      const grid = document.getElementById('themeTokenGrid');
      if (!grid) return;
      grid.textContent = '';

      for (const def of THEME_TOKEN_KEYS) {
        const val = resolved.tokens[def.key];
        const row = document.createElement('div');
        row.className = 'theme-token-row';

        const lbl = document.createElement('span');
        lbl.textContent = lang === 'es' ? def.labelEs : def.labelEn;

        const controls = document.createElement('div');
        controls.className = 'theme-token-controls';

        const colorInp = document.createElement('input');
        colorInp.type = 'color';
        colorInp.value = val;

        const hexInp = document.createElement('input');
        hexInp.type = 'text';
        hexInp.className = 'theme-hex-input';
        hexInp.value = val;

        const applyChange = (hex) => {
          if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
          this._draftOverrides[def.key] = hex.toUpperCase();
          colorInp.value = hex;
          hexInp.value = hex.toUpperCase();
          this.onPreviewTheme?.(this._draftPreset, this._draftOverrides);
        };

        colorInp.addEventListener('input', () => applyChange(colorInp.value));
        hexInp.addEventListener('change', () => applyChange(hexInp.value.trim()));

        controls.append(colorInp, hexInp);
        row.append(lbl, controls);
        grid.append(row);
      }
    }

    _render(s) {
      const { t } = window.StudioI18n;
      const { listPresets } = window.StudioThemes;
      const lang = this.getLang();
      const presets = listPresets();

      document.getElementById('settingsTitle').textContent = t('settingsTitle');
      document.getElementById('settingsSub').textContent = t('settingsSubtitle');
      this.btnSave.textContent = t('settingsSaveBtn');
      this.btnReset.textContent = t('settingsResetBtn');
      this.btnCancel.textContent = t('dlgCancel');

      const presetOpts = presets
        .map(
          (p) =>
            `<option value="${p.id}"${p.id === this._draftPreset ? ' selected' : ''}>${p.name} (${p.isLight ? (lang === 'es' ? 'Claro' : 'Light') : (lang === 'es' ? 'Oscuro' : 'Dark')})</option>`
        )
        .join('');

      this.body.innerHTML = `
        <div class="settings-section">
          <h3>${lang === 'es' ? 'Temas y editor de colores' : 'Themes & Live Theme Editor'}</h3>
          <label class="settings-row">
            <span>${lang === 'es' ? 'Tema predefinido (8 opciones)' : 'Theme preset (8 built-in)'}</span>
            <select id="set_themePreset">${presetOpts}</select>
          </label>
          <div id="themeTokenGrid" class="theme-token-grid"></div>
          <div class="theme-editor-actions">
            <button type="button" id="btnThemeResetPreset" class="dlg-btn">${lang === 'es' ? 'Restablecer tema' : 'Reset to Preset'}</button>
            <button type="button" id="btnThemeExportJson" class="dlg-btn">${lang === 'es' ? 'Exportar JSON' : 'Export JSON'}</button>
            <button type="button" id="btnThemeImportJson" class="dlg-btn">${lang === 'es' ? 'Importar JSON' : 'Import JSON'}</button>
          </div>
        </div>

        <div class="settings-section">
          <h3>${t('settingsGeneral')}</h3>
          <label class="settings-row">
            <span>${t('settingsLanguage')}</span>
            <select id="set_language">
              <option value="es"${lang === 'es' ? ' selected' : ''}>Español (Castellano)</option>
              <option value="en"${lang === 'en' ? ' selected' : ''}>English</option>
            </select>
          </label>
          <label class="settings-row">
            <span>${t('settingsMenuAction')}</span>
            <select id="set_menuAction">
              <option value="both"${s.menuAction === 'both' ? ' selected' : ''}>${t('settingsMenuActionBoth')}</option>
              <option value="run"${s.menuAction === 'run' ? ' selected' : ''}>${t('settingsMenuActionRun')}</option>
              <option value="insert"${s.menuAction === 'insert' ? ' selected' : ''}>${t('settingsMenuActionInsert')}</option>
            </select>
          </label>
          <label class="settings-row">
            <span>${t('settingsDialogStyle')}</span>
            <select id="set_dialogStyle">
              <option value="form"${s.dialogStyle !== 'steps' ? ' selected' : ''}>${t('settingsDialogStyleForm')}</option>
              <option value="steps"${s.dialogStyle === 'steps' ? ' selected' : ''}>${t('settingsDialogStyleSteps')}</option>
            </select>
          </label>
          <label class="settings-row">
            <span>${t('settingsAutoSave')}</span>
            <select id="set_autoSave">
              <option value="afterDelay"${s.autoSave === 'afterDelay' ? ' selected' : ''}>${t('settingsAutoSaveAfterDelay')}</option>
              <option value="onFocusChange"${s.autoSave === 'onFocusChange' ? ' selected' : ''}>${t('settingsAutoSaveOnFocusChange')}</option>
              <option value="onRun"${s.autoSave === 'onRun' ? ' selected' : ''}>${t('settingsAutoSaveOnRun')}</option>
              <option value="off"${s.autoSave === 'off' ? ' selected' : ''}>${t('settingsAutoSaveOff')}</option>
            </select>
          </label>
          <label class="settings-row">
            <span>${t('settingsAutoSaveDelayMs')}</span>
            <input type="number" id="set_autoSaveDelayMs" min="300" max="60000" step="100" value="${Number(s.autoSaveDelayMs) || 1500}">
          </label>
          <label class="settings-check"><input type="checkbox" id="set_editorWordWrap"${s.editorWordWrap !== false ? ' checked' : ''}> ${t('settingsEditorWordWrap')}</label>
          <label class="settings-check"><input type="checkbox" id="set_showProblemErrors"${s.showProblemErrors !== false ? ' checked' : ''}> ${t('settingsShowProblemErrors')}</label>
          <label class="settings-check"><input type="checkbox" id="set_showProblemWarnings"${s.showProblemWarnings !== false ? ' checked' : ''}> ${t('settingsShowProblemWarnings')}</label>
          <label class="settings-check"><input type="checkbox" id="set_hoverPeekSidebars"${s.hoverPeekSidebars !== false ? ' checked' : ''}> ${t('settingsHoverPeek')}</label>
          <label class="settings-check"><input type="checkbox" id="set_closeMenusAfterChoice"${s.closeMenusAfterChoice ? ' checked' : ''}> ${t('settingsCloseMenus')}</label>
        </div>

        <div class="settings-section">
          <h3>${t('settingsExecution')}</h3>
          <label class="settings-check"><input type="checkbox" id="set_limitOutput"${s.limitOutput ? ' checked' : ''}> ${t('settingsLimitOutput')}</label>
          <label class="settings-row">
            <span>${t('settingsMaxOutputItems')}</span>
            <input type="number" id="set_maxOutputItems" min="1" max="1000000" value="${Number(s.maxOutputItems) || 24}">
          </label>
          <label class="settings-check"><input type="checkbox" id="set_fixedNotation"${s.fixedNotation ? ' checked' : ''}> ${t('settingsFixedNotation')}</label>
          <label class="settings-check"><input type="checkbox" id="set_syntaxColors"${s.syntaxColors ? ' checked' : ''}> ${t('settingsSyntaxColors')}</label>
          <label class="settings-check"><input type="checkbox" id="set_skipHelp"${s.skipHelp ? ' checked' : ''}> ${t('settingsSkipHelp')}</label>
          <label class="settings-row">
            <span>${t('settingsSkipCommands')}</span>
            <input type="text" id="set_skipCommands" value="${String(s.skipCommands || '').replace(/"/g, '&quot;')}" placeholder="fix, View, utils::example">
          </label>
          <label class="settings-check"><input type="checkbox" id="set_consoleWrap"${s.consoleWrap !== false ? ' checked' : ''}> ${t('settingsConsoleWrap')}</label>
          <label class="settings-check"><input type="checkbox" id="set_consoleScroll"${s.consoleScroll !== false ? ' checked' : ''}> ${t('settingsConsoleScroll')}</label>
          <label class="settings-row">
            <span>${t('settingsRunTarget')}</span>
            <select id="set_runTarget">
              <option value="auto"${s.runTarget === 'auto' ? ' selected' : ''}>${t('settingsRunTargetAuto')}</option>
              <option value="terminal"${s.runTarget === 'terminal' ? ' selected' : ''}>${t('settingsRunTargetTerminal')}</option>
              <option value="arf"${s.runTarget === 'arf' ? ' selected' : ''}>${t('settingsRunTargetArf')}</option>
            </select>
          </label>
        </div>

        <div class="settings-section">
          <h3>${t('settingsPackages')}</h3>
          <label class="settings-check"><input type="checkbox" id="set_loadRcmdrFunctions"${s.loadRcmdrFunctions ? ' checked' : ''}> ${t('settingsLoadRcmdr')}</label>
          <label class="settings-row">
            <span>${t('settingsRcmdrPlugins')}</span>
            <input type="text" id="set_rcmdrPlugins" value="${String(s.rcmdrPlugins || '').replace(/"/g, '&quot;')}" placeholder="RcmdrPlugin.TeachStat">
          </label>
          <label class="settings-row">
            <span>${t('settingsCranMirror')}</span>
            <input type="text" id="set_cranMirror" value="${String(s.cranMirror || '').replace(/"/g, '&quot;')}">
          </label>
          <label class="settings-row">
            <span>${t('settingsPackageDownloads')}</span>
            <input type="text" id="set_packageDownloads" value="${String(s.packageDownloads || '').replace(/"/g, '&quot;')}">
          </label>
        </div>
      `;

      this._renderThemeTokenGrid();

      document.getElementById('set_themePreset').addEventListener('change', (e) => {
        this._draftPreset = e.target.value;
        this._draftOverrides = {};
        this._renderThemeTokenGrid();
        this.onPreviewTheme?.(this._draftPreset, this._draftOverrides);
      });

      document.getElementById('btnThemeResetPreset').addEventListener('click', () => {
        this._draftOverrides = {};
        this._renderThemeTokenGrid();
        this.onPreviewTheme?.(this._draftPreset, this._draftOverrides);
      });

      document.getElementById('btnThemeExportJson').addEventListener('click', async () => {
        const json = JSON.stringify({ preset: this._draftPreset, overrides: this._draftOverrides }, null, 2);
        try {
          await navigator.clipboard.writeText(json);
        } catch {
          window.prompt('Theme JSON:', json);
        }
      });

      document.getElementById('btnThemeImportJson').addEventListener('click', () => {
        const raw = window.prompt('Paste Theme JSON:');
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.preset) this._draftPreset = parsed.preset;
          if (parsed.overrides && typeof parsed.overrides === 'object') this._draftOverrides = parsed.overrides;
          document.getElementById('set_themePreset').value = this._draftPreset;
          this._renderThemeTokenGrid();
          this.onPreviewTheme?.(this._draftPreset, this._draftOverrides);
        } catch {
          // ignore invalid JSON
        }
      });
    }

    _commit() {
      const { getPreset } = window.StudioThemes;
      const cur = this.getSettings();
      const chosenPreset = getPreset(this._draftPreset);
      const maxVal = Math.max(1, Math.min(1000000, parseInt(document.getElementById('set_maxOutputItems').value, 10) || 24));
      const next = {
        ...cur,
        menuAction: document.getElementById('set_menuAction').value,
        dialogStyle: document.getElementById('set_dialogStyle').value,
        autoSave: document.getElementById('set_autoSave').value,
        autoSaveDelayMs: Math.max(300, Math.min(60000, parseInt(document.getElementById('set_autoSaveDelayMs').value, 10) || 1500)),
        editorWordWrap: document.getElementById('set_editorWordWrap').checked,
        showProblemErrors: document.getElementById('set_showProblemErrors').checked,
        showProblemWarnings: document.getElementById('set_showProblemWarnings').checked,
        hoverPeekSidebars: document.getElementById('set_hoverPeekSidebars').checked,
        closeMenusAfterChoice: document.getElementById('set_closeMenusAfterChoice').checked,
        limitOutput: document.getElementById('set_limitOutput').checked,
        maxOutputItems: maxVal,
        fixedNotation: document.getElementById('set_fixedNotation').checked,
        syntaxColors: document.getElementById('set_syntaxColors').checked,
        skipHelp: document.getElementById('set_skipHelp').checked,
        skipCommands: document.getElementById('set_skipCommands').value.trim(),
        consoleWrap: document.getElementById('set_consoleWrap').checked,
        consoleScroll: document.getElementById('set_consoleScroll').checked,
        runTarget: document.getElementById('set_runTarget').value,
        loadRcmdrFunctions: document.getElementById('set_loadRcmdrFunctions').checked,
        rcmdrPlugins: document.getElementById('set_rcmdrPlugins').value.trim(),
        cranMirror: document.getElementById('set_cranMirror').value.trim() || DEFAULT_SETTINGS.cranMirror,
        packageDownloads: document.getElementById('set_packageDownloads').value.trim() || DEFAULT_SETTINGS.packageDownloads,
        themePreset: chosenPreset.id,
        lastDarkPreset: chosenPreset.isLight ? cur.lastDarkPreset || 'dracula' : chosenPreset.id,
        lastLightPreset: chosenPreset.isLight ? chosenPreset.id : cur.lastLightPreset || 'vscode-light',
        themeOverrides: { ...this._draftOverrides }
      };
      const pickedLang = document.getElementById('set_language').value;
      saveSettings(next);
      this._origSnapshot = null;
      this.close();
      this.onSave(next);
      if (pickedLang !== this.getLang()) this.onSetLang(pickedLang);
    }
  }

  window.StudioSettings = { DEFAULT_SETTINGS, loadSettings, saveSettings, StudioSettingsModal };
})();
