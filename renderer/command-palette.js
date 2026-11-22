(function () {
  'use strict';

  function fold(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  class StudioCommandPalette {
    constructor({ getStudioCommands, onStudioCommand, onRcmdrCommand }) {
      this.getStudioCommands = getStudioCommands;
      this.onStudioCommand = onStudioCommand;
      this.onRcmdrCommand = onRcmdrCommand;

      this.backdrop = document.getElementById('paletteBackdrop');
      this.input = document.getElementById('paletteInput');
      this.list = document.getElementById('paletteList');
      this.items = [];
      this.activeIdx = 0;

      this.backdrop.addEventListener('click', (e) => {
        if (e.target === this.backdrop) this.close();
      });

      this.input.addEventListener('input', () => this.refresh());
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (this.items.length) {
            this.activeIdx = (this.activeIdx + 1) % this.items.length;
            this._highlight();
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (this.items.length) {
            this.activeIdx = (this.activeIdx - 1 + this.items.length) % this.items.length;
            this._highlight();
          }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const chosen = this.items[this.activeIdx];
          if (chosen) this._execute(chosen);
        }
      });
    }

    async open(initialQuery = '') {
      const { t } = window.StudioI18n;
      this.input.placeholder = t('palettePlaceholder');
      this.input.value = initialQuery;
      this.backdrop.hidden = false;
      this.input.focus();
      await this.refresh();
    }

    close() {
      this.backdrop.hidden = true;
    }

    async refresh() {
      const { t, getLang } = window.StudioI18n;
      const q = this.input.value.trim();
      const words = fold(q).split(/\s+/).filter(Boolean);

      const studioCmds = (this.getStudioCommands() || [])
        .filter((c) => {
          if (!words.length) return true;
          const hay = fold(`${c.label} ${c.labelAlt || ''} ${c.id} ${c.accel || ''}`);
          return words.every((w) => hay.includes(w));
        })
        .map((c) => ({
          kind: 'studio',
          id: c.id,
          label: c.label,
          detail: t('paletteCategoryStudio'),
          accel: c.accel || ''
        }));

      const rcmdrMatches = await window.studio.rcmdrSearchCommands({ query: q, lang: getLang() });
      const rcmdrCmds = (rcmdrMatches || []).slice(0, 60).map((c) => ({
        kind: 'rcmdr',
        id: c.id,
        label: c.label,
        detail: c.path || t('paletteCategoryRcmdr'),
        accel: ''
      }));

      this.items = [...studioCmds, ...rcmdrCmds].slice(0, 80);
      this.activeIdx = 0;
      this._render();
    }

    _render() {
      const { t } = window.StudioI18n;
      this.list.textContent = '';
      if (!this.items.length) {
        const empty = document.createElement('div');
        empty.className = 'ws-empty';
        empty.textContent = t('paletteNoResults');
        this.list.append(empty);
        return;
      }

      this.items.forEach((item, idx) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `palette-item${idx === this.activeIdx ? ' active' : ''}`;
        row.innerHTML =
          `<span class="palette-cat ${item.kind}">${item.kind === 'rcmdr' ? 'Rcmdr' : 'IDE'}</span>` +
          `<span class="palette-main"><span class="palette-label"></span><span class="palette-detail"></span></span>` +
          (item.accel ? `<span class="palette-accel">${item.accel}</span>` : '');
        row.querySelector('.palette-label').textContent = item.label;
        row.querySelector('.palette-detail').textContent = item.detail;
        row.addEventListener('click', () => this._execute(item));
        row.addEventListener('mouseenter', () => {
          this.activeIdx = idx;
          this._highlight(false);
        });
        this.list.append(row);
      });
    }

    _highlight(scroll = true) {
      const children = [...this.list.querySelectorAll('.palette-item')];
      children.forEach((el, idx) => {
        el.classList.toggle('active', idx === this.activeIdx);
        if (scroll && idx === this.activeIdx) el.scrollIntoView({ block: 'nearest' });
      });
    }

    _execute(item) {
      this.close();
      if (item.kind === 'studio') this.onStudioCommand(item.id);
      else this.onRcmdrCommand(item.id);
    }
  }

  window.StudioCommandPalette = StudioCommandPalette;
})();
