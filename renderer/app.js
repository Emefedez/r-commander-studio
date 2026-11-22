(async function () {
  'use strict';

  const { t, getLang, setLang, applyToDom } = window.StudioI18n;
  const { svg, rcmdrColor } = window.StudioIcons;
  const { FileGroupsModel } = window.StudioFileGroups;
  const { WorkbenchLayoutModel } = window.StudioWorkbenchLayout;
  const { loadSettings, saveSettings, StudioSettingsModal } = window.StudioSettings;

  const DEFAULT_R_SCRIPT = `# R Commander Studio — Quick Start
data(mtcars)
summary(mtcars[, c("mpg", "wt", "hp")])
fit <- lm(mpg ~ wt + hp, data = mtcars)

# Generate a plot (captured automatically in Plots)
if (requireNamespace("ggplot2", quietly = TRUE)) {
  library(ggplot2)
  ggplot(mtcars, aes(x = wt, y = mpg, color = factor(cyl))) +
    geom_point(size = 2.6, alpha = 0.85) +
    geom_smooth(method = "lm", se = FALSE) +
    labs(
      title = "Fuel Efficiency vs. Vehicle Weight",
      x = "Weight (1000 lbs)",
      y = "Miles per Gallon",
      color = "Cylinders"
    ) +
    theme_minimal()
} else {
  plot(mtcars$wt, mtcars$mpg, pch = 19, col = "#6272A4",
       xlab = "Weight (1000 lbs)", ylab = "Miles per Gallon",
       main = "Fuel Efficiency vs. Vehicle Weight")
}
`;

  const DEFAULT_RMD_DOC = `---
title: "Exploratory Analysis"
author: "R Commander Studio"
date: "AUTOMATIC"
output: html_document
---

## Overview

This **R Markdown** document demonstrates YAML frontmatter, Markdown prose, fenced R code chunks, live R hover documentation, and real-time R error checking.

\`\`\`{r setup, message=FALSE}
data(iris)
aggregate(Sepal.Length ~ Species, data = iris, FUN = mean)
\`\`\`

### Summary Plot

\`\`\`{r plot-iris, fig.width=6, fig.height=4}
boxplot(Sepal.Length ~ Species, data = iris,
        col = c("#BD93F9", "#8BE9FD", "#50FA7B"),
        main = "Iris Sepal Length by Species")
\`\`\`
`;

  // Hydrate all static [data-icon] elements in index.html with crisp inline SVGs
  function hydrateStaticIcons(root = document) {
    for (const el of root.querySelectorAll('[data-icon]')) {
      const name = el.getAttribute('data-icon');
      const size = Number(el.getAttribute('data-size')) || 16;
      el.innerHTML = svg(name, { size });
    }
  }

  function loadSavedLayout() {
    try {
      return new WorkbenchLayoutModel(JSON.parse(localStorage.getItem('rcs-layout-v2') || 'null'));
    } catch {
      return new WorkbenchLayoutModel();
    }
  }

  function persistLayout() {
    localStorage.setItem('rcs-layout-v2', JSON.stringify(state.layout.serialize()));
  }

  const state = {
    monaco: null,
    editors: [null, null],
    tableViewers: [null, null],
    tabs: [],
    activeTabByGroup: [null, null],
    focusedGroup: 0,
    splitOpen: false,
    nextTabNum: 1,

    // Dracula default; optional Light+
    theme: localStorage.getItem('rcs-theme-v2') === 'light' ? 'light' : 'dark',
    settings: loadSettings(),
    layout: loadSavedLayout(),
    activePanelTab: 'console', // 'console' | 'arf' | 'plots' | 'problems' | 'help'
    runTarget: localStorage.getItem('rcs-run-target') || 'r', // 'r' | 'arf'

    tree: [],
    workspaceRoot: null,
    workspaceName: '',
    folderTree: [],
    fileGroups: new FileGroupsModel(),

    snapshot: { datasets: {}, models: [], hclusts: [], objects: [] },
    activeDataset: null,
    activeModel: null,
    recordingDocs: { rmd: null, rnw: null },
    diagnosticsByUri: new Map(),
    plots: [],
    plotIndex: -1,
    plotZoom: 1,
    previewOpen: false,
    previewMode: 'live',
    knittedHtml: '',
    lspTimers: new Map(),
    lspStatus: 'starting',
    bridgePort: null,
    rVersion: null,
    arfAvailable: false,
    arfStarted: false,
    running: false,
    rHistory: [],
    rHistoryIdx: -1,
    arfHistory: [],
    arfHistoryIdx: -1
  };

  const $ = (id) => document.getElementById(id);

  let toastTimer = null;
  function showToast(message, kind = 'info') {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 3600);
  }

  function detectLanguage(filename = '') {
    const ext = String(filename).toLowerCase().split('.').pop();
    if (ext === 'rmd' || ext === 'qmd') return 'rmd';
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    if (ext === 'r') return 'r';
    return 'plaintext';
  }

  function isRmdOrR(lang) {
    return lang === 'r' || lang === 'rmd';
  }

  function isDataBinaryExt(filename = '') {
    return /\.(rdata|rda|rds|xlsx|xls)$/i.test(filename);
  }

  function isDelimitedExt(filename = '') {
    return /\.(csv|tsv)$/i.test(filename);
  }

  // --- File Groups Persistence ---
  function groupsStorageKey() {
    return `rcs-filegroups:${state.workspaceRoot || '__default__'}`;
  }

  function loadFileGroups() {
    try {
      state.fileGroups = new FileGroupsModel(JSON.parse(localStorage.getItem(groupsStorageKey()) || 'null'));
    } catch {
      state.fileGroups = new FileGroupsModel();
    }
  }

  function saveFileGroups() {
    localStorage.setItem(groupsStorageKey(), JSON.stringify(state.fileGroups.serialize()));
  }

  function tabKey(tab) {
    return tab.filePath || `${tab.kind}:${tab.name}`;
  }

  // --- Live Theme Engine (8 Built-in Presets + Live Custom Token Overrides + Monaco Sync) ---
  function applyThemePreset(presetId, overrides = {}) {
    const { resolveTheme, THEME_TOKEN_KEYS } = window.StudioThemes;
    const resolved = resolveTheme(presetId || state.settings.themePreset || 'dracula', overrides);
    state.theme = resolved.isLight ? 'light' : 'dark';
    state.activeThemePreset = resolved.id;

    if (resolved.isLight) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');

    const rootStyle = document.documentElement.style;
    for (const def of THEME_TOKEN_KEYS) {
      rootStyle.setProperty(def.css, resolved.tokens[def.key]);
    }
    rootStyle.setProperty('--bg-input', resolved.isLight ? resolved.tokens.bgEditor : resolved.tokens.bgChrome);
    rootStyle.setProperty('--bg-menu', resolved.tokens.bgSidebar);
    rootStyle.setProperty('--border', resolved.isLight ? resolved.tokens.border : resolved.tokens.bgChrome);
    rootStyle.setProperty('--accent-pink-soft', resolved.tokens.tabHighlight);
    rootStyle.setProperty('--focus-border', resolved.tokens.accent);
    rootStyle.setProperty('--btn-primary-bg', resolved.tokens.accent);
    rootStyle.setProperty('--btn-primary-fg', resolved.isLight ? '#FFFFFF' : '#191A21');

    $('statusThemeBtn').textContent = resolved.name;
    $('actTheme').innerHTML = svg(resolved.isLight ? 'sun' : 'moon', { size: 18 });

    if (state.monaco) {
      const syn = resolved.syntax;
      state.monaco.editor.defineTheme('studio-active', {
        base: resolved.isLight ? 'vs' : 'vs-dark',
        inherit: true,
        rules: [
          { token: '', foreground: resolved.tokens.fg.slice(1), background: resolved.tokens.bgEditor.slice(1) },
          { token: 'comment', foreground: syn.comment, fontStyle: 'italic' },
          { token: 'comment.quote', foreground: syn.comment, fontStyle: 'italic' },
          { token: 'keyword', foreground: syn.keyword },
          { token: 'keyword.heading', foreground: syn.keyword, fontStyle: 'bold' },
          { token: 'keyword.fence', foreground: syn.comment },
          { token: 'tag.chunk', foreground: syn.fn },
          { token: 'meta.frontmatter', foreground: syn.number },
          { token: 'attribute.name', foreground: syn.fn },
          { token: 'entity.name.function', foreground: syn.fn },
          { token: 'constant', foreground: syn.number },
          { token: 'number', foreground: syn.number },
          { token: 'string', foreground: syn.string },
          { token: 'string.code', foreground: syn.fn },
          { token: 'string.link', foreground: syn.type, fontStyle: 'underline' },
          { token: 'type', foreground: syn.type, fontStyle: 'italic' },
          { token: 'operator', foreground: syn.operator },
          { token: 'operator.special', foreground: syn.operator }
        ],
        colors: {
          'editor.background': resolved.tokens.bgEditor,
          'editor.foreground': resolved.tokens.fg,
          'editorLineNumber.foreground': resolved.tokens.fgMuted,
          'editorLineNumber.activeForeground': resolved.tokens.fg,
          'editor.selectionBackground': resolved.tokens.selection,
          'editor.lineHighlightBackground': resolved.isLight ? '#0000000A' : '#FFFFFF0B',
          'editorCursor.foreground': resolved.tokens.fg,
          'editorWidget.background': resolved.tokens.bgSidebar,
          'editorWidget.border': resolved.tokens.border,
          'editorGutter.background': resolved.tokens.bgEditor,
          'editorError.foreground': syn.error,
          'editorWarning.foreground': syn.warn
        }
      });
      state.monaco.editor.setTheme('studio-active');
    }
  }

  function applyTheme(modeOrPreset) {
    if (modeOrPreset === 'light') {
      const target = state.settings.lastLightPreset || 'vscode-light';
      state.settings.themePreset = target;
      state.settings.themeOverrides = {};
      saveSettings(state.settings);
      applyThemePreset(target, {});
    } else if (modeOrPreset === 'dark') {
      const target = state.settings.lastDarkPreset || 'dracula';
      state.settings.themePreset = target;
      state.settings.themeOverrides = {};
      saveSettings(state.settings);
      applyThemePreset(target, {});
    } else {
      state.settings.themePreset = modeOrPreset;
      state.settings.themeOverrides = {};
      saveSettings(state.settings);
      applyThemePreset(modeOrPreset, {});
    }
  }

  // --- Workbench Layout Engine (2 independent sidebars + dockable panel + H/V tabs) ---
  function applyWorkbenchLayout() {
    const dockLeft = $('dockLeft');
    const dockRight = $('dockRight');
    const dockBottom = $('dockBottom');
    const leftGrip = $('leftDockGrip');
    const rightGrip = $('rightDockGrip');
    const bottomGrip = $('bottomPanelGrip');

    const sbExplorer = $('sidebarExplorer');
    const sbRcmdr = $('sidebarRcmdr');
    const panel = $('dockPanel');

    const L = state.layout;

    // Place sidebars into left or right dock (side-by-side when on the same side)
    // plus handle floating peek-open state when hovering a collapsed rail!
    const peekLeft = $('peekRailLeft');
    const peekRight = $('peekRailRight');
    peekLeft.textContent = '';
    peekRight.textContent = '';

    for (const [id, el] of [
      ['explorer', sbExplorer],
      ['rcmdr', sbRcmdr]
    ]) {
      const cfg = L.sidebars[id];
      const peeking = L.isPeeking(id);
      el.style.setProperty('--sb-width', `${cfg.width || 268}px`);
      el.classList.toggle('peek-open', peeking);
      el.classList.toggle('peek-left', peeking && cfg.dock === 'left');
      el.classList.toggle('peek-right', peeking && cfg.dock === 'right');
      el.hidden = !cfg.open && !peeking;

      const targetDock = cfg.dock === 'right' ? dockRight : dockLeft;
      if (el.parentElement !== targetDock) targetDock.append(el);

      // Render collapsed peek rail button when closed
      if (!cfg.open) {
        const rail = cfg.dock === 'right' ? peekRight : peekLeft;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'peek-rail-btn';
        btn.title = id === 'explorer' ? t('sidebarExplorerTitle') : t('sidebarRcmdrTitle');
        btn.innerHTML = svg(id === 'explorer' ? 'files' : 'r-logo', { size: 15 });
        btn.addEventListener('mouseenter', () => schedulePeekOpen(id));
        btn.addEventListener('mouseleave', () => schedulePeekClose(id));
        btn.addEventListener('click', () => {
          L.closePeek(id);
          L.setSidebarOpen(id, true);
          applyWorkbenchLayout();
        });
        rail.append(btn);
      }
    }

    peekLeft.hidden = !peekLeft.children.length;
    peekRight.hidden = !peekRight.children.length;

    // Place dockable panel into bottom, left, or right dock
    panel.hidden = !L.panel.open;
    const panelTarget =
      L.panel.dock === 'left' ? dockLeft : L.panel.dock === 'right' ? dockRight : dockBottom;
    if (panel.parentElement !== panelTarget) panelTarget.append(panel);

    // Apply panel horizontal vs vertical tab orientation
    panel.classList.toggle('orient-horizontal', L.panel.orientation === 'horizontal');
    panel.classList.toggle('orient-vertical', L.panel.orientation === 'vertical');
    $('btnPanelOrient').innerHTML = svg(L.panel.orientation === 'horizontal' ? 'orient-v' : 'orient-h', { size: 14 });

    // Update dock flip icons & titles on each sidebar
    const expFlip = $('btnFlipExplorer');
    expFlip.innerHTML = svg(L.sidebars.explorer.dock === 'left' ? 'dock-right' : 'dock-left', { size: 14 });
    expFlip.title = L.sidebars.explorer.dock === 'left' ? t('moveSidebarRight') : t('moveSidebarLeft');

    const rcmdrFlip = $('btnFlipRcmdr');
    rcmdrFlip.innerHTML = svg(L.sidebars.rcmdr.dock === 'left' ? 'dock-right' : 'dock-left', { size: 14 });
    rcmdrFlip.title = L.sidebars.rcmdr.dock === 'left' ? t('moveSidebarRight') : t('moveSidebarLeft');

    // Show/hide left, right, and bottom containers based on visible NON-peeking children
    const hasLeft = [...dockLeft.children].some((c) => !c.hidden && !c.classList.contains('peek-open'));
    const hasRight = [...dockRight.children].some((c) => !c.hidden && !c.classList.contains('peek-open'));
    const hasBottom = L.panel.open && L.panel.dock === 'bottom';

    dockLeft.hidden = !hasLeft && !L.isPeeking('explorer') && !L.isPeeking('rcmdr');
    leftGrip.hidden = !hasLeft;
    dockRight.hidden = !hasRight && !L.isPeeking('explorer') && !L.isPeeking('rcmdr');
    rightGrip.hidden = !hasRight;
    dockBottom.hidden = !hasBottom;
    bottomGrip.hidden = !hasBottom;

    if (hasBottom) dockBottom.style.height = `${L.panel.size}px`;

    // Sync Activity Bar & Top Bar active indicators
    $('actExplorer').classList.toggle('active', L.sidebars.explorer.open);
    $('actRcmdr').classList.toggle('active', L.sidebars.rcmdr.open);
    $('btnToggleExplorer').classList.toggle('active', L.sidebars.explorer.open);
    $('btnToggleRcmdr').classList.toggle('active', L.sidebars.rcmdr.open);
    $('btnTogglePanel').classList.toggle('active', L.panel.open);

    persistLayout();
    state.editors.forEach((ed) => ed?.layout());
  }

  // --- Hover-to-Peek Closed Sidebars (Auto-Open on Hover -> Auto-Close on Choice) ---
  let peekOpenTimer = null;
  let peekCloseTimer = null;

  function schedulePeekOpen(id) {
    if (state.settings.hoverPeekSidebars === false) return;
    if (state.layout.sidebars[id]?.open) return;
    clearTimeout(peekCloseTimer);
    clearTimeout(peekOpenTimer);
    peekOpenTimer = setTimeout(() => {
      if (state.layout.openPeek(id)) applyWorkbenchLayout();
    }, 120);
  }

  function schedulePeekClose(id) {
    clearTimeout(peekOpenTimer);
    clearTimeout(peekCloseTimer);
    peekCloseTimer = setTimeout(() => {
      // Keep peek open while typing inside the sidebar's search input
      const sbEl = id === 'explorer' ? $('sidebarExplorer') : $('sidebarRcmdr');
      if (sbEl && sbEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
      if (state.layout.closePeek(id)) applyWorkbenchLayout();
    }, 280);
  }

  function dismissPeekAfterSelection(id) {
    clearTimeout(peekOpenTimer);
    clearTimeout(peekCloseTimer);
    if (state.layout.onSelectionInSidebar(id)) applyWorkbenchLayout();
  }

  for (const [id, sbId, actId] of [
    ['explorer', 'sidebarExplorer', 'actExplorer'],
    ['rcmdr', 'sidebarRcmdr', 'actRcmdr']
  ]) {
    const sbEl = $(sbId);
    const actEl = $(actId);
    sbEl.addEventListener('mouseenter', () => clearTimeout(peekCloseTimer));
    sbEl.addEventListener('mouseleave', () => {
      if (state.layout.isPeeking(id)) schedulePeekClose(id);
    });
    actEl.addEventListener('mouseenter', () => schedulePeekOpen(id));
    actEl.addEventListener('mouseleave', () => {
      if (state.layout.isPeeking(id)) schedulePeekClose(id);
    });
  }

  // --- Drag-and-Drop Workbench Docking (Sidebars + Panel) ---
  function wireWorkbenchDragDock() {
    let draggingWhat = null; // 'explorer' | 'rcmdr' | 'panel'
    const zLeft = $('dropZoneLeft');
    const zRight = $('dropZoneRight');
    const zBottom = $('dropZoneBottom');

    const hideZones = () => {
      zLeft.hidden = true;
      zRight.hidden = true;
      zBottom.hidden = true;
      zLeft.classList.remove('drag-over');
      zRight.classList.remove('drag-over');
      zBottom.classList.remove('drag-over');
      draggingWhat = null;
    };

    for (const handle of document.querySelectorAll('[data-drag-panel]')) {
      handle.addEventListener('dragstart', (e) => {
        draggingWhat = handle.getAttribute('data-drag-panel');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggingWhat);
        zLeft.hidden = false;
        zRight.hidden = false;
        zBottom.hidden = draggingWhat !== 'panel';
      });
      handle.addEventListener('dragend', hideZones);
    }

    const bindZone = (zoneEl, targetDock) => {
      zoneEl.addEventListener('dragover', (e) => {
        if (!draggingWhat) return;
        e.preventDefault();
        zoneEl.classList.add('drag-over');
      });
      zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('drag-over'));
      zoneEl.addEventListener('drop', (e) => {
        if (!draggingWhat) return;
        e.preventDefault();
        const what = draggingWhat;
        hideZones();
        if (what === 'panel') {
          state.layout.setPanelDock(targetDock);
        } else if ((what === 'explorer' || what === 'rcmdr') && (targetDock === 'left' || targetDock === 'right')) {
          state.layout.setSidebarDock(what, targetDock);
        }
        applyWorkbenchLayout();
      });
    };

    bindZone(zLeft, 'left');
    bindZone(zRight, 'right');
    bindZone(zBottom, 'bottom');
  }

  // --- Settings Application ---
  function applySettingsUI() {
    const s = state.settings;
    for (const out of [$('consoleOut'), $('arfOut')]) {
      out.classList.toggle('nowrap', s.consoleWrap === false);
      out.classList.toggle('scroll-blocks', s.consoleScroll !== false);
    }
    const wrapMode = s.editorWordWrap !== false ? 'on' : 'off';
    for (const ed of state.editors) {
      ed?.updateOptions({ wordWrap: wrapMode });
    }
    $('btnPanelLimitOutput')?.classList.toggle('active', Boolean(s.limitOutput));
    $('btnPanelWordWrap')?.classList.toggle('active', s.consoleWrap !== false);

    if (s.runTarget === 'arf' && state.arfAvailable) state.runTarget = 'arf';
    else if (s.runTarget === 'terminal') state.runTarget = 'r';

    const previewTxt = s.limitOutput ? t('statusRPlayPreview', s.maxOutputItems) : t('statusRPlayFull');
    const skips = [
      ...(s.skipHelp ? [getLang() === 'es' ? 'ayuda' : 'help'] : []),
      ...String(s.skipCommands || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    ];
    $('statusRPlay').textContent = skips.length
      ? `${previewTxt} | ${t('statusRPlaySkips', skips.join(', '))}`
      : previewTxt;

    window.studio
      .updateSettings({
        cranMirror: s.cranMirror,
        packageDownloads: s.packageDownloads
      })
      .catch(() => {});
  }

  // --- Language Switch (updates ALL chrome, menus, sidebars, status bar, dialogs) ---
  async function switchLanguage(lang) {
    const clean = setLang(lang);
    $('statusLangBtn').textContent = clean.toUpperCase();
    $('statusThemeBtn').textContent = state.theme === 'light' ? t('themeLight') : t('themeDracula');

    await window.studio.setLanguage(clean);
    menuBar.render();
    renderRcmdrTree();
    renderWorkspace();
    renderFileGroupsPanel();
    renderFolderTree();
    renderTabs(0);
    renderTabs(1);
    renderProblemsPanel();
    renderPlotPane();
    refreshStatusBar();
    applySettingsUI();
    applyWorkbenchLayout();

    for (let g = 0; g < 2; g++) {
      const tab = activeTabInGroup(g);
      if (tab?.kind === 'table' && state.tableViewers[g]) {
        state.tableViewers[g].render();
      }
    }
    if (state.previewOpen && state.previewMode === 'live') renderLivePreview();
  }

  function refreshStatusBar() {
    $('statusR').textContent = state.rVersion ? `R ${state.rVersion}` : t('statusRNotFound');
    const lspKey =
      state.lspStatus === 'ready'
        ? 'statusLspReady'
        : state.lspStatus === 'starting'
          ? 'statusLspStarting'
          : 'statusLspFallback';
    $('statusLsp').textContent = t('statusLsp', t(lspKey));
    $('statusBridge').textContent = state.bridgePort ? `${t('bridgeLabel')} :${state.bridgePort}` : '';
    $('statusBridge').title = state.bridgePort ? t('bridgeTitle', state.bridgePort) : '';
    $('statusRunTarget').textContent = state.runTarget === 'arf' ? 'arf' : 'R';
    $('statusRunTarget').title = state.runTarget === 'arf' ? t('runTargetArf') : t('runTargetR');

    const dsLabel = getLang() === 'es' ? 'Conjunto de datos' : 'Data set';
    const modLabel = getLang() === 'es' ? 'Modelo' : 'Model';
    $('statusRcmdrCtx').textContent = `R Commander: ${dsLabel}: ${state.activeDataset || '-'} | ${modLabel}: ${state.activeModel || '-'}`;

    const recTab =
      state.tabs.find((x) => x.id === state.recordingDocs.rmd) ||
      state.tabs.find((x) => x.id === state.recordingDocs.rnw);
    const recEl = $('statusRecording');
    if (recTab) {
      recEl.textContent = t('statusRecordingRmd', recTab.name);
      recEl.hidden = false;
    } else {
      recEl.hidden = true;
    }
  }

  // --- ANSI Terminal Output Renderer (for both R Console and arf) ---
  function appendAnsi(container, text, cls = '') {
    const block = document.createElement('span');
    block.className = `console-block${cls ? ' ' + cls : ''}`;

    if (text.includes('\x1b[')) {
      const parts = text.split(/(\x1b\[[0-9;]*m)/g);
      let classes = [];
      for (const part of parts) {
        const m = part.match(/^\x1b\[([0-9;]*)m$/);
        if (m) {
          const codes = (m[1] || '0').split(';').filter(Boolean);
          if (!codes.length || codes.includes('0')) {
            classes = [];
          } else {
            for (const c of codes) {
              if (c === '0') classes = [];
              else if (/^(1|3[0-7]|9[0-7])$/.test(c)) classes.push(`ansi-${c}`);
            }
          }
        } else if (part) {
          const span = document.createElement('span');
          if (classes.length) span.className = classes.join(' ');
          span.textContent = part;
          block.append(span);
        }
      }
    } else {
      block.textContent = text;
    }

    container.append(block);
    container.scrollTop = container.scrollHeight;
  }

  function appendConsole(text, cls = '') {
    appendAnsi($('consoleOut'), text, cls);
  }

  function appendArf(text, cls = '') {
    appendAnsi($('arfOut'), text, cls);
  }

  async function ensureArfStarted() {
    if (state.arfStarted) return true;
    if (!state.arfAvailable) {
      appendArf(t('arfNotFound') + '\n', 'console-line-err');
      return false;
    }
    const res = await window.studio.arfStart();
    if (res?.ok) {
      state.arfStarted = true;
      return true;
    }
    appendArf(t('arfNotFound') + '\n', 'console-line-err');
    return false;
  }

  // --- Plots + SVG / PNG (2x) / PDF / Copy PNG Export ---
  function addPlots(svgs = []) {
    if (!svgs.length) return;
    for (const s of svgs) state.plots.push(s);
    state.plotIndex = state.plots.length - 1;
    renderPlotPane();
    openPanelTab('plots');
  }

  function svgToPngBlob(svgStr, scale = 2) {
    return new Promise((resolve, reject) => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(svgStr, 'image/svg+xml');
      const svgEl = doc.documentElement;
      const vb = (svgEl.getAttribute('viewBox') || '').split(/\s+/).map(Number);
      const w = vb.length === 4 && vb[2] > 0 ? vb[2] : parseFloat(svgEl.getAttribute('width')) || 640;
      const h = vb.length === 4 && vb[3] > 0 ? vb[3] : parseFloat(svgEl.getAttribute('height')) || 440;

      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((pngBlob) => {
          if (pngBlob) resolve(pngBlob);
          else reject(new Error('PNG export failed'));
        }, 'image/png');
      };
      img.onerror = (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      };
      img.src = url;
    });
  }

  function renderPlotPane() {
    const count = state.plots.length;
    $('plotsCount').textContent = String(count);
    $('plotIndexLabel').textContent = count ? `${state.plotIndex + 1} / ${count}` : '0 / 0';
    const hasPlot = state.plotIndex >= 0 && Boolean(state.plots[state.plotIndex]);
    $('btnPlotPrev').disabled = state.plotIndex <= 0;
    $('btnPlotNext').disabled = !hasPlot || state.plotIndex >= count - 1;
    $('btnPlotSaveSvg').disabled = !hasPlot;
    $('btnPlotSavePng').disabled = !hasPlot;
    $('btnPlotSavePdf').disabled = !hasPlot;
    $('btnPlotCopyPng').disabled = !hasPlot;
    $('btnPlotZoomReset').textContent = `${Math.round(state.plotZoom * 100)}%`;

    const canvas = $('plotsCanvas');
    canvas.textContent = '';
    if (!hasPlot) {
      const empty = document.createElement('div');
      empty.className = 'ws-empty';
      empty.textContent = t('plotsEmpty');
      canvas.append(empty);
      return;
    }
    const frame = document.createElement('div');
    frame.className = 'plot-frame';
    frame.style.transform = `scale(${state.plotZoom})`;
    frame.innerHTML = state.plots[state.plotIndex];
    canvas.append(frame);
  }

  // --- R Help Tab ---
  async function openRDocs(topic) {
    const clean = String(topic || '').trim();
    if (!clean) return;
    $('helpSearchInput').value = clean;
    openPanelTab('help');
    const host = $('helpContent');
    host.textContent = '...';
    const res = await window.studio.rHelp(clean);
    host.textContent = '';
    if (!res || !res.ok) {
      const empty = document.createElement('div');
      empty.className = 'ws-empty';
      empty.textContent = res?.error || `No documentation found for ${clean}`;
      host.append(empty);
      return;
    }
    const head = document.createElement('div');
    head.className = 'help-doc-head';
    head.innerHTML = `<span class="help-doc-fn"></span><span class="help-doc-pkg"></span>`;
    head.querySelector('.help-doc-fn').textContent = res.fn || clean;
    head.querySelector('.help-doc-pkg').textContent = res.package ? `{${res.package}}` : '';
    const pre = document.createElement('pre');
    pre.className = 'help-doc-pre';
    pre.textContent = res.fullText || res.description || res.usage || '';
    host.append(head, pre);
  }

  function openDocsForCursor() {
    const tab = activeTab();
    if (tab && tab.kind === 'code') {
      const ed = state.editors[tab.groupIndex];
      const pos = ed?.getPosition();
      const word = pos ? tab.model.getWordAtPosition(pos) : null;
      if (word?.word) {
        openRDocs(word.word);
        return;
      }
    }
    openPanelTab('help');
    $('helpSearchInput').focus();
  }

  // --- Workspace Inspector (VS Code flat tree matching overview.png) ---
  function applySnapshot(snap) {
    if (!snap) return;
    state.snapshot = snap;
    const dsNames = Object.keys(snap.datasets || {});
    if (!state.activeDataset || !dsNames.includes(state.activeDataset)) {
      state.activeDataset = dsNames[0] || null;
    }
    const modelNames = (snap.models || []).map((m) => m.name);
    if (!state.activeModel || !modelNames.includes(state.activeModel)) {
      state.activeModel = modelNames[0] || null;
    }
    refreshStatusBar();
    renderWorkspace();
  }

  function renderWorkspace() {
    const host = $('workspaceContent');
    host.textContent = '';
    const snap = state.snapshot || { datasets: {}, models: [], hclusts: [], objects: [] };
    const dsEntries = Object.values(snap.datasets || {});
    const models = snap.models || [];
    const hclusts = snap.hclusts || [];
    const otherObjs = (snap.objects || []).filter(
      (n) => !snap.datasets[n] && !models.some((m) => m.name === n) && !hclusts.includes(n)
    );

    if (!dsEntries.length && !models.length && !hclusts.length && !otherObjs.length) {
      const empty = document.createElement('div');
      empty.className = 'ws-empty';
      empty.textContent = t('wsEmpty');
      host.append(empty);
      return;
    }

    if (dsEntries.length) {
      const gh = document.createElement('div');
      gh.className = 'ws-group-row';
      gh.innerHTML = `${svg('database', { size: 13, color: 'var(--chart-green)' })}<span>${t('wsDatasets')} (${dsEntries.length})</span>`;
      host.append(gh);

      for (const ds of dsEntries) {
        const row = document.createElement('div');
        row.className = `ws-item-row${ds.name === state.activeDataset ? ' active' : ''}`;
        row.innerHTML =
          `<span class="ws-item-name"></span>` +
          `<span class="ws-item-meta">${ds.rows} x ${ds.columns}</span>` +
          `<span class="ws-item-actions">` +
          `<button type="button" class="icon-btn ws-act-view" title="${t('viewDataTitle')}">${svg('eye', { size: 13 })}</button>` +
          `<button type="button" class="icon-btn ws-act-edit" title="${t('editDataTitle')}">${svg('edit', { size: 13 })}</button>` +
          `<button type="button" class="icon-btn ws-act-sum" title="${t('summaryDataTitle')}">${svg('list-summary', { size: 13 })}</button>` +
          `</span>`;
        row.querySelector('.ws-item-name').textContent = ds.name;

        const varsBox = document.createElement('div');
        varsBox.hidden = ds.name !== state.activeDataset;
        for (const v of ds.vars || []) {
          const vrow = document.createElement('div');
          vrow.className = 'ws-var-row';
          vrow.innerHTML = `<span class="ws-var-name"></span><span class="ws-var-kind"></span>`;
          vrow.querySelector('.ws-var-name').textContent = v.name;
          vrow.querySelector('.ws-var-kind').textContent = v.levels ? `${v.kind} (${v.levels})` : v.kind;
          varsBox.append(vrow);
        }

        row.querySelector('.ws-act-view').addEventListener('click', (e) => {
          e.stopPropagation();
          dismissPeekAfterSelection('explorer');
          openRTableTab({ objectName: ds.name, title: ds.name, editable: false });
        });
        row.querySelector('.ws-act-edit').addEventListener('click', (e) => {
          e.stopPropagation();
          dismissPeekAfterSelection('explorer');
          openRTableTab({ objectName: ds.name, title: ds.name, editable: true });
        });
        row.querySelector('.ws-act-sum').addEventListener('click', (e) => {
          e.stopPropagation();
          openPanelTab('console');
          executeR(`summary(${ds.name})`, { label: `summary(${ds.name})`, fromMenu: true });
        });
        row.addEventListener('click', () => {
          state.activeDataset = ds.name;
          varsBox.hidden = !varsBox.hidden;
          refreshStatusBar();
          renderWorkspace();
        });
        host.append(row, varsBox);
      }
    }

    if (models.length) {
      const gh = document.createElement('div');
      gh.className = 'ws-group-row';
      gh.innerHTML = `${svg('beaker', { size: 13, color: 'var(--chart-red)' })}<span>${t('wsModels')} (${models.length})</span>`;
      host.append(gh);

      for (const m of models) {
        const row = document.createElement('div');
        row.className = `ws-item-row${m.name === state.activeModel ? ' active' : ''}`;
        row.innerHTML =
          `<span class="ws-item-name"></span><span class="ws-item-meta"></span>` +
          `<span class="ws-item-actions"><button type="button" class="icon-btn ws-act-sum" title="${t('summaryModelTitle')}">${svg('list-summary', { size: 13 })}</button></span>`;
        row.querySelector('.ws-item-name').textContent = m.name;
        row.querySelector('.ws-item-meta').textContent = m.cls;
        row.querySelector('.ws-act-sum').addEventListener('click', (e) => {
          e.stopPropagation();
          openPanelTab('console');
          executeR(`summary(${m.name})`, { label: `summary(${m.name})`, fromMenu: true });
        });
        row.addEventListener('click', () => {
          state.activeModel = m.name;
          refreshStatusBar();
          renderWorkspace();
        });
        host.append(row);
      }
    }

    if (otherObjs.length) {
      const gh = document.createElement('div');
      gh.className = 'ws-group-row';
      gh.innerHTML = `${svg('circle-filled', { size: 11, color: 'var(--chart-blue)' })}<span>${t('wsObjects')} (${otherObjs.length})</span>`;
      host.append(gh);

      for (const name of otherObjs) {
        const row = document.createElement('div');
        row.className = 'ws-item-row';
        row.innerHTML = `<span class="ws-item-name"></span><span class="ws-item-meta">${t('wsObjectKind')}</span>`;
        row.querySelector('.ws-item-name').textContent = name;
        row.addEventListener('click', () => openRTableTab({ objectName: name, title: name, editable: false }));
        host.append(row);
      }
    }
  }

  // --- Diagnostics & Problems ---
  function mergeDiagnostics(uri) {
    const entry = state.diagnosticsByUri.get(uri) || { syntax: [], lsp: [] };
    const combined = [...(entry.syntax || [])];
    for (const d of entry.lsp || []) {
      const dup = combined.some(
        (x) => x.startLineNumber === d.startLineNumber && x.severity === d.severity && x.message === d.message
      );
      if (!dup) combined.push(d);
    }
    return combined;
  }

  function applyMarkersForUri(uri) {
    const tab = state.tabs.find((x) => x.kind === 'code' && x.uri === uri);
    if (!tab || !state.monaco) return;
    const diags = mergeDiagnostics(uri);
    const sevMap = {
      error: state.monaco.MarkerSeverity.Error,
      warning: state.monaco.MarkerSeverity.Warning,
      info: state.monaco.MarkerSeverity.Info,
      hint: state.monaco.MarkerSeverity.Hint
    };
    const markers = diags.map((d) => ({
      startLineNumber: d.startLineNumber,
      startColumn: d.startColumn,
      endLineNumber: d.endLineNumber,
      endColumn: d.endColumn,
      message: d.message,
      severity: sevMap[d.severity] || state.monaco.MarkerSeverity.Warning,
      source: d.source || 'R'
    }));
    state.monaco.editor.setModelMarkers(tab.model, 'r-diagnostics', markers);
    renderProblemsPanel();
  }

  function renderProblemsPanel() {
    const listEl = $('problemsList');
    const all = [];
    for (const tab of state.tabs) {
      if (tab.kind !== 'code') continue;
      for (const d of mergeDiagnostics(tab.uri)) all.push({ tab, ...d });
    }
    const errCount = all.filter((x) => x.severity === 'error').length;
    const warnCount = all.filter((x) => x.severity === 'warning').length;
    $('statusErrCount').textContent = String(errCount);
    $('statusWarnCount').textContent = String(warnCount);

    const badge = $('problemsCount');
    badge.textContent = String(all.length);
    badge.classList.toggle('has-errors', errCount > 0);

    listEl.textContent = '';
    if (!all.length) {
      const empty = document.createElement('div');
      empty.className = 'ws-empty';
      empty.textContent = t('problemsEmpty');
      listEl.append(empty);
      return;
    }

    for (const item of all) {
      const row = document.createElement('div');
      row.className = 'problem-item';
      const ico = item.severity === 'error' ? 'error' : 'warning';
      row.innerHTML =
        `<span class="ico problem-sev-ico ${item.severity}">${svg(ico, { size: 13 })}</span>` +
        `<span class="problem-msg"></span>` +
        `<span class="problem-loc"></span>`;
      row.querySelector('.problem-msg').textContent = item.message;
      row.querySelector('.problem-loc').textContent = `${item.tab.name}:${item.startLineNumber}:${item.startColumn}`;
      row.addEventListener('click', () => {
        activateTab(item.tab.id);
        const ed = state.editors[item.tab.groupIndex];
        ed?.revealLineInCenter(item.startLineNumber);
        ed?.setPosition({ lineNumber: item.startLineNumber, column: item.startColumn });
        ed?.focus();
      });
      listEl.append(row);
    }
  }

  // --- Split Editor Groups & Tabs ---
  function activeTabInGroup(g) {
    return state.tabs.find((x) => x.id === state.activeTabByGroup[g]) || null;
  }

  function activeTab() {
    return activeTabInGroup(state.focusedGroup) || activeTabInGroup(0) || state.tabs[0] || null;
  }

  function setFocusedGroup(g) {
    state.focusedGroup = g === 1 && state.splitOpen ? 1 : 0;
    $('editorGroup0').classList.toggle('focused', state.focusedGroup === 0);
    $('editorGroup1').classList.toggle('focused', state.focusedGroup === 1);
    const tab = activeTab();
    if (tab) $('statusLang').textContent = tab.kind === 'table' ? 'TABLE' : tab.language.toUpperCase();
    renderFileGroupsPanel();
  }

  function openSplitGroup() {
    if (state.splitOpen) return;
    state.splitOpen = true;
    $('editorGroup1').hidden = false;
    $('splitGrip').hidden = false;
    renderGroupStage(1);
    renderTabs(1);
    state.editors.forEach((ed) => ed?.layout());
  }

  function closeSplitGroup() {
    if (!state.splitOpen) return;
    for (const tab of state.tabs) {
      if (tab.groupIndex === 1) tab.groupIndex = 0;
    }
    state.activeTabByGroup[1] = null;
    state.splitOpen = false;
    $('editorGroup1').hidden = true;
    $('splitGrip').hidden = true;
    setFocusedGroup(0);
    renderTabs(0);
    renderGroupStage(0);
    renderFileGroupsPanel();
    state.editors.forEach((ed) => ed?.layout());
  }

  function toggleSplitGroup() {
    if (state.splitOpen) closeSplitGroup();
    else {
      openSplitGroup();
      const g0Tabs = state.tabs.filter((x) => x.groupIndex === 0);
      if (g0Tabs.length > 1) {
        const cur = activeTabInGroup(0);
        if (cur) moveTabToGroup(cur.id, 1);
      }
    }
  }

  function moveTabToGroup(tabId, targetGroup) {
    const tab = state.tabs.find((x) => x.id === tabId);
    if (!tab) return;
    if (targetGroup === 1 && !state.splitOpen) openSplitGroup();
    const prevGroup = tab.groupIndex;
    if (prevGroup === targetGroup) {
      activateTab(tab.id);
      return;
    }
    tab.groupIndex = targetGroup;
    if (state.activeTabByGroup[prevGroup] === tab.id) {
      const remaining = state.tabs.find((x) => x.groupIndex === prevGroup);
      state.activeTabByGroup[prevGroup] = remaining ? remaining.id : null;
    }
    state.activeTabByGroup[targetGroup] = tab.id;
    setFocusedGroup(targetGroup);
    renderTabs(0);
    renderTabs(1);
    renderGroupStage(0);
    renderGroupStage(1);
    renderFileGroupsPanel();
  }

  function renderGroupStage(g) {
    const tab = activeTabInGroup(g);
    const edHost = $(`editorHost${g}`);
    const tblHost = $(`tableHost${g}`);
    const emptyHost = $(`emptyHost${g}`);
    const bc = $(`breadcrumb${g}`);

    if (!tab) {
      bc.textContent = '';
      edHost.hidden = true;
      tblHost.hidden = true;
      emptyHost.hidden = false;
      emptyHost.textContent = t('emptyGroupHint');
      return;
    }

    const iconName = tab.kind === 'table' ? 'table' : tab.language === 'r' ? 'r-logo' : 'file';
    bc.innerHTML = `${svg(iconName, { size: 12, color: 'var(--accent-cyan)' })}<span></span>`;
    bc.querySelector('span').textContent = tab.filePath || tab.name;

    emptyHost.hidden = true;
    if (tab.kind === 'table') {
      edHost.hidden = true;
      tblHost.hidden = false;
      state.tableViewers[g]?.mount(tab);
    } else {
      tblHost.hidden = true;
      edHost.hidden = false;
      const ed = state.editors[g];
      if (ed) {
        if (ed.getModel() !== tab.model) ed.setModel(tab.model);
        if (tab.viewState) ed.restoreViewState(tab.viewState);
        ed.layout();
      }
    }
  }

  function createCodeTab({ name, content = '', filePath = null, language = null, dirty = false, groupIndex = null } = {}) {
    if (filePath) {
      const existing = state.tabs.find((x) => x.kind === 'code' && x.filePath === filePath);
      if (existing) {
        activateTab(existing.id);
        return existing;
      }
    }

    const g = groupIndex !== null ? groupIndex : state.focusedGroup;
    const id = `tab-${state.nextTabNum++}`;
    const lang = language || detectLanguage(name);
    const uri = filePath ? `file://${filePath}` : `inmemory://studio/${id}/${name}`;
    const monacoUri = state.monaco.Uri.parse(uri);
    const existingModel = state.monaco.editor.getModel(monacoUri);
    const model = existingModel || state.monaco.editor.createModel(content, lang, monacoUri);
    if (existingModel) existingModel.setValue(content);

    const tab = { id, kind: 'code', groupIndex: g, name, filePath, language: lang, uri, model, dirty, viewState: null };
    state.tabs.push(tab);

    model.onDidChangeContent(() => {
      if (!tab.dirty) {
        tab.dirty = true;
        renderTabs(tab.groupIndex);
        renderFileGroupsPanel();
      }
      if (isRmdOrR(tab.language)) {
        clearTimeout(state.lspTimers.get(tab.uri));
        state.lspTimers.set(
          tab.uri,
          setTimeout(() => {
            window.studio.lspDidChange({
              uri: tab.uri,
              text: tab.model.getValue(),
              isRmd: tab.language === 'rmd'
            });
          }, 220)
        );
      }
      if (tab.id === activeTab()?.id && state.previewOpen && state.previewMode === 'live') renderLivePreview();
    });

    if (isRmdOrR(tab.language)) {
      window.studio.lspDidOpen({ uri: tab.uri, text: content, isRmd: tab.language === 'rmd' });
    }

    activateTab(id);
    return tab;
  }

  function openRTableTab({ objectName, source = 'global', title = null, editable = false, groupIndex = null } = {}) {
    const existing = state.tabs.find(
      (x) =>
        x.kind === 'table' &&
        x.tableConfig?.kind === 'r' &&
        x.tableConfig.objectName === objectName &&
        x.tableConfig.source === source
    );
    if (existing) {
      if (editable && existing.tableState) existing.tableState.editMode = true;
      activateTab(existing.id);
      return existing;
    }

    const g = groupIndex !== null ? groupIndex : state.splitOpen ? 1 : state.focusedGroup;
    const id = `tab-${state.nextTabNum++}`;
    const tab = {
      id,
      kind: 'table',
      groupIndex: g,
      name: title || objectName,
      filePath: null,
      language: 'table',
      dirty: false,
      tableConfig: { kind: 'r', objectName, source, title: title || objectName, editable },
      tableState: null
    };
    state.tabs.push(tab);
    activateTab(id);
    return tab;
  }

  function openCsvTableTab({ name, filePath = null, rawText = '', delimiter = null, groupIndex = null } = {}) {
    if (filePath) {
      const existing = state.tabs.find((x) => x.kind === 'table' && x.filePath === filePath);
      if (existing) {
        activateTab(existing.id);
        return existing;
      }
    }
    const g = groupIndex !== null ? groupIndex : state.focusedGroup;
    const id = `tab-${state.nextTabNum++}`;
    const tab = {
      id,
      kind: 'table',
      groupIndex: g,
      name,
      filePath,
      language: 'table',
      dirty: false,
      tableConfig: { kind: 'csv', title: name, rawText, delimiter, editable: true },
      tableState: null
    };
    state.tabs.push(tab);
    activateTab(id);
    return tab;
  }

  function activateTab(id) {
    const next = state.tabs.find((x) => x.id === id);
    if (!next) return;
    const g = next.groupIndex;
    const prev = activeTabInGroup(g);
    if (prev && prev.kind === 'code' && state.editors[g]) {
      prev.viewState = state.editors[g].saveViewState();
    }
    state.activeTabByGroup[g] = id;
    setFocusedGroup(g);
    renderTabs(g);
    renderGroupStage(g);
    renderFileGroupsPanel();
    if (next.kind === 'code') state.editors[g]?.focus();
    if (state.previewOpen && state.previewMode === 'live' && next.kind === 'code') renderLivePreview();
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex((x) => x.id === id);
    if (idx === -1) return;
    const [tab] = state.tabs.splice(idx, 1);
    const g = tab.groupIndex;
    if (tab.kind === 'code') {
      if (isRmdOrR(tab.language)) window.studio.lspDidClose({ uri: tab.uri });
      state.diagnosticsByUri.delete(tab.uri);
      tab.model.dispose();
    }
    if (state.recordingDocs.rmd === id) state.recordingDocs.rmd = null;
    if (state.recordingDocs.rnw === id) state.recordingDocs.rnw = null;

    if (state.activeTabByGroup[g] === id) {
      const sameGroup = state.tabs.filter((x) => x.groupIndex === g);
      state.activeTabByGroup[g] = sameGroup.length ? sameGroup[sameGroup.length - 1].id : null;
    }

    if (!state.tabs.length) {
      createCodeTab({ name: 'untitled.R', content: '', language: 'r', groupIndex: 0 });
      return;
    }
    renderTabs(g);
    renderGroupStage(g);
    renderFileGroupsPanel();
    renderProblemsPanel();
    refreshStatusBar();
  }

  function renderTabs(g) {
    const bar = $(`tabBar${g}`);
    bar.textContent = '';
    const groupTabs = state.tabs.filter((x) => x.groupIndex === g);

    for (const tab of groupTabs) {
      const el = document.createElement('div');
      el.className = `tab-item${tab.id === state.activeTabByGroup[g] ? ' active' : ''}`;
      el.title = tab.filePath || tab.name;

      const icoName = tab.kind === 'table' ? 'table' : tab.language === 'r' ? 'r-logo' : 'file';
      const icoColor = tab.kind === 'table' ? 'var(--accent-green)' : tab.language === 'rmd' ? 'var(--accent-purple)' : 'var(--accent-cyan)';
      const icoSpan = document.createElement('span');
      icoSpan.className = 'ico';
      icoSpan.innerHTML = svg(icoName, { size: 13, color: icoColor });

      const nameSpan = document.createElement('span');
      nameSpan.className = 'tab-name';
      nameSpan.textContent = tab.name;

      el.append(icoSpan, nameSpan);

      if (tab.dirty) {
        const dot = document.createElement('span');
        dot.className = 'tab-dirty';
        dot.title = t('unsavedChanges');
        el.append(dot);
      }

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'tab-close';
      closeBtn.title = t('closeTabTitle');
      closeBtn.innerHTML = svg('close', { size: 12 });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      el.append(closeBtn);

      el.addEventListener('click', () => activateTab(tab.id));
      bar.append(el);
    }
  }

  // --- File Groups & Folder Tree ---
  function renderFileGroupsPanel() {
    const host = $('fileGroupsList');
    host.textContent = '';
    const { groups, ungrouped } = state.fileGroups.partition(state.tabs, tabKey);
    const curActive = activeTab();

    const renderBucket = (title, items, groupObj = null) => {
      const head = document.createElement('div');
      head.className = 'fg-head';
      const collapsed = groupObj ? groupObj.collapsed : false;
      head.innerHTML =
        `<span class="ico">${svg(collapsed ? 'chevron-right' : 'chevron-down', { size: 12 })}</span>` +
        `<span class="fg-head-title"></span>` +
        `<span class="muted">(${items.length})</span>`;
      head.querySelector('.fg-head-title').textContent = title;

      if (groupObj) {
        const acts = document.createElement('span');
        acts.className = 'fg-head-actions';
        const renBtn = document.createElement('button');
        renBtn.type = 'button';
        renBtn.className = 'icon-btn';
        renBtn.title = t('renameGroupPrompt');
        renBtn.innerHTML = svg('edit', { size: 12 });
        renBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const nextName = window.prompt(t('renameGroupPrompt'), groupObj.name);
          if (nextName && state.fileGroups.renameGroup(groupObj.id, nextName)) {
            saveFileGroups();
            renderFileGroupsPanel();
          }
        });
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'icon-btn';
        delBtn.title = t('deleteGroupConfirm', groupObj.name);
        delBtn.innerHTML = svg('close', { size: 12 });
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.confirm(t('deleteGroupConfirm', groupObj.name))) {
            state.fileGroups.deleteGroup(groupObj.id);
            saveFileGroups();
            renderFileGroupsPanel();
          }
        });
        acts.append(renBtn, delBtn);
        head.append(acts);
        head.addEventListener('click', () => {
          state.fileGroups.toggleCollapsed(groupObj.id);
          saveFileGroups();
          renderFileGroupsPanel();
        });
      }
      host.append(head);

      if (!collapsed) {
        for (const tab of items) {
          const row = document.createElement('div');
          row.className = `fg-item${curActive?.id === tab.id ? ' active' : ''}`;
          const icoName = tab.kind === 'table' ? 'table' : tab.language === 'r' ? 'r-logo' : 'file';
          const icoSpan = document.createElement('span');
          icoSpan.className = 'ico';
          icoSpan.innerHTML = svg(icoName, { size: 12, color: 'var(--accent-cyan)' });

          const nameSpan = document.createElement('span');
          nameSpan.className = 'fg-item-name';
          nameSpan.textContent = tab.name;

          const paneTag = document.createElement('span');
          paneTag.className = 'fg-pane-tag';
          paneTag.textContent = t('groupBadge', tab.groupIndex + 1);
          paneTag.title = t('moveToSplit');
          paneTag.addEventListener('click', (e) => {
            e.stopPropagation();
            moveTabToGroup(tab.id, tab.groupIndex === 0 ? 1 : 0);
          });

          row.append(icoSpan, nameSpan, paneTag);

          if (state.fileGroups.groups.length > 0) {
            const sel = document.createElement('select');
            sel.className = 'fg-assign-sel';
            sel.title = t('assignGroup');
            const optNone = document.createElement('option');
            optNone.value = '';
            optNone.textContent = '-';
            sel.append(optNone);
            const assigned = state.fileGroups.getGroupIdFor(tabKey(tab)) || '';
            for (const g of state.fileGroups.groups) {
              const opt = document.createElement('option');
              opt.value = g.id;
              opt.textContent = g.name;
              opt.selected = g.id === assigned;
              sel.append(opt);
            }
            sel.addEventListener('click', (e) => e.stopPropagation());
            sel.addEventListener('change', (e) => {
              e.stopPropagation();
              state.fileGroups.assignItem(tabKey(tab), sel.value || null);
              saveFileGroups();
              renderFileGroupsPanel();
            });
            row.append(sel);
          }

          row.addEventListener('click', () => {
            dismissPeekAfterSelection('explorer');
            activateTab(tab.id);
          });
          host.append(row);
        }
      }
    };

    for (const g of groups) renderBucket(g.name, g.items, g);
    renderBucket(t('ungroupedFiles'), ungrouped, null);
  }

  async function refreshFolderTree() {
    if (!state.workspaceRoot) {
      renderFolderTree();
      return;
    }
    const res = await window.studio.readDirTree(state.workspaceRoot);
    if (res) {
      state.folderTree = res.tree || [];
      state.workspaceName = res.name;
    }
    renderFolderTree();
  }

  function renderFolderTree() {
    const host = $('folderTree');
    host.textContent = '';
    $('folderHeaderName').textContent = state.workspaceName || t('workspaceFolder');
    $('btnExplorerNewFile').hidden = !state.workspaceRoot;
    $('btnExplorerNewFolder').hidden = !state.workspaceRoot;

    if (!state.workspaceRoot) {
      const empty = document.createElement('div');
      empty.className = 'ws-empty';
      empty.textContent = t('noFolderOpen');
      host.append(empty);
      return;
    }

    const build = (nodes, parent, depth = 0) => {
      for (const node of nodes || []) {
        if (node.isDir) {
          const wrap = document.createElement('div');
          const row = document.createElement('div');
          row.className = 'fs-row';
          row.style.paddingLeft = `${6 + depth * 12}px`;
          row.innerHTML =
            `<span class="ico fs-chev">${svg('chevron-right', { size: 12 })}</span>` +
            `<span class="ico">${svg('folder', { size: 13, color: 'var(--accent-yellow)' })}</span>` +
            `<span class="fs-row-name"></span>`;
          row.querySelector('.fs-row-name').textContent = node.name;
          const kids = document.createElement('div');
          kids.hidden = true;
          build(node.children, kids, depth + 1);
          row.addEventListener('click', () => {
            kids.hidden = !kids.hidden;
            row.querySelector('.fs-chev').innerHTML = svg(kids.hidden ? 'chevron-right' : 'chevron-down', { size: 12 });
          });
          wrap.append(row, kids);
          parent.append(wrap);
        } else {
          const row = document.createElement('div');
          row.className = 'fs-row';
          row.style.paddingLeft = `${20 + depth * 12}px`;
          const ext = (node.name.split('.').pop() || '').toUpperCase();
          const fIco = isDataBinaryExt(node.name) ? 'database' : isDelimitedExt(node.name) ? 'table' : 'file';
          row.innerHTML =
            `<span class="ico">${svg(fIco, { size: 13, color: 'var(--fg-muted)' })}</span>` +
            `<span class="fs-row-name"></span>` +
            (isDataBinaryExt(node.name) || isDelimitedExt(node.name) ? `<span class="fs-ext-tag">${ext}</span>` : '') +
            `<span class="fs-row-actions">` +
            `<button type="button" class="icon-btn fs-act-ren" title="${t('renamePrompt')}">${svg('edit', { size: 12 })}</button>` +
            `<button type="button" class="icon-btn fs-act-del" title="${t('deleteConfirm', node.name)}">${svg('clear', { size: 12 })}</button>` +
            `</span>`;
          row.querySelector('.fs-row-name').textContent = node.name;

          row.querySelector('.fs-act-ren').addEventListener('click', async (e) => {
            e.stopPropagation();
            const next = window.prompt(t('renamePrompt'), node.name);
            if (next && next.trim() && next.trim() !== node.name) {
              await window.studio.renamePath({ oldPath: node.path, newName: next.trim() });
              await refreshFolderTree();
            }
          });
          row.querySelector('.fs-act-del').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (window.confirm(t('deleteConfirm', node.name))) {
              await window.studio.deletePath(node.path);
              await refreshFolderTree();
            }
          });
          row.addEventListener('click', () => {
            dismissPeekAfterSelection('explorer');
            openPathSmart(node.path);
          });
          parent.append(row);
        }
      }
    };

    build(state.folderTree, host);
  }

  async function openPathSmart(filePath, forceCode = false) {
    if (!filePath) return;
    if (!forceCode && isDataBinaryExt(filePath)) {
      await loadDataFileIntoR(filePath);
      return;
    }
    const file = await window.studio.openPath(filePath);
    if (!file) return;
    if (!forceCode && isDelimitedExt(file.name)) {
      openCsvTableTab({ name: file.name, filePath: file.filePath, rawText: file.content });
    } else {
      createCodeTab({ name: file.name, filePath: file.filePath, content: file.content, dirty: false });
    }
  }

  async function loadDataFileIntoR(filePath) {
    const res = await window.studio.loadDataFile(filePath);
    if (!res.ok) {
      showToast(res.error || 'Failed to load data file', 'error');
      appendConsole(`\nError loading ${filePath}: ${res.error}\n`, 'console-line-err');
      return;
    }
    if (res.snapshot) applySnapshot(res.snapshot);
    const fname = filePath.split(/[\\/]/).pop();
    showToast(t('toastLoadedRData', fname, res.objects.length));
    appendConsole(`\n# Loaded ${fname}: ${res.objects.join(', ')}\n`, 'console-line-meta');
    if (res.loadedDatasets && res.loadedDatasets.length) {
      const ds = res.loadedDatasets[0];
      state.activeDataset = ds;
      refreshStatusBar();
      renderWorkspace();
      openRTableTab({ objectName: ds, title: ds, editable: false });
    }
  }

  // --- Insert Code + Live Rmd/Rnw Recording ---
  function insertCodeInActiveScript(code, commentTitle = '') {
    let tab = activeTab();
    if (!tab || tab.kind !== 'code' || !isRmdOrR(tab.language)) {
      tab =
        state.tabs.find((x) => x.kind === 'code' && isRmdOrR(x.language)) ||
        createCodeTab({ name: 'script.R', content: '', language: 'r', groupIndex: 0 });
    }
    const model = tab.model;
    const current = model.getValue();
    let addition;
    if (tab.language === 'rmd') {
      addition = `${current.trim() ? '\n\n' : ''}### ${commentTitle || 'R Commander'}\n\n\`\`\`{r}\n${code}\n\`\`\`\n`;
    } else {
      const header = commentTitle ? `# ${commentTitle}\n` : '';
      addition = `${current.trim() ? '\n\n' : ''}${header}${code}\n`;
    }
    const lastLine = model.getLineCount();
    const lastCol = model.getLineMaxColumn(lastLine);
    model.pushEditOperations(
      [],
      [{ range: new state.monaco.Range(lastLine, lastCol, lastLine, lastCol), text: addition }],
      () => null
    );
    state.editors[tab.groupIndex]?.revealLine(model.getLineCount());
  }

  async function appendToRecordingDocs(code, title) {
    for (const kind of ['rmd', 'rnw']) {
      const tabId = state.recordingDocs[kind];
      if (!tabId) continue;
      const tab = state.tabs.find((x) => x.id === tabId && x.kind === 'code');
      if (!tab) {
        state.recordingDocs[kind] = null;
        continue;
      }
      const next = await window.studio.rcmdrReportHelper({
        action: 'append',
        kind,
        text: tab.model.getValue(),
        title,
        code
      });
      if (next !== tab.model.getValue()) tab.model.setValue(next);
    }
    refreshStatusBar();
  }

  // --- R & arf Execution ---
  async function executeR(code, { require = [], label = '', fromMenu = false } = {}) {
    if (!String(code || '').trim()) return;

    // Route ad-hoc runs to interactive arf terminal if user chose arf as run target
    if (!fromMenu && state.runTarget === 'arf' && state.arfAvailable) {
      openPanelTab('arf');
      if (await ensureArfStarted()) {
        await window.studio.arfSend(code);
        return;
      }
    }

    state.running = true;
    $('btnRun').disabled = true;
    $('btnRunAll').disabled = true;
    $('btnInterrupt').classList.add('busy-stop');
    if (label) appendConsole(`\n# --- ${label} ---\n`, 'console-line-meta');

    const s = state.settings;
    const skipCmds = fromMenu
      ? []
      : String(s.skipCommands || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
    const plugins = String(s.rcmdrPlugins || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

    const res = await window.studio.runCode({
      code,
      require,
      capturePlots: true,
      skipHelp: fromMenu ? false : Boolean(s.skipHelp),
      skipCommands: skipCmds,
      limitOutput: Boolean(s.limitOutput),
      maxOutputItems: Number(s.maxOutputItems) || 24,
      syntaxColors: Boolean(s.syntaxColors),
      fixedNotation: Boolean(s.fixedNotation),
      loadRcmdrFunctions: Boolean(s.loadRcmdrFunctions),
      rcmdrPlugins: plugins
    });

    state.running = false;
    $('btnRun').disabled = false;
    $('btnRunAll').disabled = false;
    $('btnInterrupt').classList.remove('busy-stop');

    if (res.snapshot) applySnapshot(res.snapshot);
    if (res.plots && res.plots.length) addPlots(res.plots);
    if (!res.ok && res.stderr && !res.stdout) appendConsole(res.stderr + '\n', 'console-line-err');
  }

  function extractCodeToRun(all = false) {
    const tab = activeTab();
    if (!tab || tab.kind !== 'code') return '';
    const ed = state.editors[tab.groupIndex];
    const model = tab.model;

    if (all) {
      const full = model.getValue();
      if (tab.language === 'rmd') {
        const chunks = [];
        const lines = full.split(/\r?\n/);
        let inChunk = false;
        let buf = [];
        for (const line of lines) {
          if (!inChunk && /^\s*```+\s*\{\s*r\b/i.test(line)) {
            inChunk = true;
            buf = [];
          } else if (inChunk && /^\s*```+\s*$/.test(line)) {
            chunks.push(buf.join('\n'));
            inChunk = false;
          } else if (inChunk) buf.push(line);
        }
        return chunks.join('\n\n');
      }
      return full;
    }

    const sel = ed?.getSelection();
    if (sel && !sel.isEmpty()) return model.getValueInRange(sel);

    const pos = ed?.getPosition();
    if (!pos) return '';
    const lineText = model.getLineContent(pos.lineNumber);
    if (runAll !== 'retain' && pos.lineNumber < model.getLineCount()) {
      ed.setPosition({ lineNumber: pos.lineNumber + 1, column: 1 });
    }
    return lineText;
  }

  function extractRmdChunkToRun(aboveOnly = false) {
    const tab = activeTab();
    if (!tab || tab.kind !== 'code' || !tab.model) return '';
    const ed = state.editors[state.focusedGroup];
    const curLine = ed?.getPosition()?.lineNumber || 1;
    const lines = tab.model.getValue().split(/\r?\n/);
    const chunks = [];
    let inChunk = false, startLine = 0, buf = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], ln = i + 1;
      if (!inChunk && /^\s*```+\s*\{\s*[rR]\b[^}]*\}/.test(line)) {
        inChunk = true; startLine = ln; buf = [];
      } else if (inChunk && /^\s*```+\s*$/.test(line)) {
        chunks.push({ startLine, endLine: ln, code: buf.join('\n') });
        inChunk = false;
      } else if (inChunk) {
        buf.push(line);
      }
    }
    if (aboveOnly) {
      return chunks.filter((c) => c.endLine < curLine).map((c) => c.code).join('\n\n');
    }
    const active = chunks.find((c) => curLine >= c.startLine && curLine <= c.endLine);
    return active ? active.code : extractCodeToRun(true);
  }

  function extractLineToEnd() {
    const tab = activeTab();
    if (!tab || tab.kind !== 'code' || !tab.model) return '';
    const ed = state.editors[state.focusedGroup];
    const startLine = ed?.getPosition()?.lineNumber || 1;
    const endLine = tab.model.getLineCount();
    return tab.model.getValueInRange({
      startLineNumber: startLine,
      startColumn: 1,
      endLineNumber: endLine,
      endColumn: tab.model.getLineMaxColumn(endLine),
    });
  }

  function insertTextAtCursor(ed, snippet) {
    if (!ed) return;
    const sel = ed.getSelection();
    if (!sel) return;
    ed.executeEdits('r-hotkey', [{ range: sel, text: snippet, forceMoveMarkers: true }]);
    ed.focus();
  }

  // --- Preview & Knit ---
  function renderLivePreview() {
    const tab = activeTab();
    if (!tab || tab.kind !== 'code') return;
    $('previewTitle').textContent = t('previewLiveTitle', tab.name);
    $('previewBody').hidden = false;
    $('previewIframe').hidden = true;
    $('btnPreviewModeLive').classList.add('active');
    $('btnPreviewModeKnit').classList.remove('active');

    const { html, chunks } = window.StudioMarkdownPreview.renderMarkdown(tab.model.getValue());
    $('previewBody').innerHTML = html;
    for (const btn of $('previewBody').querySelectorAll('[data-run-chunk]')) {
      btn.title = t('runChunkBtn');
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-run-chunk'));
        if (chunks[idx]) executeR(chunks[idx], { label: `Chunk ${idx + 1}` });
      });
    }
  }

  function openPreview(mode = 'live') {
    state.previewOpen = true;
    state.previewMode = mode;
    $('previewPane').hidden = false;
    $('btnPreview').classList.add('active');
    if (mode === 'live') {
      renderLivePreview();
    } else {
      $('previewBody').hidden = true;
      $('previewIframe').hidden = false;
      $('btnPreviewModeLive').classList.remove('active');
      $('btnPreviewModeKnit').classList.add('active');
      $('previewIframe').srcdoc =
        state.knittedHtml || `<p style="font-family:sans-serif;padding:16px;color:#6272a4">${t('previewKnitEmpty')}</p>`;
    }
    state.editors.forEach((ed) => ed?.layout());
  }

  function closePreview() {
    state.previewOpen = false;
    $('previewPane').hidden = true;
    $('btnPreview').classList.remove('active');
    state.editors.forEach((ed) => ed?.layout());
  }

  async function knitCurrentRmd() {
    const tab = activeTab();
    if (!tab || tab.kind !== 'code') return;
    showToast(t('toastKnitting'));
    const res = await window.studio.knitRmd({ content: tab.model.getValue(), filename: tab.name });
    if (res.ok) {
      state.knittedHtml = res.html;
      $('previewTitle').textContent = t('previewKnitTitle', tab.name);
      openPreview('knit');
      showToast(t('toastKnitted', res.elapsedMs));
    } else {
      appendConsole(`\n${t('toastKnitFailed')}: ${res.error}\n`, 'console-line-err');
      showToast(res.error || t('toastKnitFailed'), 'error');
    }
  }

  // --- R Commander Tree (EXACT overview.png 13 Codicon SVGs + Dracula chart colors!) ---
  function fold(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function getLabel(node) {
    if (!node.label) return node.id || '';
    if (typeof node.label === 'string') return node.label;
    const lang = getLang();
    return node.label[lang] || node.label.en || node.id || '';
  }

  function filterTree(nodes, words, parents = []) {
    if (!words.length) return nodes;
    const out = [];
    for (const node of nodes) {
      if (node.sep) continue;
      const en = node.label?.en || node.id || '';
      const es = node.label?.es || en;
      if (node.children) {
        const kids = filterTree(node.children, words, [...parents, en, es]);
        if (kids.length) out.push({ ...node, children: kids, _expanded: true });
      } else {
        const hay = fold([...parents, en, es, node.id || ''].join(' '));
        if (words.every((w) => hay.includes(w))) out.push(node);
      }
    }
    return out;
  }

  function renderRcmdrTree() {
    const container = $('rcmdrTree');
    const rawQ = $('rcmdrSearch').value.trim();
    const words = fold(rawQ).split(/\s+/).filter(Boolean);
    const nodes = filterTree(state.tree, words);
    container.textContent = '';

    const buildNodes = (list, parentEl) => {
      for (const node of list) {
        if (node.sep) {
          if (!words.length) {
            const sep = document.createElement('div');
            sep.className = 'tree-sep';
            parentEl.append(sep);
          }
          continue;
        }
        const label = getLabel(node);
        const iconSvg = svg(node.icon || 'circle-filled', {
          size: 14,
          color: rcmdrColor(node.color)
        });

        if (node.children) {
          const group = document.createElement('div');
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'tree-row';
          const expanded = Boolean(node._expanded);
          row.innerHTML =
            `<span class="tree-caret">${svg(expanded ? 'chevron-down' : 'chevron-right', { size: 12 })}</span>` +
            `<span class="ico">${iconSvg}</span>` +
            `<span class="tree-label"></span>`;
          row.querySelector('.tree-label').textContent = label;

          const childWrap = document.createElement('div');
          childWrap.className = 'tree-children';
          childWrap.hidden = !expanded;
          buildNodes(node.children, childWrap);

          row.addEventListener('click', () => {
            childWrap.hidden = !childWrap.hidden;
            row.querySelector('.tree-caret').innerHTML = svg(childWrap.hidden ? 'chevron-right' : 'chevron-down', { size: 12 });
          });
          group.append(row, childWrap);
          parentEl.append(group);
        } else if (node.id) {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'tree-row';
          row.title = `${label} (${node.id})`;
          row.innerHTML =
            `<span class="tree-caret"></span>` +
            `<span class="ico">${iconSvg}</span>` +
            `<span class="tree-label"></span>`;
          row.querySelector('.tree-label').textContent = label;
          row.addEventListener('click', () => {
            if (state.settings.closeMenusAfterChoice && !words.length) renderRcmdrTree();
            dismissPeekAfterSelection('rcmdr');
            triggerRcmdrCommand(node.id);
          });
          parentEl.append(row);
        }
      }
    };

    buildNodes(nodes, container);
    if (!container.children.length) {
      const empty = document.createElement('div');
      empty.className = 'ws-empty';
      empty.textContent = t('rcmdrNoMatches');
      container.append(empty);
    }
  }

  async function deliverRcmdrResult(res, mode = null) {
    const action = mode || state.settings.menuAction || 'both';
    if (action === 'insert' || action === 'both') insertCodeInActiveScript(res.code, res.title);
    if (action === 'run' || action === 'both') {
      await executeR(res.code, { require: res.pkgs || [], label: res.title, fromMenu: true });
    }
    await appendToRecordingDocs(res.code, res.title);
    if (res.activeDataset) state.activeDataset = res.activeDataset;
    if (res.activeModel) state.activeModel = res.activeModel;
    refreshStatusBar();
    if (res.detectNew) {
      const snap = await window.studio.snapshot();
      applySnapshot(snap);
    }
  }

  async function triggerRcmdrCommand(id) {
    const res = await window.studio.rcmdrOpenCommand({
      id,
      activeDataset: state.activeDataset,
      activeModel: state.activeModel,
      lang: getLang(),
      settings: {
        cranMirror: state.settings.cranMirror,
        packageDownloads: state.settings.packageDownloads
      }
    });
    if (!res) return;

    if (res.kind === 'error') return showToast(res.error, 'error');
    if (res.kind === 'warning') return showToast(res.message, 'warn');
    if (res.kind === 'url') return window.studio.openExternal(res.url);
    if (res.kind === 'viewTable') {
      return openRTableTab({ objectName: res.name, title: res.title, editable: res.editable });
    }
    if (res.kind === 'refresh') {
      const snap = await window.studio.snapshot();
      applySnapshot(snap);
      return showToast(t('toastWsRefreshed', Object.keys(snap.datasets || {}).length));
    }
    if (res.kind === 'select') {
      state.layout.setSidebarOpen('explorer', true);
      applyWorkbenchLayout();
      const snap = await window.studio.snapshot();
      applySnapshot(snap);
      return showToast(t('toastSelectTarget', res.target));
    }
    if (res.kind === 'editorAction') return handleVscodeAction(res.action);
    if (res.kind === 'reportAction') return handleReportAction(res.id);
    if (res.kind === 'direct') return deliverRcmdrResult(res);
    if (res.kind === 'form') {
      modal.open(res, (submitted, mode) => deliverRcmdrResult(submitted, mode), {
        stepMode: state.settings.dialogStyle === 'steps'
      });
    }
  }

  function handleVscodeAction(action) {
    switch (action) {
      case 'workbench.action.files.openFile':
        openFileAction();
        break;
      case 'workbench.action.files.save':
        saveFileAction(false);
        break;
      case 'workbench.action.files.saveAs':
        saveFileAction(true);
        break;
      case 'workbench.action.openSettings':
        settingsModal.open();
        break;
      case 'rCommanderPlay.clearTerminal':
        $('consoleOut').textContent = '';
        break;
      case 'rCommanderPlay.interruptR':
        window.studio.interruptR();
        showToast(t('toastInterrupted'));
        break;
      case 'r.createRTerm':
        window.studio.restartR().then((r) => {
          if (r.snapshot) applySnapshot(r.snapshot);
          showToast(t('toastRestarted'));
        });
        break;
      case 'actions.find':
      case 'undo':
      case 'redo':
      case 'editor.action.selectAll':
        state.editors[state.focusedGroup]?.trigger('menu', action, null);
        break;
      default:
        showToast(action);
    }
  }

  async function handleReportAction(id) {
    if (id === 'editMarkdown' || id === 'editKnitr') {
      const kind = id === 'editKnitr' ? 'rnw' : 'rmd';
      const existing = state.tabs.find((x) => x.id === state.recordingDocs[kind]);
      if (existing) {
        activateTab(existing.id);
        return;
      }
      const text = await window.studio.rcmdrReportHelper({ action: 'template', kind });
      const filename = kind === 'rnw' ? 'RCommander.Rnw' : 'RCommander.Rmd';
      const tab = createCodeTab({
        name: filename,
        content: text,
        language: kind === 'rnw' ? 'plaintext' : 'rmd',
        dirty: true
      });
      state.recordingDocs[kind] = tab.id;
      refreshStatusBar();
      showToast(t('toastRecordingStarted', filename));
    } else if (id === 'removeLastRmdBlock' || id === 'removeLastRmdSection' || id === 'removeLastRnwBlock') {
      const kind = id === 'removeLastRnwBlock' ? 'rnw' : 'rmd';
      const targetTab = state.tabs.find((x) => x.id === state.recordingDocs[kind]) || activeTab();
      if (!targetTab || targetTab.kind !== 'code') return;
      const next = await window.studio.rcmdrReportHelper({
        action: id === 'removeLastRmdSection' ? 'removeLastTitle' : 'removeLastBlock',
        kind,
        text: targetTab.model.getValue()
      });
      targetTab.model.setValue(next);
    }
  }

  // --- Panel Tabs ---
  function openPanelTab(which) {
    state.activePanelTab = which;
    state.layout.setPanelOpen(true);
    applyWorkbenchLayout();
    for (const btn of document.querySelectorAll('.panel-tab')) {
      btn.classList.toggle('active', btn.dataset.dock === which);
    }
    $('dockConsole').hidden = which !== 'console';
    $('dockArf').hidden = which !== 'arf';
    $('dockPlots').hidden = which !== 'plots';
    $('dockProblems').hidden = which !== 'problems';
    $('dockHelp').hidden = which !== 'help';
    if (which === 'arf') ensureArfStarted();
  }

  // --- File Actions ---
  async function openFileAction() {
    const files = await window.studio.openFile();
    if (!files || !files.length) return;
    for (const file of files) {
      if (file.isBinaryData) await loadDataFileIntoR(file.filePath);
      else if (isDelimitedExt(file.name)) openCsvTableTab({ name: file.name, filePath: file.filePath, rawText: file.content });
      else createCodeTab({ name: file.name, filePath: file.filePath, content: file.content, dirty: false });
    }
  }

  async function openFolderAction() {
    const res = await window.studio.openFolder();
    if (!res) return;
    state.workspaceRoot = res.root;
    state.workspaceName = res.name;
    state.folderTree = res.tree || [];
    loadFileGroups();
    renderFileGroupsPanel();
    renderFolderTree();
    state.layout.setSidebarOpen('explorer', true);
    applyWorkbenchLayout();
  }

  async function saveFileAction(forceAs = false) {
    const tab = activeTab();
    if (!tab) return;
    if (tab.kind === 'table') {
      const tv = state.tableViewers[tab.groupIndex];
      if (tab.tableConfig.kind === 'csv') await tv?._saveCsvFile();
      else await tv?._exportCsv();
      return;
    }
    const content = tab.model.getValue();
    if (!forceAs && tab.filePath) {
      const res = await window.studio.saveFile({ filePath: tab.filePath, content });
      if (res?.ok) {
        tab.dirty = false;
        renderTabs(tab.groupIndex);
        renderFileGroupsPanel();
        showToast(t('toastSaved', tab.name));
      }
    } else {
      const res = await window.studio.saveFileAs({ defaultName: tab.name, content });
      if (res?.ok) {
        tab.filePath = res.filePath;
        tab.name = res.name;
        tab.language = detectLanguage(res.name);
        state.monaco.editor.setModelLanguage(tab.model, tab.language);
        tab.dirty = false;
        renderTabs(tab.groupIndex);
        renderFileGroupsPanel();
        showToast(t('toastSaved', tab.name));
      }
    }
  }

  // --- Studio Commands ---
  async function handleStudioCommand(cmd) {
    switch (cmd) {
      case 'new-r':
        createCodeTab({ name: `script-${state.nextTabNum}.R`, content: '', language: 'r' });
        break;
      case 'new-rmd':
        createCodeTab({ name: `report-${state.nextTabNum}.Rmd`, content: DEFAULT_RMD_DOC, language: 'rmd' });
        break;
      case 'open':
        await openFileAction();
        break;
      case 'open-folder':
        await openFolderAction();
        break;
      case 'load-workspace':
      case 'load-dataset-file': {
        const picked = await window.studio.openDataFileDialog();
        if (picked) await loadDataFileIntoR(picked);
        break;
      }
      case 'save':
        await saveFileAction(false);
        break;
      case 'save-as':
        await saveFileAction(true);
        break;
      case 'run-selection':
        await executeR(extractCodeToRun(false));
        break;
      case 'run-all':
        await executeR(extractCodeToRun(true));
        break;
      case 'knit':
        await knitCurrentRmd();
        break;
      case 'interrupt-r':
        if (state.activePanelTab === 'arf') await window.studio.arfInterrupt();
        else {
          await window.studio.interruptR();
          appendConsole(`\n${t('consoleInterrupted')}\n`, 'console-line-err');
        }
        showToast(t('toastInterrupted'));
        break;
      case 'restart-r':
        if (state.activePanelTab === 'arf') {
          await window.studio.arfRestart();
        } else {
          appendConsole(`\n${t('consoleRestarting')}\n`, 'console-line-meta');
          const res = await window.studio.restartR();
          applySnapshot(res.snapshot);
          appendConsole(`${t('consoleSessionReady')}\n`, 'console-line-meta');
        }
        showToast(t('toastRestarted'));
        break;
      case 'clear-console':
        if (state.activePanelTab === 'arf') $('arfOut').textContent = '';
        else $('consoleOut').textContent = '';
        break;
      case 'refresh-workspace': {
        const snap = await window.studio.snapshot();
        applySnapshot(snap);
        showToast(t('toastWsRefreshed', Object.keys(snap.datasets || {}).length));
        break;
      }
      case 'toggle-preview':
        state.previewOpen ? closePreview() : openPreview('live');
        break;
      case 'toggle-split':
        toggleSplitGroup();
        break;
      case 'move-tab-group': {
        const cur = activeTab();
        if (cur) moveTabToGroup(cur.id, cur.groupIndex === 0 ? 1 : 0);
        break;
      }
      case 'toggle-explorer-sidebar':
      case 'toggle-sidebar':
        state.layout.toggleSidebar('explorer');
        applyWorkbenchLayout();
        break;
      case 'toggle-rcmdr-sidebar':
        state.layout.toggleSidebar('rcmdr');
        applyWorkbenchLayout();
        break;
      case 'toggle-panel':
        state.layout.togglePanel();
        applyWorkbenchLayout();
        break;
      case 'toggle-panel-orientation':
        state.layout.togglePanelOrientation();
        applyWorkbenchLayout();
        break;
      case 'toggle-dock-position': {
        const order = ['bottom', 'right', 'left'];
        const next = order[(order.indexOf(state.layout.panel.dock) + 1) % order.length];
        state.layout.setPanelDock(next);
        applyWorkbenchLayout();
        break;
      }
      case 'layout-both-left':
        state.layout.applyPreset('both-left');
        applyWorkbenchLayout();
        break;
      case 'layout-explorer-left-rcmdr-right':
        state.layout.applyPreset('explorer-left-rcmdr-right');
        applyWorkbenchLayout();
        break;
      case 'layout-rcmdr-left-explorer-right':
        state.layout.applyPreset('rcmdr-left-explorer-right');
        applyWorkbenchLayout();
        break;
      case 'layout-both-right':
        state.layout.applyPreset('both-right');
        applyWorkbenchLayout();
        break;
      case 'toggle-word-wrap':
        state.settings.consoleWrap = !state.settings.consoleWrap;
        saveSettings(state.settings);
        applySettingsUI();
        break;
      case 'toggle-scroll-output':
        state.settings.consoleScroll = !state.settings.consoleScroll;
        saveSettings(state.settings);
        applySettingsUI();
        break;
      case 'toggle-theme':
        applyTheme(state.theme === 'light' ? 'dark' : 'light');
        break;
      case 'switch-language':
        await switchLanguage(getLang() === 'es' ? 'en' : 'es');
        break;
      case 'command-palette':
        await palette.open('');
        break;
      case 'open-settings':
        settingsModal.open();
        break;
      case 'r-help':
        openDocsForCursor();
        break;
      case 'undo':
      case 'redo':
      case 'find':
        state.editors[state.focusedGroup]?.trigger('menu', cmd === 'find' ? 'actions.find' : cmd, null);
        break;
      default:
        break;
    }
  }

  function getStudioCommandsList() {
    return [
      { id: 'new-r', label: t('newRScript'), accel: 'Ctrl+N' },
      { id: 'new-rmd', label: t('newRmdDoc'), accel: 'Ctrl+Shift+N' },
      { id: 'open', label: t('openFile'), accel: 'Ctrl+O' },
      { id: 'open-folder', label: t('openFolder'), accel: 'Ctrl+Shift+O' },
      { id: 'load-workspace', label: t('loadWorkspace') },
      { id: 'load-dataset-file', label: t('loadDatasetFile') },
      { id: 'save', label: t('save'), accel: 'Ctrl+S' },
      { id: 'save-as', label: t('saveAs'), accel: 'Ctrl+Shift+S' },
      { id: 'run-selection', label: t('runSelection'), accel: 'Ctrl+Enter' },
      { id: 'run-all', label: t('runAll'), accel: 'Ctrl+Shift+Enter' },
      { id: 'knit', label: t('knitRmd'), accel: 'Ctrl+Shift+K' },
      { id: 'toggle-split', label: t('splitEditor'), accel: 'Ctrl+\\' },
      { id: 'move-tab-group', label: t('moveTabOtherGroup') },
      { id: 'toggle-preview', label: t('togglePreview'), accel: 'Ctrl+Shift+V' },
      { id: 'toggle-explorer-sidebar', label: t('toggleSidebar') },
      { id: 'toggle-rcmdr-sidebar', label: t('toggleRcmdrSidebar') },
      { id: 'toggle-panel', label: t('togglePanel') },
      { id: 'toggle-panel-orientation', label: t('togglePanelOrientation') },
      { id: 'layout-both-left', label: t('layoutBothLeft') },
      { id: 'layout-explorer-left-rcmdr-right', label: t('layoutExplorerLeftRcmdrRight') },
      { id: 'layout-rcmdr-left-explorer-right', label: t('layoutRcmdrLeftExplorerRight') },
      { id: 'layout-both-right', label: t('layoutBothRight') },
      { id: 'toggle-theme', label: t('toggleTheme') },
      { id: 'switch-language', label: t('switchLanguage') },
      { id: 'open-settings', label: t('openSettings'), accel: 'Ctrl+,' },
      { id: 'r-help', label: t('rHelpMenu'), accel: 'F1' },
      { id: 'interrupt-r', label: t('interruptR') },
      { id: 'restart-r', label: t('restartR') },
      { id: 'clear-console', label: t('clearConsole') },
      { id: 'refresh-workspace', label: t('refreshWorkspace') }
    ];
  }

  // --- Resize Sashes ---
  function wireGrips() {
    const wireColGrip = (gripEl, targetEl, invert = false) => {
      gripEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        gripEl.classList.add('dragging');
        const startX = e.clientX;
        const startW = targetEl.getBoundingClientRect().width;
        const onMove = (ev) => {
          const delta = invert ? startX - ev.clientX : ev.clientX - startX;
          targetEl.style.width = `${Math.max(190, Math.min(520, startW + delta))}px`;
          state.editors.forEach((ed) => ed?.layout());
        };
        const onUp = () => {
          gripEl.classList.remove('dragging');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    };

    wireColGrip($('leftDockGrip'), $('dockLeft'), false);
    wireColGrip($('rightDockGrip'), $('dockRight'), true);

    const bGrip = $('bottomPanelGrip');
    const bSlot = $('dockBottom');
    bGrip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bGrip.classList.add('dragging');
      const startY = e.clientY;
      const startH = bSlot.getBoundingClientRect().height;
      const onMove = (ev) => {
        const h = Math.max(110, Math.min(window.innerHeight * 0.68, startH - (ev.clientY - startY)));
        bSlot.style.height = `${h}px`;
        state.layout.panel.size = Math.round(h);
        state.editors.forEach((ed) => ed?.layout());
      };
      const onUp = () => {
        bGrip.classList.remove('dragging');
        persistLayout();
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    const sGrip = $('splitGrip');
    const g0 = $('editorGroup0');
    sGrip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sGrip.classList.add('dragging');
      const startX = e.clientX;
      const startW = g0.getBoundingClientRect().width;
      const totalW = $('editorGroups').getBoundingClientRect().width;
      const onMove = (ev) => {
        g0.style.flex = `0 0 ${Math.max(180, Math.min(totalW - 180, startW + (ev.clientX - startX)))}px`;
        state.editors.forEach((ed) => ed?.layout());
      };
      const onUp = () => {
        sGrip.classList.remove('dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // --- External File Drag & Drop ---
  function wireFileDragDrop() {
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      depth++;
      $('dropOverlay').hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      if (depth > 0) {
        depth--;
        if (depth === 0) $('dropOverlay').hidden = true;
      }
    });
    window.addEventListener('drop', async (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      depth = 0;
      $('dropOverlay').hidden = true;
      for (const f of [...e.dataTransfer.files]) {
        if (f.path) await openPathSmart(f.path);
      }
    });
  }

  // --- Accordion Collapsers ---
  for (const head of document.querySelectorAll('.accordion-head')) {
    head.addEventListener('click', (e) => {
      if (e.target.closest('.acc-actions')) return;
      const acc = $(head.getAttribute('data-acc'));
      if (!acc) return;
      acc.classList.toggle('open');
      head.querySelector('.acc-chevron').innerHTML = svg(acc.classList.contains('open') ? 'chevron-down' : 'chevron-right', { size: 13 });
    });
  }

  // --- Components ---
  hydrateStaticIcons();
  const modal = new window.RcmdrDialogModal();
  const menuBar = new window.StudioMenuBar($('menuBar'), {
    onStudioCommand: handleStudioCommand,
    onRcmdrCommand: triggerRcmdrCommand
  });
  const palette = new window.StudioCommandPalette({
    getStudioCommands: getStudioCommandsList,
    onStudioCommand: handleStudioCommand,
    onRcmdrCommand: triggerRcmdrCommand
  });
  const settingsModal = new StudioSettingsModal({
    getSettings: () => state.settings,
    onSave: (next) => {
      state.settings = next;
      applyThemePreset(next.themePreset, next.themeOverrides);
      applySettingsUI();
      showToast(t('settingsSavedToast'));
    },
    onPreviewTheme: (presetId, overrides) => applyThemePreset(presetId, overrides),
    getLang,
    onSetLang: switchLanguage
  });

  for (let g = 0; g < 2; g++) {
    state.tableViewers[g] = new window.StudioTableViewer($(`tableHost${g}`), {
      onToast: showToast,
      onSnapshot: applySnapshot,
      onOpenAsCode: (filePath) => openPathSmart(filePath, true),
      onImportCsvToR: async (tab) => {
        if (tab.filePath) {
          await loadDataFileIntoR(tab.filePath);
        } else {
          const csv = await state.tableViewers[g]._getFullCsv();
          const stem = tab.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._]/g, '_') || 'imported_table';
          await executeR(`${stem} <- utils::read.csv(text = ${JSON.stringify(csv)}, stringsAsFactors = TRUE)\nstr(${stem})`, {
            label: t('tableImportToR'),
            fromMenu: true
          });
          state.activeDataset = stem;
          refreshStatusBar();
          showToast(t('toastImportedToR', stem));
        }
      }
    });
    $(`editorGroup${g}`).addEventListener('mousedown', () => setFocusedGroup(g));
  }

  // --- Boot Sequence (gracefully degrades if previewed directly in Chrome without Electron preload) ---
  setLang(getLang());
  applyToDom();
  applyThemePreset(state.settings.themePreset || 'dracula', state.settings.themeOverrides || {});
  loadFileGroups();
  wireGrips();
  wireWorkbenchDragDock();
  wireFileDragDrop();

  const hasBridge = Boolean(window.studio && typeof window.studio.getInitInfo === 'function');
  const init = hasBridge
    ? await window.studio.getInitInfo()
    : { env: { rVersion: null, arfAvailable: false }, bridge: null, tree: [], rcmdrCount: 371, lspStatus: 'fallback', monacoVsUrl: '../node_modules/monaco-editor/min/vs' };
  state.tree = init.tree || [];
  state.rVersion = init.env?.rVersion || null;
  state.arfAvailable = Boolean(init.env?.arfAvailable);
  state.lspStatus = init.lspStatus || 'fallback';
  state.bridgePort = init.bridge?.port || null;

  if (hasBridge) await window.studio.setLanguage(getLang());
  $('statusLangBtn').textContent = getLang().toUpperCase();

  menuBar.setTree(state.tree);
  renderRcmdrTree();
  renderWorkspace();
  renderFolderTree();
  renderPlotPane();
  $('helpContent').innerHTML = `<div class="ws-empty">${t('helpEmpty')}</div>`;
  applyWorkbenchLayout();
  refreshStatusBar();
  applySettingsUI();

  // Load local offline Monaco with exact Dracula theme + MenuHover + R Usage/Examples Hover + Signature Help
  state.monaco = await window.StudioMonaco.loadMonaco(
    init.monacoVsUrl,
    (model) => {
      const tab = state.tabs.find((x) => x.kind === 'code' && x.model === model);
      return tab?.uri || null;
    },
    {
      onOpenRcmdr: (id) => triggerRcmdrCommand(id),
      onOpenRDocs: (topic) => openRDocs(topic)
    }
  );

  for (let g = 0; g < 2; g++) {
    const ed = state.monaco.editor.create($(`editorHost${g}`), {
      theme: state.theme === 'light' ? 'vscode-light' : 'dracula',
      automaticLayout: true,
      fontSize: 13.5,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", SFMono-Regular, Menlo, Consolas, monospace',
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      tabSize: 2,
      wordWrap: state.settings.editorWordWrap !== false ? 'on' : 'off'
    });
    ed.onDidFocusEditorText(() => setFocusedGroup(g));
    ed.onDidChangeCursorPosition((e) => {
      if (state.focusedGroup === g) {
        $('statusCursor').textContent = t('statusCursor', e.position.lineNumber, e.position.column);
      }
    });
    ed.addCommand(state.monaco.KeyMod.CtrlCmd | state.monaco.KeyCode.Enter, () => executeR(extractCodeToRun(false)));
    ed.addCommand(state.monaco.KeyMod.Alt | state.monaco.KeyCode.Enter, () => executeR(extractCodeToRun('retain')));
    ed.addCommand(state.monaco.KeyMod.CtrlCmd | state.monaco.KeyMod.Shift | state.monaco.KeyCode.Enter, () => {
      const tab = activeTab();
      const code = tab?.language === 'rmd' ? extractRmdChunkToRun(false) : extractCodeToRun(true);
      if (code) executeR(code);
    });
    ed.addCommand(state.monaco.KeyMod.CtrlCmd | state.monaco.KeyMod.Alt | state.monaco.KeyCode.KeyP, () => {
      const code = extractRmdChunkToRun(true);
      if (code) executeR(code);
    });
    ed.addCommand(state.monaco.KeyMod.CtrlCmd | state.monaco.KeyMod.Alt | state.monaco.KeyCode.KeyE, () => {
      const code = extractLineToEnd();
      if (code) executeR(code);
    });
    ed.addCommand(state.monaco.KeyMod.Alt | state.monaco.KeyCode.Minus, () => insertTextAtCursor(ed, ' <- '));
    ed.addCommand(state.monaco.KeyMod.CtrlCmd | state.monaco.KeyMod.Shift | state.monaco.KeyCode.KeyM, () => insertTextAtCursor(ed, ' |> '));
    ed.addCommand(state.monaco.KeyCode.F1, () => openDocsForCursor());
    ed.addAction({
      id: 'studio.context.openRDocs',
      label: t('openDocsBtn'),
      contextMenuGroupId: 'navigation',
      run: () => openDocsForCursor()
    });
    state.editors[g] = ed;
  }

  // Apply active custom/preset theme to Monaco immediately after editor creation
  applyThemePreset(state.settings.themePreset || 'dracula', state.settings.themeOverrides || {});

  // Starter tabs
  createCodeTab({ name: 'report.Rmd', content: DEFAULT_RMD_DOC, language: 'rmd', dirty: false, groupIndex: 0 });
  createCodeTab({ name: 'analysis.R', content: DEFAULT_R_SCRIPT, language: 'r', dirty: false, groupIndex: 0 });

  // --- Wire Main Process Events ---
  if (hasBridge) {
    window.studio.onROutput(({ stream, text }) => appendConsole(text, stream === 'stderr' ? 'console-line-err' : ''));
    window.studio.onArfOutput(({ stream, text }) => appendArf(text, stream === 'stderr' ? 'console-line-err' : ''));
    window.studio.onRViewTable(({ name, title, source }) =>
      openRTableTab({ objectName: name, title: title || name, source: source || 'global', editable: false })
    );
    window.studio.onDiagnostics(({ uri, diagnostics, source }) => {
      const entry = state.diagnosticsByUri.get(uri) || { syntax: [], lsp: [] };
      if (source === 'lsp') entry.lsp = diagnostics || [];
      else entry.syntax = diagnostics || [];
      state.diagnosticsByUri.set(uri, entry);
      applyMarkersForUri(uri);
    });
    window.studio.onLspStatus((status) => {
      state.lspStatus = status;
      refreshStatusBar();
    });
    window.studio.onBridgeOpenScript(({ title, code, kind, filePath }) => {
      const ext = kind === 'rmd' ? '.Rmd' : '.R';
      const filename = title.endsWith(ext) || title.endsWith(ext.toLowerCase()) ? title : `${title}${ext}`;
      createCodeTab({ name: filename, filePath: filePath || null, content: code || '', language: kind === 'rmd' ? 'rmd' : 'r', dirty: !filePath });
      showToast(t('toastOpenedBridge', filename));
    });
    const handleOpenPathTarget = async ({ filePath, folderPath } = {}) => {
      if (folderPath) {
        const res = await window.studio.readDirTree(folderPath);
        if (res) {
          state.workspaceRoot = res.root;
          state.workspaceName = res.name;
          state.folderTree = res.tree || [];
          loadFileGroups();
          renderFileGroupsPanel();
          renderFolderTree();
          state.layout.setSidebarOpen('explorer', true);
          applyWorkbenchLayout();
        }
      }
      if (filePath) {
        await openPathSmart(filePath);
      }
    };
    window.studio.onBridgeOpenPath(handleOpenPathTarget);
    if (Array.isArray(init.pendingOpenPaths) && init.pendingOpenPaths.length) {
      for (const target of init.pendingOpenPaths) {
        handleOpenPathTarget(target).catch(() => {});
      }
    }
    window.studio.onMenuCommand((cmd) => handleStudioCommand(cmd));
    window.studio.onMenuRcmdr((id) => triggerRcmdrCommand(id));
  }

  // Global Shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      e.preventDefault();
      openDocsForCursor();
      return;
    }
    if (e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      state.settings.editorWordWrap = state.settings.editorWordWrap === false;
      saveSettings(state.settings);
      applySettingsUI();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && !mod && (e.key === '-' || e.key === '_')) {
      const ed = state.editors[state.focusedGroup];
      if (ed && ed.hasTextFocus?.()) {
        e.preventDefault();
        insertTextAtCursor(ed, ' <- ');
        return;
      }
    }
    if (!mod) return;
    const key = e.key.toLowerCase();
    // User keybindings.json: Ctrl+0 zoomReset, Ctrl++/Ctrl+=/Ctrl+Shift++/Ctrl+Shift+= zoomIn, Ctrl+- zoomOut
    if (!e.altKey && (e.key === '0' || e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
      e.preventDefault();
      const curZ = parseFloat(document.documentElement.style.zoom || '1') || 1;
      const nextZ = e.key === '0' ? 1 : (e.key === '-' || e.key === '_') ? Math.max(0.7, +(curZ - 0.1).toFixed(2)) : Math.min(1.6, +(curZ + 0.1).toFixed(2));
      document.documentElement.style.zoom = nextZ === 1 ? '' : String(nextZ);
      state.editors.forEach((ed) => ed?.layout());
      return;
    }
    if (e.altKey && key === 'i') {
      e.preventDefault();
      handleStudioCommand('toggle-rcmdr-sidebar');
      return;
    }
    if (e.altKey && key === 'h') {
      e.preventDefault();
      $('btnPanelHistory')?.click();
      return;
    }
    if (e.altKey && key === 'p') {
      e.preventDefault();
      const code = extractRmdChunkToRun(true);
      if (code) executeR(code);
      return;
    }
    if (e.altKey && key === 'e') {
      e.preventDefault();
      const code = extractLineToEnd();
      if (code) executeR(code);
      return;
    }
    if (!e.shiftKey && !e.altKey && key === 'b') {
      e.preventDefault();
      handleStudioCommand('toggle-explorer-sidebar');
      return;
    }
    if (!e.shiftKey && !e.altKey && key === 'j') {
      e.preventDefault();
      handleStudioCommand('toggle-panel');
      return;
    }
    if ((e.shiftKey && key === 'p') || (!e.shiftKey && key === 'k')) {
      e.preventDefault();
      palette.open('');
    } else if (key === '\\') {
      e.preventDefault();
      toggleSplitGroup();
    } else if (key === ',') {
      e.preventDefault();
      settingsModal.open();
    } else if (key === 's') {
      e.preventDefault();
      if (e.shiftKey && activeTab()?.language === 'r') executeR(extractCodeToRun(true));
      else saveFileAction(e.shiftKey);
    } else if (key === 'o') {
      e.preventDefault();
      if (e.shiftKey) openFolderAction();
      else openFileAction();
    } else if (key === 'n') {
      e.preventDefault();
      handleStudioCommand(e.shiftKey ? 'new-rmd' : 'new-r');
    } else if (e.shiftKey && key === 'v') {
      e.preventDefault();
      handleStudioCommand('toggle-preview');
    } else if (e.shiftKey && key === 'k') {
      e.preventDefault();
      handleStudioCommand('knit');
    }
  });

  // --- Wire UI Buttons ---
  $('topSearchTrigger').addEventListener('click', () => palette.open(''));
  $('btnRun').addEventListener('click', () => handleStudioCommand('run-selection'));
  $('btnRunAll').addEventListener('click', () => handleStudioCommand('run-all'));
  $('btnInterrupt').addEventListener('click', () => handleStudioCommand('interrupt-r'));
  $('btnPreview').addEventListener('click', () => handleStudioCommand('toggle-preview'));
  $('btnKnit').addEventListener('click', () => handleStudioCommand('knit'));
  $('btnDocsCursor').addEventListener('click', openDocsForCursor);
  $('btnSplit').addEventListener('click', () => handleStudioCommand('toggle-split'));
  $('btnToggleExplorer').addEventListener('click', () => handleStudioCommand('toggle-explorer-sidebar'));
  $('btnToggleRcmdr').addEventListener('click', () => handleStudioCommand('toggle-rcmdr-sidebar'));
  $('btnTogglePanel').addEventListener('click', () => handleStudioCommand('toggle-panel'));

  // Activity Bar
  $('actExplorer').addEventListener('click', () => handleStudioCommand('toggle-explorer-sidebar'));
  $('actRcmdr').addEventListener('click', () => handleStudioCommand('toggle-rcmdr-sidebar'));
  $('actPlots').addEventListener('click', () => openPanelTab('plots'));
  $('actHelp').addEventListener('click', () => openPanelTab('help'));
  $('actTheme').addEventListener('click', () => handleStudioCommand('toggle-theme'));
  $('actSettings').addEventListener('click', () => settingsModal.open());

  // Sidebar header dock/close actions
  $('btnFlipExplorer').addEventListener('click', () => {
    state.layout.flipSidebarDock('explorer');
    applyWorkbenchLayout();
  });
  $('btnCloseExplorer').addEventListener('click', () => {
    state.layout.setSidebarOpen('explorer', false);
    applyWorkbenchLayout();
  });
  $('btnFlipRcmdr').addEventListener('click', () => {
    state.layout.flipSidebarDock('rcmdr');
    applyWorkbenchLayout();
  });
  $('btnCloseRcmdr').addEventListener('click', () => {
    state.layout.setSidebarOpen('rcmdr', false);
    applyWorkbenchLayout();
  });

  // Editor Tab Strip actions
  $('btnAddTab0').addEventListener('click', () => createCodeTab({ name: `script-${state.nextTabNum}.R`, content: '', language: 'r', groupIndex: 0 }));
  $('btnAddTab1').addEventListener('click', () => createCodeTab({ name: `script-${state.nextTabNum}.R`, content: '', language: 'r', groupIndex: 1 }));
  $('btnSave0').addEventListener('click', () => saveFileAction(false));
  $('btnSplit0').addEventListener('click', toggleSplitGroup);
  $('btnCloseSplit').addEventListener('click', closeSplitGroup);
  $('btnClosePreview').addEventListener('click', closePreview);
  $('btnPreviewModeLive').addEventListener('click', () => openPreview('live'));
  $('btnPreviewModeKnit').addEventListener('click', () => openPreview('knit'));

  // Workspace & Files buttons
  $('btnWsLoadRData').addEventListener('click', () => handleStudioCommand('load-workspace'));
  $('btnWsSaveRData').addEventListener('click', () => triggerRcmdrCommand('saveWorkspaceAs'));
  $('btnRefreshWs').addEventListener('click', () => handleStudioCommand('refresh-workspace'));
  $('btnNewFileGroup').addEventListener('click', () => {
    const name = window.prompt(t('newGroupPrompt'));
    if (name && state.fileGroups.createGroup(name)) {
      saveFileGroups();
      renderFileGroupsPanel();
    }
  });
  $('btnNewRQuick').addEventListener('click', () => handleStudioCommand('new-r'));
  $('btnOpenFileQuick').addEventListener('click', () => handleStudioCommand('open'));
  $('btnOpenFolder').addEventListener('click', openFolderAction);
  $('btnExplorerNewFile').addEventListener('click', async () => {
    if (!state.workspaceRoot) return;
    const name = window.prompt(t('newFilePrompt'), 'new_script.R');
    if (name && name.trim()) {
      const created = await window.studio.createFile({ dir: state.workspaceRoot, name: name.trim() });
      await refreshFolderTree();
      if (created?.path) await openPathSmart(created.path);
    }
  });
  $('btnExplorerNewFolder').addEventListener('click', async () => {
    if (!state.workspaceRoot) return;
    const name = window.prompt(t('newFolderPrompt'), 'data');
    if (name && name.trim()) {
      await window.studio.createDir({ dir: state.workspaceRoot, name: name.trim() });
      await refreshFolderTree();
    }
  });

  // R Commander Search & Collapse
  $('rcmdrSearch').addEventListener('input', renderRcmdrTree);
  $('btnRcmdrFocusSearch').addEventListener('click', () => $('rcmdrSearch').focus());
  $('btnRcmdrClear').addEventListener('click', () => {
    $('rcmdrSearch').value = '';
    renderRcmdrTree();
  });
  $('btnRcmdrCollapse').addEventListener('click', () => {
    $('rcmdrSearch').value = '';
    renderRcmdrTree();
  });

  // Panel tabs & header controls
  for (const btn of document.querySelectorAll('.panel-tab')) {
    btn.addEventListener('click', () => openPanelTab(btn.dataset.dock));
  }
  $('btnPanelLimitOutput').addEventListener('click', () => {
    state.settings.limitOutput = !state.settings.limitOutput;
    saveSettings(state.settings);
    applySettingsUI();
  });
  $('btnPanelWordWrap').addEventListener('click', () => handleStudioCommand('toggle-word-wrap'));
  $('btnPanelHistory').addEventListener('click', () => {
    const hist = state.activePanelTab === 'arf' ? state.arfHistory : state.rHistory;
    if (!hist.length) {
      showToast(t('panelHistoryEmpty'));
      return;
    }
    const recent = hist.slice(-15).reverse().join('\n');
    appendConsole(`\n# ${t('panelHistoryTitle')} (${hist.length}):\n${recent}\n`, 'console-line-meta');
    openPanelTab('console');
  });
  $('btnPanelInterrupt').addEventListener('click', () => handleStudioCommand('interrupt-r'));
  $('btnPanelRestart').addEventListener('click', () => handleStudioCommand('restart-r'));
  $('btnPanelClear').addEventListener('click', () => handleStudioCommand('clear-console'));
  $('btnPanelOrient').addEventListener('click', () => handleStudioCommand('toggle-panel-orientation'));
  $('btnPanelDockCycle').addEventListener('click', () => handleStudioCommand('toggle-dock-position'));
  $('btnPanelClose').addEventListener('click', () => {
    state.layout.setPanelOpen(false);
    applyWorkbenchLayout();
  });

  // R Console REPL input with Up/Down history
  $('consoleInput').addEventListener('keydown', (e) => {
    const inp = $('consoleInput');
    if (e.key === 'Enter') {
      const val = inp.value;
      if (!val.trim()) return;
      state.rHistory.push(val);
      state.rHistoryIdx = state.rHistory.length;
      inp.value = '';
      executeR(val, { fromMenu: true });
    } else if (e.key === 'ArrowUp' && state.rHistory.length) {
      e.preventDefault();
      state.rHistoryIdx = Math.max(0, state.rHistoryIdx - 1);
      inp.value = state.rHistory[state.rHistoryIdx] || '';
    } else if (e.key === 'ArrowDown' && state.rHistory.length) {
      e.preventDefault();
      state.rHistoryIdx = Math.min(state.rHistory.length, state.rHistoryIdx + 1);
      inp.value = state.rHistory[state.rHistoryIdx] || '';
    }
  });

  // arf Terminal REPL input with Up/Down history
  $('arfInput').addEventListener('keydown', async (e) => {
    const inp = $('arfInput');
    if (e.key === 'Enter') {
      const val = inp.value;
      if (!val.trim()) return;
      state.arfHistory.push(val);
      state.arfHistoryIdx = state.arfHistory.length;
      inp.value = '';
      if (await ensureArfStarted()) await window.studio.arfSend(val);
    } else if (e.key === 'ArrowUp' && state.arfHistory.length) {
      e.preventDefault();
      state.arfHistoryIdx = Math.max(0, state.arfHistoryIdx - 1);
      inp.value = state.arfHistory[state.arfHistoryIdx] || '';
    } else if (e.key === 'ArrowDown' && state.arfHistory.length) {
      e.preventDefault();
      state.arfHistoryIdx = Math.min(state.arfHistory.length, state.arfHistoryIdx + 1);
      inp.value = state.arfHistory[state.arfHistoryIdx] || '';
    }
  });

  // Help search input
  $('helpSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openRDocs($('helpSearchInput').value);
  });
  $('btnHelpGo').addEventListener('click', () => openRDocs($('helpSearchInput').value));

  // Plot controls & Multi-format Export (SVG / PNG 2x / PDF / Copy PNG)
  $('btnPlotPrev').addEventListener('click', () => {
    if (state.plotIndex > 0) {
      state.plotIndex--;
      renderPlotPane();
    }
  });
  $('btnPlotNext').addEventListener('click', () => {
    if (state.plotIndex < state.plots.length - 1) {
      state.plotIndex++;
      renderPlotPane();
    }
  });
  $('btnPlotZoomOut').addEventListener('click', () => {
    state.plotZoom = Math.max(0.3, Number((state.plotZoom - 0.15).toFixed(2)));
    renderPlotPane();
  });
  $('btnPlotZoomIn').addEventListener('click', () => {
    state.plotZoom = Math.min(3, Number((state.plotZoom + 0.15).toFixed(2)));
    renderPlotPane();
  });
  $('btnPlotZoomReset').addEventListener('click', () => {
    state.plotZoom = 1;
    renderPlotPane();
  });
  $('btnPlotSaveSvg').addEventListener('click', async () => {
    const s = state.plots[state.plotIndex];
    if (!s) return;
    const res = await window.studio.saveSvg({ svg: s, defaultName: `plot-${state.plotIndex + 1}.svg` });
    if (res?.ok) showToast(t('toastSavedSvg', res.filePath));
  });
  $('btnPlotSavePng').addEventListener('click', async () => {
    const s = state.plots[state.plotIndex];
    if (!s) return;
    try {
      const blob = await svgToPngBlob(s, 2);
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (const b of buf) bin += String.fromCharCode(b);
      const res = await window.studio.savePlotPng({ base64Png: btoa(bin), defaultName: `plot-${state.plotIndex + 1}.png` });
      if (res?.ok) showToast(t('toastSaved', res.filePath));
    } catch (err) {
      showToast(err.message || 'PNG export failed', 'error');
    }
  });
  $('btnPlotSavePdf').addEventListener('click', async () => {
    const s = state.plots[state.plotIndex];
    if (!s) return;
    const res = await window.studio.savePlotPdf({ svg: s, defaultName: `plot-${state.plotIndex + 1}.pdf` });
    if (res?.ok) showToast(t('toastSaved', res.filePath));
  });
  $('btnPlotCopyPng').addEventListener('click', async () => {
    const s = state.plots[state.plotIndex];
    if (!s) return;
    try {
      const blob = await svgToPngBlob(s, 2);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Plot copied as PNG.');
    } catch (err) {
      showToast(err.message || 'Copy PNG failed', 'error');
    }
  });
  $('btnPlotClear').addEventListener('click', () => {
    state.plots = [];
    state.plotIndex = -1;
    renderPlotPane();
  });

  // Status Bar click actions
  $('statusProblemsBtn').addEventListener('click', () => openPanelTab('problems'));
  $('statusRPlay').addEventListener('click', () => settingsModal.open());
  $('statusRcmdrCtx').addEventListener('click', () => {
    state.layout.setSidebarOpen('explorer', true);
    applyWorkbenchLayout();
  });
  $('statusLangBtn').addEventListener('click', () => handleStudioCommand('switch-language'));
  $('statusThemeBtn').addEventListener('click', () => handleStudioCommand('toggle-theme'));
  $('statusRunTarget').addEventListener('click', () => {
    if (!state.arfAvailable) return;
    state.runTarget = state.runTarget === 'arf' ? 'r' : 'arf';
    localStorage.setItem('rcs-run-target', state.runTarget);
    refreshStatusBar();
    showToast(state.runTarget === 'arf' ? t('runTargetArf') : t('runTargetR'));
  });

  // Automation hooks for real screenshot capture
  window.__STUDIO_DEBUG__ = {
    applyTheme,
    switchLanguage,
    openPanelTab,
    executeR,
    extractCodeToRun,
    openRTableTab,
    openSplitGroup,
    moveTabToGroup,
    triggerRcmdrCommand,
    openPreview,
    openRDocs,
    createCodeTab,
    applyWorkbenchLayout,
    state
  };

  appendConsole(
    t('consoleReady', state.rVersion ? `R ${state.rVersion}` : t('statusRNotFound'), init.rcmdrCount) + '\n',
    'console-line-meta'
  );
})();
