(function () {
  'use strict';

  /**
   * T3 Code Copilot UI for R Commander Studio:
   *  - `Ctrl+Alt+B`: toggles the Copilot / T3 Code Chat Window (with 1-click Apply, Insert, Run in R,
   *    slash commands `/fix`, `/explain`, `/plot`, `/rmd`, and built-in Cross-Platform T3 Code Installer Tool).
   *  - `Ctrl+I`: opens the Inline Copilot Fix bar right inside the active editor to fix or transform
   *    the selected R / R Markdown code in place.
   *  - `Shift+Click`: pops the Copilot Chat Window out into a standalone window.
   */
  class StudioT3Copilot {
    constructor({ getState, getActiveTab, getSelectedCode, applyCodeToEditor, insertCodeAtCursor, runCodeInR, showToast, openStandaloneWindow }) {
      this.getState = getState;
      this.getActiveTab = getActiveTab;
      this.getSelectedCode = getSelectedCode;
      this.applyCodeToEditor = applyCodeToEditor;
      this.insertCodeAtCursor = insertCodeAtCursor;
      this.runCodeInR = runCodeInR;
      this.showToast = showToast;
      this.openStandaloneWindow = openStandaloneWindow;

      this.messages = [];
      this.attachments = [];
      this.selectedModel = localStorage.getItem('rcs-t3-model') || 'auto';
      this.recording = false;
      this._speechRec = null;
      this._mediaRecorder = null;
      this._audioChunks = [];
      this.status = null;
      this.busy = false;
      this.windowOpen = false;
      this.inlineOpen = false;

      this._initDom();
      this.refreshStatus();
      this.refreshModels();
    }

    _t(key, fallback) {
      const { t } = window.StudioI18n || {};
      const val = t ? t(key) : key;
      return val && val !== key ? val : fallback;
    }

    _isEs() {
      return (window.StudioI18n?.getLang?.() || 'es') === 'es';
    }

    _initDom() {
      const { svg } = window.StudioIcons;

      // Wire floating / dockable Copilot Chat Window (#t3ChatWindow)
      this.winEl = document.getElementById('t3ChatWindow');
      this.msgListEl = document.getElementById('t3ChatMessages');
      this.inputEl = document.getElementById('t3ChatInput');
      this.sendBtn = document.getElementById('btnT3Send');
      this.statusDotEl = document.getElementById('t3StatusDot');
      this.statusTextEl = document.getElementById('t3StatusText');
      this.installBtn = document.getElementById('btnT3Install');
      this.startBtn = document.getElementById('btnT3Start');
      this.contextBarEl = document.getElementById('t3ContextBar');
      this.attachmentsBarEl = document.getElementById('t3AttachmentsBar');
      this.attachBtn = document.getElementById('btnT3Attach');
      this.attachMenuEl = document.getElementById('t3AttachMenu');
      this.micBtn = document.getElementById('btnT3Mic');
      this.modelSelectEl = document.getElementById('t3ModelSelect');

      // Inline Ctrl+I bar (#t3InlineBar)
      this.inlineBarEl = document.getElementById('t3InlineBar');
      this.inlineInputEl = document.getElementById('t3InlineInput');
      this.inlineRunBtn = document.getElementById('btnT3InlineRun');
      this.inlineCloseBtn = document.getElementById('btnT3InlineClose');
      this.inlineStatusEl = document.getElementById('t3InlineStatus');

      if (this.sendBtn) {
        this.sendBtn.addEventListener('click', () => this.sendChat());
      }
      if (this.inputEl) {
        this.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.sendChat();
          }
        });
      }
      if (this.installBtn) {
        this.installBtn.addEventListener('click', () => this.installT3Code());
      }
      if (this.startBtn) {
        this.startBtn.addEventListener('click', () => this.startT3Backend());
      }
      if (this.attachBtn) {
        this.attachBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleAttachMenu();
        });
      }
      if (this.micBtn) {
        this.micBtn.addEventListener('click', () => this._toggleMic());
      }
      if (this.modelSelectEl) {
        this.modelSelectEl.addEventListener('change', () => {
          this.selectedModel = this.modelSelectEl.value || 'auto';
          localStorage.setItem('rcs-t3-model', this.selectedModel);
        });
      }
      document.addEventListener('click', (e) => {
        if (this.attachMenuEl && !this.attachMenuEl.hidden && !this.attachMenuEl.contains(e.target) && e.target !== this.attachBtn) {
          this.attachMenuEl.hidden = true;
        }
      });

      document.getElementById('btnT3Close')?.addEventListener('click', () => this.toggleWindow(false));
      document.getElementById('btnT3Clear')?.addEventListener('click', () => {
        this.messages = [];
        this.renderMessages();
      });
      document.getElementById('btnT3Popout')?.addEventListener('click', () => this.popoutWindow());

      for (const chip of document.querySelectorAll('[data-t3-prompt]')) {
        chip.addEventListener('click', () => {
          const cmd = chip.getAttribute('data-t3-prompt') || '';
          if (this.inputEl) {
            this.inputEl.value = cmd;
            this.sendChat();
          }
        });
      }

      if (this.inlineRunBtn) {
        this.inlineRunBtn.addEventListener('click', () => this.runInlineFix());
      }
      if (this.inlineCloseBtn) {
        this.inlineCloseBtn.addEventListener('click', () => this.closeInlineFix());
      }
      if (this.inlineInputEl) {
        this.inlineInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.runInlineFix();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.closeInlineFix();
          }
        });
      }

      if (window.studio?.onT3InstallProgress) {
        window.studio.onT3InstallProgress(({ detail, pct }) => {
          if (this.statusTextEl) {
            this.statusTextEl.textContent = `${detail || 'Installing T3 Code...'} (${pct || 0}%)`;
          }
        });
      }

      this.renderMessages();
    }

    async refreshStatus() {
      if (!window.studio?.t3Status) return;
      try {
        const st = await window.studio.t3Status();
        this.status = st;
        this._renderStatusHeader();
      } catch {
        // ignore
      }
    }

    async refreshModels() {
      if (!this.modelSelectEl) return;
      const fallback = [
        { id: 'auto', label: 'T3 Code (Auto)' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
        { id: 'gpt-5.4', label: 'GPT-5.4 / Codex' },
        { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
        { id: 'r-expert', label: 'Built-in R Expert (Offline)' }
      ];
      let models = fallback;
      try {
        const res = await window.studio?.t3Models?.();
        if (res?.ok && Array.isArray(res.models) && res.models.length) models = res.models;
      } catch {
        // use fallback
      }
      this.modelSelectEl.textContent = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        if (m.id === this.selectedModel) opt.selected = true;
        this.modelSelectEl.append(opt);
      }
      if (!models.some((m) => m.id === this.selectedModel) && models.length) {
        this.selectedModel = models[0].id;
        this.modelSelectEl.value = this.selectedModel;
      }
    }

    addAttachment({ name, kind = 'file', content = '', language = 'r' } = {}) {
      if (!content || !String(content).trim()) return;
      const cleanName = name || (kind === 'snippet' ? 'snippet.R' : 'file.R');
      const existingIdx = this.attachments.findIndex((a) => a.name === cleanName && a.kind === kind);
      if (existingIdx >= 0) this.attachments[existingIdx] = { name: cleanName, kind, content: String(content), language };
      else this.attachments.push({ name: cleanName, kind, content: String(content), language });
      this._renderAttachments();
    }

    _renderAttachments() {
      if (!this.attachmentsBarEl) return;
      const { svg } = window.StudioIcons;
      this.attachmentsBarEl.textContent = '';
      this.attachments.forEach((att, idx) => {
        const chip = document.createElement('span');
        chip.className = 't3-attachment-chip';
        const lines = att.content.split(/\r?\n/).length;
        const ico = document.createElement('span');
        ico.className = 'ico';
        ico.innerHTML = svg(att.kind === 'snippet' ? 'edit' : 'file', { size: 11 });
        const lbl = document.createElement('span');
        lbl.className = 't3-att-name';
        lbl.textContent = `${att.name} (${lines} ln)`;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 't3-att-rm';
        rm.innerHTML = svg('close', { size: 10 });
        rm.addEventListener('click', () => {
          this.attachments.splice(idx, 1);
          this._renderAttachments();
        });
        chip.append(ico, lbl, rm);
        this.attachmentsBarEl.append(chip);
      });
    }

    _toggleAttachMenu() {
      if (!this.attachMenuEl) return;
      if (!this.attachMenuEl.hidden) {
        this.attachMenuEl.hidden = true;
        return;
      }
      const { svg } = window.StudioIcons;
      const isEs = this._isEs();
      this.attachMenuEl.textContent = '';

      const addItem = (icon, label, fn) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'output-action-btn';
        btn.innerHTML = `<span class="ico">${svg(icon, { size: 13 })}</span><span></span>`;
        btn.querySelector('span:last-child').textContent = label;
        btn.addEventListener('click', async () => {
          this.attachMenuEl.hidden = true;
          await fn();
        });
        this.attachMenuEl.append(btn);
      };

      addItem('edit', isEs ? 'Adjuntar selección actual del editor' : 'Attach selected code snippet', () => {
        const sel = this.getSelectedCode?.() || '';
        const tab = this.getActiveTab?.();
        if (!sel.trim()) {
          this.showToast?.(isEs ? 'Selecciona primero unas líneas en el editor.' : 'Select some code in the editor first.');
          return;
        }
        this.addAttachment({
          name: `${tab?.name || 'editor'} (sel)`,
          kind: 'snippet',
          content: sel,
          language: tab?.language || 'r'
        });
      });

      addItem('file', isEs ? 'Adjuntar archivo activo del editor' : 'Attach active editor file', () => {
        const tab = this.getActiveTab?.();
        const code = tab?.model?.getValue?.() || '';
        if (!code.trim()) {
          this.showToast?.(isEs ? 'El editor activo está vacío.' : 'Active editor is empty.');
          return;
        }
        this.addAttachment({
          name: tab.name || 'script.R',
          kind: 'file',
          content: code,
          language: tab.language || 'r'
        });
      });

      addItem('folder-open', isEs ? 'Elegir archivo desde disco...' : 'Choose file from disk...', async () => {
        const st = this.getState?.() || {};
        const files = await window.studio?.openFile?.({ defaultDir: st.workspaceRoot || undefined });
        if (!Array.isArray(files) || !files.length) return;
        for (const f of files) {
          if (f.content) {
            this.addAttachment({
              name: f.name,
              kind: 'file',
              content: f.content,
              language: /\.rmd$/i.test(f.name) ? 'rmd' : 'r'
            });
          }
        }
      });

      this.attachMenuEl.hidden = false;
    }

    async _toggleMic() {
      const isEs = this._isEs();
      if (this.recording) {
        this._stopMic();
        return;
      }

      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRec) {
        try {
          const rec = new SpeechRec();
          rec.lang = isEs ? 'es-ES' : 'en-US';
          rec.interimResults = false;
          rec.continuous = false;
          this._speechRec = rec;
          this.recording = true;
          this.micBtn?.classList.add('recording');
          this.showToast?.(isEs ? 'Escuchando... habla tu consulta.' : 'Listening... speak your prompt.');

          rec.onresult = (ev) => {
            const transcript = Array.from(ev.results || [])
              .map((r) => r[0]?.transcript || '')
              .join(' ')
              .trim();
            if (transcript && this.inputEl) {
              this.inputEl.value = this.inputEl.value ? `${this.inputEl.value} ${transcript}` : transcript;
              this.inputEl.focus();
            }
          };
          rec.onerror = async () => {
            this._stopMic();
            await this._startMediaRecorderFallback();
          };
          rec.onend = () => {
            this.recording = false;
            this.micBtn?.classList.remove('recording');
            this._speechRec = null;
          };
          rec.start();
          return;
        } catch {
          this._stopMic();
        }
      }
      await this._startMediaRecorderFallback();
    }

    async _startMediaRecorderFallback() {
      const isEs = this._isEs();
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        this.showToast?.(isEs ? 'Micrófono no disponible en este entorno.' : 'Microphone is not available in this environment.', 'error');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this._audioChunks = [];
        const recorder = new MediaRecorder(stream);
        this._mediaRecorder = recorder;
        this.recording = true;
        this.micBtn?.classList.add('recording');
        this.showToast?.(isEs ? 'Grabando audio... pulsa el micrófono otra vez para transcribir.' : 'Recording audio... click mic again to transcribe.');

        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) this._audioChunks.push(ev.data);
        };
        recorder.onstop = async () => {
          stream.getTracks().forEach((tr) => tr.stop());
          this.recording = false;
          this.micBtn?.classList.remove('recording');
          const blob = new Blob(this._audioChunks, { type: recorder.mimeType || 'audio/webm' });
          this._audioChunks = [];
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (const b of buf) bin += String.fromCharCode(b);
          const res = await window.studio?.t3Transcribe?.({
            base64Audio: btoa(bin),
            mimeType: blob.type || 'audio/webm',
            lang: isEs ? 'es' : 'en'
          });
          if (res?.ok && res.text && this.inputEl) {
            this.inputEl.value = this.inputEl.value ? `${this.inputEl.value} ${res.text}` : res.text;
            this.inputEl.focus();
          } else if (res?.error) {
            this.showToast?.(res.error, 'error');
          }
        };
        recorder.start();
      } catch (err) {
        this.recording = false;
        this.micBtn?.classList.remove('recording');
        this.showToast?.(err.message || 'Microphone access denied', 'error');
      }
    }

    _stopMic() {
      if (this._speechRec) {
        try {
          this._speechRec.stop();
        } catch {
          // ignore
        }
        this._speechRec = null;
      }
      if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
        try {
          this._mediaRecorder.stop();
        } catch {
          // ignore
        }
        this._mediaRecorder = null;
      }
      this.recording = false;
      this.micBtn?.classList.remove('recording');
    }

    _renderStatusHeader() {
      if (!this.statusTextEl || !this.statusDotEl) return;
      const st = this.status || {};
      const isEs = this._isEs();

      if (st.t3Running) {
        this.statusDotEl.dataset.state = 'ready';
        this.statusTextEl.textContent = isEs
          ? `T3 Code activo (${st.t3Url || '127.0.0.1:3773'})`
          : `T3 Code running (${st.t3Url || '127.0.0.1:3773'})`;
        if (this.installBtn) this.installBtn.hidden = true;
        if (this.startBtn) this.startBtn.hidden = true;
      } else if (st.t3Installed) {
        this.statusDotEl.dataset.state = 'installed';
        this.statusTextEl.textContent = isEs
          ? 'T3 Code instalado (servicio en espera)'
          : 'T3 Code installed (daemon idle)';
        if (this.installBtn) this.installBtn.hidden = true;
        if (this.startBtn) {
          this.startBtn.hidden = false;
          this.startBtn.textContent = isEs ? 'Iniciar T3 Code' : 'Start T3 Code';
        }
      } else {
        this.statusDotEl.dataset.state = 'offline';
        const wslHint = st.platform === 'win32' ? (isEs ? ' (vía WSL2 / nativo)' : ' (via WSL2 / native)') : '';
        this.statusTextEl.textContent = isEs
          ? `T3 Code no instalado${wslHint} · Experto R local activo`
          : `T3 Code not installed${wslHint} · Local R Expert active`;
        if (this.installBtn) {
          this.installBtn.hidden = false;
          this.installBtn.textContent = isEs ? 'Instalar T3 Code' : 'Install T3 Code';
        }
        if (this.startBtn) this.startBtn.hidden = true;
      }
    }

    updateContextPills() {
      if (!this.contextBarEl) return;
      const isEs = this._isEs();
      const tab = this.getActiveTab?.();
      const sel = this.getSelectedCode?.() || '';
      const st = this.getState?.() || {};
      const pills = [];
      if (tab) pills.push(`${isEs ? 'Archivo' : 'File'}: ${tab.name}`);
      if (sel.trim()) pills.push(`${isEs ? 'Selección' : 'Selection'}: ${sel.trim().split(/\r?\n/).length} ln`);
      if (st.activeDataset) pills.push(`${isEs ? 'Datos' : 'Data'}: ${st.activeDataset}`);
      this.contextBarEl.innerHTML = pills.map((p) => `<span class="t3-ctx-pill">${p.replace(/[<>&]/g, '')}</span>`).join('');
    }

    toggleWindow(force = null) {
      this.windowOpen = force !== null ? Boolean(force) : !this.windowOpen;
      if (this.winEl) {
        this.winEl.hidden = !this.windowOpen;
      }
      document.getElementById('actCopilot')?.classList.toggle('active', this.windowOpen);
      document.getElementById('btnTopCopilot')?.classList.toggle('active', this.windowOpen);
      if (this.windowOpen) {
        this.updateContextPills();
        this.refreshStatus();
        this.refreshModels();
        this.inputEl?.focus();
      }
    }

    openInlineFix() {
      if (!this.inlineBarEl) return;
      this.inlineOpen = true;
      this.inlineBarEl.hidden = false;
      const isEs = this._isEs();
      if (this.inlineStatusEl) {
        const sel = this.getSelectedCode?.() || '';
        this.inlineStatusEl.textContent = sel.trim()
          ? isEs
            ? `Seleccionadas ${sel.trim().split(/\r?\n/).length} línea(s)`
            : `${sel.trim().split(/\r?\n/).length} line(s) selected`
          : isEs
            ? 'Línea actual / archivo'
            : 'Current line / file';
      }
      if (this.inlineInputEl) {
        this.inlineInputEl.value = '';
        this.inlineInputEl.placeholder = isEs
          ? 'Ctrl+I: Describe qué corregir o transformar en R (Intro para aplicar)...'
          : 'Ctrl+I: Describe what to fix or transform in R (Enter to apply)...';
        this.inlineInputEl.focus();
      }
    }

    closeInlineFix() {
      this.inlineOpen = false;
      if (this.inlineBarEl) this.inlineBarEl.hidden = true;
    }

    async runInlineFix() {
      if (this.busy) return;
      const isEs = this._isEs();
      const prompt = this.inlineInputEl?.value?.trim() || (isEs ? 'Corrige cualquier error o warning en este código R' : 'Fix any error or warning in this R code');
      const tab = this.getActiveTab?.();
      const selection = this.getSelectedCode?.() || '';
      const st = this.getState?.() || {};

      this.busy = true;
      if (this.inlineRunBtn) this.inlineRunBtn.disabled = true;
      if (this.inlineStatusEl) this.inlineStatusEl.textContent = isEs ? 'T3 Code analizando...' : 'T3 Code thinking...';

      try {
        const res = await window.studio.t3Ask({
          mode: 'inline-fix',
          model: this.selectedModel || 'auto',
          prompt,
          code: tab?.model?.getValue?.() || '',
          selection,
          filePath: tab?.filePath || tab?.name || '',
          language: tab?.language || 'r',
          activeDataset: st.activeDataset || '',
          rOutput: document.getElementById('consoleOut')?.innerText?.slice(-1600) || '',
          lang: isEs ? 'es' : 'en'
        });

        if (res?.code) {
          this.applyCodeToEditor?.(res.code);
          this.showToast?.(isEs ? 'Corrección de T3 Code aplicada al editor.' : 'T3 Code fix applied to editor.');
          this.closeInlineFix();
        } else if (res?.reply) {
          this.closeInlineFix();
          this.toggleWindow(true);
          this.messages.push({ role: 'user', text: `[Ctrl+I] ${prompt}` }, { role: 'assistant', text: res.reply, code: res.code || '', backend: res.backend });
          this.renderMessages();
        }
      } catch (err) {
        if (this.inlineStatusEl) this.inlineStatusEl.textContent = err.message || 'Error';
      } finally {
        this.busy = false;
        if (this.inlineRunBtn) this.inlineRunBtn.disabled = false;
      }
    }

    async installT3Code() {
      if (!window.studio?.t3Install) return;
      const isEs = this._isEs();
      if (this.installBtn) this.installBtn.disabled = true;
      if (this.statusTextEl) {
        this.statusTextEl.textContent = isEs ? 'Descargando e instalando T3 Code...' : 'Downloading & installing T3 Code...';
      }
      try {
        const res = await window.studio.t3Install({ preferWsl: true });
        if (res?.ok) {
          this.showToast?.(
            isEs
              ? `T3 Code instalado (${res.installedPath || res.source}).`
              : `T3 Code installed (${res.installedPath || res.source}).`
          );
        } else {
          this.showToast?.(res?.error || 'T3 Code install failed', 'error');
        }
      } catch (err) {
        this.showToast?.(err.message || 'T3 Code install failed', 'error');
      } finally {
        if (this.installBtn) this.installBtn.disabled = false;
        await this.refreshStatus();
      }
    }

    async startT3Backend() {
      if (!window.studio?.t3Start) return;
      const isEs = this._isEs();
      if (this.startBtn) this.startBtn.disabled = true;
      if (this.statusTextEl) {
        this.statusTextEl.textContent = isEs ? 'Iniciando servicio T3 Code...' : 'Starting T3 Code backend...';
      }
      try {
        await window.studio.t3Start();
      } finally {
        if (this.startBtn) this.startBtn.disabled = false;
        await this.refreshStatus();
      }
    }

    async sendChat(overridePrompt = null) {
      if (this.busy) return;
      const raw = overridePrompt !== null ? overridePrompt : this.inputEl?.value || '';
      const prompt = raw.trim();
      if (!prompt) return;
      if (this.inputEl && overridePrompt === null) this.inputEl.value = '';

      const isEs = this._isEs();
      const tab = this.getActiveTab?.();
      const selection = this.getSelectedCode?.() || '';
      const st = this.getState?.() || {};

      const attachedSnapshot = this.attachments.slice();
      this.attachments = [];
      this._renderAttachments();

      const attLabel = attachedSnapshot.length ? `\n\n[${attachedSnapshot.map((a) => a.name).join(', ')}]` : '';
      this.messages.push({ role: 'user', text: `${prompt}${attLabel}` });
      this.renderMessages();
      this.busy = true;
      if (this.sendBtn) this.sendBtn.disabled = true;

      try {
        const res = await window.studio.t3Ask({
          mode: 'chat',
          model: this.selectedModel || 'auto',
          prompt,
          code: tab?.model?.getValue?.() || '',
          selection,
          attachments: attachedSnapshot,
          filePath: tab?.filePath || tab?.name || '',
          language: tab?.language || 'r',
          activeDataset: st.activeDataset || '',
          rOutput: document.getElementById('consoleOut')?.innerText?.slice(-1800) || '',
          lang: isEs ? 'es' : 'en'
        });
        this.messages.push({
          role: 'assistant',
          text: res?.reply || (isEs ? 'Sin respuesta.' : 'No response.'),
          code: res?.code || '',
          backend: res?.backend || 't3code'
        });
      } catch (err) {
        this.messages.push({
          role: 'assistant',
          text: `Error: ${err.message || String(err)}`,
          code: '',
          backend: 'error'
        });
      } finally {
        this.busy = false;
        if (this.sendBtn) this.sendBtn.disabled = false;
        this.renderMessages();
        this.refreshStatus();
      }
    }

    renderMessages() {
      if (!this.msgListEl) return;
      const isEs = this._isEs();
      this.msgListEl.textContent = '';

      if (!this.messages.length) {
        const empty = document.createElement('div');
        empty.className = 't3-empty-hint';
        empty.innerHTML = isEs
          ? `<strong>T3 Code Copilot (Ctrl+Alt+B)</strong><p>Pregunta sobre R, R Markdown, modelos estadísticos o depura errores de la consola. Usa <code>Ctrl+I</code> en el editor para correcciones rápidas en línea.</p>`
          : `<strong>T3 Code Copilot (Ctrl+Alt+B)</strong><p>Ask about R, R Markdown, statistical models, or debug console errors. Press <code>Ctrl+I</code> inside the editor for inline code fixes.</p>`;
        if (!this.status?.t3Running) {
          const actions = document.createElement('div');
          actions.className = 'prereq-actions';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'dlg-btn primary';
          if (this.status?.t3Installed) {
            btn.textContent = isEs ? 'Iniciar T3 Code' : 'Start T3 Code';
            btn.addEventListener('click', () => this.startT3Backend());
          } else {
            btn.textContent = isEs ? 'Instalar T3 Code' : 'Install T3 Code';
            btn.addEventListener('click', () => this.installT3Code());
          }
          actions.append(btn);
          empty.append(actions);
        }
        this.msgListEl.append(empty);
        return;
      }

      for (const msg of this.messages) {
        const card = document.createElement('div');
        card.className = `t3-msg t3-msg-${msg.role}`;

        const head = document.createElement('div');
        head.className = 't3-msg-head';
        head.textContent =
          msg.role === 'user'
            ? isEs
              ? 'Tú'
              : 'You'
            : `T3 Code${msg.backend ? ` (${msg.backend})` : ''}`;
        card.append(head);

        const body = document.createElement('div');
        body.className = 't3-msg-body';
        if (window.StudioMarkdownPreview?.renderMarkdown) {
          body.innerHTML = window.StudioMarkdownPreview.renderMarkdown(msg.text).html;
        } else {
          body.textContent = msg.text;
        }
        card.append(body);

        if (msg.role === 'assistant' && msg.code) {
          const actions = document.createElement('div');
          actions.className = 't3-msg-actions';

          const mkBtn = (label, fn) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'dlg-btn';
            b.textContent = label;
            b.addEventListener('click', fn);
            return b;
          };

          actions.append(
            mkBtn(isEs ? 'Aplicar al editor' : 'Apply to Editor', () => {
              this.applyCodeToEditor?.(msg.code);
              this.showToast?.(isEs ? 'Código aplicado al editor.' : 'Code applied to editor.');
            }),
            mkBtn(isEs ? 'Insertar en cursor' : 'Insert at Cursor', () => {
              this.insertCodeAtCursor?.(msg.code);
            }),
            mkBtn(isEs ? 'Ejecutar en R' : 'Run in R', () => {
              this.runCodeInR?.(msg.code);
            }),
            mkBtn(isEs ? 'Copiar' : 'Copy', async () => {
              await navigator.clipboard.writeText(msg.code);
              this.showToast?.(isEs ? 'Código copiado.' : 'Code copied.');
            })
          );
          card.append(actions);
        }

        this.msgListEl.append(card);
      }

      this.msgListEl.scrollTop = this.msgListEl.scrollHeight;
    }

    popoutWindow() {
      if (!this.openStandaloneWindow) return;
      const isEs = this._isEs();
      const html = this.msgListEl ? this.msgListEl.innerHTML : '';
      const raw = this.messages.map((m) => `[${m.role.toUpperCase()}]\n${m.text}`).join('\n\n');
      this.openStandaloneWindow({
        title: isEs ? 'T3 Code Copilot — R Commander Studio' : 'T3 Code Copilot — R Commander Studio',
        sourceLabel: 'T3 Code',
        htmlContent: html,
        rawText: raw
      });
    }
  }

  window.StudioT3Copilot = StudioT3Copilot;
})();
