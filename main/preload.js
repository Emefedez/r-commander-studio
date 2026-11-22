'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('studio', {
  getInitInfo: () => ipcRenderer.invoke('studio:init'),

  // File I/O
  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  saveFileAs: (payload) => ipcRenderer.invoke('file:saveAs', payload),
  saveSvg: (payload) => ipcRenderer.invoke('file:saveSvg', payload),
  browsePath: (payload) => ipcRenderer.invoke('file:browse', payload),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // R Runtime
  runCode: (payload) => ipcRenderer.invoke('r:run', payload),
  interruptR: () => ipcRenderer.invoke('r:interrupt'),
  restartR: () => ipcRenderer.invoke('r:restart'),
  snapshot: () => ipcRenderer.invoke('r:snapshot'),
  queryR: (expr) => ipcRenderer.invoke('r:query', expr),
  knitRmd: (payload) => ipcRenderer.invoke('r:knit', payload),

  // LSP & Diagnostics
  lspDidOpen: (payload) => ipcRenderer.invoke('lsp:didOpen', payload),
  lspDidChange: (payload) => ipcRenderer.invoke('lsp:didChange', payload),
  lspDidClose: (payload) => ipcRenderer.invoke('lsp:didClose', payload),
  lspHover: (payload) => ipcRenderer.invoke('lsp:hover', payload),
  lspCompletion: (payload) => ipcRenderer.invoke('lsp:completion', payload),

  // R Commander
  rcmdrGetTree: (lang) => ipcRenderer.invoke('rcmdr:getTree', lang),
  rcmdrOpenCommand: (payload) => ipcRenderer.invoke('rcmdr:openCommand', payload),
  rcmdrUpdateLayout: (payload) => ipcRenderer.invoke('rcmdr:updateLayout', payload),
  rcmdrSwitchDataset: (payload) => ipcRenderer.invoke('rcmdr:switchDataset', payload),
  rcmdrResetDialog: (payload) => ipcRenderer.invoke('rcmdr:resetDialog', payload),
  rcmdrSubmitDialog: (payload) => ipcRenderer.invoke('rcmdr:submitDialog', payload),
  rcmdrCloseDialog: (payload) => ipcRenderer.invoke('rcmdr:closeDialog', payload),
  rcmdrReportHelper: (payload) => ipcRenderer.invoke('rcmdr:reportHelper', payload),

  // Events
  onROutput: (cb) => subscribe('r:output', cb),
  onDiagnostics: (cb) => subscribe('lsp:diagnostics', cb),
  onLspStatus: (cb) => subscribe('lsp:status', cb),
  onBridgeOpenScript: (cb) => subscribe('bridge:openScript', cb),
  onMenuCommand: (cb) => subscribe('menu:command', cb)
});
