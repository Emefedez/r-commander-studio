(function () {
  'use strict';

  class StudioMenuBar {
    constructor(hostEl, { onStudioCommand, onRcmdrCommand }) {
      this.host = hostEl;
      this.onStudioCommand = onStudioCommand;
      this.onRcmdrCommand = onRcmdrCommand;
      this.openIndex = -1;
      this.tree = [];

      document.addEventListener('click', (e) => {
        if (!this.host.contains(e.target)) this.closeAll();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.openIndex >= 0) this.closeAll();
      });
    }

    setTree(tree) {
      this.tree = tree || [];
      this.render();
    }

    closeAll() {
      this.openIndex = -1;
      for (const el of this.host.querySelectorAll('.menubar-item')) {
        el.classList.remove('open');
      }
    }

    _rcmdrItems(nodes, lang) {
      const out = [];
      for (const node of nodes || []) {
        if (node.sep) {
          out.push({ sep: true });
          continue;
        }
        const label = node.label?.[lang] || node.label?.en || node.id || '';
        if (node.children) {
          out.push({
            label,
            icon: node.icon || '',
            color: node.color || '',
            children: this._rcmdrItems(node.children, lang)
          });
        } else if (node.id) {
          out.push({
            label,
            icon: node.icon || '',
            color: node.color || '',
            rcmdrId: node.id
          });
        }
      }
      return out;
    }

    _buildDefinition() {
      const { t, getLang } = window.StudioI18n;
      const lang = getLang();
      const byEn = new Map();
      for (const n of this.tree) {
        if (!n.sep && n.children && n.label?.en) byEn.set(n.label.en, n.children);
      }
      const rcmdrSub = (enName) => this._rcmdrItems(byEn.get(enName), lang);

      return [
        {
          label: t('menuFile'),
          items: [
            { label: t('newRScript'), accel: 'Ctrl+N / Ctrl+T', cmd: 'new-r' },
            { label: t('newRmdDoc'), accel: 'Ctrl+Shift+N', cmd: 'new-rmd' },
            { sep: true },
            { label: t('openFile'), accel: 'Ctrl+O', cmd: 'open' },
            { label: t('openFolder'), accel: 'Ctrl+Shift+O', cmd: 'open-folder' },
            { label: t('loadWorkspace'), cmd: 'load-workspace' },
            { label: t('loadDatasetFile'), cmd: 'load-dataset-file' },
            { sep: true },
            { label: t('save'), accel: 'Ctrl+S', cmd: 'save' },
            { label: t('saveAs'), accel: 'Ctrl+Shift+S', cmd: 'save-as' },
            { label: t('menuAutoSave'), cmd: 'toggle-autosave' },
            { label: t('closeTab'), accel: 'Ctrl+W', cmd: 'close-tab' },
            { sep: true },
            ...rcmdrSub('File')
          ]
        },
        {
          label: t('menuEdit'),
          items: [
            { label: t('undo'), accel: 'Ctrl+Z', cmd: 'undo' },
            { label: t('redo'), accel: 'Ctrl+Y', cmd: 'redo' },
            { sep: true },
            { label: t('find'), accel: 'Ctrl+F', cmd: 'find' },
            { sep: true },
            ...rcmdrSub('Edit')
          ]
        },
        { label: t('menuData'), items: rcmdrSub('Data') },
        { label: t('menuStatistics'), items: rcmdrSub('Statistics') },
        { label: t('menuGraphs'), items: rcmdrSub('Graphs') },
        { label: t('menuModels'), items: rcmdrSub('Models') },
        { label: t('menuDistributions'), items: rcmdrSub('Distributions') },
        { label: t('menuBasicStats'), items: rcmdrSub('Basic Statistics') },
        {
          label: t('menuTools'),
          items: [
            ...rcmdrSub('Tools'),
            { sep: true },
            { label: t('copilotToggle'), accel: 'Ctrl+Alt+B', cmd: 'toggle-copilot' },
            { label: t('copilotInlineFix'), accel: 'Ctrl+I', cmd: 'inline-copilot' },
            {
              label: t('copilotChooseHarness'),
              children: [
                { label: 'Claude Code', cmd: 'set-ai-harness:claude' },
                { label: 'Antigravity (agy)', cmd: 'set-ai-harness:antigravity' },
                { label: 'Codex', cmd: 'set-ai-harness:codex' },
                { label: 'OpenCode', cmd: 'set-ai-harness:opencode' },
                { sep: true },
                { label: 'T3 Code / Local', cmd: 'set-ai-harness:t3code' },
                { label: 'R Expert (Offline)', cmd: 'set-ai-harness:r-expert' }
              ]
            },
            { label: t('copilotInstallBtn'), cmd: 'install-t3code' }
          ]
        },
        {
          label: t('menuView'),
          items: [
            { label: t('commandPalette'), accel: 'Ctrl+Shift+P', cmd: 'command-palette' },
            { label: t('copilotToggle'), accel: 'Ctrl+Alt+B', cmd: 'toggle-copilot' },
            { sep: true },
            { label: t('splitEditor'), accel: 'Ctrl+\\', cmd: 'toggle-split' },
            { label: t('moveTabOtherGroup'), cmd: 'move-tab-group' },
            { label: t('togglePreview'), accel: 'Ctrl+Shift+V', cmd: 'toggle-preview' },
            { sep: true },
            { label: t('toggleSidebar'), cmd: 'toggle-explorer-sidebar' },
            { label: t('toggleRcmdrSidebar'), cmd: 'toggle-rcmdr-sidebar' },
            { label: t('togglePanel'), cmd: 'toggle-panel' },
            { label: t('togglePanelOrientation'), cmd: 'toggle-panel-orientation' },
            {
              label: t('lockLayout'),
              cmd: 'toggle-layout-lock',
              checked: localStorage.getItem('rcs-layout-locked') === '1'
            },
            { sep: true },
            { label: t('layoutBothLeft'), cmd: 'layout-both-left' },
            { label: t('layoutExplorerLeftRcmdrRight'), cmd: 'layout-explorer-left-rcmdr-right' },
            { label: t('layoutRcmdrLeftExplorerRight'), cmd: 'layout-rcmdr-left-explorer-right' },
            { label: t('layoutBothRight'), cmd: 'layout-both-right' },
            { sep: true },
            { label: t('toggleTheme'), cmd: 'toggle-theme' },
            { label: t('switchLanguage'), cmd: 'switch-language' },
            { label: t('openSettings'), accel: 'Ctrl+,', cmd: 'open-settings' }
          ]
        },
        {
          label: t('menuRun'),
          items: [
            { label: t('runSelection'), accel: 'Ctrl+Enter', cmd: 'run-selection' },
            { label: t('runAll'), accel: 'Ctrl+Shift+Enter', cmd: 'run-all' },
            { label: t('knitRmd'), accel: 'Ctrl+Shift+K', cmd: 'knit' },
            { sep: true },
            { label: t('interruptR'), cmd: 'interrupt-r' },
            { label: t('restartR'), cmd: 'restart-r' },
            { label: t('clearConsole'), cmd: 'clear-console' },
            { label: t('refreshWorkspace'), cmd: 'refresh-workspace' }
          ]
        },
        {
          label: t('menuHelp'),
          items: [
            { label: t('guideBtnTitle'), cmd: 'open-guide' },
            { label: t('wizardMenuItem'), cmd: 'open-setup-wizard' },
            { label: t('rHelpMenu'), accel: 'F1', cmd: 'r-help' },
            { sep: true },
            ...rcmdrSub('Help'),
            { sep: true },
            { label: t('menuBuilds'), children: this._buildsItems(t) },
            { label: t('checkForUpdates'), cmd: 'check-updates' },
            { label: t('checkForUpdatesOnOpen'), cmd: 'toggle-update-on-open' },
            { label: t('installDesktopEntry'), cmd: 'install-desktop' },
            { sep: true },
            { label: t('repoGithub'), sub: 'Emefedez/r-commander-studio', cmd: 'open-repo-github' },
            { label: t('vscodeExtGithub'), sub: 'Emefedez/r-commander-in-vscode', cmd: 'open-vscode-ext-github' },
            { label: t('myGithub'), sub: t('myGithubSub'), cmd: 'open-my-github' }
          ]
        }
      ];
    }

    // Help > Builds: installed build + recent published builds (set by app.js).
    _buildsItems(t) {
      const b = this.builds || {};
      const info = b.info;
      const fmtDate = (iso) => {
        if (!iso) return '';
        const d = new Date(iso);
        const loc = window.StudioI18n?.getLang?.() === 'es' ? 'es-ES' : 'en-US';
        return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' });
      };
      const items = [];
      if (info) {
        const commit = info.commit ? `${info.commit}${info.dirty ? '+' : ''}` : info.source === 'dev' ? 'dev' : '';
        items.push({
          label: t('buildInstalled', `v${info.version}`),
          sub: [commit, fmtDate(info.date)].filter(Boolean).join(' · '),
          checked: true,
          cmd: 'copy-build-info'
        });
      }
      items.push({ sep: true });
      if (b.state === 'loading' || !b.state) items.push({ label: t('buildsLoading'), cmd: 'refresh-builds' });
      else if (b.state === 'error') items.push({ label: t('buildsUnavailable'), cmd: 'refresh-builds' });
      for (const r of b.releases || []) {
        const isCurrent = info && r.tag.replace(/^v/i, '') === info.version;
        items.push({
          label: r.tag + (r.prerelease ? ' (pre)' : ''),
          sub: fmtDate(r.date),
          checked: Boolean(isCurrent),
          cmd: 'open-url',
          arg: r.url
        });
      }
      items.push({ sep: true });
      items.push({ label: t('buildsAll'), cmd: 'open-url', arg: 'https://github.com/Emefedez/r-commander-studio/releases' });
      return items;
    }

    _buildMenuList(items, isSub = false) {
      const { svg } = window.StudioIcons;
      const panel = document.createElement('div');
      panel.className = isSub ? 'menubar-dropdown menubar-sub' : 'menubar-dropdown';

      for (const item of items || []) {
        if (item.sep) {
          const sep = document.createElement('div');
          sep.className = 'menubar-sep';
          panel.append(sep);
          continue;
        }

        if (item.children && item.children.length) {
          const subWrap = document.createElement('div');
          subWrap.className = 'menubar-subwrap';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'menubar-entry has-sub';
          btn.innerHTML = `<span class="menubar-entry-label"></span><span class="menubar-arrow">${svg('chevron-right', { size: 12 })}</span>`;
          btn.querySelector('.menubar-entry-label').textContent = item.label;
          const subPanel = this._buildMenuList(item.children, true);
          subWrap.addEventListener('mouseenter', () => {
            subPanel.classList.remove('flip-left');
            subPanel.style.top = '-4px';
            const r = subPanel.getBoundingClientRect();
            if (r.right > window.innerWidth - 8) {
              subPanel.classList.add('flip-left');
            }
            if (r.bottom > window.innerHeight - 8) {
              const shiftUp = Math.min(r.top - 8, r.bottom - (window.innerHeight - 8));
              subPanel.style.top = `${-4 - Math.max(0, shiftUp)}px`;
            }
          });
          subWrap.append(btn, subPanel);
          panel.append(subWrap);
        } else {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'menubar-entry';
          btn.innerHTML =
            (typeof item.checked === 'boolean'
              ? `<span class="menubar-check">${item.checked ? svg('check', { size: 12 }) : ''}</span>`
              : '') +
            `<span class="menubar-entry-label"></span>` +
            (item.sub ? `<small class="menubar-sub-tiny"></small>` : '') +
            (item.accel ? `<span class="menubar-accel">${item.accel}</span>` : '');
          btn.querySelector('.menubar-entry-label').textContent = item.label;
          if (item.sub) btn.querySelector('.menubar-sub-tiny').textContent = item.sub;
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeAll();
            if (item.cmd === 'new-rmd' && e.shiftKey) this.onStudioCommand('new-rmd-template');
            else if (item.cmd) this.onStudioCommand(item.cmd, item.arg);
            else if (item.rcmdrId) this.onRcmdrCommand(item.rcmdrId);
          });
          panel.append(btn);
        }
      }
      return panel;
    }

    render() {
      const defs = this._buildDefinition();
      this.host.textContent = '';

      defs.forEach((menuDef, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'menubar-item';

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'menubar-trigger';
        trigger.textContent = menuDef.label;

        const dropdown = this._buildMenuList(menuDef.items, false);
        wrap.append(trigger, dropdown);

        const openThis = () => {
          this.closeAll();
          this.openIndex = idx;
          wrap.classList.add('open');
          const rect = dropdown.getBoundingClientRect();
          if (rect.right > window.innerWidth - 8) {
            dropdown.style.left = 'auto';
            dropdown.style.right = '0';
          } else {
            dropdown.style.left = '0';
            dropdown.style.right = 'auto';
          }
        };

        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.openIndex === idx) this.closeAll();
          else openThis();
        });

        trigger.addEventListener('mouseenter', () => {
          if (this.openIndex >= 0 && this.openIndex !== idx) openThis();
        });

        this.host.append(wrap);
      });
    }
  }

  window.StudioMenuBar = StudioMenuBar;
})();
