'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const vendorRoot = path.join(__dirname, '..', 'vendor', 'rcmdr');
const catalog = require(path.join(vendorRoot, 'catalog'));
const commands = require(path.join(vendorRoot, 'data', 'commands.json'));
const tree = require(path.join(vendorRoot, 'data', 'tree.json'));
const formmodel = require(path.join(vendorRoot, 'lib', 'formmodel.js'));
const { context } = require(path.join(vendorRoot, 'lib', 'rhelpers.js'));
const i18n = require(path.join(vendorRoot, 'lib', 'i18n.js'));
const report = require(path.join(vendorRoot, 'lib', 'report.js'));

const STATE_FIELDS = new Set(['dataset', 'model', 'models', 'hclust']);

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
    this._language = 'en';
  }

  setLanguage(lang) {
    this._language = lang === 'es' ? 'es' : 'en';
    i18n.setLanguage(this._language);
    return this._language;
  }

  getLanguage() {
    return this._language;
  }

  getTree(lang) {
    if (lang) this.setLanguage(lang);
    return tree;
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
          item.set = field.selectAll ? item.items.map((i) => i.value) : item.items.slice(0, 1).map((i) => i.value);
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

    const ctx = makeCtx(ds, { state, activeModel: model, settings });
    const fields = spec.fields || [];

    // Zero-field commands execute/insert immediately
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
      settings
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
        run: t('Run'),
        insert: t('Insert in Script'),
        runAndInsert: t('Run & Insert'),
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

    return {
      ok: true,
      id,
      title,
      code,
      pkgs: spec.pkgs || [],
      dataset: env.dataset || null,
      activeDataset: spec.activeDataset?.(values) || null,
      activeModel: spec.activeModel?.(values) || null,
      detectNew: Boolean(spec.detectNew)
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
  formmodel,
  i18n,
  report,
  STATE_FIELDS
};
