'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');

const { RRuntime } = require('./r-runtime');
const { ArfTerminal } = require('./arf-terminal');
const { RLanguageServer } = require('./r-lsp');
const { RcmdrService, report } = require('./rcmdr-service');
const { NoteCompleteBridge } = require('./bridge');
const { createUpdater } = require('./updater');
const { integrateLinuxDesktop } = require('./linux-integration');
const { T3CodeService } = require('./t3code-service');
const fsService = require('./fs-service');
const rnoteService = require('./rnote-service');
const mainI18n = require('./i18n');

let mainWindow = null;
let runtime = null;
let arf = null;
let lsp = null;
let rcmdr = null;
let bridge = null;
let appUpdater = null;
let t3code = null;
let lastSnapshot = { datasets: {}, models: [], hclusts: [], objects: [] };
let rendererReady = false;
const pendingOpenPaths = [];

function extractCliTargets(argv, cwd = process.cwd()) {
  const results = [];
  const startIdx = app.isPackaged ? 1 : 2;
  for (const raw of (argv || []).slice(startIdx)) {
    if (!raw || raw.startsWith('-')) continue;
    const resolved = path.resolve(cwd, raw);
    if (!fs.existsSync(resolved)) continue;
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) results.push({ folderPath: resolved });
      else if (stat.isFile()) results.push({ filePath: resolved });
    } catch {
      // ignore
    }
  }
  return results;
}

function dispatchOpenPath(target) {
  if (!target || (!target.filePath && !target.folderPath)) return;
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    sendToRenderer('bridge:openPath', target);
    focusMainWindow();
  } else {
    pendingOpenPaths.push(target);
  }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function uiZoomStep(input) {
  if (!(input.control || input.meta) || !input.shift || input.alt) return null;
  if (input.key === '_' || input.key === '-' || input.code === 'Minus' || input.code === 'Slash' || input.code === 'NumpadSubtract') return -1;
  if (
    input.key === '+' ||
    input.key === '*' ||
    input.key === ']' ||
    (input.key === '=' && input.code !== 'Digit0') ||
    input.code === 'Equal' ||
    input.code === 'BracketRight' ||
    input.code === 'NumpadAdd'
  ) {
    return 1;
  }
  if (input.key === '0' || input.key === ')' || input.code === 'Digit0' || input.code === 'Numpad0') return 0;
  return null;
}

function editorZoomStep(input) {
  if (!(input.control || input.meta) || input.shift || input.alt) return null;
  if (input.key === '-' || input.key === '_' || input.code === 'Minus' || input.code === 'Slash' || input.code === 'NumpadSubtract') return -1;
  if (
    input.key === '+' ||
    input.key === '=' ||
    input.key === '*' ||
    input.code === 'Equal' ||
    input.code === 'BracketRight' ||
    input.code === 'NumpadAdd'
  ) {
    return 1;
  }
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') return 0;
  return null;
}
function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Converts a vendor/rcmdr tree.json node into an Electron native submenu item
 * so native OS menus (e.g. macOS top bar) stay 100% in sync with the in-window bilingual menu bar.
 */
function rcmdrNodesToElectronMenu(nodes, lang) {
  const out = [];
  for (const node of nodes || []) {
    if (node.sep) {
      out.push({ type: 'separator' });
      continue;
    }
    const label = node.label?.[lang] || node.label?.en || node.id || '';
    if (node.children) {
      out.push({
        label,
        submenu: rcmdrNodesToElectronMenu(node.children, lang)
      });
    } else if (node.id) {
      out.push({
        label,
        click: () => sendToRenderer('menu:rcmdr', node.id)
      });
    }
  }
  return out;
}

function buildAppMenu(lang = mainI18n.getLang()) {
  mainI18n.setLang(lang);
  const t = mainI18n.t;
  const rcmdrTree = rcmdr ? rcmdr.getTree(lang) : [];
  const rcmdrMenuByEn = new Map();
  for (const node of rcmdrTree) {
    if (!node.sep && node.children && node.label?.en) {
      rcmdrMenuByEn.set(node.label.en, node);
    }
  }

  const rcmdrSub = (enName) => {
    const node = rcmdrMenuByEn.get(enName);
    return node ? rcmdrNodesToElectronMenu(node.children, lang) : [];
  };

  const template = [
    {
      label: t('menuFile'),
      submenu: [
        { label: t('newRScript'), accelerator: 'CmdOrCtrl+N', click: () => sendToRenderer('menu:command', 'new-r') },
        { label: t('newTabTitle'), accelerator: 'CmdOrCtrl+T', click: () => sendToRenderer('menu:command', 'new-r') },
        { label: t('newRmdDoc'), accelerator: 'CmdOrCtrl+Shift+N', click: () => sendToRenderer('menu:command', 'new-rmd') },
        { type: 'separator' },
        { label: t('openFile'), accelerator: 'CmdOrCtrl+O', click: () => sendToRenderer('menu:command', 'open') },
        { label: t('openFolder'), accelerator: 'CmdOrCtrl+Shift+O', click: () => sendToRenderer('menu:command', 'open-folder') },
        { label: t('loadWorkspace'), click: () => sendToRenderer('menu:command', 'load-workspace') },
        { label: t('loadDatasetFile'), click: () => sendToRenderer('menu:command', 'load-dataset-file') },
        { label: t('importRnoteFile'), click: () => sendToRenderer('menu:command', 'import-rnote') },
        { type: 'separator' },
        { label: t('save'), accelerator: 'CmdOrCtrl+S', click: () => sendToRenderer('menu:command', 'save') },
        { label: t('saveAs'), accelerator: 'CmdOrCtrl+Shift+S', click: () => sendToRenderer('menu:command', 'save-as') },
        { label: t('closeTab'), accelerator: 'CmdOrCtrl+W', click: () => sendToRenderer('menu:command', 'close-tab') },
        { type: 'separator' },
        ...rcmdrSub('File'),
        { type: 'separator' },
        { label: t('quit'), role: 'quit' }
      ]
    },
    {
      label: t('menuEdit'),
      submenu: [
        { label: t('undo'), role: 'undo' },
        { label: t('redo'), role: 'redo' },
        { type: 'separator' },
        { label: t('cut'), role: 'cut' },
        { label: t('copy'), role: 'copy' },
        { label: t('paste'), role: 'paste' },
        { label: t('selectAll'), role: 'selectAll' },
        { type: 'separator' },
        ...rcmdrSub('Edit')
      ]
    },
    {
      label: t('menuView'),
      submenu: [
        { label: t('commandPalette'), accelerator: 'CmdOrCtrl+Shift+P', click: () => sendToRenderer('menu:command', 'command-palette') },
        { type: 'separator' },
        { label: t('splitEditor'), accelerator: 'CmdOrCtrl+\\', click: () => sendToRenderer('menu:command', 'toggle-split') },
        { label: t('moveTabOtherGroup'), click: () => sendToRenderer('menu:command', 'move-tab-group') },
        { label: t('togglePreview'), accelerator: 'CmdOrCtrl+Shift+V', click: () => sendToRenderer('menu:command', 'toggle-preview') },
        { label: t('toggleDockPosition'), click: () => sendToRenderer('menu:command', 'toggle-dock-position') },
        { type: 'separator' },
        { label: t('toggleTheme'), click: () => sendToRenderer('menu:command', 'toggle-theme') },
        { label: t('switchLanguage'), click: () => sendToRenderer('menu:command', 'switch-language') },
        { label: t('openSettings'), accelerator: 'CmdOrCtrl+,', click: () => sendToRenderer('menu:command', 'open-settings') },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: t('menuRun'),
      submenu: [
        { label: t('runSelection'), accelerator: 'CmdOrCtrl+Enter', click: () => sendToRenderer('menu:command', 'run-selection') },
        { label: t('runAll'), accelerator: 'CmdOrCtrl+Shift+Enter', click: () => sendToRenderer('menu:command', 'run-all') },
        { label: t('knitRmd'), accelerator: 'CmdOrCtrl+Shift+K', click: () => sendToRenderer('menu:command', 'knit') },
        { type: 'separator' },
        { label: t('interruptR'), click: () => sendToRenderer('menu:command', 'interrupt-r') },
        { label: t('restartR'), click: () => sendToRenderer('menu:command', 'restart-r') },
        { label: t('clearConsole'), click: () => sendToRenderer('menu:command', 'clear-console') },
        { label: t('refreshWorkspace'), click: () => sendToRenderer('menu:command', 'refresh-workspace') }
      ]
    },
    { label: t('menuData'), submenu: rcmdrSub('Data') },
    { label: t('menuStatistics'), submenu: rcmdrSub('Statistics') },
    { label: t('menuGraphs'), submenu: rcmdrSub('Graphs') },
    { label: t('menuModels'), submenu: rcmdrSub('Models') },
    { label: t('menuDistributions'), submenu: rcmdrSub('Distributions') },
    { label: t('menuBasicStats'), submenu: rcmdrSub('Basic Statistics') },
    { label: t('menuTools'), submenu: rcmdrSub('Tools') },
    {
      label: t('menuHelp'),
      submenu: [
        { label: t('rHelpMenu'), click: () => sendToRenderer('menu:command', 'r-help') },
        { label: t('wizardMenuItem'), click: () => sendToRenderer('menu:command', 'open-setup-wizard') },
        { type: 'separator' },
        ...rcmdrSub('Help'),
        { type: 'separator' },
        { label: t('checkForUpdates'), click: () => sendToRenderer('menu:command', 'check-updates') },
        { label: t('checkForUpdatesOnOpen'), click: () => sendToRenderer('menu:command', 'toggle-update-on-open') },
        { label: t('installDesktopEntry'), click: () => sendToRenderer('menu:command', 'install-desktop') },
        { type: 'separator' },
        { label: `${t('repoGithub')} (Emefedez/r-commander-studio)`, click: () => shell.openExternal('https://github.com/Emefedez/r-commander-studio') },
        { label: `${t('vscodeExtGithub')} (Emefedez/r-commander-in-vscode)`, click: () => shell.openExternal('https://github.com/Emefedez/r-commander-in-vscode') },
        { label: `${t('myGithub')} (Emefedez)`, click: () => shell.openExternal('https://github.com/Emefedez') }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.svg');
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 420,
    minHeight: 340,
    title: 'R Commander Studio',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#f7f8fa',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const uiStep = uiZoomStep(input);
    if (uiStep !== null) {
      event.preventDefault();
      sendToRenderer('studio:zoomStep', { kind: 'ui', step: uiStep });
      return;
    }
    const edStep = editorZoomStep(input);
    if (edStep !== null) {
      event.preventDefault();
      sendToRenderer('studio:zoomStep', { kind: 'editor', step: edStep });
      return;
    }
    const k = String(input.key || '').toLowerCase();
    if (k === 't') {
      event.preventDefault();
      sendToRenderer('menu:command', input.shift ? 'reopen-closed-tab' : 'new-r');
    } else if (k === 'w' && !input.shift) {
      event.preventDefault();
      sendToRenderer('menu:command', 'close-tab');
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow._allowClose = false;
  mainWindow.on('close', (event) => {
    if (!mainWindow._allowClose && rendererReady && !shuttingDown) {
      event.preventDefault();
      sendToRenderer('studio:requestClose', {});
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function pickFileOrDir(field, titleLabel) {
  if (!mainWindow || mainWindow.isDestroyed()) return undefined;
  if (field.type === 'dir') {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: titleLabel || 'Choose Folder',
      properties: ['openDirectory']
    });
    return res.canceled ? undefined : res.filePaths[0];
  }
  const filters = field.filters
    ? Object.entries(field.filters).map(([name, extensions]) => ({ name, extensions }))
    : undefined;
  if (field.mode === 'save') {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: titleLabel || 'Save File',
      defaultPath: field.def || undefined,
      filters
    });
    return res.canceled ? undefined : res.filePath;
  }
  const res = await dialog.showOpenDialog(mainWindow, {
    title: titleLabel || 'Open File',
    properties: ['openFile'],
    filters
  });
  return res.canceled ? undefined : res.filePaths[0];
}

function registerIpc() {
  ipcMain.handle('studio:init', async () => {
    rendererReady = true;
    const env = await runtime.probeEnvironment();
    const monacoVsDir = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
    const queued = pendingOpenPaths.splice(0, pendingOpenPaths.length);
    return {
      env,
      bridge: bridge ? { port: bridge.port, protocolVersion: 1 } : null,
      tree: rcmdr.getTree(mainI18n.getLang()),
      rcmdrCount: rcmdr.getCatalogSummary().count,
      lspStatus: lsp ? lsp.status : 'fallback',
      monacoVsUrl: pathToFileURL(monacoVsDir).href,
      pendingOpenPaths: queued
    };
  });

  ipcMain.handle('studio:setLanguage', async (_e, lang) => {
    const clean = lang === 'en' ? 'en' : 'es';
    mainI18n.setLang(clean);
    rcmdr.setLanguage(clean);
    buildAppMenu(clean);
    return { lang: clean };
  });

  ipcMain.handle('studio:updateSettings', async (_e, patch) => {
    return rcmdr.updateSettings(patch || {});
  });

  // --- File & Workspace Explorer I/O ---
  ipcMain.handle('file:open', async (_e, opts) => {
    const defaultDir = opts && typeof opts === 'object' ? opts.defaultDir : undefined;
    const dialogOpts = {
      title: mainI18n.t('openFile'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'R, Markdown, Data & Rnote', extensions: ['R', 'r', 'Rmd', 'rmd', 'qmd', 'md', 'csv', 'tsv', 'txt', 'RData', 'rda', 'rds', 'xlsx', 'xls', 'rnote'] },
        { name: 'Rnote Notes', extensions: ['rnote'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    };
    if (defaultDir && typeof defaultDir === 'string' && fs.existsSync(defaultDir)) {
      dialogOpts.defaultPath = defaultDir;
    }
    const res = await dialog.showOpenDialog(mainWindow, dialogOpts);
    if (res.canceled || !res.filePaths.length) return null;
    const files = [];
    for (const filePath of res.filePaths) {
      const ext = path.extname(filePath).toLowerCase();
      const isBinaryData = ['.rdata', '.rda', '.rds', '.xlsx', '.xls'].includes(ext);
      const isRnote = ext === '.rnote';
      files.push({
        filePath,
        name: path.basename(filePath),
        isBinaryData,
        isRnote,
        content: isBinaryData || isRnote ? '' : fs.readFileSync(filePath, 'utf8')
      });
    }
    return files;
  });

  ipcMain.handle('file:openPath', async (_e, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const ext = path.extname(filePath).toLowerCase();
    const isBinaryData = ['.rdata', '.rda', '.rds', '.xlsx', '.xls'].includes(ext);
    const isRnote = ext === '.rnote';
    return {
      filePath,
      name: path.basename(filePath),
      isBinaryData,
      isRnote,
      content: isBinaryData || isRnote ? '' : fs.readFileSync(filePath, 'utf8')
    };
  });

  ipcMain.handle('file:openRnoteDialog', async (_e, opts) => {
    const defaultDir = opts && typeof opts === 'object' ? opts.defaultDir : undefined;
    const dialogOpts = {
      title: mainI18n.t('importRnoteFile'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Rnote Notes', extensions: ['rnote'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    };
    if (defaultDir && typeof defaultDir === 'string' && fs.existsSync(defaultDir)) {
      dialogOpts.defaultPath = defaultDir;
    }
    const res = await dialog.showOpenDialog(mainWindow, dialogOpts);
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths;
  });

  ipcMain.handle('rnote:load', async (_e, filePath) => {
    return rnoteService.loadRnoteFile(filePath);
  });

  ipcMain.handle('file:openDataFileDialog', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: mainI18n.t('loadDatasetFile'),
      properties: ['openFile'],
      filters: [
        { name: 'R Data & Tables', extensions: ['RData', 'rda', 'rds', 'csv', 'tsv', 'xlsx', 'xls'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('file:save', async (_e, { filePath, content }) => {
    if (!filePath) return { ok: false, error: 'Missing filePath' };
    fs.writeFileSync(filePath, String(content ?? ''), 'utf8');
    return { ok: true, filePath, name: path.basename(filePath) };
  });

  ipcMain.handle('file:saveAs', async (_e, { defaultName, defaultDir, content, filters }) => {
    const baseName = defaultName || 'script.R';
    const resolvedDefault =
      defaultDir && !path.isAbsolute(baseName) && fs.existsSync(defaultDir)
        ? path.join(defaultDir, baseName)
        : baseName;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: mainI18n.t('saveAs'),
      defaultPath: resolvedDefault,
      filters: filters || [
        { name: 'R Script', extensions: ['R', 'r'] },
        { name: 'R Markdown', extensions: ['Rmd', 'rmd', 'qmd'] },
        { name: 'Markdown', extensions: ['md'] },
        { name: 'CSV Table', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, String(content ?? ''), 'utf8');
    return { ok: true, filePath: res.filePath, name: path.basename(res.filePath) };
  });

  ipcMain.handle('file:saveSvg', async (_e, { svg, defaultName }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: mainI18n.t('plotSaveSvg'),
      defaultPath: defaultName || 'plot.svg',
      filters: [{ name: 'SVG Image', extensions: ['svg'] }]
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, String(svg ?? ''), 'utf8');
    return { ok: true, filePath: res.filePath };
  });

  ipcMain.handle('file:savePlotPng', async (_e, { base64Png, defaultName }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Plot as PNG',
      defaultPath: defaultName || 'plot.png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, Buffer.from(String(base64Png || ''), 'base64'));
    return { ok: true, filePath: res.filePath };
  });

  ipcMain.handle('file:savePlotPdf', async (_e, { svg, defaultName }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Plot as PDF',
      defaultPath: defaultName || 'plot.pdf',
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return null;
    const pdfWin = new BrowserWindow({
      show: false,
      width: 900,
      height: 640,
      webPreferences: { sandbox: true }
    });
    try {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;display:grid;place-items:center;width:100vw;height:100vh}svg{max-width:96vw;max-height:96vh;width:auto;height:auto}</style></head><body>${svg}</body></html>`;
      await pdfWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdfBuf = await pdfWin.webContents.printToPDF({
        printBackground: true,
        landscape: true,
        margins: { top: 0.2, bottom: 0.2, left: 0.2, right: 0.2 }
      });
      fs.writeFileSync(res.filePath, pdfBuf);
      return { ok: true, filePath: res.filePath };
    } finally {
      pdfWin.destroy();
    }
  });

  ipcMain.handle('file:browse', async (_e, { mode, type, filters, defaultName, title }) => {
    return pickFileOrDir({ mode, type, filters, def: defaultName }, title);
  });

  ipcMain.handle('fs:openFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: mainI18n.t('openFolder'),
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    const root = res.filePaths[0];
    return { root, name: path.basename(root), tree: fsService.readDirTree(root, 4) };
  });

  ipcMain.handle('fs:readDirTree', async (_e, root) => {
    if (!root || !fs.existsSync(root)) return null;
    return { root, name: path.basename(root), tree: fsService.readDirTree(root, 4) };
  });

  ipcMain.handle('fs:createFile', async (_e, { dir, name }) => {
    const target = path.join(dir, name);
    return fsService.createFile(target, '');
  });

  ipcMain.handle('fs:createDir', async (_e, { dir, name }) => {
    const target = path.join(dir, name);
    return fsService.createDir(target);
  });

  ipcMain.handle('fs:rename', async (_e, { oldPath, newName }) => {
    const newPath = path.join(path.dirname(oldPath), newName);
    return fsService.renamePath(oldPath, newPath);
  });

  ipcMain.handle('fs:delete', async (_e, targetPath) => {
    return fsService.deletePath(targetPath);
  });

  ipcMain.handle('shell:openExternal', async (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  // --- R Runtime & Table Viewer RPC ---
  ipcMain.handle('r:run', async (_e, opts) => {
    const result = await runtime.runCode(opts.code || '', opts);
    try {
      lastSnapshot = await runtime.snapshot();
    } catch {
      // keep previous snapshot
    }
    return { ...result, snapshot: lastSnapshot };
  });

  ipcMain.handle('r:loadDataFile', async (_e, filePath) => {
    const result = await runtime.loadDataFile(filePath);
    if (result.ok && result.snapshot) {
      lastSnapshot = result.snapshot;
    }
    return result;
  });

  ipcMain.handle('r:interrupt', async () => ({ ok: runtime.interrupt() }));

  // Interactive arf terminal IPC
  ipcMain.handle('arf:start', async () => ({ ok: arf ? arf.start() : false, available: Boolean(arf?.available) }));
  ipcMain.handle('arf:send', async (_e, code) => ({ ok: arf ? arf.send(code) : false }));
  ipcMain.handle('arf:write', async (_e, data) => ({ ok: arf ? arf.writeRaw(data) : false }));
  ipcMain.handle('arf:resize', async (_e, { cols, rows } = {}) => ({ ok: arf ? arf.resize(cols, rows) : false }));
  ipcMain.handle('arf:interrupt', async () => ({ ok: arf ? arf.interrupt() : false }));
  ipcMain.handle('arf:restart', async () => ({ ok: arf ? arf.restart() : false }));

  ipcMain.handle('r:restart', async () => {
    await runtime.restartSession();
    lastSnapshot = await runtime.snapshot();
    return { ok: true, snapshot: lastSnapshot };
  });

  ipcMain.handle('r:snapshot', async () => {
    lastSnapshot = await runtime.snapshot();
    return lastSnapshot;
  });

  ipcMain.handle('r:query', async (_e, expr) => runtime.query(expr));

  ipcMain.handle('r:knit', async (_e, opts) => runtime.knitRmd(opts));

  ipcMain.handle('r:help', async (_e, topic) => {
    const clean = String(topic || '').trim();
    if (!clean) return { ok: false, text: '' };

    // Always search bilingual (EN + ES + R function names) R Commander commands too
    const rcmdrMatches = rcmdr ? rcmdr.searchCommands(clean, mainI18n.getLang()).slice(0, 12) : [];

    const [maybePkg, maybeFn] = clean.includes('::') ? clean.split('::') : ['', clean];
    // Only call getFunctionHelp directly if clean looks like a single R identifier
    if (/^[A-Za-z.][A-Za-z0-9._]*$/.test(maybeFn || clean)) {
      const structured = await runtime.getFunctionHelp(maybeFn || clean, maybePkg);
      if (structured && structured.ok && structured.fullText) {
        return { ...structured, rcmdrMatches };
      }
    }

    // If the user searched a function/concept in Spanish or English (e.g. "regresión lineal",
    // "linear regression", "test t", "diagrama de caja") and it matched an R Commander command
    // with an associated R function, load that R function's documentation automatically!
    const matchedFn = rcmdrMatches.find((m) => Array.isArray(m.fns) && m.fns.length > 0)?.fns?.[0];
    if (matchedFn) {
      const structured = await runtime.getFunctionHelp(matchedFn, '');
      if (structured && structured.ok && structured.fullText) {
        return { ...structured, rcmdrMatches, resolvedFromQuery: clean };
      }
    }

    const res = await runtime.runCode(
      `local({ hs <- tryCatch(utils::help.search(${JSON.stringify(clean)}, agrep = FALSE)$matches, error = function(e) NULL); if (!is.null(hs) && nrow(hs)) print(head(hs[, c("Package", "Topic", "Title")], 20)) else cat("No R help entries found for:", ${JSON.stringify(clean)}, "\\n") })`,
      { capturePlots: false, skipHelp: false, limitOutput: false }
    );
    return {
      ok: true,
      fn: clean,
      title: `Search: ${clean}`,
      fullText: res.stdout || res.stderr || '',
      rcmdrMatches
    };
  });

  ipcMain.handle('r:fnHelp', async (_e, { fnName, pkg }) => runtime.getFunctionHelp(fnName, pkg));

  // Table Viewer RPC (R objects + CSV/TSV files)
  ipcMain.handle('table:getPage', async (_e, opts) => runtime.getTablePage(opts));
  ipcMain.handle('table:colSummary', async (_e, opts) => runtime.getColumnSummary(opts));
  ipcMain.handle('table:editCell', async (_e, opts) => {
    const res = await runtime.editTableCell(opts);
    if (res.ok) lastSnapshot = await runtime.snapshot();
    return { ...res, snapshot: lastSnapshot };
  });
  ipcMain.handle('table:addRow', async (_e, opts) => {
    const res = await runtime.addTableRow(opts);
    if (res.ok) lastSnapshot = await runtime.snapshot();
    return { ...res, snapshot: lastSnapshot };
  });
  ipcMain.handle('table:addCol', async (_e, opts) => {
    const res = await runtime.addTableCol(opts);
    if (res.ok) lastSnapshot = await runtime.snapshot();
    return { ...res, snapshot: lastSnapshot };
  });
  ipcMain.handle('table:exportCsv', async (_e, opts) => runtime.exportTableCsv(opts));
  ipcMain.handle('table:parseDelimited', async (_e, { text, delimiter }) => fsService.parseDelimited(text, delimiter));
  ipcMain.handle('table:serializeDelimited', async (_e, { columns, rows, delimiter }) => fsService.serializeDelimited(columns, rows, delimiter));
  ipcMain.handle('table:toMarkdown', async (_e, { columns, rows }) => fsService.toMarkdownTable(columns, rows));

  // --- LSP & Diagnostics ---
  ipcMain.handle('lsp:didOpen', async (_e, { uri, text, isRmd }) => lsp.didOpen(uri, text, { isRmd }));
  ipcMain.handle('lsp:didChange', async (_e, { uri, text, isRmd }) => lsp.didChange(uri, text, { isRmd }));
  ipcMain.handle('lsp:didClose', async (_e, { uri }) => {
    lsp.didClose(uri);
    return true;
  });
  ipcMain.handle('lsp:hover', async (_e, { uri, line, character }) => lsp.hover(uri, line, character));
  ipcMain.handle('lsp:checkPackage', async () => lsp.checkPackage());
  ipcMain.handle('lsp:installPackage', async (_e, { repos } = {}) =>
    lsp.installPackage({ repos, onProgress: (line) => sendToRenderer('lsp:installProgress', { line }) })
  );
  ipcMain.handle('lsp:completion', async (_e, { uri, line, character }) => lsp.completion(uri, line, character));

  // --- R Commander Service ---
  ipcMain.handle('rcmdr:getTree', async (_e, lang) => rcmdr.getTree(lang));
  ipcMain.handle('rcmdr:searchCommands', async (_e, { query, lang }) => rcmdr.searchCommands(query, lang));
  ipcMain.handle('rcmdr:menuHover', async (_e, { fnName, lang }) => rcmdr.getMenuHover(fnName, lang));

  ipcMain.handle('rcmdr:openCommand', async (_e, { id, activeDataset, activeModel, lang, settings }) => {
    try {
      lastSnapshot = await runtime.snapshot();
    } catch {
      // use cached snapshot
    }
    return rcmdr.openCommand(id, {
      state: lastSnapshot,
      activeDataset,
      activeModel,
      lang,
      settings,
      queryFn: (expr, timeout) => runtime.query(expr, timeout)
    });
  });

  ipcMain.handle('rcmdr:updateLayout', async (_e, { sessionId, rawValues, dirty }) => {
    return rcmdr.updateLayout(sessionId, {
      rawValues,
      dirty,
      queryFn: (expr, timeout) => runtime.query(expr, timeout)
    });
  });

  ipcMain.handle('rcmdr:switchDataset', async (_e, { sessionId, datasetName }) => {
    return rcmdr.switchDataset(sessionId, datasetName, {
      queryFn: (expr, timeout) => runtime.query(expr, timeout)
    });
  });

  ipcMain.handle('rcmdr:resetDialog', async (_e, { sessionId }) => {
    return rcmdr.resetDialog(sessionId, {
      queryFn: (expr, timeout) => runtime.query(expr, timeout)
    });
  });

  ipcMain.handle('rcmdr:submitDialog', async (_e, { sessionId, rawValues }) => {
    return rcmdr.submitDialog(sessionId, {
      rawValues,
      queryFn: (expr, timeout) => runtime.query(expr, timeout),
      filePicker: (field, label) => pickFileOrDir(field, label)
    });
  });

  ipcMain.handle('rcmdr:closeDialog', async (_e, { sessionId }) => {
    rcmdr.closeDialog(sessionId);
    return true;
  });

  ipcMain.handle('rcmdr:reportHelper', async (_e, { action, kind = 'rmd', text = '', title = '', code = '' }) => {
    if (action === 'template') return report.template(kind);
    if (action === 'append') return report.append(kind, text, title, code);
    if (action === 'removeLastBlock') return report.removeLastBlock(kind, text);
    if (action === 'removeLastTitle') return report.removeLastTitle(kind, text);
    return text;
  });

  // --- Auto-Updater, Desktop Integration & Standalone Output/Viewer Window ---
  ipcMain.handle('updater:check', async (_e, { manual = true } = {}) => {
    if (!appUpdater) return { current: app.getVersion(), upToDate: true };
    return appUpdater.check({ manual });
  });
  ipcMain.handle('updater:install', async () => {
    if (!appUpdater) throw new Error('Updater not initialized');
    return appUpdater.install((pct) => sendToRenderer('updater:progress', pct));
  });
  ipcMain.handle('updater:restart', async () => {
    if (appUpdater) appUpdater.restart();
    return true;
  });
  ipcMain.handle('updater:settings', async () => {
    if (!appUpdater) return { checkOnOpen: true, current: app.getVersion() };
    return appUpdater.settings();
  });
  ipcMain.handle('updater:setCheckOnOpen', async (_e, on) => {
    if (!appUpdater) return false;
    await appUpdater.setCheckOnOpen(on);
    return true;
  });
  ipcMain.handle('studio:buildInfo', async () => {
    const base = { version: app.getVersion(), packaged: app.isPackaged, installPath: path.dirname(app.getPath('exe')) };
    try {
      return { ...base, ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'build-info.json'), 'utf8')), version: base.version };
    } catch {
      return { ...base, commit: null, date: null, source: app.isPackaged ? 'unknown' : 'dev' };
    }
  });
  ipcMain.handle('updater:listReleases', async () => {
    if (!appUpdater) return [];
    return appUpdater.listReleases();
  });
  ipcMain.handle('studio:installDesktop', async () => {
    return integrateLinuxDesktop({ createDesktopShortcut: true });
  });
  ipcMain.handle('studio:checkSessionPaths', async (_e, { workspaceRoot = '', openFiles = [] } = {}) => {
    const workspaceExists = Boolean(workspaceRoot && fs.existsSync(workspaceRoot) && fs.statSync(workspaceRoot).isDirectory());
    const existingFiles = (Array.isArray(openFiles) ? openFiles : []).filter(
      (p) => typeof p === 'string' && p && fs.existsSync(p) && fs.statSync(p).isFile()
    );
    return { workspaceExists, existingFiles };
  });
  ipcMain.handle('studio:confirmCloseDialog', async (_e, { count = 1, names = [], lang = 'es' } = {}) => {
    if (!mainWindow || mainWindow.isDestroyed()) return 1;
    const isEs = lang === 'es';
    const previewNames = (Array.isArray(names) ? names : []).slice(0, 6).join(', ');
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'R Commander Studio',
      message: isEs
        ? `Tienes ${count} archivo(s) con cambios sin guardar.`
        : `You have ${count} file(s) with unsaved changes.`,
      detail: previewNames
        ? (isEs ? `Archivos: ${previewNames}` : `Files: ${previewNames}`)
        : '',
      buttons: isEs ? ['Guardar todo', 'No guardar', 'Cancelar'] : ['Save All', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    return res.response;
  });
  ipcMain.handle('studio:allowClose', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow._allowClose = true;
      mainWindow.close();
    }
    return true;
  });

  // --- T3 Code Background Copilot & Cross-Platform Installer IPC ---
  ipcMain.handle('t3:status', async () => {
    if (!t3code) t3code = new T3CodeService();
    return t3code.getStatus();
  });
  ipcMain.handle('t3:start', async () => {
    if (!t3code) t3code = new T3CodeService();
    return t3code.startBackend();
  });
  ipcMain.handle('t3:install', async (_e, opts = {}) => {
    if (!t3code) t3code = new T3CodeService();
    return t3code.installT3Code({
      preferWsl: opts.preferWsl !== false,
      onProgress: (p) => sendToRenderer('t3:installProgress', p)
    });
  });
  ipcMain.handle('t3:ask', async (_e, opts = {}) => {
    if (!t3code) t3code = new T3CodeService();
    return t3code.askCopilot(opts);
  });
  ipcMain.handle('t3:providers', async () => {
    if (!t3code) t3code = new T3CodeService();
    return t3code.getProviders();
  });
  ipcMain.handle('t3:models', async (_e, opts = {}) => {
    if (!t3code) t3code = new T3CodeService();
    const provider = typeof opts === 'string' ? opts : opts?.provider || 'auto';
    return t3code.getModels(provider, { fresh: Boolean(opts?.fresh) });
  });
  ipcMain.handle('t3:transcribe', async (_e, opts = {}) => {
    if (!t3code) t3code = new T3CodeService();
    return t3code.transcribeAudio(opts);
  });

  ipcMain.handle('studio:openOutputWindow', async (_e, { title, htmlContent, rawText, code, sourceLabel, isLight } = {}) => {
    const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
    const win = new BrowserWindow({
      width: 860,
      height: 640,
      minWidth: 480,
      minHeight: 340,
      title: title || 'R Output Viewer — R Commander Studio',
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      backgroundColor: isLight ? '#FFFFFF' : '#282A36',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    const bg = isLight ? '#FFFFFF' : '#282A36';
    const bgBar = isLight ? '#F3F3F3' : '#191A21';
    const fg = isLight ? '#1E1E1E' : '#F8F8F2';
    const fgMuted = isLight ? '#6E7681' : '#6272A4';
    const border = isLight ? '#D4D4D4' : '#343746';
    const accent = isLight ? '#007ACC' : '#BD93F9';
    const safeRaw = JSON.stringify(String(rawText || ''));
    const safeTitle = String(title || 'R Output').replace(/[&<>"]/g, '');
    const safeSource = String(sourceLabel || 'R').replace(/[&<>"]/g, '');
    const pageHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: ${bg}; color: ${fg}; font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; height: 100vh; display: flex; flex-direction: column; }
  header { height: 36px; padding: 0 12px; background: ${bgBar}; border-bottom: 1px solid ${border}; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .badge { font: 600 11px ui-monospace, monospace; padding: 2px 6px; border-radius: 3px; background: ${accent}22; color: ${accent}; border: 1px solid ${accent}55; }
  .title { font-weight: 600; font-size: 12.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button { height: 24px; padding: 0 10px; border: 1px solid ${border}; border-radius: 3px; background: ${bg}; color: ${fg}; font-size: 11.5px; cursor: pointer; }
  button:hover { border-color: ${accent}; }
  main { flex: 1; overflow: auto; padding: 16px 20px; }
  pre, .out-body { margin: 0; font: 12.5px/1.5 ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  .ansi-31, .ansi-91 { color: #FF5555; }
  .ansi-32, .ansi-92 { color: #50FA7B; }
  .ansi-33, .ansi-93 { color: #F1FA8C; }
  .ansi-34, .ansi-94 { color: #BD93F9; }
  .ansi-35, .ansi-95 { color: #FF79C6; }
  .ansi-36, .ansi-96 { color: #8BE9FD; }
  .ansi-90 { color: ${fgMuted}; font-style: italic; }
  .ansi-1 { font-weight: 700; }
  .tk-kw { color: #FF79C6; font-weight: 600; }
  .tk-fn { color: #50FA7B; }
  .tk-str { color: #F1FA8C; }
  .tk-num { color: #BD93F9; }
  .tk-com { color: ${fgMuted}; font-style: italic; }
  .tk-op { color: #FF79C6; }
  .tk-type { color: #FFB86C; font-style: italic; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12.5px; }
  th, td { border: 1px solid ${border}; padding: 5px 9px; }
  th { background: ${bgBar}; }
  blockquote, .md-alert { border-left: 3px solid ${accent}; padding: 8px 12px; margin: 10px 0; background: ${bgBar}; }
  .md-chunk { border: 1px solid ${border}; border-radius: 3px; margin: 10px 0; background: ${bgBar}; }
  .md-chunk-bar { padding: 4px 10px; border-bottom: 1px solid ${border}; font-family: monospace; font-size: 11px; color: ${fgMuted}; display: flex; justify-content: space-between; }
  .md-chunk pre { padding: 10px; }
  .md-chunk-actions { display: none; }
</style>
</head>
<body>
  <header>
    <span class="badge">${safeSource}</span>
    <span class="title">${safeTitle}</span>
    <button id="btnCopy">Copy</button>
    <button id="btnPrint">Print / PDF</button>
  </header>
  <main>
    <div class="out-body">${htmlContent || ''}</div>
  </main>
  <script>
    const raw = ${safeRaw};
    document.getElementById('btnCopy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(raw || document.querySelector('.out-body').innerText);
        document.getElementById('btnCopy').textContent = 'Copied!';
        setTimeout(() => { document.getElementById('btnCopy').textContent = 'Copy'; }, 1400);
      } catch {}
    });
    document.getElementById('btnPrint').addEventListener('click', () => window.print());
  </script>
</body>
</html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`);
    return { ok: true };
  });
}

async function bootServices() {
  runtime = new RRuntime();
  arf = new ArfTerminal();
  rcmdr = new RcmdrService();
  lsp = new RLanguageServer({ rscriptPath: runtime.rscriptPath });
  t3code = new T3CodeService();
  t3code.startBackend().catch(() => {});

  runtime.on('output', (payload) => sendToRenderer('r:output', payload));
  runtime.on('viewTable', (payload) => sendToRenderer('r:viewTable', payload));
  runtime.on('browseUrl', (url) => {
    if (typeof url === 'string' && /^(https?|file):\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
  });
  arf.on('output', (payload) => sendToRenderer('arf:output', payload));
  arf.on('status', (status) => sendToRenderer('arf:status', status));
  lsp.on('diagnostics', (payload) => sendToRenderer('lsp:diagnostics', payload));
  lsp.on('status', (status) => sendToRenderer('lsp:status', status));

  bridge = new NoteCompleteBridge({
    runtime,
    rcmdr,
    getDatasets: () => Object.keys(lastSnapshot?.datasets || {}),
    onOpenScript: ({ title, code, kind, filePath, folderPath }) => {
      if (folderPath) dispatchOpenPath({ folderPath });
      if (filePath && !code) {
        dispatchOpenPath({ filePath });
      } else {
        sendToRenderer('bridge:openScript', { title, code, kind, filePath });
        focusMainWindow();
      }
    },
    onOpenPath: ({ filePath, folderPath }) => {
      dispatchOpenPath({ filePath, folderPath });
    }
  });

  await bridge.start();
  appUpdater = createUpdater({ app });
  integrateLinuxDesktop().catch(() => {});
  runtime.ensureSession().catch(() => {});
  lsp.start().catch(() => {});
  setTimeout(() => {
    appUpdater
      .check({ manual: false })
      .then((info) => {
        if (info && info.version && !info.skipped) {
          sendToRenderer('updater:available', info);
        }
      })
      .catch(() => {});
  }, 3500);
}

let shuttingDown = false;
async function shutdownServices() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (bridge) await bridge.close();
  } catch {
    // ignore
  }
  try {
    if (lsp) lsp.stop();
  } catch {
    // ignore
  }
  try {
    if (runtime) runtime.stopSession();
  } catch {
    // ignore
  }
  try {
    if (arf) arf.stop();
  } catch {
    // ignore
  }
  try {
    if (t3code) await t3code.stopBackendIfOwned();
  } catch {
    // ignore
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    const targets = extractCliTargets(commandLine, workingDirectory);
    for (const target of targets) dispatchOpenPath(target);
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    for (const target of extractCliTargets(process.argv, process.cwd())) {
      pendingOpenPaths.push(target);
    }
    await bootServices();
    buildAppMenu(mainI18n.getLang());
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', async (event) => {
  if (!shuttingDown) {
    event.preventDefault();
    await shutdownServices();
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    shutdownServices().finally(() => process.exit(0));
  });
}
