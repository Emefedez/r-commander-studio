(function () {
  'use strict';

  /**
   * First-run Setup Wizard: Language -> Theme -> Code completion (R languageserver / LSP)
   * -> AI assistant (Optional) -> General preferences.
   *
   * It reuses the existing building blocks instead of duplicating them:
   *  - settings are read/written through `StudioSettings` (same `rcs-settings` store as the Settings modal),
   *  - themes come from `StudioThemes` and preview through the app's live `applyThemePreset`,
   *  - language switching goes through the app's `switchLanguage`,
   *  - the AI step uses the T3 Copilot provider list / installer IPC and the Copilot's provider store.
   *
   * Completion (or skipping) is persisted under `rcs-setup-wizard`, so it only opens on first launch.
   * It can be reopened at any time from Help > Setup Wizard or the command palette.
   */
  const STORAGE_KEY = 'rcs-setup-wizard';
  const STEPS = ['language', 'theme', 'lsp', 'ai', 'prefs'];
  const GITHUB_PROFILE_URL = 'https://github.com/Emefedez';

  function readState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function isSetupComplete() {
    const st = readState();
    return Boolean(st && st.completed);
  }

  function markSetupComplete(meta = {}) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ completed: true, at: new Date().toISOString(), ...meta }));
    } catch {
      // storage unavailable: the wizard will simply show again next launch
    }
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  class StudioSetupWizard {
    constructor({ getSettings, onSave, onPreviewTheme, getLang, onSetLang, onSetAiProvider, getVersion }) {
      this.getSettings = getSettings;
      this.onSave = onSave;
      this.onPreviewTheme = onPreviewTheme;
      this.getLang = getLang;
      this.onSetLang = onSetLang;
      this.onSetAiProvider = onSetAiProvider;
      this.getVersion = getVersion || (() => '');

      this.backdrop = document.getElementById('wizardBackdrop');
      this.stepsEl = document.getElementById('wizardSteps');
      this.bodyEl = document.getElementById('wizardBody');
      this.counterEl = document.getElementById('wizardCounter');
      this.btnSkip = document.getElementById('wizardSkip');
      this.btnBack = document.getElementById('wizardBack');
      this.btnNext = document.getElementById('wizardNext');

      this.index = 0;
      this.done = false;
      this.draft = null;
      this.lsp = { state: 'idle' };
      this.ai = { state: 'idle', providers: [], t3Msg: '' };

      this.btnSkip.addEventListener('click', () => this.skip());
      this.btnBack.addEventListener('click', () => this.go(this.index - 1));
      this.btnNext.addEventListener('click', () => {
        if (this.done) this.close();
        else if (this.index >= STEPS.length - 1) this.finish();
        else this.go(this.index + 1);
      });
      document.addEventListener('keydown', (e) => {
        if (this.backdrop.hidden) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          if (this.done) this.close();
          else this.skip();
        }
      });

      if (window.studio?.onLspInstallProgress) {
        window.studio.onLspInstallProgress(({ line }) => {
          if (this.lsp.state !== 'installing') return;
          this.lsp.progress = line;
          const el = document.getElementById('wizLspProgress');
          if (el) el.textContent = line;
        });
      }
    }

    get isOpen() {
      return !this.backdrop.hidden;
    }

    open() {
      const cur = this.getSettings();
      this.draft = {
        ...cur,
        themeOverrides: { ...(cur.themeOverrides || {}) }
      };
      this.index = 0;
      this.done = false;
      this.backdrop.hidden = false;
      this.render();
      this.btnNext.focus();
    }

    close() {
      this.backdrop.hidden = true;
    }

    go(i) {
      if (this.done) return;
      this.index = Math.max(0, Math.min(STEPS.length - 1, i));
      this.render();
    }

    /** Skip keeps whatever the user already picked on earlier steps (language/theme are applied live). */
    skip() {
      this._persist({ skipped: true });
    }

    finish() {
      this._persist({ skipped: false });
    }

    _persist({ skipped }) {
      const { saveSettings, DEFAULT_SETTINGS } = window.StudioSettings;
      const { getPreset } = window.StudioThemes;
      const cur = this.getSettings();
      const chosen = getPreset(this.draft.themePreset || cur.themePreset || DEFAULT_SETTINGS.themePreset);
      const next = {
        ...cur,
        ...this.draft,
        themePreset: chosen.id,
        lastDarkPreset: chosen.isLight ? cur.lastDarkPreset || 'dracula' : chosen.id,
        lastLightPreset: chosen.isLight ? chosen.id : cur.lastLightPreset || 'vscode-light'
      };
      saveSettings(next);
      markSetupComplete({ skipped, version: this.getVersion(), step: STEPS[this.index] });
      this.onSave?.(next, { skipped });
      if (skipped) {
        this.close();
        return;
      }
      // Settings are already saved: closing the "All done!" screen in any way is safe.
      this.done = true;
      this.render();
    }

    // --- Rendering -----------------------------------------------------------------------------

    render() {
      const { t } = window.StudioI18n;
      document.getElementById('wizardTitle').textContent = t('wizardTitle');
      document.getElementById('wizardSub').textContent = t('wizardSubtitle');
      this.btnSkip.textContent = t('wizardSkip');
      this.btnBack.textContent = t('wizardBack');
      this.btnBack.hidden = this.index === 0 || this.done;
      this.btnSkip.hidden = this.done;
      this.counterEl.hidden = this.done;
      this.btnNext.hidden = this.done;
      this.backdrop.querySelector('.wizard-modal')?.classList.toggle('is-done', this.done);
      this.btnNext.textContent = this.index >= STEPS.length - 1 ? t('wizardFinish') : t('wizardNext');
      this.counterEl.textContent = t('wizardStepOf', this.index + 1, STEPS.length);

      this._renderStepper();
      if (this.done) {
        this.bodyEl.textContent = '';
        this.bodyEl.dataset.step = 'done';
        this._renderDone();
        return;
      }
      const step = STEPS[this.index];
      this.bodyEl.textContent = '';
      this.bodyEl.dataset.step = step;
      if (step === 'language') this._renderLanguage();
      else if (step === 'theme') this._renderTheme();
      else if (step === 'lsp') this._renderLsp();
      else if (step === 'ai') this._renderAi();
      else this._renderPrefs();
    }

    _optionalTag() {
      return `<span class="wizard-optional">${esc(window.StudioI18n.t('wizardOptional'))}</span>`;
    }

    _renderStepper() {
      const { t } = window.StudioI18n;
      const { svg } = window.StudioIcons;
      const labels = {
        language: t('wizardStepLanguage'),
        theme: t('wizardStepTheme'),
        lsp: t('wizardStepLsp'),
        ai: t('wizardStepAi'),
        prefs: t('wizardStepPrefs')
      };
      this.stepsEl.innerHTML = STEPS.map((id, i) => {
        const isDone = this.done || i < this.index;
        const cls = !this.done && i === this.index ? ' active' : isDone ? ' done' : '';
        const mark = isDone ? svg('check', { size: 11 }) : String(i + 1);
        return `<button type="button" class="wizard-step${cls}" data-step="${i}">
            <span class="wizard-step-num">${mark}</span>
            <span class="wizard-step-label">${esc(labels[id])}${id === 'ai' ? ' ' + this._optionalTag() : ''}</span>
          </button>`;
      }).join('');
      for (const btn of this.stepsEl.querySelectorAll('[data-step]')) {
        btn.addEventListener('click', () => this.go(Number(btn.dataset.step)));
      }
    }

    _section(title, hint, extraTitleHtml = '') {
      const wrap = document.createElement('section');
      wrap.className = 'wizard-section';
      wrap.innerHTML = `<h3 class="wizard-heading">${esc(title)}${extraTitleHtml}</h3>${hint ? `<p class="wizard-hint">${esc(hint)}</p>` : ''}`;
      this.bodyEl.append(wrap);
      return wrap;
    }

    _renderLanguage() {
      const { t } = window.StudioI18n;
      const sec = this._section(t('wizardLanguageHeading'), t('wizardLanguageHint'));
      const grid = document.createElement('div');
      grid.className = 'wizard-choice-grid';
      const lang = this.getLang();
      const options = [
        { id: 'es', name: 'Español', sub: 'Castellano' },
        { id: 'en', name: 'English', sub: 'English (US / UK)' }
      ];
      for (const opt of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `wizard-choice${opt.id === lang ? ' selected' : ''}`;
        btn.innerHTML = `<span class="wizard-choice-title">${esc(opt.name)}</span><span class="wizard-choice-sub">${esc(opt.sub)}</span>`;
        btn.addEventListener('click', async () => {
          if (opt.id !== this.getLang()) await this.onSetLang?.(opt.id);
          this.render();
        });
        grid.append(btn);
      }
      sec.append(grid);
    }

    _renderTheme() {
      const { t } = window.StudioI18n;
      const { listPresets } = window.StudioThemes;
      const sec = this._section(t('wizardThemeHeading'), t('wizardThemeHint'));
      const grid = document.createElement('div');
      grid.className = 'wizard-theme-grid';
      for (const p of listPresets()) {
        const tk = p.tokens;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `wizard-theme-card${p.id === this.draft.themePreset ? ' selected' : ''}`;
        btn.innerHTML = `
          <span class="wizard-theme-swatch" style="background:${tk.bgEditor};border-color:${tk.border}">
            <span class="wizard-theme-side" style="background:${tk.bgSidebar}"></span>
            <span class="wizard-theme-lines">
              <span style="background:${tk.tabHighlight};width:46%"></span>
              <span style="background:${tk.accent};width:70%"></span>
              <span style="background:${tk.fgMuted};width:58%"></span>
              <span style="background:${tk.fg};width:36%"></span>
            </span>
          </span>
          <span class="wizard-theme-name">${esc(p.name)}</span>
          <span class="wizard-theme-kind">${esc(p.isLight ? t('wizardThemeLight') : t('wizardThemeDark'))}</span>`;
        btn.addEventListener('click', () => {
          this.draft.themePreset = p.id;
          this.draft.themeOverrides = {};
          this.onPreviewTheme?.(p.id, {});
          for (const el of grid.querySelectorAll('.wizard-theme-card')) el.classList.remove('selected');
          btn.classList.add('selected');
        });
        grid.append(btn);
      }
      sec.append(grid);
    }

    // --- LSP / languageserver ------------------------------------------------------------------

    async _checkLsp(force = false) {
      if (!window.studio?.lspCheckPackage) {
        this.lsp = { state: 'unavailable' };
        return;
      }
      if (!force && (this.lsp.state === 'ready' || this.lsp.state === 'missing' || this.lsp.state === 'nor')) return;
      this.lsp = { state: 'checking' };
      this._refreshLspCard();
      try {
        const res = await window.studio.lspCheckPackage();
        if (!res?.rAvailable) this.lsp = { state: 'nor' };
        else if (res.installed) this.lsp = { state: 'ready', version: res.version, rVersion: res.rVersion };
        else this.lsp = { state: 'missing', rVersion: res.rVersion };
      } catch (err) {
        this.lsp = { state: 'error', error: err?.message || String(err) };
      }
      this._refreshLspCard();
    }

    async _installLsp() {
      const { DEFAULT_SETTINGS } = window.StudioSettings;
      this.lsp = { ...this.lsp, state: 'installing', progress: '' };
      this._refreshLspCard();
      try {
        const res = await window.studio.lspInstallPackage({ repos: this.draft.cranMirror || DEFAULT_SETTINGS.cranMirror });
        if (res?.ok) this.lsp = { state: 'installed', version: res.version };
        else this.lsp = { state: 'failed', error: res?.error || 'unknown error', rVersion: this.lsp.rVersion };
      } catch (err) {
        this.lsp = { state: 'failed', error: err?.message || String(err), rVersion: this.lsp.rVersion };
      }
      this._refreshLspCard();
    }

    _renderLsp() {
      const { t } = window.StudioI18n;
      const sec = this._section(t('wizardLspHeading'), t('wizardLspHint'));
      const card = document.createElement('div');
      card.id = 'wizLspCard';
      card.className = 'wizard-status-card';
      sec.append(card);
      this._refreshLspCard();
      this._checkLsp(false);
    }

    _refreshLspCard() {
      const card = document.getElementById('wizLspCard');
      if (!card) return;
      const { t } = window.StudioI18n;
      const { svg } = window.StudioIcons;
      const s = this.lsp;
      let icon = 'info';
      let tone = '';
      let text = t('wizardLspChecking');
      const actions = [];
      switch (s.state) {
        case 'unavailable':
          text = t('wizardLspUnavailable');
          break;
        case 'nor':
          icon = 'warning';
          tone = 'warn';
          text = t('wizardLspNoR');
          actions.push({ id: 'getr', label: t('wizardLspGetR') }, { id: 'recheck', label: t('wizardLspRecheck') });
          break;
        case 'ready':
          icon = 'check';
          tone = 'ok';
          text = t('wizardLspInstalled', s.version || '');
          break;
        case 'installed':
          icon = 'check';
          tone = 'ok';
          text = t('wizardLspInstallOk', s.version || '');
          break;
        case 'missing':
          icon = 'warning';
          tone = 'warn';
          text = t('wizardLspMissing', s.rVersion || '?');
          actions.push({ id: 'install', label: t('wizardLspInstallBtn'), primary: true }, { id: 'recheck', label: t('wizardLspRecheck') });
          break;
        case 'installing':
          icon = 'download';
          text = t('wizardLspInstalling');
          break;
        case 'failed':
        case 'error':
          icon = 'error';
          tone = 'err';
          text = t('wizardLspInstallFail');
          actions.push({ id: 'install', label: t('wizardLspInstallBtn'), primary: true }, { id: 'recheck', label: t('wizardLspRecheck') });
          break;
        default:
          break;
      }
      card.className = `wizard-status-card${tone ? ' ' + tone : ''}`;
      card.innerHTML = `
        <div class="wizard-status-line"><span class="ico">${svg(icon, { size: 14 })}</span><span>${esc(text)}</span></div>
        ${s.state === 'installing' ? `<div class="wizard-progress"><span></span></div><div id="wizLspProgress" class="wizard-mono">${esc(s.progress || '')}</div>` : ''}
        ${s.error ? `<pre class="wizard-mono wizard-error">${esc(s.error)}</pre>` : ''}
        ${actions.length ? `<div class="wizard-actions">${actions.map((a) => `<button type="button" class="dlg-btn${a.primary ? ' primary' : ''}" data-act="${a.id}">${esc(a.label)}</button>`).join('')}</div>` : ''}`;
      for (const btn of card.querySelectorAll('[data-act]')) {
        btn.addEventListener('click', () => {
          const act = btn.dataset.act;
          if (act === 'install') this._installLsp();
          else if (act === 'recheck') this._checkLsp(true);
          else if (act === 'getr') window.studio?.openExternal?.('https://cloud.r-project.org/');
        });
      }
    }

    // --- AI assistant (Optional) ---------------------------------------------------------------

    async _loadProviders() {
      if (this.ai.state === 'loading' || this.ai.state === 'loaded') return;
      this.ai.state = 'loading';
      let list = [{ id: 'r-expert', label: 'R Expert (Offline)', available: true }];
      try {
        const res = await window.studio?.t3Providers?.();
        if (res?.ok && Array.isArray(res.providers) && res.providers.length) list = res.providers;
      } catch {
        // keep offline fallback
      }
      this.ai.providers = list;
      this.ai.state = 'loaded';
      if (STEPS[this.index] === 'ai' && this.isOpen) this.render();
    }

    _currentProvider() {
      const saved = localStorage.getItem('rcs-t3-provider') || '';
      const list = this.ai.providers;
      if (saved && list.some((p) => p.id === saved)) return saved;
      return (list.find((p) => p.available) || list[0] || { id: 'r-expert' }).id;
    }

    _renderAi() {
      const { t } = window.StudioI18n;
      const sec = this._section(t('wizardAiHeading'), t('wizardAiHint'), ' ' + this._optionalTag());

      if (this.ai.state !== 'loaded') {
        const p = document.createElement('p');
        p.className = 'wizard-hint';
        p.textContent = t('wizardAiDetecting');
        sec.append(p);
        this._loadProviders();
        return;
      }

      const current = this._currentProvider();
      const list = document.createElement('div');
      list.className = 'wizard-provider-list';
      for (const p of this.ai.providers) {
        const row = document.createElement('label');
        row.className = `wizard-provider${p.available ? '' : ' unavailable'}`;
        row.innerHTML = `<input type="radio" name="wizProvider" value="${esc(p.id)}"${p.id === current ? ' checked' : ''}>
          <span class="wizard-provider-name">${esc(p.label)}</span>
          ${p.available ? '' : `<span class="wizard-provider-tag">${esc(t('wizardAiNotFound'))}</span>`}`;
        row.querySelector('input').addEventListener('change', () => {
          localStorage.setItem('rcs-t3-provider', p.id);
          this.onSetAiProvider?.(p.id);
        });
        list.append(row);
      }
      const lbl = document.createElement('div');
      lbl.className = 'wizard-label';
      lbl.textContent = t('wizardAiProvider');
      sec.append(lbl, list);

      if (window.studio?.t3Install) {
        const t3 = document.createElement('div');
        t3.className = 'wizard-inline-row';
        t3.innerHTML = `<button type="button" class="dlg-btn" id="wizT3Install">${esc(t('wizardAiT3'))}</button>
          <span class="wizard-hint" id="wizT3Msg">${esc(this.ai.t3Msg || t('wizardAiT3Hint'))}</span>`;
        sec.append(t3);
        const btn = t3.querySelector('#wizT3Install');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const msg = document.getElementById('wizT3Msg');
          if (msg) msg.textContent = t('wizardAiT3Working');
          try {
            const res = await window.studio.t3Install({ preferWsl: true });
            this.ai.t3Msg = res?.ok ? t('wizardAiT3Ready', res.installedPath || res.url || '127.0.0.1:3773') : res?.error || 'T3 Code install failed';
          } catch (err) {
            this.ai.t3Msg = err?.message || 'Error';
          }
          this.ai.state = 'idle';
          await this._loadProviders();
          if (STEPS[this.index] === 'ai') this.render();
        });
      }
    }

    // --- All done! -----------------------------------------------------------------------------

    _renderDone() {
      const { t } = window.StudioI18n;
      const { svg } = window.StudioIcons;
      const wrap = document.createElement('section');
      wrap.className = 'wizard-done';
      wrap.innerHTML = `
        <div class="wizard-done-badge">${svg('check', { size: 30 })}</div>
        <h3 class="wizard-done-title">${esc(t('wizardDoneTitle'))}</h3>
        <p class="wizard-hint wizard-done-text">${esc(t('wizardDoneText'))}</p>
        <div class="wizard-done-actions">
          <button type="button" class="dlg-btn wizard-ok-btn" id="wizDoneOk">${esc(t('wizardDoneOk'))}</button>
          <button type="button" class="dlg-btn wizard-github-btn" id="wizDoneGithub">
            <span class="ico">${svg('github', { size: 15 })}</span><span>${esc(t('wizardDoneGithub'))}</span>
          </button>
        </div>`;
      this.bodyEl.append(wrap);
      const ok = wrap.querySelector('#wizDoneOk');
      ok.addEventListener('click', () => this.close());
      wrap.querySelector('#wizDoneGithub').addEventListener('click', () => {
        if (window.studio?.openExternal) window.studio.openExternal(GITHUB_PROFILE_URL);
        else window.open(GITHUB_PROFILE_URL, '_blank', 'noopener');
      });
      ok.focus();
    }

    // --- General preferences -------------------------------------------------------------------

    _renderPrefs() {
      const { t } = window.StudioI18n;
      const s = this.draft;
      const sec = this._section(t('wizardPrefsHeading'), t('wizardPrefsHint'));
      const sel = (id, value, opts) =>
        `<select id="${id}">${opts.map(([v, key]) => `<option value="${v}"${v === value ? ' selected' : ''}>${esc(t(key))}</option>`).join('')}</select>`;
      const form = document.createElement('div');
      form.className = 'wizard-prefs';
      form.innerHTML = `
        <label class="settings-row"><span>${esc(t('settingsMenuAction'))}</span>${sel('wiz_menuAction', s.menuAction, [
          ['both', 'settingsMenuActionBoth'],
          ['run', 'settingsMenuActionRun'],
          ['insert', 'settingsMenuActionInsert']
        ])}</label>
        <label class="settings-row"><span>${esc(t('settingsDialogStyle'))}</span>${sel('wiz_dialogStyle', s.dialogStyle === 'steps' ? 'steps' : 'form', [
          ['form', 'settingsDialogStyleForm'],
          ['steps', 'settingsDialogStyleSteps']
        ])}</label>
        <label class="settings-row"><span>${esc(t('settingsAutoSave'))}</span>${sel('wiz_autoSave', s.autoSave, [
          ['afterDelay', 'settingsAutoSaveAfterDelay'],
          ['onFocusChange', 'settingsAutoSaveOnFocusChange'],
          ['onRun', 'settingsAutoSaveOnRun'],
          ['off', 'settingsAutoSaveOff']
        ])}</label>
        <label class="settings-row"><span>${esc(t('settingsRunTarget'))}</span>${sel('wiz_runTarget', s.runTarget, [
          ['auto', 'settingsRunTargetAuto'],
          ['terminal', 'settingsRunTargetTerminal'],
          ['arf', 'settingsRunTargetArf']
        ])}</label>
        <label class="settings-check"><input type="checkbox" id="wiz_editorWordWrap"${s.editorWordWrap !== false ? ' checked' : ''}> ${esc(t('settingsEditorWordWrap'))}</label>
        <label class="settings-check"><input type="checkbox" id="wiz_showStyleLints"${s.showStyleLints === true ? ' checked' : ''}> ${esc(t('settingsShowStyleLints'))}</label>
        <label class="settings-check"><input type="checkbox" id="wiz_hoverPeekSidebars"${s.hoverPeekSidebars !== false ? ' checked' : ''}> ${esc(t('settingsHoverPeek'))}</label>`;
      sec.append(form);

      for (const key of ['menuAction', 'dialogStyle', 'autoSave', 'runTarget']) {
        form.querySelector(`#wiz_${key}`).addEventListener('change', (e) => {
          this.draft[key] = e.target.value;
        });
      }
      for (const key of ['editorWordWrap', 'showStyleLints', 'hoverPeekSidebars']) {
        form.querySelector(`#wiz_${key}`).addEventListener('change', (e) => {
          this.draft[key] = e.target.checked;
        });
      }
    }
  }

  window.StudioSetupWizard = { StudioSetupWizard, isSetupComplete, markSetupComplete, STORAGE_KEY };
})();
