'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');

const { RRuntime } = require('./r-runtime');
const { RLanguageServer } = require('./r-lsp');
const { RcmdrService, report } = require('./rcmdr-service');
const { NoteCompleteBridge } = require('./bridge');

let mainWindow = null;
let runtime = null;
let lsp = null;
let rcmdr = null;
let bridge = null;
let lastSnapshot = { datasets: {}, models: [], hclusts: [], objects: [] };

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New R Script', accelerator: 'CmdOrCtrl+N', click: () => sendToRenderer('menu:command', 'new-r') },
        { label: 'New R Markdown', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendToRenderer('menu:command', 'new-rmd') },
        { type: 'separator' },
        { label: 'Open...', accelerator: 'CmdOrCtrl+O', click: () => sendToRenderer('menu:command', 'open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendToRenderer('menu:command', 'save') },
        { label: 'Save As...', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendToRenderer('menu:command', 'save-as') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Run',
      submenu: [
        { label: 'Run Line / Selection', accelerator: 'CmdOrCtrl+Enter', click: () => sendToRenderer('menu:command', 'run-selection') },
        { label: 'Run All', accelerator: 'CmdOrCtrl+Shift+Enter', click: () => sendToRenderer('menu:command', 'run-all') },
        { label: 'Knit R Markdown', accelerator: 'CmdOrCtrl+Shift+K', click: () => sendToRenderer('menu:command', 'knit') },
        { type: 'separator' },
        { label: 'Interrupt R', click: () => sendToRenderer('menu:command', 'interrupt-r') },
        { label: 'Restart R Session', click: () => sendToRenderer('menu:command', 'restart-r') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Preview', accelerator: 'CmdOrCtrl+Shift+V', click: () => sendToRenderer('menu:command', 'toggle-preview') },
        { label: 'Toggle Theme', click: () => sendToRenderer('menu:command', 'toggle-theme') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: 'R Commander Studio',
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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
    const env = await runtime.probeEnvironment();
    const monacoVsDir = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
    return {
      env,
      bridge: bridge ? { port: bridge.port, protocolVersion: 1 } : null,
      tree: rcmdr.getTree('en'),
      rcmdrCount: rcmdr.getCatalogSummary().count,
      lspStatus: lsp ? lsp.status : 'fallback',
      monacoVsUrl: pathToFileURL(monacoVsDir).href
    };
  });

  // --- File operations ---
  ipcMain.handle('file:open', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Open File',
      properties: ['openFile'],
      filters: [
        { name: 'R & Markdown', extensions: ['R', 'r', 'Rmd', 'rmd', 'qmd', 'md', 'csv', 'txt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    const filePath = res.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf8');
    return { filePath, name: path.basename(filePath), content };
  });

  ipcMain.handle('file:save', async (_e, { filePath, content }) => {
    if (!filePath) return { ok: false, error: 'Missing filePath' };
    fs.writeFileSync(filePath, String(content ?? ''), 'utf8');
    return { ok: true, filePath, name: path.basename(filePath) };
  });

  ipcMain.handle('file:saveAs', async (_e, { defaultName, content, filters }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save File As',
      defaultPath: defaultName || 'script.R',
      filters: filters || [
        { name: 'R Script', extensions: ['R', 'r'] },
        { name: 'R Markdown', extensions: ['Rmd', 'rmd', 'qmd'] },
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, String(content ?? ''), 'utf8');
    return { ok: true, filePath: res.filePath, name: path.basename(res.filePath) };
  });

  ipcMain.handle('file:saveSvg', async (_e, { svg, defaultName }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Plot as SVG',
      defaultPath: defaultName || 'plot.svg',
      filters: [{ name: 'SVG Image', extensions: ['svg'] }]
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, String(svg ?? ''), 'utf8');
    return { ok: true, filePath: res.filePath };
  });

  ipcMain.handle('file:browse', async (_e, { mode, type, filters, defaultName, title }) => {
    return pickFileOrDir({ mode, type, filters, def: defaultName }, title);
  });

  ipcMain.handle('shell:openExternal', async (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  // --- R Runtime ---
  ipcMain.handle('r:run', async (_e, opts) => {
    const result = await runtime.runCode(opts.code || '', opts);
    try {
      lastSnapshot = await runtime.snapshot();
    } catch {
      // keep previous snapshot
    }
    return { ...result, snapshot: lastSnapshot };
  });

  ipcMain.handle('r:interrupt', async () => {
    return { ok: runtime.interrupt() };
  });

  ipcMain.handle('r:restart', async () => {
    await runtime.restartSession();
    lastSnapshot = await runtime.snapshot();
    return { ok: true, snapshot: lastSnapshot };
  });

  ipcMain.handle('r:snapshot', async () => {
    lastSnapshot = await runtime.snapshot();
    return lastSnapshot;
  });

  ipcMain.handle('r:query', async (_e, expr) => {
    return runtime.query(expr);
  });

  ipcMain.handle('r:knit', async (_e, opts) => {
    return runtime.knitRmd(opts);
  });

  // --- LSP & Diagnostics ---
  ipcMain.handle('lsp:didOpen', async (_e, { uri, text, isRmd }) => {
    return lsp.didOpen(uri, text, { isRmd });
  });

  ipcMain.handle('lsp:didChange', async (_e, { uri, text, isRmd }) => {
    return lsp.didChange(uri, text, { isRmd });
  });

  ipcMain.handle('lsp:didClose', async (_e, { uri }) => {
    lsp.didClose(uri);
    return true;
  });

  ipcMain.handle('lsp:hover', async (_e, { uri, line, character }) => {
    return lsp.hover(uri, line, character);
  });

  ipcMain.handle('lsp:completion', async (_e, { uri, line, character }) => {
    return lsp.completion(uri, line, character);
  });

  // --- R Commander Service ---
  ipcMain.handle('rcmdr:getTree', async (_e, lang) => {
    return rcmdr.getTree(lang);
  });

  ipcMain.handle('rcmdr:openCommand', async (_e, { id, activeDataset, activeModel, lang }) => {
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
}

async function bootServices() {
  runtime = new RRuntime();
  rcmdr = new RcmdrService();
  lsp = new RLanguageServer({ rscriptPath: runtime.rscriptPath });

  runtime.on('output', (payload) => sendToRenderer('r:output', payload));
  lsp.on('diagnostics', (payload) => sendToRenderer('lsp:diagnostics', payload));
  lsp.on('status', (status) => sendToRenderer('lsp:status', status));

  bridge = new NoteCompleteBridge({
    runtime,
    rcmdr,
    getDatasets: () => Object.keys(lastSnapshot?.datasets || {}),
    onOpenScript: ({ title, code, kind }) => {
      sendToRenderer('bridge:openScript', { title, code, kind });
      focusMainWindow();
    }
  });

  await bridge.start();
  // Kick off background R session & LSP startup without blocking UI
  runtime.ensureSession().catch(() => {});
  lsp.start().catch(() => {});
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
}

app.whenReady().then(async () => {
  buildAppMenu();
  await bootServices();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

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
