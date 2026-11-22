'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const vendorRoot = path.join(__dirname, '..', 'vendor', 'rcmdr');
const catalog = require(path.join(vendorRoot, 'catalog'));
const commands = require(path.join(vendorRoot, 'data', 'commands.json'));
const tree = require(path.join(vendorRoot, 'data', 'tree.json'));
const functionsMap = require(path.join(vendorRoot, 'data', 'functions.json'));
const formmodel = require(path.join(vendorRoot, 'lib', 'formmodel.js'));
const { context } = require(path.join(vendorRoot, 'lib', 'rhelpers.js'));
const i18n = require(path.join(vendorRoot, 'lib', 'i18n.js'));
const report = require(path.join(vendorRoot, 'lib', 'report.js'));

const STATE_FIELDS = new Set(['dataset', 'model', 'models', 'hclust']);

// Reverse index: command id -> array of R function names from data/functions.json
const FNS_BY_CMD = new Map();
for (const [fnName, cmdIds] of Object.entries(functionsMap || {})) {
  for (const cid of cmdIds || []) {
    const key = String(cid);
    if (!FNS_BY_CMD.has(key)) FNS_BY_CMD.set(key, []);
    const arr = FNS_BY_CMD.get(key);
    if (!arr.includes(fnName)) arr.push(fnName);
  }
}

const FNS_IGNORE = new Set([
  'if', 'for', 'while', 'switch', 'return', 'function', 'new', 'Map', 'Set', 'Array', 'Object',
  'String', 'Number', 'Boolean', 'Math', 'JSON', 'RegExp', 'Error', 'Promise', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'q', 'dv', 'id', 'num', 'join',
  'map', 'filter', 'find', 'some', 'every', 'reduce', 'push', 'slice', 'split', 'trim', 'replace',
  'includes', 'startsWith', 'endsWith', 'concat', 'flat', 'flatMap', 'sort', 'reverse', 'keys', 'values',
  'entries', 'assign', 'freeze', 'create', 'defineProperty', 'hasOwnProperty', 'toString', 'valueOf',
  'local', 'print', 'cat', 'c', 'list', 'paste', 'paste0', 'with', 'within'
]);

// Extra R function aliases for common statistical tests so searching e.g. "shapiro.test" finds normalityTest
const EXTRA_FN_ALIASES = {
  normalityTest: ['shapiro.test', 'ad.test', 'cvm.test', 'lillie.test', 'pearson.test', 'sf.test'],
  Hist: ['hist', 'truehist'],
  Boxplot: ['boxplot'],
  scatterplot: ['plot', 'xyplot'],
  scatterplotMatrix: ['pairs'],
  linePlot: ['matplot', 'plot'],
  BarPlot: ['barplot'],
  PieChart: ['pie'],
  DotPlot: ['dotchart', 'stripchart'],
  numSummary: ['summary', 'mean', 'sd', 'IQR', 'quantile'],
  'rcorr.adjust': ['cor', 'cor.test'],
  linearModel: ['lm'],
  generalizedLinearModel: ['glm'],
  oneWayAnova: ['aov', 'anova', 'oneway.test'],
  multiWayAnova: ['aov', 'Anova'],
  singleSampleTTest: ['t.test'],
  independentSamplesTTest: ['t.test'],
  pairedTTest: ['t.test']
};

// Enrich tree nodes in-place with R function names and target id so both sidebar & palette search
// match EN labels, ES labels, command IDs, and R function names regardless of active language.
function enrichTreeNodes(nodes) {
  for (const node of nodes || []) {
    if (node.sep) continue;
    if (node.children) {
      enrichTreeNodes(node.children);
    } else if (node.id) {
      const target = commands[node.id]?.target || node.id;
      const fns = new Set([...(FNS_BY_CMD.get(node.id) || []), ...(FNS_BY_CMD.get(target) || [])]);
      const spec = catalog[target];
      if (spec?.pkgs) {
        for (const p of spec.pkgs) fns.add(p);
      }
      if (typeof spec?.code === 'function') {
        const src = spec.code.toString();
        for (const m of src.matchAll(/(?:[A-Za-z0-9._]+::)?([A-Za-z.][A-Za-z0-9._]*)\s*\(/g)) {
          const fn = m[1];
          if (fn && fn.length > 1 && !FNS_IGNORE.has(fn) && !fn.startsWith('_')) {
            fns.add(fn);
          }
        }
      }
      for (const existing of [...fns]) {
        const aliases = EXTRA_FN_ALIASES[existing];
        if (aliases) {
          for (const a of aliases) fns.add(a);
        }
      }
      if (EXTRA_FN_ALIASES[target]) {
        for (const a of EXTRA_FN_ALIASES[target]) fns.add(a);
      }
      node.target = target;
      node.fns = [...fns];
    }
  }
}
enrichTreeNodes(tree);

function fold(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function buildMenuPaths(lang = 'en') {
  const paths = {};
  let order = 0;
  const walk = (nodes, trail) => {
    for (const node of nodes) {
      if (node.sep) continue;
      const label = node.label?.[lang] || node.label?.en || node.id || '';
      if (node.children) {
        walk(node.children, [...trail, label]);
      } else {
        const key = node.target || node.id;
        if (key && !(key in paths)) {
          paths[key] = { path: [...trail, label], order: order++, id: node.id, label };
        }
      }
    }
  };
  walk(tree, []);
  return paths;
}

function describeFields(fields, env) {
  const { t } = env;
  return (fields || []).map((f) => ({
    k: f.k,
    type: f.type,
    label: f.label === '' ? '' : t(f.label || f.k),
    multi: Boolean(f.multi),
    optional: Boolean(f.optional),
    filterable: Boolean(f.filterable),
    single: Boolean(f.single),
    compact: Boolean(f.compact),
    mode: f.mode,
    free: f.type === 'var' && !env.vars,
    flags: f.items?.map(([key, text]) => [key, t(text)]),
    placeholder: f.type === 'file' ? f.def || '' : '',
    filters: f.filters || undefined,
    hasLhs: f.hasLhs,
    showBar: Boolean(f.showBar),
    heading: Boolean(f.heading),
    rhsLabel: f.rhsLabel ? t(f.rhsLabel) : undefined,
    cellDefault: f.cellDefault,
    strings:
      f.type === 'formula'
        ? {
            vars: t('Variables (double-click to formula)'),
            operators: t('Operators (click to formula):  '),
            splines: t('Splines/Polynomials:\n(select variable and click)'),
            bs: t('B-spline\n'),
            ns: t('natural\nspline'),
            poly: t('orthogonal\npolynomial'),
            raw: t('raw\npolynomial'),
            df: t('df for splines: '),
            deg: t('deg. for polynomials: ')
          }
        : undefined
  }));
}

function parseTabLines(lines, labelColumn) {
  return (lines || []).map((line) => {
    const [value, description] = String(line).split('\t');
    return labelColumn === 2 && description
      ? { value, label: description, description: value }
      : { value, label: value, description };
  });
}

function makeCtx(ds, { state, activeModel, settings = {} } = {}) {
  const c = context(ds, { objects: state?.objects });
  c.model = activeModel;
  c.cranMirror = settings.cranMirror || 'https://cloud.r-project.org';
  c.packageDownloads = settings.packageDownloads || '~/.cache/r-commander-studio/packages';
  c.kindOf = (v) => state?.datasets?.[ds]?.vars?.find((x) => x.name === v)?.kind;
  c.varNames = (state?.datasets?.[ds]?.vars || []).map((x) => x.name);
  c.nvars = state?.datasets?.[ds]?.vars?.length;
  c.nrows = state?.datasets?.[ds]?.rows;
  c.isDiscrete = (v) => Boolean(state?.datasets?.[ds]?.vars?.find((x) => x.name === v)?.discrete);
  c.nlevelsOf = (v) => state?.datasets?.[ds]?.vars?.find((x) => x.name === v)?.levels;
  c.modelClass = (state?.models || []).find((m) => m.name === activeModel)?.cls;
  return c;
}

class RcmdrService {
  constructor() {
    this._sessions = new Map();
    this._language = 'es';
    this._settings = {
      cranMirror: 'https://cloud.r-project.org',
      packageDownloads: '~/.cache/r-commander-studio/packages'
    };
    this._menuPathsCache = {
      en: buildMenuPaths('en'),
      es: buildMenuPaths('es')
    };
  }

  setLanguage(lang) {
    this._language = lang === 'en' ? 'en' : 'es';
    i18n.setLanguage(this._language);
    return this._language;
  }

  getLanguage() {
    return this._language;
  }

  updateSettings(patch = {}) {
    Object.assign(this._settings, patch);
    return { ...this._settings };
  }

  getTree(lang) {
    if (lang) this.setLanguage(lang);
    return tree;
  }

  /**
   * Collects every leaf command id reachable from data/tree.json.
   */
  getAllTreeCommandIds() {
    const ids = new Set();
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.sep) continue;
        if (n.children) walk(n.children);
        else if (n.id) ids.add(n.id);
      }
    };
    walk(tree);
    return ids;
  }

  /**
   * Accent-insensitive bilingual search across all 371 R Commander commands (matches EN, ES, menu path, and id).
   */
  searchCommands(query = '', lang = this._language) {
    const words = fold(query).trim().split(/\s+/).filter(Boolean);
    const items = [];
    const seen = new Set();

    const walk = (nodes, trailEn = [], trailEs = []) => {
      for (const node of nodes) {
        if (node.sep) continue;
        const enLabel = node.label?.en || node.id || '';
        const esLabel = node.label?.es || enLabel;
        if (node.children) {
          walk(node.children, [...trailEn, enLabel], [...trailEs, esLabel]);
        } else if (node.id && !seen.has(node.id)) {
          seen.add(node.id);
          const fns = node.fns || [];
          const haystack = fold(
            [...trailEn, ...trailEs, enLabel, esLabel, node.id, node.target || '', ...fns].join(' ')
          );
          if (!words.length || words.every((w) => haystack.includes(w))) {
            const label = lang === 'es' ? esLabel : enLabel;
            const altLabel = lang === 'es' ? enLabel : esLabel;
            const pathArr = lang === 'es' ? trailEs : trailEn;
            items.push({
              id: node.id,
              label,
              altLabel: altLabel !== label ? altLabel : '',
              labelEn: enLabel,
              labelEs: esLabel,
              path: pathArr.join(' ▸ '),
              pathEn: trailEn.join(' ▸ '),
              pathEs: trailEs.join(' ▸ '),
              fns,
              color: node.color || ''
            });
          }
        }
      }
    };
    walk(tree);
    return items;
  }

  /**
   * MenuHover parity with r-commander-play/lib/hover.js: maps an R function name to its R Commander menu paths.
   */
  getMenuHover(fnName, lang = this._language) {
    if (!fnName) return null;
    const clean = String(fnName).split('::').pop();
    const ids = functionsMap[clean];
    if (!ids || !ids.length) return null;
    const paths = this._menuPathsCache[lang === 'es' ? 'es' : 'en'];
    const entries = ids
      .filter((id) => paths[id])
      .sort((a, b) => paths[a].order - paths[b].order)
      .map((id) => ({
        id: paths[id].id,
        path: paths[id].path.join(' ▸ '),
        label: paths[id].label
      }));
    if (!entries.length) return null;
    return {
      fn: clean,
      total: entries.length,
      entries: entries.slice(0, 6)
    };
  }

  getCatalogSummary() {
    const menus = tree
      .filter((n) => !n.sep && n.label)
      .map((n) => ({
        label: n.label,
        id: n.id || null,
        childCount: Array.isArray(n.children) ? n.children.filter((c) => !c.sep).length : 0
      }));
    const commandList = Object.entries(commands).map(([id, meta]) => {
      const target = meta.target || id;
      const spec = catalog[target];
      return {
        id,
        label: meta.label,
        target,
        needsDataset: spec ? spec.ds !== false : false,
        needsModel: Boolean(spec?.needsModel),
        fieldCount: spec?.fields?.length || 0,
        pkgs: spec?.pkgs || []
      };
    });
    return {
      count: commandList.length,
      menus,
      commands: commandList
    };
  }

  getTitle(id) {
    const label = commands[id]?.label || id;
    return i18n.t(label).replace(/\.\.\.$/, '').replace(/…$/, '');
  }

  getSpec(id) {
    const target = commands[id]?.target || id;
    return catalog[target];
  }

  async _enrichLayout(session, layoutItems, queryFn) {
    const { spec, env, rowsCache, listCache, lastFor } = session;
    const fields = spec.fields || [];
    for (const item of layoutItems) {
      if (item.listFor !== undefined) {
        const field = fields.find((f) => f.k === item.k);
        const key = `${item.k}:${item.listFor}`;
        if (item.listFor && !listCache.has(key)) {
          const lines = queryFn
            ? (await queryFn(field.exprFor(item.listFor, env.ctx), field.timeout || 25000)) || []
            : [];
          listCache.set(key, parseTabLines(lines, field.labelColumn));
        }
        item.items = item.listFor ? listCache.get(key) || [] : [];
        if (lastFor[item.k] !== item.listFor) {
          item.set = field.selectAll
            ? item.items.map((i) => i.value)
            : item.items.slice(0, 1).map((i) => i.value);
          lastFor[item.k] = item.listFor;
        }
        continue;
      }
      if (item.rowsFor) {
        if (!rowsCache.has(item.rowsFor)) {
          const levels = queryFn
            ? (await queryFn(`levels(as.factor(${env.ctx.dv(item.rowsFor)}))`)) || []
            : [];
          rowsCache.set(item.rowsFor, levels);
        }
        item.rows = rowsCache.get(item.rowsFor);
      }
    }
    return layoutItems;
  }

  async openCommand(id, { state, activeDataset, activeModel, lang, queryFn, settings = {} } = {}) {
    if (lang) this.setLanguage(lang);
    const mergedSettings = { ...this._settings, ...settings };
    const t = i18n.t;
    const spec = this.getSpec(id);
    const title = this.getTitle(id);

    if (!spec) {
      return { kind: 'error', error: `Unknown R Commander command: ${id}` };
    }
    if (spec.url) {
      return { kind: 'url', url: spec.url, title };
    }
    if (spec.vscode) {
      return { kind: 'editorAction', action: spec.vscode, args: spec.args || [], title, id };
    }
    if (spec.run) {
      return { kind: 'reportAction', id, title };
    }
    if (spec.select) {
      return { kind: 'select', target: spec.select, title };
    }
    if (spec.refresh) {
      return { kind: 'refresh', title };
    }

    const needsDataset = spec.ds !== false;
    const dsNames = Object.keys(state?.datasets || {});
    let ds = activeDataset;
    if (needsDataset) {
      if (!dsNames.length) {
        return {
          kind: 'warning',
          message: t('There is no data set in the R session. Use Data > Load data set, Import data or New data set first.')
        };
      }
      if (!ds || !dsNames.includes(ds)) {
        ds = dsNames[0];
      }
    }

    // Intercept View / Edit dataset directly into Studio's Interactive Table Viewer!
    if (id === 'viewDataSet' || id === 'viewData') {
      return { kind: 'viewTable', name: ds, editable: false, title: ds };
    }
    if (id === 'editDataSet') {
      return { kind: 'viewTable', name: ds, editable: true, title: ds };
    }

    let model = activeModel;
    if (spec.needsModel) {
      const models = state?.models || [];
      if (!models.length) {
        return {
          kind: 'warning',
          message: t('There is no model in the R session. Fit one first (Statistics > Fit models).')
        };
      }
      if (!model || !models.some((m) => m.name === model)) {
        model = models[0].name;
      }
    }

    const ctx = makeCtx(ds, { state, activeModel: model, settings: mergedSettings });
    const fields = spec.fields || [];

    if (!fields.length || spec.noForm?.(ctx)) {
      const values = {};
      if (spec.after) {
        const ui = this._makeUiAdapter({ ctx, queryFn, t });
        const ok = await spec.after(values, ui, ctx);
        if (ok === false) return { kind: 'cancelled' };
      }
      const code = spec.code ? spec.code(values, ctx) : '';
      return {
        kind: 'direct',
        id,
        title,
        code,
        pkgs: spec.pkgs || [],
        activeDataset: spec.activeDataset?.(values) || null,
        activeModel: spec.activeModel?.(values) || null,
        detectNew: Boolean(spec.detectNew)
      };
    }

    const extra = {};
    for (const field of fields.filter((f) => f.type === 'table' && f.colsExpr)) {
      extra[field.k] = queryFn ? (await queryFn(field.colsExpr(ctx))) || [] : [];
    }
    for (const field of fields.filter((f) => f.type === 'installed' || f.type === 'rlist')) {
      if (field.type === 'rlist' && field.of) continue;
      if (field.type === 'rlist') {
        const lines = queryFn ? (await queryFn(field.expr(ctx), field.timeout || 25000)) || [] : [];
        extra[field.k] = lines;
        if (!lines.length && field.emptyMessage && field.emptyStops) {
          return { kind: 'warning', message: t(field.emptyMessage) };
        }
      } else {
        const all = queryFn ? (await queryFn('sort(.packages(all.available = TRUE))')) || [] : [];
        extra[field.k] = all.filter((n) => !field.filter || new RegExp(field.filter).test(n));
      }
    }

    const env = {
      t,
      state,
      vars: state?.datasets?.[ds]?.vars,
      activeModel: model,
      ctx,
      extra,
      dataset: ds,
      settings: mergedSettings
    };

    const sessionId = crypto.randomBytes(8).toString('hex');
    const session = {
      sessionId,
      id,
      title,
      spec,
      env,
      needsDataset,
      rowsCache: new Map(),
      listCache: new Map(),
      lastFor: {}
    };
    this._sessions.set(sessionId, session);

    const rawValues = formmodel.initial(fields, env);
    const layoutItems = await this._enrichLayout(session, formmodel.layout(fields, rawValues, env), queryFn);

    const datasets =
      needsDataset && state && dsNames.length > 0
        ? Object.values(state.datasets).map((d) => ({
            name: d.name,
            description: `${d.rows} × ${d.columns}`
          }))
        : [];
    const subtitle = [ds && `${t('Data set')}: ${ds}`, model && `${t('Model')}: ${model}`]
      .filter(Boolean)
      .join('   ·   ');

    return {
      kind: 'form',
      sessionId,
      id,
      title,
      subtitle,
      dataset: ds,
      datasets,
      fields: describeFields(fields, env),
      values: rawValues,
      layout: layoutItems,
      strings: {
        run: this._language === 'es' ? 'Ejecutar' : 'Run',
        insert: this._language === 'es' ? 'Insertar en script' : 'Insert in Script',
        runAndInsert: this._language === 'es' ? 'Ejecutar e insertar' : 'Run & Insert',
        cancel: t('Cancel'),
        reset: t('Reset'),
        browse: t('Browse...'),
        none: t('(none)'),
        filter: t('Type to filter...'),
        levels: t('Levels'),
        newOrder: t('New order'),
        oldLevels: t('Old levels'),
        newName: t('New name'),
        oldName: t('Old name'),
        freeHint: t('R did not answer; type variable names separated by commas'),
        dataset: t('Data set')
      }
    };
  }

  async updateLayout(sessionId, { rawValues, dirty = {}, queryFn } = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error('Dialog session expired');
    const fields = session.spec.fields || [];
    const rawLayout = formmodel.layout(fields, rawValues, session.env, dirty);
    const layout = await this._enrichLayout(session, rawLayout, queryFn);
    return { layout };
  }

  async switchDataset(sessionId, datasetName, { queryFn } = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error('Dialog session expired');
    const { env, spec } = session;
    const dsObj = env.state?.datasets?.[datasetName];
    if (!dsObj) throw new Error(`Dataset not found: ${datasetName}`);

    env.dataset = datasetName;
    env.vars = dsObj.vars;
    env.ctx = makeCtx(datasetName, {
      state: env.state,
      activeModel: env.activeModel,
      settings: env.settings
    });
    session.rowsCache.clear();
    session.listCache.clear();
    session.lastFor = {};

    const fields = spec.fields || [];
    const rawValues = formmodel.initial(fields, env);
    const layout = await this._enrichLayout(session, formmodel.layout(fields, rawValues, env), queryFn);
    const subtitle = [
      `${env.t('Data set')}: ${datasetName}`,
      env.activeModel && `${env.t('Model')}: ${env.activeModel}`
    ]
      .filter(Boolean)
      .join('   ·   ');

    return {
      dataset: datasetName,
      subtitle,
      fields: describeFields(fields, env),
      values: rawValues,
      layout
    };
  }

  async resetDialog(sessionId, { queryFn } = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error('Dialog session expired');
    const fields = session.spec.fields || [];
    const rawValues = formmodel.initial(fields, session.env);
    const layout = await this._enrichLayout(session, formmodel.layout(fields, rawValues, session.env), queryFn);
    return { values: rawValues, layout };
  }

  _makeUiAdapter({ ctx, queryFn, t, filePicker }) {
    return {
      ctx,
      t,
      query: (expr, timeout) => (queryFn ? queryFn(expr, timeout) : Promise.resolve([])),
      file: (field, label) => (filePicker ? filePicker(field, label) : Promise.resolve(undefined)),
      dir: (field, label) => (filePicker ? filePicker({ ...field, type: 'dir' }, label) : Promise.resolve(undefined)),
      pick: async (_label, items, many) => (many ? items.slice(0, 1) : items[0]?.value ?? items[0]?.label ?? items[0]),
      text: async ({ def }) => (def !== undefined ? String(def) : '')
    };
  }

  async submitDialog(sessionId, { rawValues, queryFn, filePicker } = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error('Dialog session expired');
    const { spec, env, title, id } = session;
    const fields = spec.fields || [];

    const errors = formmodel.validate(fields, rawValues, env);
    if (Object.keys(errors).length) {
      return { ok: false, errors };
    }

    const values = formmodel.normalize(fields, rawValues);
    const problem = spec.check?.(values);
    if (problem) {
      return { ok: false, errors: { __form: env.t(problem) } };
    }

    if (spec.after) {
      const ui = this._makeUiAdapter({ ctx: env.ctx, queryFn, t: env.t, filePicker });
      const ok = await spec.after(values, ui, env.ctx);
      if (ok === false) {
        return { ok: false, cancelled: true };
      }
    }

    const code = spec.code ? spec.code(values, env.ctx) : '';
    if (!code) {
      return {
        ok: false,
        errors: { __form: spec.emptyMessage ? env.t(spec.emptyMessage) : env.t('No code generated.') }
      };
    }

    // Apply side effects like saving CRAN mirror / package download folder
    if (spec.apply) {
      await spec.apply(values, {
        updateSetting: (k, v) => this.updateSettings({ [k]: v })
      });
    }

    return {
      ok: true,
      id,
      title,
      code,
      pkgs: spec.pkgs || [],
      dataset: env.dataset || null,
      activeDataset: spec.activeDataset?.(values) || null,
      activeModel: spec.activeModel?.(values) || null,
      detectNew: Boolean(spec.detectNew),
      settings: { ...this._settings }
    };
  }

  closeDialog(sessionId) {
    this._sessions.delete(sessionId);
  }
}

module.exports = {
  RcmdrService,
  catalog,
  commands,
  tree,
  functionsMap,
  formmodel,
  i18n,
  report,
  STATE_FIELDS
};
