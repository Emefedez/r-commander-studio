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

  // Bilingual accent-insensitive search & cross-language + R function search
  const esRes = svc.searchCommands('diagrama de caja', 'es');
  assert.ok(esRes.length > 0, 'expected Spanish search hit for diagrama de caja');
  const enRes = svc.searchCommands('histogram', 'en');
  assert.ok(enRes.length > 0, 'expected English search hit for histogram');

  // Cross-language search: search Spanish query while active language is English, and English query while active language is Spanish
  const esQueryInEn = svc.searchCommands('regresion lineal', 'en');
  assert.ok(esQueryInEn.length > 0, 'expected Spanish query "regresion lineal" to work when lang=en');
  const enQueryInEs = svc.searchCommands('linear regression', 'es');
  assert.ok(enQueryInEs.length > 0, 'expected English query "linear regression" to work when lang=es');
  assert.equal(esQueryInEn[0].id, enQueryInEs[0].id);

  // R function name search: search "t.test" or "shapiro.test" regardless of active language
  const fnSearchEs = svc.searchCommands('shapiro.test', 'es');
  const fnSearchEn = svc.searchCommands('shapiro.test', 'en');
  assert.ok(fnSearchEs.length > 0 && fnSearchEn.length > 0, 'expected R function search "shapiro.test" to find normality test');
  assert.equal(fnSearchEs[0].id, fnSearchEn[0].id);

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

test('Auto-updater parses versions, picks platform assets, and verifies SHA256SUMS', () => {
  const updater = require('../main/updater');
  assert.equal(updater.newer('v0.2.0', '0.1.0'), true);
  assert.equal(updater.newer('0.1.0', '0.1.0'), false);
  assert.equal(updater.newer('0.1.1', '0.1.0-beta.1'), true);

  const rel = updater.latestRelease([
    { tag_name: 'v0.1.0', draft: false, assets: [] },
    { tag_name: 'v0.2.0', draft: false, assets: [
      { name: 'R Commander Studio-0.2.0-linux-arm64.AppImage' },
      { name: 'R Commander Studio-0.2.0-linux-x86_64.AppImage' },
      { name: 'R Commander Studio-0.2.0-win-x64-setup.exe' },
      { name: 'R Commander Studio-0.2.0-mac-arm64.dmg' }
    ] }
  ]);
  assert.equal(rel.tag_name, 'v0.2.0');
  assert.equal(updater.pickAsset(rel, 'linux', 'arm64').name, 'R Commander Studio-0.2.0-linux-arm64.AppImage');
  assert.equal(updater.pickAsset(rel, 'linux', 'x64').name, 'R Commander Studio-0.2.0-linux-x86_64.AppImage');
  assert.equal(updater.pickAsset(rel, 'win32', 'x64').name, 'R Commander Studio-0.2.0-win-x64-setup.exe');
  assert.equal(updater.pickAsset(rel, 'darwin', 'arm64').name, 'R Commander Studio-0.2.0-mac-arm64.dmg');

  const sums = updater.parseSums(`${'a'.repeat(64)}  R Commander Studio-0.2.0-linux-arm64.AppImage\n`);
  assert.equal(sums.get('R Commander Studio-0.2.0-linux-arm64.AppImage'), 'a'.repeat(64));
});

test('Linux desktop integration builds valid .desktop entry and MIME XML', async () => {
  const linuxInt = require('../main/linux-integration');
  const entry = linuxInt.buildDesktopEntry({ execPath: '/home/user/.local/bin/r-commander-studio' });
  assert.match(entry, /Name=R Commander Studio/);
  assert.match(entry, /MimeType=text\/x-r-source;text\/x-rmarkdown;/);
  const xml = linuxInt.buildMimeXml();
  assert.match(xml, /glob pattern="\*\.Rmd"/);
  assert.match(xml, /glob pattern="\*\.RData"/);
});

test('ArfTerminal sanitizePtyOutput strips DEC save/restore cursor escapes (\\x1b7 and \\x1b8) and DSR queries', () => {
  const { sanitizePtyOutput } = require('../main/arf-terminal');
  const raw = '\x1b7\x1b[6n\x1b8\x1b[32mR 4.5.2>\x1b[0m [1] 2\r\n';
  const clean = sanitizePtyOutput(raw);
  assert.equal(clean.includes('\x1b7'), false);
  assert.equal(clean.includes('\x1b8'), false);
  assert.equal(clean.includes('\x1b[6n'), false);
  assert.match(clean, /\x1b\[32mR 4\.5\.2>\x1b\[0m \[1\] 2\n/);
});

test('T3CodeService probes status and provides R Copilot fixes and explanations', async () => {
  const { T3CodeService } = require('../main/t3code-service');
  const svc = new T3CodeService();
  const status = await svc.getStatus();
  assert.equal(status.ok, true);
  assert.equal(typeof status.t3Running, 'boolean');

  const fixRes = await svc._localRExpertFallback({
    mode: 'inline-fix',
    prompt: 'Fix warnings',
    selection: 'if (x == NA) y <- T',
    language: 'r',
    activeDataset: 'mtcars',
    lang: 'es'
  });
  assert.equal(fixRes.ok, true);
  assert.match(fixRes.code, /is\.na\(x\)/);
  assert.match(fixRes.code, /TRUE/);
});

test('workbench layout: placeSidebar docks and orders sidebars, and survives a save/load', () => {
  const layout = new WorkbenchLayoutModel();
  layout.placeSidebar('rcmdr', 'left', 'explorer');
  assert.deepEqual(layout.getSidebarsOn('left'), ['rcmdr', 'explorer']);
  layout.placeSidebar('rcmdr', 'left', null);
  assert.deepEqual(layout.getSidebarsOn('left'), ['explorer', 'rcmdr']);
  layout.placeSidebar('explorer', 'right', 'start');
  assert.deepEqual(layout.getSidebarsOn('right'), ['explorer']);
  assert.deepEqual(layout.getSidebarsOn('left'), ['rcmdr']);
  const restored = new WorkbenchLayoutModel(JSON.parse(JSON.stringify(layout.serialize())));
  assert.deepEqual(restored.sidebarOrder, layout.sidebarOrder);
  assert.equal(restored.sidebars.explorer.dock, 'right');
});

test('Auto-updater replaces the running AppImage in place (any file name, verified checksum)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const updater = require('../main/updater');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-upd-'));
  const appImage = path.join(dir, 'my-renamed.AppImage');
  fs.writeFileSync(appImage, 'old build', { mode: 0o755 });

  // A renamed AppImage is still ours when our executable runs from its mount (APPDIR).
  assert.equal(updater.resolveAppImage({ APPIMAGE: appImage, APPDIR: '/tmp/.mount_abc' }, '/tmp/.mount_abc/r-commander-studio'), appImage);
  assert.equal(updater.resolveAppImage({ APPIMAGE: appImage, APPDIR: '/tmp/.mount_abc' }, '/usr/bin/other'), '');
  assert.equal(updater.resolveAppImage({}, '/x'), '');

  // GitHub renames spaces to dots in asset names; SHA256SUMS.txt keeps the spaces.
  const sums = updater.parseSums('aa'.repeat(32) + '  R Commander Studio-0.2.0-linux-x86_64.AppImage\n');
  assert.equal(updater.expectedSum(sums, 'R.Commander.Studio-0.2.0-linux-x86_64.AppImage'), 'aa'.repeat(32));

  const payload = Buffer.from('new build 0.2.0');
  const sum = createHash('sha256').update(payload).digest('hex');
  const asset = 'R.Commander.Studio-0.2.0-linux-x86_64.AppImage';
  const release = {
    tag_name: 'v0.2.0',
    html_url: 'https://example.invalid/r',
    assets: [
      { name: asset, browser_download_url: 'https://dl/app', size: payload.length },
      { name: 'SHA256SUMS.txt', browser_download_url: 'https://dl/sums' }
    ]
  };
  const fakeFetch = async (url) => {
    if (url.includes('api.github.com')) return { ok: true, json: async () => [release] };
    if (url === 'https://dl/sums') return { ok: true, text: async () => `${sum}  R Commander Studio-0.2.0-linux-x86_64.AppImage\n` };
    if (url === 'https://dl/app') {
      return {
        ok: true,
        headers: { get: () => String(payload.length) },
        body: (async function* () { yield payload.subarray(0, 5); yield payload.subarray(5); })()
      };
    }
    throw new Error('unexpected ' + url);
  };
  const u = updater.createUpdater({
    app: { getVersion: () => '0.1.9', getPath: () => dir },
    fetch: fakeFetch,
    stateFile: path.join(dir, 'state.json'),
    appImage,
    platform: 'linux',
    arch: 'x64'
  });
  const info = await u.check({ manual: true });
  assert.equal(info.install, 'appimage');
  const seen = [];
  const res = await u.install((p) => seen.push(p));
  assert.equal(res.version, '0.2.0');
  assert.equal(fs.readFileSync(appImage, 'utf8'), 'new build 0.2.0');
  assert.equal(fs.readFileSync(appImage + '.previous', 'utf8'), 'old build');
  assert.ok(fs.statSync(appImage).mode & 0o100);
  assert.equal(seen.at(-1), 1);

  // A tampered download is rejected and the current AppImage is left untouched.
  fs.writeFileSync(appImage, 'current', { mode: 0o755 });
  const bad = updater.createUpdater({
    app: { getVersion: () => '0.1.9', getPath: () => dir },
    fetch: async (url) => (url === 'https://dl/sums' ? { ok: true, text: async () => `${'0'.repeat(64)}  R Commander Studio-0.2.0-linux-x86_64.AppImage\n` } : fakeFetch(url)),
    stateFile: path.join(dir, 'state2.json'),
    appImage,
    platform: 'linux',
    arch: 'x64'
  });
  await bad.check({ manual: true });
  await assert.rejects(() => bad.install(), /checksum/);
  assert.equal(fs.readFileSync(appImage, 'utf8'), 'current');
  assert.equal(fs.existsSync(appImage + '.download'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Auto-updater recognises the AppImage under the dotted name GitHub gives it', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-name-'));
  const file = path.join(dir, 'R.Commander.Studio-0.1.9-linux-x86_64.AppImage');
  fs.writeFileSync(file, 'x');
  assert.equal(require('../main/updater').resolveAppImage({ APPIMAGE: file }, '/elsewhere'), file);
  fs.rmSync(dir, { recursive: true, force: true });
});
