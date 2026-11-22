'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dict = require('../shared/i18n-dict');
const themes = require('../shared/themes');
const { FileGroupsModel } = require('../shared/file-groups-model');
const { WorkbenchLayoutModel } = require('../shared/workbench-layout');
const { RcmdrService, commands } = require('../main/rcmdr-service');
const fsService = require('../main/fs-service');

test('EN and ES i18n dictionaries have 100% key parity and non-empty strings', () => {
  const enKeys = Object.keys(dict.en).sort();
  const esKeys = Object.keys(dict.es).sort();

  const missingInEs = enKeys.filter((k) => !(k in dict.es));
  const missingInEn = esKeys.filter((k) => !(k in dict.en));
  assert.deepEqual(missingInEs, [], `Missing ES keys: ${missingInEs.join(', ')}`);
  assert.deepEqual(missingInEn, [], `Missing EN keys: ${missingInEn.join(', ')}`);

  for (const k of enKeys) {
    assert.equal(typeof dict.en[k], 'string');
    assert.ok(dict.en[k].trim().length > 0, `Empty EN string for ${k}`);
    assert.equal(typeof dict.es[k], 'string');
    assert.ok(dict.es[k].trim().length > 0, `Empty ES string for ${k}`);
  }
});

test('Renderer UI files contain ZERO emojis or Unicode pictographs', () => {
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const files = fs
    .readdirSync(rendererDir)
    .filter((f) => /\.(html|js|css)$/.test(f))
    .map((f) => path.join(rendererDir, f));

  // Detect standard emojis, pictographs, and symbol pictograms (play/stop/gear/etc.)
  const forbiddenRe = /[\p{Extended_Pictographic}\u25B6\u25A0\u25B7\u2699\u2318\u229E\u229F\u25EB\u270F]/u;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const match = content.match(forbiddenRe);
    assert.equal(
      match,
      null,
      `Found forbidden emoji/pictograph ${match ? JSON.stringify(match[0]) : ''} in ${path.basename(file)}`
    );
  }
});

test('All 371 R Commander commands are reachable via tree & bilingual search, and MenuHover works in EN/ES', () => {
  const svc = new RcmdrService();
  const treeIds = svc.getAllTreeCommandIds();
  const commandIds = Object.keys(commands);
  const unreachable = commandIds.filter((id) => !treeIds.has(id));
  assert.deepEqual(unreachable, [], `Unreachable commands from tree.json: ${unreachable.join(', ')}`);

  // Bilingual accent-insensitive search
  const esRes = svc.searchCommands('diagrama de caja', 'es');
  assert.ok(esRes.length > 0, 'expected Spanish search hit for diagrama de caja');
  const enRes = svc.searchCommands('histogram', 'en');
  assert.ok(enRes.length > 0, 'expected English search hit for histogram');

  // MenuHover parity (lm, t.test, Hist)
  const lmEn = svc.getMenuHover('lm', 'en');
  assert.ok(lmEn && lmEn.entries.length > 0, 'expected MenuHover for lm');
  const lmEs = svc.getMenuHover('lm', 'es');
  assert.ok(lmEs && lmEs.entries.length > 0);
  assert.notEqual(lmEn.entries[0].path, lmEs.entries[0].path);

  const ttest = svc.getMenuHover('stats::t.test', 'en');
  assert.ok(ttest && ttest.entries.length > 0, 'expected MenuHover for stats::t.test');
});

test('FileGroupsModel supports creating, renaming, collapsing, assigning, partitioning, and serializing groups', () => {
  const model = new FileGroupsModel();
  const g1 = model.createGroup('Data Prep');
  const g2 = model.createGroup('Models');
  assert.ok(g1 && g2);

  assert.equal(model.renameGroup(g1.id, 'Cleaning'), true);
  assert.equal(model.assignItem('a.R', g1.id), true);
  assert.equal(model.assignItem('b.Rmd', g2.id), true);
  assert.equal(model.toggleCollapsed(g2.id), true);

  const items = [{ id: 'a.R' }, { id: 'b.Rmd' }, { id: 'c.R' }];
  const part = model.partition(items, (x) => x.id);
  assert.equal(part.groups.length, 2);
  assert.equal(part.groups[0].name, 'Cleaning');
  assert.deepEqual(part.groups[0].items.map((x) => x.id), ['a.R']);
  assert.equal(part.groups[1].collapsed, true);
  assert.deepEqual(part.ungrouped.map((x) => x.id), ['c.R']);

  // Round-trip serialization
  const restored = new FileGroupsModel(model.serialize());
  assert.equal(restored.getGroupIdFor('a.R'), g1.id);
  assert.equal(restored.deleteGroup(g1.id), true);
  assert.equal(restored.getGroupIdFor('a.R'), null);
});

test('WorkbenchLayoutModel supports all 4 sidebar dock combinations, independent collapse, and panel H/V orientation', () => {
  const layout = new WorkbenchLayoutModel();

  // Default: explorer left, rcmdr right, panel bottom horizontal
  assert.deepEqual(layout.getSidebarsOn('left'), ['explorer']);
  assert.deepEqual(layout.getSidebarsOn('right'), ['rcmdr']);
  assert.equal(layout.panel.dock, 'bottom');
  assert.equal(layout.panel.orientation, 'horizontal');

  // All 4 presets
  layout.applyPreset('both-left');
  assert.deepEqual(layout.getSidebarsOn('left'), ['explorer', 'rcmdr']);
  assert.deepEqual(layout.getSidebarsOn('right'), []);

  layout.applyPreset('both-right');
  assert.deepEqual(layout.getSidebarsOn('left'), []);
  assert.deepEqual(layout.getSidebarsOn('right'), ['explorer', 'rcmdr']);

  layout.applyPreset('rcmdr-left-explorer-right');
  assert.deepEqual(layout.getSidebarsOn('left'), ['rcmdr']);
  assert.deepEqual(layout.getSidebarsOn('right'), ['explorer']);

  layout.applyPreset('explorer-left-rcmdr-right');
  assert.deepEqual(layout.getSidebarsOn('left'), ['explorer']);
  assert.deepEqual(layout.getSidebarsOn('right'), ['rcmdr']);

  // Independent collapse + Hover-to-Peek state transitions
  layout.toggleSidebar('explorer');
  assert.deepEqual(layout.getSidebarsOn('left'), []);
  assert.deepEqual(layout.getSidebarsOn('right'), ['rcmdr']);

  assert.equal(layout.openPeek('explorer'), true);
  assert.equal(layout.isPeeking('explorer'), true);
  assert.equal(layout.onSelectionInSidebar('explorer'), true);
  assert.equal(layout.isPeeking('explorer'), false);

  // Panel dock switches default orientation + supports manual override
  layout.setPanelDock('right');
  assert.equal(layout.panel.dock, 'right');
  assert.equal(layout.panel.orientation, 'vertical');

  layout.togglePanelOrientation();
  assert.equal(layout.panel.orientation, 'horizontal');

  layout.setPanelDock('left');
  assert.equal(layout.panel.dock, 'left');
  assert.equal(layout.panel.orientation, 'vertical');

  // Round-trip serialization
  const restored = new WorkbenchLayoutModel(layout.serialize());
  assert.deepEqual(restored.serialize(), layout.serialize());
});

test('fs-service parses/serializes RFC-4180 CSV and renders Markdown tables', () => {
  const csv = 'name,val,note\n"Alice, A.",10,"says ""hi"""\nBob,20,ok\n';
  const parsed = fsService.parseDelimited(csv, ',');
  assert.deepEqual(parsed.columns, ['name', 'val', 'note']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0][0], 'Alice, A.');
  assert.equal(parsed.rows[0][2], 'says "hi"');

  const roundTrip = fsService.serializeDelimited(parsed.columns, parsed.rows, ',');
  const reparsed = fsService.parseDelimited(roundTrip, ',');
  assert.deepEqual(reparsed, parsed);

  const md = fsService.toMarkdownTable(parsed.columns, parsed.rows);
  assert.match(md, /^\| name \| val \| note \|/);
  assert.match(md, /\| Bob \| 20 \| ok \|/);
});

test('StudioThemes exposes 8 built-in dark & light presets with valid hex tokens and live overrides', () => {
  const list = themes.listPresets();
  assert.equal(list.length, 8);
  assert.ok(list.filter((p) => !p.isLight).length >= 5);
  assert.ok(list.filter((p) => p.isLight).length >= 3);

  for (const preset of list) {
    for (const def of themes.THEME_TOKEN_KEYS) {
      assert.match(preset.tokens[def.key], /^#[0-9a-fA-F]{6}$/, `${preset.id}.${def.key}`);
    }
  }

  const custom = themes.resolveTheme('dracula', { bgEditor: '#111218', accent: '#00FFAA' });
  assert.equal(custom.tokens.bgEditor, '#111218');
  assert.equal(custom.tokens.accent, '#00FFAA');
  assert.equal(custom.tokens.bgSidebar, '#21222C');
});
