#!/usr/bin/env node
/**
 * Captures crisp real screenshots of R Commander Studio + renders assets/icon.png (512x512)
 * directly from Electron's Chromium engine using offscreen / hidden capturePage().
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const electronBin = path.join(repoRoot, 'node_modules', '.bin', 'electron');

const captureDriver = path.join(repoRoot, 'tools', '_capture-driver.cjs');
const driverSource = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain } = require('electron');

const repoRoot = ${JSON.stringify(repoRoot)};
const { RRuntime } = require(path.join(repoRoot, 'main', 'r-runtime.js'));
const { RLanguageServer } = require(path.join(repoRoot, 'main', 'r-lsp.js'));
const { RcmdrService, report } = require(path.join(repoRoot, 'main', 'rcmdr-service.js'));
const fsService = require(path.join(repoRoot, 'main', 'fs-service.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const runtime = new RRuntime();
  const rcmdr = new RcmdrService();
  const lsp = new RLanguageServer({ rscriptPath: runtime.rscriptPath });
  let lastSnapshot = { datasets: {}, models: [], hclusts: [], objects: [] };

  // 1. Render crisp 512x512 PNG app icon from assets/icon.svg
  const iconSvg = fs.readFileSync(path.join(repoRoot, 'assets', 'icon.svg'), 'utf8');
  const iconWin = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true, sandbox: true }
  });
  await iconWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!DOCTYPE html><html><body style="margin:0;width:512px;height:512px;overflow:hidden;background:transparent">' +
    iconSvg.replace(/width="128"/, 'width="512"').replace(/height="128"/, 'height="512"') +
    '</body></html>'
  ));
  await sleep(250);
  const iconImg = await iconWin.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(path.join(repoRoot, 'assets', 'icon.png'), iconImg.toPNG());
  iconWin.destroy();
  console.log('Generated assets/icon.png (512x512)');

  // 2. Register IPC needed by renderer
  const monacoVsDir = path.join(repoRoot, 'node_modules', 'monaco-editor', 'min', 'vs');
  ipcMain.handle('studio:init', async () => ({
    env: await runtime.probeEnvironment(),
    bridge: { port: 49152, protocolVersion: 1 },
    tree: rcmdr.getTree('es'),
    rcmdrCount: rcmdr.getCatalogSummary().count,
    lspStatus: 'ready',
    monacoVsUrl: pathToFileURL(monacoVsDir).href
  }));
  ipcMain.handle('studio:setLanguage', (_e, lang) => { rcmdr.setLanguage(lang); return { lang }; });
  ipcMain.handle('studio:updateSettings', (_e, p) => rcmdr.updateSettings(p));
  ipcMain.handle('r:run', async (_e, opts) => {
    const res = await runtime.runCode(opts.code || '', opts);
    lastSnapshot = await runtime.snapshot();
    return { ...res, snapshot: lastSnapshot };
  });
  ipcMain.handle('r:snapshot', async () => (lastSnapshot = await runtime.snapshot()));
  ipcMain.handle('r:query', (_e, expr) => runtime.query(expr));
  ipcMain.handle('r:help', (_e, topic) => runtime.getFunctionHelp(topic));
  ipcMain.handle('r:fnHelp', (_e, { fnName, pkg }) => runtime.getFunctionHelp(fnName, pkg));
  ipcMain.handle('table:getPage', (_e, opts) => runtime.getTablePage(opts));
  ipcMain.handle('table:colSummary', (_e, opts) => runtime.getColumnSummary(opts));
  ipcMain.handle('table:parseDelimited', (_e, o) => fsService.parseDelimited(o.text, o.delimiter));
  ipcMain.handle('table:toMarkdown', (_e, o) => fsService.toMarkdownTable(o.columns, o.rows));
  ipcMain.handle('lsp:didOpen', (_e, { uri, text, isRmd }) => lsp.didOpen(uri, text, { isRmd }));
  ipcMain.handle('lsp:didChange', (_e, { uri, text, isRmd }) => lsp.didChange(uri, text, { isRmd }));
  ipcMain.handle('lsp:didClose', () => true);
  ipcMain.handle('lsp:hover', () => null);
  ipcMain.handle('lsp:completion', () => []);
  ipcMain.handle('rcmdr:getTree', (_e, lang) => rcmdr.getTree(lang));
  ipcMain.handle('rcmdr:searchCommands', (_e, { query, lang }) => rcmdr.searchCommands(query, lang));
  ipcMain.handle('rcmdr:menuHover', (_e, { fnName, lang }) => rcmdr.getMenuHover(fnName, lang));
  ipcMain.handle('rcmdr:openCommand', async (_e, opts) =>
    rcmdr.openCommand(opts.id, { state: lastSnapshot, ...opts, queryFn: (expr, to) => runtime.query(expr, to) })
  );
  ipcMain.handle('rcmdr:updateLayout', (_e, opts) =>
    rcmdr.updateLayout(opts.sessionId, { ...opts, queryFn: (expr, to) => runtime.query(expr, to) })
  );
  ipcMain.handle('rcmdr:closeDialog', (_e, { sessionId }) => { rcmdr.closeDialog(sessionId); return true; });
  ipcMain.handle('rcmdr:reportHelper', (_e, { action, kind, text, title, code }) => {
    if (action === 'template') return report.template(kind);
    if (action === 'append') return report.append(kind, text, title, code);
    return text;
  });

  // 3. Boot hidden offscreen Electron window at crisp 1440x900
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    backgroundColor: '#282A36',
    webPreferences: {
      preload: path.join(repoRoot, 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true
    }
  });
  runtime.on('output', (p) => win.webContents.send('r:output', p));
  lsp.on('diagnostics', (p) => win.webContents.send('lsp:diagnostics', p));

  await win.loadURL(pathToFileURL(path.join(repoRoot, 'renderer', 'index.html')).href);
  await sleep(1800);

  const outDir = path.join(repoRoot, 'docs', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });

  // Shot 1: VS Code Dracula IDE with live R run (mtcars + fit + ggplot2 plot + R Commander sidebar)
  await win.webContents.executeJavaScript(\`
    (async () => {
      const D = window.__STUDIO_DEBUG__;
      D.applyTheme('dark');
      await D.switchLanguage('en');
      const code = D.extractCodeToRun(true);
      await D.executeR(code, { fromMenu: true });
      D.openPanelTab('console');
    })()
  \`);
  await sleep(1200);
  const s1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, '01-dracula-ide.png'), s1.toPNG());
  console.log('Captured docs/screenshots/01-dracula-ide.png');

  // Shot 2: Split Editor + Live Interactive Table Viewer (mtcars + column Sigma summary) + ggplot2 Plot!
  await win.webContents.executeJavaScript(\`
    (async () => {
      const D = window.__STUDIO_DEBUG__;
      D.openSplitGroup();
      D.openRTableTab({ objectName: 'mtcars', title: 'mtcars', editable: false, groupIndex: 1 });
      D.openPanelTab('plots');
    })()
  \`);
  await sleep(900);
  await win.webContents.executeJavaScript(\`
    (async () => {
      const statBtn = document.querySelector('#tableHost1 .tv-col-stat');
      if (statBtn) statBtn.click();
    })()
  \`);
  await sleep(600);
  const s2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, '02-table-viewer-plots.png'), s2.toPNG());
  console.log('Captured docs/screenshots/02-table-viewer-plots.png');

  // Shot 3: VS Code Light+ Theme with R Markdown + Live Preview
  await win.webContents.executeJavaScript(\`
    (async () => {
      const D = window.__STUDIO_DEBUG__;
      D.applyTheme('vscode-light');
      await D.switchLanguage('en');
    })()
  \`);
  await sleep(600);
  const s3Light = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, '03-light-theme.png'), s3Light.toPNG());
  console.log('Captured docs/screenshots/03-light-theme.png');

  // Shot 4: Bilingual Spanish R Commander Dialog (Boxplot / Diagrama de cajas) over Dracula IDE!
  await win.webContents.executeJavaScript(\`
    (async () => {
      const D = window.__STUDIO_DEBUG__;
      D.applyTheme('dracula');
      await D.switchLanguage('es');
      await D.triggerRcmdrCommand('boxPlot');
    })()
  \`);
  await sleep(800);
  const s4 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, '04-rcmdr-dialog-es.png'), s4.toPNG());
  console.log('Captured docs/screenshots/04-rcmdr-dialog-es.png');

  lsp.stop();
  runtime.stopSession();
  win.destroy();
  app.quit();
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

fs.writeFileSync(captureDriver, driverSource, 'utf8');

const env = { ...process.env };
const args = ['--disable-gpu', '--no-sandbox', captureDriver];
const child = spawn(electronBin, args, { stdio: 'inherit', env });
child.on('close', (code) => {
  try {
    fs.unlinkSync(captureDriver);
  } catch {
    // ignore
  }
  process.exit(code ?? 0);
});
