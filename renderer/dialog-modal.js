(function () {
  'use strict';

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, String(v));
    }
    for (const kid of kids) {
      if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    }
    return el;
  }

  function fillSelect(select, items, keep, noneLabel) {
    const wanted = new Set([].concat(keep ?? []));
    select.textContent = '';
    if (select.dataset.optional) {
      const noneOpt = h('option', { value: '', textContent: noneLabel || '(none)' });
      noneOpt.selected = wanted.has('') || !wanted.size;
      select.append(noneOpt);
    }
    for (const item of items || []) {
      const opt = h('option', {
        value: item.value,
        textContent: item.description ? `${item.label}  —  ${item.description}` : item.label
      });
      opt.selected = wanted.has(item.value);
      select.append(opt);
    }
  }

  function applyFilter(select, text) {
    const q = String(text || '').trim().toLowerCase();
    for (const opt of select.options) {
      opt.hidden = Boolean(q) && !opt.textContent.toLowerCase().includes(q);
    }
  }

  class RcmdrDialogModal {
    constructor() {
      this.backdrop = document.getElementById('rcmdrModalBackdrop');
      this.titleEl = document.getElementById('rcmdrModalTitle');
      this.subEl = document.getElementById('rcmdrModalSub');
      this.dsRow = document.getElementById('rcmdrDsRow');
      this.fieldsEl = document.getElementById('rcmdrFields');
      this.statusEl = document.getElementById('rcmdrModalStatus');
      this.btnClose = document.getElementById('rcmdrModalClose');
      this.btnReset = document.getElementById('rcmdrBtnReset');
      this.btnCancel = document.getElementById('rcmdrBtnCancel');
      this.btnInsert = document.getElementById('rcmdrBtnInsert');
      this.btnRun = document.getElementById('rcmdrBtnRun');
      this.btnBoth = document.getElementById('rcmdrBtnBoth');

      this.sessionId = null;
      this.widgets = {};
      this.dirty = {};
      this.strings = {};
      this.fields = [];
      this.touchTimer = null;
      this.busy = false;
      this.onDeliver = null;

      this.btnClose.addEventListener('click', () => this.close());
      this.btnCancel.addEventListener('click', () => this.close());
      this.btnReset.addEventListener('click', () => this.reset());
      this.btnRun.addEventListener('click', () => this.submit('run'));
      this.btnInsert.addEventListener('click', () => this.submit('insert'));
      this.btnBoth.addEventListener('click', () => this.submit('both'));

      this.backdrop.addEventListener('click', (e) => {
        if (e.target === this.backdrop) this.close();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.backdrop.hidden) {
          e.preventDefault();
          this.close();
        }
      });
    }

    open(payload, onDeliver, options = {}) {
      this.close(true);
      this.sessionId = payload.sessionId;
      this.strings = payload.strings || {};
      this.onDeliver = onDeliver;
      this.stepMode = Boolean(options.stepMode);
      this.stepIndex = 0;
      this.dirty = {};
      this.busy = false;

      this.titleEl.textContent = payload.title || 'R Commander';
      this.subEl.textContent = payload.subtitle || '';
      this.statusEl.textContent = '';

      this.btnReset.textContent = this.strings.reset || 'Reset';
      this.btnCancel.textContent = this.strings.cancel || 'Cancel';
      this.btnInsert.textContent = this.strings.insert || 'Insert';
      this.btnRun.textContent = this.strings.run || 'Run';
      this.btnBoth.textContent = this.strings.runAndInsert || 'OK';

      // Dataset switcher if multiple datasets exist
      this.dsRow.textContent = '';
      if (Array.isArray(payload.datasets) && payload.datasets.length > 1) {
        const sel = h('select');
        for (const d of payload.datasets) {
          const opt = h('option', {
            value: d.name,
            textContent: `${d.name} — ${d.description}`,
            selected: d.name === payload.dataset
          });
          sel.append(opt);
        }
        sel.addEventListener('change', () => this.switchDataset(sel.value));
        this.dsRow.append(h('strong', {}, `${this.strings.dataset || 'Data set'}:`), sel);
        this.dsRow.hidden = false;
      } else {
        this.dsRow.hidden = true;
      }

      this.buildFields(payload.fields || []);
      this.writeInitialValues(payload.values || {});
      this.applyLayout(payload.layout || [], payload.values || {});

      this.backdrop.hidden = false;
      const first = this.fieldsEl.querySelector('select, input[type="text"], input[type="number"]');
      if (first) first.focus();
    }

    buildFields(fields) {
      this.fields = fields;
      this.widgets = {};
      this.fieldsEl.textContent = '';
      const S = this.strings;
      const legend = (text) => (text ? [h('legend', {}, text)] : []);

      for (const f of fields) {
        const err = h('div', { class: 'rcmdr-err' });
        let box, read, write;

        const isList = ['var', 'dataset', 'model', 'models', 'hclust', 'installed', 'rlist'].includes(f.type) && !f.free;

        if (isList) {
          const many = f.multi || f.type === 'models' || f.type === 'installed' || (f.type === 'rlist' && !f.single);
          const sel = h('select', { size: f.compact && !many ? 1 : f.filterable ? 12 : 7, multiple: many });
          const filter = f.filterable ? h('input', { type: 'text', placeholder: S.filter || 'Type to filter...', style: { marginBottom: '6px' } }) : null;
          if (filter) filter.addEventListener('input', () => applyFilter(sel, filter.value));
          if (f.optional && !many) sel.dataset.optional = '1';

          box = h(
            'fieldset',
            { class: `rcmdr-field${f.filterable ? ' wide' : ''}${f.compact && !many ? ' compact' : ''}` },
            ...legend(f.label),
            filter,
            sel,
            err
          );
          read = () => (many ? [...sel.selectedOptions].map((o) => o.value) : sel.selectedOptions[0]?.value ?? '');
          write = (v, items) => {
            if (items) fillSelect(sel, items, v, S.none);
            else fillSelect(sel, [...sel.options].map((o) => ({ value: o.value, label: o.textContent })), v, S.none);
          };
          sel.addEventListener('change', () => this.touch(f.k));
          sel.addEventListener('dblclick', () => this.submit('both'));
          this.widgets[f.k] = { box, err, read, write, sel };
        } else if (f.type === 'levelorder' || f.type === 'renames') {
          const isOrder = f.type === 'levelorder';
          const grid = h('div', { class: 'rcmdr-grid' });
          const inputs = {};
          let lastRows = '';
          box = h('fieldset', { class: 'rcmdr-field' }, ...legend(f.label), grid, err);
          read = () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
          const setRows = (rows) => {
            const key = JSON.stringify(rows || []);
            if (key === lastRows) return;
            lastRows = key;
            const prev = read();
            grid.textContent = '';
            for (const k of Object.keys(inputs)) delete inputs[k];
            grid.append(
              h('div', { class: 'head' }, isOrder ? S.newOrder || 'New order' : S.newName || 'New name'),
              h('div', { class: 'head' }, isOrder ? S.oldLevels || 'Old levels' : S.oldName || 'Old name')
            );
            (rows || []).forEach((name, idx) => {
              const inp = h('input', {
                type: isOrder ? 'number' : 'text',
                value: prev[name] ?? (isOrder ? String(idx + 1) : name)
              });
              if (isOrder) {
                inp.min = '1';
                inp.max = String(rows.length);
              }
              inp.addEventListener('input', () => this.touch(f.k));
              inputs[name] = inp;
              grid.append(inp, h('span', {}, name));
            });
          };
          this.widgets[f.k] = { box, err, read, write() {}, setRows };
        } else if (f.type === 'matrix') {
          const grid = h('div', { class: 'rcmdr-matrix' });
          let cells = {};
          let lastRows = '';
          box = h('fieldset', { class: 'rcmdr-field wide' }, ...legend(f.label), grid, err);
          read = () => Object.entries(cells).map(([name, inputs]) => [name, inputs.map((i) => i.value)]);
          const setRows = (rows) => {
            const key = JSON.stringify(rows || []);
            if (key === lastRows) return;
            lastRows = key;
            const prev = Object.fromEntries(read());
            grid.textContent = '';
            cells = {};
            const k = Math.max((rows || []).length - 1, 1);
            grid.style.gridTemplateColumns = `auto repeat(${k}, 5.5em)`;
            grid.append(h('div', { class: 'head' }, S.levels || 'Levels'));
            for (let j = 1; j <= k; j++) grid.append(h('div', { class: 'head' }, `.${j}`));
            for (const name of rows || []) {
              grid.append(h('div', {}, name));
              cells[name] = [];
              for (let j = 0; j < k; j++) {
                const inp = h('input', { type: 'text', value: (prev[name] || [])[j] ?? '0' });
                inp.addEventListener('input', () => this.touch(f.k));
                cells[name].push(inp);
                grid.append(inp);
              }
            }
          };
          this.widgets[f.k] = { box, err, read, write() {}, setRows };
        } else if (f.type === 'choice') {
          const group = h('div');
          box = h('fieldset', { class: 'rcmdr-field' }, ...legend(f.label), group, err);
          read = () => (group.querySelector('input:checked') || {}).value ?? '';
          write = (v, items) => {
            if (items) {
              group.textContent = '';
              for (const item of items) {
                const r = h('input', {
                  type: 'radio',
                  name: `rcmdr-r-${f.k}`,
                  value: item.value,
                  checked: item.value === v
                });
                r.addEventListener('change', () => this.touch(f.k));
                group.append(h('label', { class: 'rcmdr-opt' }, r, item.label));
              }
            } else {
              for (const r of group.querySelectorAll('input')) r.checked = r.value === v;
            }
          };
          this.widgets[f.k] = { box, err, read, write };
        } else if (f.type === 'formula') {
          const T = f.strings || {};
          const two = f.hasLhs !== false;
          const sel = h('select', { size: 7, multiple: true });
          const lhs = h('input', { type: 'text', style: { width: '11em', flex: '0 0 auto' } });
          const rhs = h('input', { type: 'text' });
          const df = h('input', { type: 'text', value: '5', style: { width: '3.2em' } });
          const deg = h('input', { type: 'text', value: '2', style: { width: '3.2em' } });

          const OPERATORS = ['+', '*', ':', '/', '-', '^', '(', '%'];
          const lastChar = (s) => {
            const c = [...s].reverse();
            return c.length ? (c[0] !== ' ' || c.length === 1 ? c[0] : c[1]) : '';
          };
          const canAddOp = (s) => s.trim() !== '' && ![...OPERATORS, '|'].includes(lastChar(s));
          const picked = () => {
            const vals = [...sel.selectedOptions].map((o) => o.value);
            for (const o of sel.options) o.selected = false;
            return vals;
          };
          const changed = () => {
            this.touch(f.k);
            rhs.focus();
          };
          const append = (text) => {
            rhs.value += text;
            changed();
          };

          sel.addEventListener('dblclick', () => {
            const v = picked()[0];
            if (!v) return;
            if (two && lhs.value.trim() === '') {
              lhs.value = v;
              changed();
              return;
            }
            const r = rhs.value;
            const c = lastChar(r);
            rhs.value = r === '' || OPERATORS.includes(c) ? r + v : c === '|' ? `${r} ${v}` : `${r} + ${v}`;
            changed();
          });

          const joinOp = (op, sep) => () => {
            const r = rhs.value;
            const v = picked();
            const check = !canAddOp(r);
            if (check && !v.length) return;
            if (v.length > 1) append((check ? '' : ' + ') + v.join(sep));
            else if (op === '+') append((check ? '' : ' + ') + v.join(''));
            else if (!check) append(op);
          };
          const simple = (text) => () => {
            if (canAddOp(rhs.value)) append(text);
          };
          const actions = {
            '+': joinOp('+', ' + '),
            '*': joinOp('*', '*'),
            ':': joinOp(':', ':'),
            '/': simple('/'),
            '|': simple(' |'),
            '%in%': simple(' %in% '),
            '-': simple(' - '),
            '^': simple('^'),
            '(': () => {
              if (rhs.value.endsWith('+')) rhs.value += ' ';
              append('(');
            },
            ')': simple(')')
          };

          const opsBar = h('div', { class: 'rcmdr-ops' });
          for (const op of ['+', '*', ':', '/', ...(f.showBar ? ['|'] : []), '%in%', '-', '^', '(', ')']) {
            opsBar.append(h('button', { type: 'button', textContent: op, onClick: actions[op] }));
          }

          const term = (fn, extra) => () => {
            const v = picked();
            if (v.length > 1) return;
            append(`${canAddOp(rhs.value) ? ' + ' : ' '}${fn}(${v[0] || ' '}${extra()})`);
          };
          const splinesBar = h(
            'div',
            { class: 'rcmdr-ops' },
            h('button', { type: 'button', textContent: T.bs || 'bs', onClick: term('bs', () => `, df=${df.value}`) }),
            h('button', { type: 'button', textContent: T.ns || 'ns', onClick: term('ns', () => `, df=${df.value}`) }),
            h('button', { type: 'button', textContent: T.poly || 'poly', onClick: term('poly', () => `, degree=${deg.value}`) }),
            h('button', { type: 'button', textContent: T.raw || 'raw poly', onClick: term('poly', () => `, degree=${deg.value}, raw=TRUE`) }),
            h('label', { class: 'rcmdr-opt' }, T.df || 'df:', df),
            h('label', { class: 'rcmdr-opt' }, T.deg || 'deg:', deg)
          );

          lhs.addEventListener('input', () => this.touch(f.k));
          rhs.addEventListener('input', () => this.touch(f.k));

          const formulaLine = two
            ? h('div', { class: 'rcmdr-row', style: { marginTop: '8px' } }, lhs, h('strong', {}, ' ~ '), rhs)
            : h('div', { class: 'rcmdr-row', style: { marginTop: '8px' } }, h('strong', {}, ' ~ '), rhs);

          box = h(
            'fieldset',
            { class: 'rcmdr-field wide' },
            ...legend(f.label),
            h(
              'div',
              { class: 'rcmdr-row', style: { alignItems: 'flex-start', gap: '12px' } },
              h('div', { style: { flex: '0 0 180px' } }, h('div', { class: 'rcmdr-hint' }, T.vars || 'Variables'), sel),
              h(
                'div',
                { style: { flex: '1' } },
                h('div', { class: 'rcmdr-hint' }, T.operators || 'Operators'),
                opsBar,
                h('div', { class: 'rcmdr-hint' }, T.splines || 'Splines/Polynomials'),
                splinesBar
              )
            ),
            formulaLine,
            err
          );

          read = () => ({ lhs: lhs.value, rhs: rhs.value });
          write = (v, items) => {
            if (items) fillSelect(sel, items, [], S.none);
            if (v && typeof v === 'object') {
              lhs.value = v.lhs || '';
              rhs.value = v.rhs || '';
            }
          };
          this.widgets[f.k] = { box, err, read, write };
        } else if (f.type === 'table') {
          const grid = h('div', { class: 'rcmdr-matrix' });
          let cells = [];
          let rowNames = [];
          let colNames = [];
          let rhs = [];
          let lastKey = '';
          box = h('fieldset', { class: 'rcmdr-field wide' }, ...legend(f.label), grid, err);
          read = () => ({
            rows: rowNames.map((i) => i.value),
            cols: colNames.map((i) => i.value ?? i.textContent),
            cells: cells.map((r) => r.map((i) => i.value)),
            rhs: rhs.map((i) => i.value)
          });
          const setDims = ([nr, nc], fixed) => {
            const key = `${nr}x${nc}:${(fixed || []).join(',')}`;
            if (key === lastKey) return;
            lastKey = key;
            const prev = read();
            grid.textContent = '';
            cells = [];
            rowNames = [];
            colNames = [];
            rhs = [];
            const named = !fixed;
            const extra = f.rhsLabel ? 1 : 0;
            grid.style.gridTemplateColumns = `repeat(${nc + (named ? 1 : 0) + extra}, 5.5em)`;
            if (named) grid.append(h('div'));
            for (let j = 0; j < nc; j++) {
              const c = fixed
                ? h('div', { class: 'head', textContent: fixed[j] })
                : h('input', { type: 'text', value: prev.cols[j] ?? String(j + 1) });
              if (!fixed) c.addEventListener('input', () => this.touch(f.k));
              colNames.push(c);
              grid.append(c);
            }
            if (extra) grid.append(h('div', { class: 'head', textContent: f.rhsLabel }));
            for (let r = 0; r < nr; r++) {
              if (named) {
                const rn = h('input', { type: 'text', value: prev.rows[r] ?? String(r + 1) });
                rn.addEventListener('input', () => this.touch(f.k));
                rowNames.push(rn);
                grid.append(rn);
              }
              cells.push([]);
              for (let j = 0; j < nc; j++) {
                const inp = h('input', { type: 'text', value: (prev.cells[r] || [])[j] ?? (f.cellDefault ?? '') });
                inp.addEventListener('input', () => this.touch(f.k));
                cells[r].push(inp);
                grid.append(inp);
              }
              if (extra) {
                const inp = h('input', { type: 'text', value: (prev.rhs || [])[r] ?? '0' });
                inp.addEventListener('input', () => this.touch(f.k));
                rhs.push(inp);
                grid.append(inp);
              }
            }
          };
          this.widgets[f.k] = { box, err, read, write() {}, setDims };
        } else if (f.type === 'hidden') {
          let val = '';
          box = h('div', { hidden: true });
          this.widgets[f.k] = {
            box,
            err: h('div'),
            read: () => val,
            write: (v) => {
              val = v ?? '';
            }
          };
        } else if (f.type === 'note') {
          box = h('div', { class: `rcmdr-note${f.heading ? ' heading' : ''}` }, f.label);
          this.widgets[f.k] = { box, err: h('div'), read: () => '', write() {} };
        } else if (f.type === 'flags') {
          const group = h('div');
          const boxes = {};
          for (const [key, text] of f.flags || []) {
            const cb = h('input', { type: 'checkbox' });
            cb.addEventListener('change', () => this.touch(f.k));
            boxes[key] = cb;
            group.append(h('label', { class: 'rcmdr-opt' }, cb, text));
          }
          box = h('fieldset', { class: 'rcmdr-field' }, ...legend(f.label), group, err);
          read = () => Object.fromEntries(Object.entries(boxes).map(([k, cb]) => [k, cb.checked]));
          write = (v) => {
            for (const [k, cb] of Object.entries(boxes)) cb.checked = Boolean(v && v[k]);
          };
          this.widgets[f.k] = { box, err, read, write };
        } else {
          const input = h('input', {
            type: 'text',
            placeholder: f.placeholder || (f.free ? S.freeHint || 'Type variable names...' : '')
          });
          const isBrowse = f.type === 'file' || f.type === 'dir';
          const isWide = !f.compact && (f.type === 'text' || f.type === 'name' || isBrowse || f.free || f.type === 'numlist');
          const browseBtn = isBrowse
            ? h('button', {
                type: 'button',
                class: 'btn-filled',
                textContent: S.browse || 'Browse...',
                onClick: async () => {
                  const chosen = await window.studio.browsePath({
                    mode: f.mode,
                    type: f.type,
                    filters: f.filters,
                    defaultName: f.placeholder,
                    title: f.label
                  });
                  if (chosen) {
                    input.value = chosen;
                    this.dirty[f.k] = true;
                    this.touch(f.k);
                  }
                }
              })
            : null;
          box = h(
            'div',
            { class: `rcmdr-field${isWide ? ' wide' : ''}${f.compact ? ' compact' : ''}` },
            h('label', { class: 'field-title' }, f.label),
            isBrowse ? h('div', { class: 'rcmdr-row' }, input, browseBtn) : input,
            err
          );
          read = () => input.value;
          write = (v) => {
            input.value = v ?? '';
          };
          input.addEventListener('input', () => {
            this.dirty[f.k] = true;
            this.touch(f.k);
          });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              this.submit('both');
            }
          });
          this.widgets[f.k] = { box, err, read, write };
        }

        this.fieldsEl.append(box);
      }
    }

    writeInitialValues(values) {
      for (const [k, v] of Object.entries(values || {})) {
        const w = this.widgets[k];
        if (w && !w.sel) w.write(v);
      }
    }

    collect() {
      return Object.fromEntries(Object.entries(this.widgets).map(([k, w]) => [k, w.read()]));
    }

    applyLayout(layoutItems, initialValues) {
      for (const item of layoutItems || []) {
        const w = this.widgets[item.k];
        if (!w) continue;
        w.box.style.display = item.visible ? '' : 'none';
        if (w.setDims) {
          if (item.dims) w.setDims(item.dims, item.colNames);
          continue;
        }
        if (w.setRows) {
          w.setRows(item.rows || (item.items ? item.items.map((i) => i.value) : []));
          continue;
        }
        const current = initialValues && item.k in initialValues ? initialValues[item.k] : w.read();
        if (item.items) {
          w.write(item.set !== undefined ? item.set : current, item.items);
        } else if (item.set !== undefined) {
          w.write(item.set);
        }
      }
    }

    touch() {
      clearTimeout(this.touchTimer);
      this.touchTimer = setTimeout(async () => {
        if (!this.sessionId) return;
        try {
          const res = await window.studio.rcmdrUpdateLayout({
            sessionId: this.sessionId,
            rawValues: this.collect(),
            dirty: this.dirty
          });
          if (res?.layout) this.applyLayout(res.layout);
        } catch {
          // ignore transient layout errors
        }
      }, 70);
    }

    async switchDataset(datasetName) {
      if (!this.sessionId) return;
      try {
        const res = await window.studio.rcmdrSwitchDataset({
          sessionId: this.sessionId,
          datasetName
        });
        this.dirty = {};
        this.subEl.textContent = res.subtitle || '';
        this.buildFields(res.fields || []);
        this.writeInitialValues(res.values || {});
        this.applyLayout(res.layout || [], res.values || {});
      } catch (err) {
        this.statusEl.textContent = err.message || String(err);
      }
    }

    async reset() {
      if (!this.sessionId) return;
      try {
        const res = await window.studio.rcmdrResetDialog({ sessionId: this.sessionId });
        this.dirty = {};
        this.clearErrors();
        this.writeInitialValues(res.values || {});
        this.applyLayout(res.layout || [], res.values || {});
      } catch (err) {
        this.statusEl.textContent = err.message || String(err);
      }
    }

    clearErrors() {
      this.statusEl.textContent = '';
      for (const w of Object.values(this.widgets)) {
        w.err.textContent = '';
        w.box.classList.remove('bad');
      }
    }

    setBusy(flag) {
      this.busy = flag;
      for (const b of [this.btnReset, this.btnCancel, this.btnInsert, this.btnRun, this.btnBoth]) {
        b.disabled = flag;
      }
    }

    async submit(mode) {
      if (!this.sessionId || this.busy) return;
      this.clearErrors();
      this.setBusy(true);
      try {
        const res = await window.studio.rcmdrSubmitDialog({
          sessionId: this.sessionId,
          rawValues: this.collect()
        });
        if (!res.ok) {
          if (res.cancelled) {
            this.setBusy(false);
            return;
          }
          const errors = res.errors || {};
          for (const [k, w] of Object.entries(this.widgets)) {
            w.err.textContent = errors[k] || '';
            w.box.classList.toggle('bad', Boolean(errors[k]));
          }
          const firstKey = Object.keys(errors).find((k) => k !== '__form' && this.widgets[k]);
          if (firstKey) this.widgets[firstKey].box.scrollIntoView({ block: 'nearest' });
          this.statusEl.textContent = errors.__form || '';
          this.setBusy(false);
          return;
        }

        const deliver = this.onDeliver;
        this.close();
        if (deliver) await deliver(res, mode);
      } catch (err) {
        this.statusEl.textContent = err.message || String(err);
        this.setBusy(false);
      }
    }

    close(silent = false) {
      clearTimeout(this.touchTimer);
      if (this.sessionId) {
        const id = this.sessionId;
        this.sessionId = null;
        window.studio.rcmdrCloseDialog({ sessionId: id }).catch(() => {});
      }
      this.setBusy(false);
      if (!silent) {
        this.backdrop.hidden = true;
      }
    }
  }

  window.RcmdrDialogModal = RcmdrDialogModal;
})();
