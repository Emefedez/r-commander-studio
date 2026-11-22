'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RcmdrService, catalog, commands, tree, formmodel, i18n, report } = require('../main/rcmdr-service');

const MOCK_STATE = {
  objects: ['mtcars', 'iris', 'LinearModel.1'],
  datasets: {
    mtcars: {
      name: 'mtcars',
      rows: 32,
      columns: 11,
      vars: [
        { name: 'mpg', kind: 'numeric', levels: 0, discrete: false },
        { name: 'wt', kind: 'numeric', levels: 0, discrete: false },
        { name: 'am', kind: 'factor', levels: 2, discrete: false },
        { name: 'cyl', kind: 'factor', levels: 3, discrete: false }
      ]
    }
  },
  models: [{ name: 'LinearModel.1', cls: 'lm' }],
  hclusts: []
};

test('vendor/rcmdr loads all 371 commands cleanly without vscode', () => {
  const commandIds = Object.keys(commands);
  assert.equal(commandIds.length, 371, `expected 371 commands, got ${commandIds.length}`);
  assert.ok(Array.isArray(tree) && tree.length > 5, 'tree.json should contain top-level menus');

  const missing = commandIds.filter((id) => !catalog[commands[id].target || id]);
  assert.deepEqual(missing, [], `missing catalog implementations: ${missing.join(', ')}`);

  const service = new RcmdrService();
  const summary = service.getCatalogSummary();
  assert.equal(summary.count, 371);
  assert.ok(summary.menus.length >= 8);
  assert.equal(summary.commands.length, 371);
});

test('i18n translates between English and Spanish cleanly', () => {
  i18n.setLanguage('en');
  assert.equal(i18n.t('Data set'), 'Data set');
  i18n.setLanguage('es');
  assert.notEqual(i18n.t('Data set'), 'Data set');
  i18n.setLanguage('en');
});

test('RcmdrService dialog lifecycle: open, validate, layout, and generate R code', async () => {
  const service = new RcmdrService();

  // Histogram on mtcars$mpg
  const opened = await service.openCommand('Histogram', {
    state: MOCK_STATE,
    activeDataset: 'mtcars',
    lang: 'en'
  });
  assert.equal(opened.kind, 'form');
  assert.ok(opened.sessionId);
  assert.ok(opened.fields.length > 0);

  // Submitting without picking a variable fails validation
  const invalid = await service.submitDialog(opened.sessionId, { rawValues: opened.values });
  assert.equal(invalid.ok, false);
  assert.ok(Object.keys(invalid.errors).length > 0);

  // Pick numeric variable mpg and update layout
  const updatedRaw = { ...opened.values, x: 'mpg' };
  const layoutRes = await service.updateLayout(opened.sessionId, { rawValues: updatedRaw });
  assert.ok(Array.isArray(layoutRes.layout));

  // Submit valid dialog and verify generated R code
  const submitted = await service.submitDialog(opened.sessionId, { rawValues: updatedRaw });
  assert.equal(submitted.ok, true);
  assert.match(submitted.code, /Hist\(/);
  assert.match(submitted.code, /with\(mtcars,\s*Hist\(mpg/);

  service.closeDialog(opened.sessionId);
});

test('RcmdrService handles formula-based linearModel dialog and formmodel validation', async () => {
  const service = new RcmdrService();
  const opened = await service.openCommand('linearModel', {
    state: MOCK_STATE,
    activeDataset: 'mtcars',
    lang: 'en'
  });
  assert.equal(opened.kind, 'form');
  assert.ok(opened.fields.some((f) => f.type === 'formula'));

  const values = {
    ...opened.values,
    name: 'LinearModel.2',
    formula: { lhs: 'mpg', rhs: 'wt + cyl' }
  };
  const submitted = await service.submitDialog(opened.sessionId, { rawValues: values });
  assert.equal(submitted.ok, true, JSON.stringify(submitted.errors));
  assert.match(submitted.code, /lm\(/);
  assert.match(submitted.code, /mpg\s*~\s*wt \+ cyl/);
  assert.match(submitted.code, /data\s*=\s*mtcars/);

  service.closeDialog(opened.sessionId);
});

test('formmodel rank and report Rmd helpers work standalone', () => {
  assert.equal(formmodel.rank([[1, 0], [0, 1]]), 2);
  assert.equal(formmodel.rank([[1, 2], [2, 4]]), 1);

  const tpl = report.template('rmd');
  assert.match(tpl, /^---/);
  const appended = report.append('rmd', tpl, 'Summary', 'summary(mtcars)');
  assert.match(appended, /### Summary/);
  assert.match(appended, /```\{r\}\nsummary\(mtcars\)\n```/);
  const trimmed = report.removeLastBlock('rmd', appended);
  assert.doesNotMatch(trimmed, /summary\(mtcars\)/);
});
