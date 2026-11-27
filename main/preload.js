'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('studio', {
  getInitInfo: () => ipcRenderer.invoke('studio:init'),
  setLanguage: (lang) => ipcRenderer.invoke('studio:setLanguage', lang),
  updateSettings: (patch) => ipcRenderer.invoke('studio:updateSettings', patch),
  setUiZoom: (factor) => {
    const f = Math.max(0.65, Math.min(1.75, Number(factor) || 1));
    webFrame.setZoomFactor(f);
    return f;
  },
  getUiZoom: () => webFrame.getZoomFactor(),

  // File & Workspace Explorer I/O
  openFile: (payload) => ipcRenderer.invoke('file:open', payload),
  openPath: (filePath) => ipcRenderer.invoke('file:openPath', filePath),
  openDataFileDialog: () => ipcRenderer.invoke('file:openDataFileDialog'),
  openRnoteDialog: (payload) => ipcRenderer.invoke('file:openRnoteDialog', payload),
  loadRnote: (filePath) => ipcRenderer.invoke('rnote:load', filePath),
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  saveFileAs: (payload) => ipcRenderer.invoke('file:saveAs', payload),
  saveSvg: (payload) => ipcRenderer.invoke('file:saveSvg', payload),
  savePlotPng: (payload) => ipcRenderer.invoke('file:savePlotPng', payload),
  savePlotPdf: (payload) => ipcRenderer.invoke('file:savePlotPdf', payload),
  browsePath: (payload) => ipcRenderer.invoke('file:browse', payload),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  openFolder: () => ipcRenderer.invoke('fs:openFolder'),
  readDirTree: (root) => ipcRenderer.invoke('fs:readDirTree', root),
  createFile: (payload) => ipcRenderer.invoke('fs:createFile', payload),
  createDir: (payload) => ipcRenderer.invoke('fs:createDir', payload),
  renamePath: (payload) => ipcRenderer.invoke('fs:rename', payload),
  deletePath: (targetPath) => ipcRenderer.invoke('fs:delete', targetPath),

  // R Runtime & arf Terminal
  runCode: (payload) => ipcRenderer.invoke('r:run', payload),
  loadDataFile: (filePath) => ipcRenderer.invoke('r:loadDataFile', filePath),
  interruptR: () => ipcRenderer.invoke('r:interrupt'),
  restartR: () => ipcRenderer.invoke('r:restart'),
  snapshot: () => ipcRenderer.invoke('r:snapshot'),
  queryR: (expr) => ipcRenderer.invoke('r:query', expr),
  knitRmd: (payload) => ipcRenderer.invoke('r:knit', payload),
  rHelp: (topic) => ipcRenderer.invoke('r:help', topic),
  rHelpSuggest: (query) => ipcRenderer.invoke('r:helpSuggest', query),
  rFnHelp: (payload) => ipcRenderer.invoke('r:fnHelp', payload),

  arfStart: () => ipcRenderer.invoke('arf:start'),
  arfSend: (code) => ipcRenderer.invoke('arf:send', code),
  arfWrite: (data) => ipcRenderer.invoke('arf:write', data),
  arfResize: (payload) => ipcRenderer.invoke('arf:resize', payload),
  arfInterrupt: () => ipcRenderer.invoke('arf:interrupt'),
  arfRestart: () => ipcRenderer.invoke('arf:restart'),

  // Interactive Table & Data Viewer
  tableGetPage: (payload) => ipcRenderer.invoke('table:getPage', payload),
  tableColSummary: (payload) => ipcRenderer.invoke('table:colSummary', payload),
  tableEditCell: (payload) => ipcRenderer.invoke('table:editCell', payload),
  tableAddRow: (payload) => ipcRenderer.invoke('table:addRow', payload),
  tableAddCol: (payload) => ipcRenderer.invoke('table:addCol', payload),
  tableExportCsv: (payload) => ipcRenderer.invoke('table:exportCsv', payload),
  tableParseDelimited: (payload) => ipcRenderer.invoke('table:parseDelimited', payload),
  tableSerializeDelimited: (payload) => ipcRenderer.invoke('table:serializeDelimited', payload),
  tableToMarkdown: (payload) => ipcRenderer.invoke('table:toMarkdown', payload),

  // LSP & Diagnostics
  lspDidOpen: (payload) => ipcRenderer.invoke('lsp:didOpen', payload),
  lspDidChange: (payload) => ipcRenderer.invoke('lsp:didChange', payload),
  lspDidClose: (payload) => ipcRenderer.invoke('lsp:didClose', payload),
  lspHover: (payload) => ipcRenderer.invoke('lsp:hover', payload),
  lspCompletion: (payload) => ipcRenderer.invoke('lsp:completion', payload),
  lspCheckPackage: () => ipcRenderer.invoke('lsp:checkPackage'),
  lspInstallPackage: (payload) => ipcRenderer.invoke('lsp:installPackage', payload),
  onLspInstallProgress: (cb) => subscribe('lsp:installProgress', cb),

  // R Commander
  rcmdrGetTree: (lang) => ipcRenderer.invoke('rcmdr:getTree', lang),
  rcmdrSearchCommands: (payload) => ipcRenderer.invoke('rcmdr:searchCommands', payload),
  rcmdrMenuHover: (payload) => ipcRenderer.invoke('rcmdr:menuHover', payload),
  rcmdrOpenCommand: (payload) => ipcRenderer.invoke('rcmdr:openCommand', payload),
  rcmdrUpdateLayout: (payload) => ipcRenderer.invoke('rcmdr:updateLayout', payload),
  rcmdrSwitchDataset: (payload) => ipcRenderer.invoke('rcmdr:switchDataset', payload),
  rcmdrResetDialog: (payload) => ipcRenderer.invoke('rcmdr:resetDialog', payload),
  rcmdrSubmitDialog: (payload) => ipcRenderer.invoke('rcmdr:submitDialog', payload),
  rcmdrCloseDialog: (payload) => ipcRenderer.invoke('rcmdr:closeDialog', payload),
  rcmdrReportHelper: (payload) => ipcRenderer.invoke('rcmdr:reportHelper', payload),

  // Updates, System Desktop Integration & Popout Output Window
  updaterCheck: (payload) => ipcRenderer.invoke('updater:check', payload),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  updaterRestart: () => ipcRenderer.invoke('updater:restart'),
  updaterSettings: () => ipcRenderer.invoke('updater:settings'),
  updaterListReleases: () => ipcRenderer.invoke('updater:listReleases'),
  buildInfo: () => ipcRenderer.invoke('studio:buildInfo'),
  updaterSetCheckOnOpen: (on) => ipcRenderer.invoke('updater:setCheckOnOpen', on),
  installDesktop: () => ipcRenderer.invoke('studio:installDesktop'),
  openOutputWindow: (payload) => ipcRenderer.invoke('studio:openOutputWindow', payload),
  checkSessionPaths: (payload) => ipcRenderer.invoke('studio:checkSessionPaths', payload),
  confirmCloseDialog: (payload) => ipcRenderer.invoke('studio:confirmCloseDialog', payload),
  allowClose: () => ipcRenderer.invoke('studio:allowClose'),
  onRequestClose: (cb) => subscribe('studio:requestClose', cb),

  // T3 Code Background Copilot & Cross-Platform Installer
  t3Status: () => ipcRenderer.invoke('t3:status'),
  t3Start: () => ipcRenderer.invoke('t3:start'),
  t3Install: (payload) => ipcRenderer.invoke('t3:install', payload),
  t3Ask: (payload) => ipcRenderer.invoke('t3:ask', payload),
  t3Providers: () => ipcRenderer.invoke('t3:providers'),
  t3Models: (payload) => ipcRenderer.invoke('t3:models', payload),
  t3Transcribe: (payload) => ipcRenderer.invoke('t3:transcribe', payload),
  onT3InstallProgress: (cb) => subscribe('t3:installProgress', cb),

  // Events
  onROutput: (cb) => subscribe('r:output', cb),
  onRViewTable: (cb) => subscribe('r:viewTable', cb),
  onArfOutput: (cb) => subscribe('arf:output', cb),
  onArfStatus: (cb) => subscribe('arf:status', cb),
  onDiagnostics: (cb) => subscribe('lsp:diagnostics', cb),
  onLspStatus: (cb) => subscribe('lsp:status', cb),
  onBridgeOpenScript: (cb) => subscribe('bridge:openScript', cb),
  onBridgeOpenPath: (cb) => subscribe('bridge:openPath', cb),
  onMenuCommand: (cb) => subscribe('menu:command', cb),
  onMenuRcmdr: (cb) => subscribe('menu:rcmdr', cb),
  onZoomStep: (cb) => subscribe('studio:zoomStep', cb),
  onUpdaterAvailable: (cb) => subscribe('updater:available', cb),
  onUpdaterProgress: (cb) => subscribe('updater:progress', cb)
});
