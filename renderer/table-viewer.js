(function () {
  'use strict';

  function fmtNum(v) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '-';
    const n = Number(v);
    if (Math.abs(n) >= 1e5 || (Math.abs(n) > 0 && Math.abs(n) < 1e-3)) return n.toExponential(3);
    return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/\.?0+$/, '');
  }

  function inferColType(values) {
    let seenNum = 0;
    let seenInt = 0;
    let seenBool = 0;
    let seenNonEmpty = 0;
    for (const v of values) {
      if (v === null || v === undefined || v === '' || v === 'NA') continue;
      seenNonEmpty++;
      const s = String(v).trim();
      if (/^(TRUE|FALSE|true|false)$/.test(s)) seenBool++;
      if (/^[-+]?\d+$/.test(s)) {
        seenInt++;
        seenNum++;
      } else if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) {
        seenNum++;
      }
    }
    if (!seenNonEmpty) return 'NA';
    if (seenBool === seenNonEmpty) return 'logi';
    if (seenInt === seenNonEmpty) return 'int';
    if (seenNum === seenNonEmpty) return 'num';
    return 'chr';
  }

  function computeLocalSummary(colName, values) {
    const valid = values.filter((v) => v !== null && v !== undefined && v !== '' && v !== 'NA');
    const naCount = values.length - valid.length;
    const type = inferColType(values);
    if (type === 'num' || type === 'int') {
      const nums = valid.map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      if (!nums.length) return { ok: true, col: colName, kind: 'numeric', type, n: values.length, naCount };
      const q = (p) => {
        const pos = (nums.length - 1) * p;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        return nums[lo] + (nums[hi] - nums[lo]) * (pos - lo);
      };
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const variance = nums.length > 1 ? nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1) : 0;
      return {
        ok: true,
        col: colName,
        kind: 'numeric',
        type,
        n: values.length,
        naCount,
        min: nums[0],
        q1: q(0.25),
        median: q(0.5),
        mean,
        q3: q(0.75),
        max: nums[nums.length - 1],
        sd: Math.sqrt(variance)
      };
    }
    const freq = new Map();
    for (const v of valid) freq.set(String(v), (freq.get(String(v)) || 0) + 1);
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    return {
      ok: true,
      col: colName,
      kind: 'categorical',
      type,
      n: values.length,
      naCount,
      nUnique: sorted.length,
      topLevels: sorted.slice(0, 6).map(([label, count]) => ({ label, count }))
    };
  }

  function iconBtn(iconName, title, onClick, active = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `icon-btn${active ? ' active' : ''}`;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = window.StudioIcons.svg(iconName, { size: 14 });
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
  }

  class StudioTableViewer {
    constructor(hostEl, { onToast, onSnapshot, onOpenAsCode, onImportCsvToR }) {
      this.host = hostEl;
      this.onToast = onToast;
      this.onSnapshot = onSnapshot;
      this.onOpenAsCode = onOpenAsCode;
      this.onImportCsvToR = onImportCsvToR;
      this.currentTab = null;
      this.filterTimer = null;
    }

    async mount(tab) {
      this.currentTab = tab;
      if (!tab.tableState) {
        tab.tableState = {
          page: 1,
          pageSize: 100,
          sortCol: '',
          sortDir: 'asc',
          filter: '',
          editMode: Boolean(tab.tableConfig?.editable),
          data: null,
          summary: null,
          localParsed: null
        };
      }
      await this.loadData();
      this.render();
    }

    async loadData() {
      const tab = this.currentTab;
      if (!tab) return;
      const ts = tab.tableState;
      const cfg = tab.tableConfig;

      if (cfg.kind === 'r') {
        ts.data = await window.studio.tableGetPage({
          name: cfg.objectName,
          source: cfg.source || 'global',
          page: ts.page,
          pageSize: ts.pageSize,
          sortCol: ts.sortCol,
          sortDir: ts.sortDir,
          filter: ts.filter
        });
      } else if (cfg.kind === 'csv') {
        if (!ts.localParsed) {
          const delimiter = cfg.delimiter || (tab.name.toLowerCase().endsWith('.tsv') ? '\t' : ',');
          ts.localParsed = await window.studio.tableParseDelimited({
            text: cfg.rawText || '',
            delimiter
          });
          ts.localParsed.delimiter = delimiter;
        }
        const { columns, rows } = ts.localParsed;
        const indexed = rows.map((r, i) => ({ rowIndex: i + 1, rowName: String(i + 1), values: r }));
        let filtered = indexed;
        if (ts.filter.trim()) {
          const q = ts.filter.trim().toLowerCase();
          filtered = indexed.filter((r) => r.values.some((v) => String(v ?? '').toLowerCase().includes(q)));
        }
        if (ts.sortCol) {
          const ci = columns.indexOf(ts.sortCol);
          if (ci >= 0) {
            const dir = ts.sortDir === 'desc' ? -1 : 1;
            filtered = filtered.slice().sort((a, b) => {
              const av = a.values[ci];
              const bv = b.values[ci];
              const an = Number(av);
              const bn = Number(bv);
              if (av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
              return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
            });
          }
        }
        const start = (ts.page - 1) * ts.pageSize;
        const pageRows = filtered.slice(start, start + ts.pageSize);
        const colMeta = columns.map((name, ci) => {
          const vals = rows.map((r) => r[ci]);
          const naCount = vals.filter((v) => v === '' || v === 'NA' || v === null || v === undefined).length;
          return { name, type: inferColType(vals), naCount };
        });
        ts.data = {
          ok: true,
          name: tab.name,
          editable: true,
          totalRows: rows.length,
          filteredRows: filtered.length,
          totalCols: columns.length,
          page: ts.page,
          pageSize: ts.pageSize,
          columns: colMeta,
          rows: pageRows
        };
      }
    }

    render() {
      const { t } = window.StudioI18n;
      const { svg } = window.StudioIcons;
      const tab = this.currentTab;
      if (!tab) return;
      const ts = tab.tableState;
      const cfg = tab.tableConfig;
      const data = ts.data;

      this.host.textContent = '';

      const wrap = document.createElement('div');
      wrap.className = 'tv-wrap';

      if (!data || !data.ok) {
        wrap.innerHTML = `<div class="ws-empty">${data?.error || 'Could not load table.'}</div>`;
        this.host.append(wrap);
        return;
      }

      const totalPages = Math.max(1, Math.ceil((data.filteredRows || 0) / ts.pageSize));
      if (ts.page > totalPages) ts.page = totalPages;

      // Compact VS Code Toolbar with strictly uniform 22x22 icon-only SVG buttons
      const bar = document.createElement('div');
      bar.className = 'tv-bar';

      const titleBadge = document.createElement('span');
      titleBadge.className = 'tv-title';
      titleBadge.textContent = cfg.title || data.name;

      const dimsBadge = document.createElement('span');
      dimsBadge.className = 'tv-dims';
      dimsBadge.textContent = ts.filter.trim()
        ? `${t('tableFilteredRows', data.filteredRows, data.totalRows)} / ${data.totalCols} cols`
        : t('tableRowsCols', data.totalRows, data.totalCols);

      const search = document.createElement('input');
      search.type = 'text';
      search.className = 'tv-search';
      search.value = ts.filter;
      search.placeholder = t('tableSearchPlaceholder');
      search.addEventListener('input', () => {
        ts.filter = search.value;
        ts.page = 1;
        clearTimeout(this.filterTimer);
        this.filterTimer = setTimeout(async () => {
          await this.loadData();
          this.render();
          const inp = this.host.querySelector('.tv-search');
          if (inp) {
            inp.focus();
            inp.setSelectionRange(inp.value.length, inp.value.length);
          }
        }, 160);
      });

      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      bar.append(titleBadge, dimsBadge, search, spacer);

      if (data.editable) {
        bar.append(
          iconBtn('edit', t('tableEditMode'), () => {
            ts.editMode = !ts.editMode;
            this.render();
          }, ts.editMode)
        );
        if (ts.editMode) {
          bar.append(iconBtn('add-row', t('tableAddRow'), () => this._addRow()));
          bar.append(iconBtn('add-col', t('tableAddCol'), () => this._addCol()));
        }
      }

      if (cfg.kind === 'csv') {
        bar.append(iconBtn('upload', t('tableImportToR'), () => this.onImportCsvToR?.(tab)));
        bar.append(iconBtn('save', t('tableSaveCsv'), () => this._saveCsvFile()));
        if (tab.filePath) {
          bar.append(iconBtn('file', t('openAsCode'), () => this.onOpenAsCode?.(tab.filePath)));
        }
      }

      bar.append(
        iconBtn('copy', t('tableCopyCsv'), () => this._copyCsv()),
        iconBtn('markdown', t('tableCopyMd'), () => this._copyMarkdown()),
        iconBtn('download', t('tableExportCsv'), () => this._exportCsv()),
        iconBtn('refresh', t('tableRefresh'), async () => {
          if (cfg.kind === 'csv') ts.localParsed = null;
          await this.loadData();
          this.render();
        })
      );

      wrap.append(bar);

      // Column Summary Bar
      if (ts.summary && ts.summary.ok) {
        const s = ts.summary;
        const sBar = document.createElement('div');
        sBar.className = 'tv-summary';
        const items = [];
        if (s.kind === 'numeric') {
          items.push(`${t('tableStatsMin')}: <b>${fmtNum(s.min)}</b>`);
          items.push(`${t('tableStatsQ1')}: <b>${fmtNum(s.q1)}</b>`);
          items.push(`${t('tableStatsMedian')}: <b>${fmtNum(s.median)}</b>`);
          items.push(`${t('tableStatsMean')}: <b>${fmtNum(s.mean)}</b>`);
          items.push(`${t('tableStatsQ3')}: <b>${fmtNum(s.q3)}</b>`);
          items.push(`${t('tableStatsMax')}: <b>${fmtNum(s.max)}</b>`);
          items.push(`${t('tableStatsSd')}: <b>${fmtNum(s.sd)}</b>`);
          items.push(`${t('tableStatsNA')}: <b>${s.naCount}</b>`);
        } else {
          items.push(`${t('tableStatsUnique')}: <b>${s.nUnique}</b>`);
          items.push(`${t('tableStatsNA')}: <b>${s.naCount}</b>`);
          if (s.topLevels?.length) {
            const topStr = s.topLevels.map((l) => `${l.label} (${l.count})`).join(', ');
            items.push(`${t('tableStatsTop')}: <b>${topStr}</b>`);
          }
        }
        const colSpan = document.createElement('span');
        colSpan.className = 'tv-summary-col';
        colSpan.innerHTML = `${svg('sigma', { size: 13 })} <span class="tv-sum-name"></span> <span class="tv-type-pill"></span>`;
        colSpan.querySelector('.tv-sum-name').textContent = s.col;
        colSpan.querySelector('.tv-type-pill').textContent = s.type;

        const metSpan = document.createElement('span');
        metSpan.className = 'tv-summary-metrics';
        metSpan.innerHTML = items.join(' | ');

        const closeBtn = iconBtn('close', t('dlgClose'), () => {
          ts.summary = null;
          this.render();
        });

        sBar.append(colSpan, metSpan, closeBtn);
        wrap.append(sBar);
      }

      // Data Grid
      const scroller = document.createElement('div');
      scroller.className = 'tv-scroller';

      const table = document.createElement('table');
      table.className = `tv-table${ts.editMode ? ' editable' : ''}`;

      const thead = document.createElement('thead');
      const headTr = document.createElement('tr');
      const rnTh = document.createElement('th');
      rnTh.className = 'tv-rn-col';
      rnTh.textContent = '#';
      headTr.append(rnTh);

      for (const col of data.columns || []) {
        const th = document.createElement('th');
        const isSorted = ts.sortCol === col.name;
        const sortIcon = isSorted
          ? svg(ts.sortDir === 'asc' ? 'chevron-down' : 'chevron-right', { size: 11 })
          : '';

        const inner = document.createElement('div');
        inner.className = 'tv-th-inner';

        const sortBtn = document.createElement('button');
        sortBtn.type = 'button';
        sortBtn.className = 'tv-col-sort';
        sortBtn.title = t('tableClickColForStats');
        sortBtn.innerHTML = `<span class="tv-col-name"></span>${sortIcon}`;
        sortBtn.querySelector('.tv-col-name').textContent = col.name;
        sortBtn.addEventListener('click', async () => {
          if (ts.sortCol === col.name) ts.sortDir = ts.sortDir === 'asc' ? 'desc' : 'asc';
          else {
            ts.sortCol = col.name;
            ts.sortDir = 'asc';
          }
          ts.page = 1;
          await this.loadData();
          this.render();
        });

        const statBtn = iconBtn('sigma', t('tableColStatsTitle'), async (e) => {
          e.stopPropagation();
          await this._showColSummary(col.name);
        });
        statBtn.classList.add('tv-col-stat');

        inner.append(sortBtn, statBtn);

        const meta = document.createElement('div');
        meta.className = 'tv-col-meta';
        meta.innerHTML = `<span class="tv-type-pill"></span>${col.naCount ? `<span class="tv-na-count">${col.naCount} NA</span>` : ''}`;
        meta.querySelector('.tv-type-pill').textContent = col.type;

        th.append(inner, meta);
        headTr.append(th);
      }
      thead.append(headTr);
      table.append(thead);

      const tbody = document.createElement('tbody');
      if (!data.rows || !data.rows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = (data.columns?.length || 0) + 1;
        td.className = 'ws-empty';
        td.textContent = t('tableNoRows');
        tr.append(td);
        tbody.append(tr);
      } else {
        for (const row of data.rows) {
          const tr = document.createElement('tr');
          const rnTd = document.createElement('td');
          rnTd.className = 'tv-rn-col';
          rnTd.textContent = row.rowName;
          tr.append(rnTd);

          (row.values || []).forEach((val, ci) => {
            const col = data.columns[ci];
            const td = document.createElement('td');
            const isNa = val === null || val === undefined || val === 'NA' || (cfg.kind === 'csv' && val === '');
            if (isNa) {
              td.innerHTML = '<span class="tv-na-badge">NA</span>';
            } else {
              td.textContent = String(val);
              if (col && (col.type === 'num' || col.type === 'int')) td.classList.add('num');
            }
            if (ts.editMode && data.editable) {
              td.title = t('tableClickCellToEdit');
              td.addEventListener('click', () => this._beginCellEdit(td, row.rowIndex, col.name, isNa ? '' : String(val)));
            }
            tr.append(td);
          });
          tbody.append(tr);
        }
      }

      table.append(tbody);
      scroller.append(table);
      wrap.append(scroller);

      // Pagination Footer with uniform icon-only navigation buttons
      const foot = document.createElement('div');
      foot.className = 'tv-foot';
      const hint = document.createElement('span');
      hint.className = 'muted';
      hint.textContent = ts.editMode ? t('tableClickCellToEdit') : t('tableClickColForStats');

      const footSpacer = document.createElement('span');
      footSpacer.className = 'spacer';

      const psSel = document.createElement('select');
      psSel.className = 'tv-ps-sel';
      psSel.title = t('tableRowsPerPage');
      for (const n of [50, 100, 250, 500]) {
        const opt = document.createElement('option');
        opt.value = String(n);
        opt.textContent = String(n);
        opt.selected = ts.pageSize === n;
        psSel.append(opt);
      }
      psSel.addEventListener('change', async () => {
        ts.pageSize = Number(psSel.value);
        ts.page = 1;
        await this.loadData();
        this.render();
      });

      const btnFirst = iconBtn('chevrons-left', t('tableFirst'), async () => {
        ts.page = 1;
        await this.loadData();
        this.render();
      });
      btnFirst.disabled = ts.page <= 1;

      const btnPrev = iconBtn('chevron-left', t('tablePrev'), async () => {
        ts.page = Math.max(1, ts.page - 1);
        await this.loadData();
        this.render();
      });
      btnPrev.disabled = ts.page <= 1;

      const pageInfo = document.createElement('span');
      pageInfo.className = 'tv-page-info';
      pageInfo.textContent = t('tablePageOf', ts.page, totalPages);

      const btnNext = iconBtn('chevron-right', t('tableNext'), async () => {
        ts.page = Math.min(totalPages, ts.page + 1);
        await this.loadData();
        this.render();
      });
      btnNext.disabled = ts.page >= totalPages;

      const btnLast = iconBtn('chevrons-right', t('tableLast'), async () => {
        ts.page = totalPages;
        await this.loadData();
        this.render();
      });
      btnLast.disabled = ts.page >= totalPages;

      foot.append(hint, footSpacer, psSel, btnFirst, btnPrev, pageInfo, btnNext, btnLast);
      wrap.append(foot);
      this.host.append(wrap);
    }

    async _showColSummary(colName) {
      const tab = this.currentTab;
      if (!tab) return;
      const ts = tab.tableState;
      const cfg = tab.tableConfig;
      if (cfg.kind === 'r') {
        ts.summary = await window.studio.tableColSummary({
          name: cfg.objectName,
          source: cfg.source || 'global',
          col: colName
        });
      } else if (cfg.kind === 'csv' && ts.localParsed) {
        const ci = ts.localParsed.columns.indexOf(colName);
        const vals = ts.localParsed.rows.map((r) => r[ci]);
        ts.summary = computeLocalSummary(colName, vals);
      }
      this.render();
    }

    _beginCellEdit(td, rowIndex, colName, initialVal) {
      if (td.querySelector('input')) return;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'tv-cell-input';
      inp.value = initialVal;
      td.textContent = '';
      td.append(inp);
      inp.focus();
      inp.select();

      let done = false;
      const commit = async (save) => {
        if (done) return;
        done = true;
        if (!save || inp.value === initialVal) {
          this.render();
          return;
        }
        await this._commitCellEdit(rowIndex, colName, inp.value);
      };

      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          commit(false);
        }
      });
      inp.addEventListener('blur', () => commit(true));
    }

    async _commitCellEdit(rowIndex, colName, value) {
      const { t } = window.StudioI18n;
      const tab = this.currentTab;
      const ts = tab.tableState;
      const cfg = tab.tableConfig;

      if (cfg.kind === 'r') {
        const res = await window.studio.tableEditCell({
          name: cfg.objectName,
          rowIndex,
          colName,
          value
        });
        if (!res.ok) this.onToast?.(res.error || 'Cell update failed', 'error');
        else {
          if (res.snapshot) this.onSnapshot?.(res.snapshot);
          this.onToast?.(t('tableCellUpdated', cfg.objectName, rowIndex, colName));
        }
      } else if (cfg.kind === 'csv' && ts.localParsed) {
        const ci = ts.localParsed.columns.indexOf(colName);
        if (ci >= 0 && ts.localParsed.rows[rowIndex - 1]) {
          ts.localParsed.rows[rowIndex - 1][ci] = value;
          tab.dirty = true;
        }
      }
      await this.loadData();
      this.render();
    }

    async _addRow() {
      const { t } = window.StudioI18n;
      const tab = this.currentTab;
      const ts = tab.tableState;
      const cfg = tab.tableConfig;

      if (cfg.kind === 'r') {
        const res = await window.studio.tableAddRow({ name: cfg.objectName });
        if (!res.ok) this.onToast?.(res.error || 'Failed to add row', 'error');
        else {
          if (res.snapshot) this.onSnapshot?.(res.snapshot);
          this.onToast?.(t('tableRowAdded', cfg.objectName));
        }
      } else if (cfg.kind === 'csv' && ts.localParsed) {
        ts.localParsed.rows.push(ts.localParsed.columns.map(() => ''));
        tab.dirty = true;
      }
      await this.loadData();
      this.render();
    }

    async _addCol() {
      const { t } = window.StudioI18n;
      const colName = window.prompt(t('tableAddColPrompt'), 'new_col');
      if (!colName || !colName.trim()) return;
      const defVal = window.prompt(t('tableAddColDefaultPrompt'), 'NA');
      const tab = this.currentTab;
      const ts = tab.tableState;
      const cfg = tab.tableConfig;

      if (cfg.kind === 'r') {
        const res = await window.studio.tableAddCol({
          name: cfg.objectName,
          colName: colName.trim(),
          defaultValue: defVal ?? 'NA'
        });
        if (!res.ok) this.onToast?.(res.error || 'Failed to add column', 'error');
        else {
          if (res.snapshot) this.onSnapshot?.(res.snapshot);
          this.onToast?.(t('tableColAdded', cfg.objectName, res.colName));
        }
      } else if (cfg.kind === 'csv' && ts.localParsed) {
        ts.localParsed.columns.push(colName.trim());
        for (const r of ts.localParsed.rows) r.push(defVal === 'NA' || defVal === null ? '' : defVal);
        tab.dirty = true;
      }
      await this.loadData();
      this.render();
    }

    async _getFullCsv() {
      const tab = this.currentTab;
      const ts = tab.tableState;
      const cfg = tab.tableConfig;
      if (cfg.kind === 'r') {
        const res = await window.studio.tableExportCsv({ name: cfg.objectName, source: cfg.source || 'global' });
        return res.ok ? res.csv : '';
      }
      if (cfg.kind === 'csv' && ts.localParsed) {
        return window.studio.tableSerializeDelimited({
          columns: ts.localParsed.columns,
          rows: ts.localParsed.rows,
          delimiter: ts.localParsed.delimiter || ','
        });
      }
      return '';
    }

    async _copyCsv() {
      const { t } = window.StudioI18n;
      const csv = await this._getFullCsv();
      if (!csv) return;
      await navigator.clipboard.writeText(csv);
      this.onToast?.(t('tableCopiedCsv'));
    }

    async _copyMarkdown() {
      const { t } = window.StudioI18n;
      const data = this.currentTab?.tableState?.data;
      if (!data?.columns) return;
      const cols = data.columns.map((c) => c.name);
      const rows = (data.rows || []).map((r) => r.values.map((v) => (v === null || v === undefined ? 'NA' : String(v))));
      const md = await window.studio.tableToMarkdown({ columns: cols, rows });
      await navigator.clipboard.writeText(md);
      this.onToast?.(t('tableCopiedMd'));
    }

    async _exportCsv() {
      const { t } = window.StudioI18n;
      const csv = await this._getFullCsv();
      if (!csv) return;
      const base = (this.currentTab?.tableConfig?.objectName || this.currentTab?.name || 'table').replace(/\.[^.]+$/, '');
      const res = await window.studio.saveFileAs({
        defaultName: `${base}.csv`,
        content: csv,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (res?.ok) this.onToast?.(t('toastSaved', res.name));
    }

    async _saveCsvFile() {
      const { t } = window.StudioI18n;
      const tab = this.currentTab;
      const csv = await this._getFullCsv();
      if (!csv) return;
      if (tab.filePath) {
        const res = await window.studio.saveFile({ filePath: tab.filePath, content: csv });
        if (res?.ok) {
          tab.dirty = false;
          this.onToast?.(t('toastSaved', tab.name));
        }
      } else {
        await this._exportCsv();
      }
    }
  }

  window.StudioTableViewer = StudioTableViewer;
})();
