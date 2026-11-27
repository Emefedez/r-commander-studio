(async function () {
  'use strict';

  const { t, getLang, setLang, applyToDom } = window.StudioI18n;
  const { svg, rcmdrColor } = window.StudioIcons;
  const { FileGroupsModel } = window.StudioFileGroups;
  const { WorkbenchLayoutModel } = window.StudioWorkbenchLayout;
  const { loadSettings, saveSettings, StudioSettingsModal } = window.StudioSettings;
  const { StudioSetupWizard, isSetupComplete, markSetupComplete } = window.StudioSetupWizard;

  // First-run detection: existing installs (saved language / settings / session from an earlier
  // version) count as already set up, so the wizard only greets brand-new users.
  if (!isSetupComplete()) {
    const hadPriorLaunch = ['rcs-lang', 'rcs-settings', 'rcs-last-session'].some((k) => localStorage.getItem(k) !== null);
    if (hadPriorLaunch) markSetupComplete({ migrated: true });
  }

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
    rnoteViewers: [null, null],
    tabs: [],
    closedTabs: [],
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
    editorFontSize: Math.max(10, Math.min(28, Number(localStorage.getItem('rcs-editor-font-size')) || 13.5)),
    uiZoomFactor: Math.max(0.7, Math.min(1.6, Number(localStorage.getItem('rcs-ui-zoom-factor')) || 1)),
    panelMaximized: false,
    autoSaveTimers: new Map(),

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
  let copilot = null;

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

  function isRnoteExt(filename = '') {
    return /\.rnote$/i.test(filename);
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

    // Place sidebars into their docks following the user's left-to-right order.
    for (const [side, dockEl] of [
      ['left', dockLeft],
      ['right', dockRight]
    ]) {
      const want = L.sidebarOrder
        .filter((id) => L.sidebars[id].dock === side)
        .map((id) => (id === 'explorer' ? sbExplorer : sbRcmdr));
      const have = [...dockEl.children].filter((c) => c.classList.contains('dockable-sidebar'));
      if (want.length !== have.length || want.some((el, i) => el !== have[i])) {
        const anchor = panel.parentElement === dockEl ? panel : null;
        for (const el of want) dockEl.insertBefore(el, anchor);
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

    // When both sidebars are open on the same side (and the panel is not in that side dock),
    // stack them vertically in one clean column so they don't eat double horizontal width!
    const bothLeft =
      L.sidebars.explorer.open &&
      L.sidebars.rcmdr.open &&
      L.sidebars.explorer.dock === 'left' &&
      L.sidebars.rcmdr.dock === 'left' &&
      !(L.panel.open && L.panel.dock === 'left');
    const bothRight =
      L.sidebars.explorer.open &&
      L.sidebars.rcmdr.open &&
      L.sidebars.explorer.dock === 'right' &&
      L.sidebars.rcmdr.dock === 'right' &&
      !(L.panel.open && L.panel.dock === 'right');
    dockLeft.classList.toggle('stack-sidebars', bothLeft);
    dockRight.classList.toggle('stack-sidebars', bothRight);

    const peekingLeft =
      (L.isPeeking('explorer') && L.sidebars.explorer.dock === 'left') ||
      (L.isPeeking('rcmdr') && L.sidebars.rcmdr.dock === 'left');
    const peekingRight =
      (L.isPeeking('explorer') && L.sidebars.explorer.dock === 'right') ||
      (L.isPeeking('rcmdr') && L.sidebars.rcmdr.dock === 'right');

    dockLeft.hidden = !hasLeft && !peekingLeft;
    leftGrip.hidden = !hasLeft;
    dockRight.hidden = !hasRight && !peekingRight;
    rightGrip.hidden = !hasRight;
    dockBottom.hidden = !hasBottom;
    bottomGrip.hidden = !hasBottom;
    dockBottom.classList.toggle('maximized', Boolean(state.panelMaximized && hasBottom));
    $('btnPanelMaximize')?.classList.toggle('active', Boolean(state.panelMaximized && hasBottom));

    if (hasBottom && !state.panelMaximized) dockBottom.style.height = `${L.panel.size}px`;

    // Sync Activity Bar & Top Bar active / readiness indicators
    $('actExplorer').classList.toggle('active', L.sidebars.explorer.open);
    $('actRcmdr').classList.toggle('active', L.sidebars.rcmdr.open);
    $('actPlots')?.classList.toggle('active', L.panel.open && state.activePanelTab === 'plots');
    $('actPlots')?.classList.toggle('needs-step', state.plots.length === 0);
    $('actHelp')?.classList.toggle('active', L.panel.open && state.activePanelTab === 'help');
    $('actHelp')?.classList.toggle('needs-step', !state.lastHelpTopic);
    $('actCopilot')?.classList.toggle('active', Boolean(copilot?.windowOpen));
    $('actCopilot')?.classList.toggle('needs-step', !copilot?.status?.t3Running);
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
    // In small tiled windows (<= 760px), open sidebars act as overlay drawers, so auto-close them after a choice!
    if (window.innerWidth <= 760 && state.layout.sidebars[id]?.open) {
      state.layout.setSidebarOpen(id, false);
      applyWorkbenchLayout();
      return;
    }
    if (state.layout.onSelectionInSidebar(id)) applyWorkbenchLayout();
  }

  // Responsive adaptation when window is resized to a small/tiled width
  let lastNarrowMode = window.innerWidth <= 920;
  window.addEventListener('resize', () => {
    const isNarrow = window.innerWidth <= 920;
    if (isNarrow && !lastNarrowMode) {
      // If both sidebars are open on opposite sides when the window shrinks below 920px, collapse Explorer so the editor stays wide
      if (state.layout.sidebars.explorer.open && state.layout.sidebars.rcmdr.open && state.layout.sidebars.explorer.dock !== state.layout.sidebars.rcmdr.dock) {
        state.layout.setSidebarOpen('explorer', false);
        applyWorkbenchLayout();
      }
    }
    lastNarrowMode = isNarrow;
    state.editors.forEach((ed) => ed?.layout());
  });

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

  // --- Drag-and-Drop Workbench Docking (Sidebars, Panel, Panel Tabs) ---
  // Pointer-event based (not native HTML5 DnD): native drag in Electron on
  // Wayland is unreliable and could get stuck after the first drop.
  const LAYOUT_LOCK_KEY = 'rcs-layout-locked';
  const PANEL_TAB_ORDER_KEY = 'rcs-panel-tab-order';
  const isLayoutLocked = () => localStorage.getItem(LAYOUT_LOCK_KEY) === '1';
  function applyLayoutLockUI() {
    document.body.classList.toggle('layout-locked', isLayoutLocked());
  }

  function restorePanelTabOrder() {
    const strip = $('panelTabs');
    if (!strip) return;
    let order = [];
    try {
      order = JSON.parse(localStorage.getItem(PANEL_TAB_ORDER_KEY) || '[]');
    } catch {
      order = [];
    }
    if (!Array.isArray(order)) return;
    for (const key of order) {
      const btn = strip.querySelector(`.panel-tab[data-dock="${CSS.escape(String(key))}"]`);
      if (btn) strip.append(btn);
    }
  }

  function savePanelTabOrder() {
    const keys = [...document.querySelectorAll('#panelTabs .panel-tab[data-dock]')].map((b) => b.dataset.dock);
    localStorage.setItem(PANEL_TAB_ORDER_KEY, JSON.stringify(keys));
  }

  // FLIP animation helper: animates elements from their old to new positions.
  function animateReflow(els, mutate) {
    const before = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
    mutate();
    for (const el of els) {
      const a = before.get(el);
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (!dx && !dy) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: 180,
        easing: 'cubic-bezier(0.2, 0, 0, 1)'
      });
    }
  }

  function dropDockTab(key, isRight) {
    if (isRight) {
      if (key === state.activePanelTab && splitPanelTab) {
        const oldRight = splitPanelTab;
        state.activePanelTab = oldRight;
        setSplitPanelTab(key);
      } else if (key === state.activePanelTab) {
        // Dragging the visible tab to the right: the previous companion stays left.
        const companion = key === 'console' ? 'plots' : 'console';
        state.activePanelTab = companion;
        setSplitPanelTab(key);
      } else {
        setSplitPanelTab(key);
      }
    } else if (splitPanelTab === key) {
      const oldLeft = state.activePanelTab;
      state.activePanelTab = key;
      setSplitPanelTab(oldLeft);
    } else {
      openPanelTab(key);
    }
    if (key === 'arf') ensureArfStarted();
  }

  // Makes an overflowing row horizontally scrollable with the mouse wheel and
  // fades whichever edge still has hidden content. `startAtEnd` keeps the
  // rightmost items (e.g. split/dock/close) in view when it first overflows.
  function wireHScrollFade(el, { startAtEnd = false } = {}) {
    if (!el) return;
    el.classList.add('hscroll-fade');
    let wasOverflowing = false;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const overflowing = max > 1;
      if (overflowing && !wasOverflowing && startAtEnd) {
        el.style.scrollBehavior = 'auto';
        el.scrollLeft = max;
        el.style.scrollBehavior = '';
      }
      wasOverflowing = overflowing;
      el.classList.toggle('fade-left', overflowing && el.scrollLeft > 1);
      el.classList.toggle('fade-right', overflowing && el.scrollLeft < max - 1);
    };
    el.addEventListener('scroll', update, { passive: true });
    el.addEventListener(
      'wheel',
      (e) => {
        if (el.scrollWidth <= el.clientWidth + 1) return;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!delta) return;
        e.preventDefault();
        el.scrollLeft += delta;
      },
      { passive: false }
    );
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      for (const child of el.children) ro.observe(child);
    }
    window.addEventListener('resize', update);
    el._hscrollUpdate = update;
    update();
  }

  function wireWorkbenchDragDock() {
    const zLeft = $('dropZoneLeft');
    const zRight = $('dropZoneRight');
    const zBottom = $('dropZoneBottom');
    const zones = [
      [zLeft, 'left'],
      [zRight, 'right'],
      [zBottom, 'bottom']
    ];
    const sidebarEls = { explorer: $('sidebarExplorer'), rcmdr: $('sidebarRcmdr') };
    const dockPanel = $('dockPanel');
    const panelBody = $('panelBody');
    const tabStrip = $('panelTabs');
    const THRESHOLD = 5;

    const ghost = document.createElement('div');
    ghost.className = 'dock-drag-ghost';
    ghost.hidden = true;
    document.body.append(ghost);

    const splitPreview = document.createElement('div');
    splitPreview.className = 'dock-split-preview';
    splitPreview.hidden = true;
    panelBody?.append(splitPreview);

    const insertMarker = document.createElement('div');
    insertMarker.className = 'panel-tab-insert-marker';
    insertMarker.hidden = true;
    document.body.append(insertMarker);

    let drag = null; // { kind: 'sidebar'|'panel'|'tab', id, startX, startY, active, pointerId, handle, target }
    let suppressClickUntil = 0;

    // Swallow the click that follows a real drag (so buttons/tabs don't fire).
    document.addEventListener(
      'click',
      (e) => {
        if (Date.now() < suppressClickUntil) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );

    const inRect = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    const visibleRect = (el) => (el && !el.hidden && el.offsetParent !== null ? el.getBoundingClientRect() : null);

    const clearIndicators = () => {
      for (const [z] of zones) z.classList.remove('drag-over');
      for (const el of Object.values(sidebarEls)) {
        el.classList.remove('sb-drop-before', 'sb-drop-after', 'sb-drop-vertical');
      }
      splitPreview.hidden = true;
      splitPreview.classList.remove('side-left', 'side-right', 'show');
      insertMarker.hidden = true;
    };

    const endDrag = () => {
      if (!drag) return;
      try {
        drag.handle.releasePointerCapture?.(drag.pointerId);
      } catch {
        /* already released */
      }
      for (const [z] of zones) z.hidden = true;
      clearIndicators();
      ghost.hidden = true;
      ghost.classList.remove('show');
      document.body.classList.remove('dock-dragging');
      drag.source?.classList.remove('dock-drag-source');
      drag = null;
    };

    const ghostLabel = (kind, id) => {
      if (kind === 'sidebar') return id === 'explorer' ? t('sidebarExplorerTitle') : t('sidebarRcmdrTitle');
      if (kind === 'tab') {
        return document.querySelector(`.panel-tab[data-dock="${id}"] .panel-tab-label`)?.textContent || id;
      }
      return t('togglePanel');
    };

    const activate = () => {
      drag.active = true;
      document.body.classList.add('dock-dragging');
      ghost.textContent = ghostLabel(drag.kind, drag.id);
      ghost.hidden = false;
      requestAnimationFrame(() => ghost.classList.add('show'));
      if (drag.kind === 'sidebar') {
        drag.source = sidebarEls[drag.id];
        zLeft.hidden = false;
        zRight.hidden = false;
      } else if (drag.kind === 'panel') {
        drag.source = dockPanel;
        zLeft.hidden = false;
        zRight.hidden = false;
        zBottom.hidden = false;
      } else if (drag.kind === 'tab') {
        drag.source = drag.handle;
      }
      drag.source?.classList.add('dock-drag-source');
    };

    // --- Hit testing per drag kind ---
    const hitZones = (x, y, allowed) => {
      for (const [z, side] of zones) {
        if (!allowed.includes(side) || z.hidden) continue;
        if (inRect(z.getBoundingClientRect(), x, y)) return { z, side };
      }
      return null;
    };

    const computeSidebarTarget = (x, y) => {
      const zone = hitZones(x, y, ['left', 'right']);
      if (zone) {
        return { side: zone.side, before: zone.side === 'left' ? 'start' : null, zone: zone.z };
      }
      for (const [otherId, el] of Object.entries(sidebarEls)) {
        if (otherId === drag.id) continue;
        const r = visibleRect(el);
        if (!r || !inRect(r, x, y)) continue;
        const side = state.layout.sidebars[otherId].dock;
        // Two sidebars on one side stack vertically unless the panel shares that dock.
        const vertical = !(state.layout.panel.open && state.layout.panel.dock === side);
        const first = vertical ? y < r.top + r.height / 2 : x < r.left + r.width / 2;
        const order = state.layout.sidebarOrder.filter((i) => i !== drag.id);
        const after = order[order.indexOf(otherId) + 1] || null;
        return { side, before: first ? otherId : after, over: el, first, vertical };
      }
      return null;
    };

    const computeTabTarget = (x, y) => {
      const stripRect = visibleRect(tabStrip);
      const vertical = dockPanel.classList.contains('orient-vertical');
      if (stripRect && inRect(stripRect, x, y)) {
        const tabs = [...tabStrip.querySelectorAll('.panel-tab[data-dock]')].filter(
          (b) => b.dataset.dock !== drag.id && !b.classList.contains('split-hidden')
        );
        let beforeEl = null;
        for (const b of tabs) {
          const r = b.getBoundingClientRect();
          if (vertical ? y < r.top + r.height / 2 : x < r.left + r.width / 2) {
            beforeEl = b;
            break;
          }
        }
        return { reorder: true, beforeEl, vertical, tabs };
      }
      const bodyRect = visibleRect(panelBody);
      if (bodyRect && inRect(bodyRect, x, y)) {
        return { split: true, isRight: x > bodyRect.left + bodyRect.width / 2 };
      }
      return null;
    };

    const showTarget = (x, y) => {
      clearIndicators();
      if (drag.kind === 'sidebar') {
        const tgt = computeSidebarTarget(x, y);
        drag.target = tgt;
        if (tgt?.zone) tgt.zone.classList.add('drag-over');
        if (tgt?.over) {
          tgt.over.classList.add(tgt.first ? 'sb-drop-before' : 'sb-drop-after');
          tgt.over.classList.toggle('sb-drop-vertical', tgt.vertical);
        }
      } else if (drag.kind === 'panel') {
        const zone = hitZones(x, y, ['left', 'right', 'bottom']);
        drag.target = zone;
        zone?.z.classList.add('drag-over');
      } else if (drag.kind === 'tab') {
        const tgt = computeTabTarget(x, y);
        drag.target = tgt;
        if (tgt?.reorder) {
          const ref = tgt.beforeEl || tgt.tabs[tgt.tabs.length - 1];
          if (ref) {
            const r = ref.getBoundingClientRect();
            const atEnd = !tgt.beforeEl;
            insertMarker.classList.toggle('vertical', tgt.vertical);
            if (tgt.vertical) {
              Object.assign(insertMarker.style, {
                left: `${r.left + 4}px`,
                top: `${(atEnd ? r.bottom : r.top) - 1}px`,
                width: `${r.width - 8}px`,
                height: '2px'
              });
            } else {
              Object.assign(insertMarker.style, {
                left: `${(atEnd ? r.right : r.left) - 1}px`,
                top: `${r.top + 4}px`,
                width: '2px',
                height: `${r.height - 8}px`
              });
            }
            insertMarker.hidden = false;
          }
        } else if (tgt?.split) {
          splitPreview.hidden = false;
          splitPreview.classList.add(tgt.isRight ? 'side-right' : 'side-left');
          splitPreview.textContent = tgt.isRight ? t('dropZoneSplitRight') : t('dropZoneSplitLeft');
          requestAnimationFrame(() => splitPreview.classList.add('show'));
        }
      }
    };

    const commit = () => {
      const { kind, id, target } = drag;
      if (!target) return;
      if (kind === 'sidebar') {
        state.layout.placeSidebar(id, target.side, target.before);
        applyWorkbenchLayout();
        const el = sidebarEls[id];
        el.animate([{ opacity: 0.35, transform: 'scale(0.985)' }, { opacity: 1, transform: 'none' }], {
          duration: 200,
          easing: 'cubic-bezier(0.2, 0, 0, 1)'
        });
      } else if (kind === 'panel') {
        state.layout.setPanelDock(target.side);
        applyWorkbenchLayout();
        dockPanel.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      } else if (kind === 'tab') {
        if (target.reorder) {
          const tabs = [...tabStrip.querySelectorAll('.panel-tab[data-dock]')];
          const btn = tabStrip.querySelector(`.panel-tab[data-dock="${id}"]`);
          if (btn) animateReflow(tabs, () => tabStrip.insertBefore(btn, target.beforeEl));
          savePanelTabOrder();
          // Dropping the right pane's title back into the tab row closes the split
          // and shows that tab on the left (like moving an editor back into one group).
          if (id === splitPanelTab) {
            setSplitPanelTab(null);
            openPanelTab(id);
          }
        } else if (target.split) {
          dropDockTab(id, target.isRight);
        }
      }
    };

    const onPointerDown = (kind, getId) => (e) => {
      if (e.button !== 0 || drag || isLayoutLocked()) return;
      if (e.target.closest('input, select, textarea')) return;
      if (kind === 'panel' && e.target.closest('.panel-tab, .panel-secondary-title')) return;
      drag = {
        kind,
        id: getId(e),
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        pointerId: e.pointerId,
        handle: e.currentTarget,
        target: null
      };
    };

    const onPointerMove = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!(e.buttons & 1)) {
        endDrag();
        return;
      }
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < THRESHOLD) return;
        try {
          drag.handle.setPointerCapture(drag.pointerId);
        } catch {
          /* pointer gone */
        }
        activate();
      }
      e.preventDefault();
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
      showTarget(e.clientX, e.clientY);
    };

    const onPointerUp = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (drag.active) {
        suppressClickUntil = Date.now() + 250;
        showTarget(e.clientX, e.clientY);
        try {
          commit();
        } finally {
          endDrag();
        }
      } else {
        drag = null;
      }
    };

    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', endDrag, true);
    window.addEventListener('blur', endDrag);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drag?.active) {
        suppressClickUntil = Date.now() + 250;
        endDrag();
      }
    });

    for (const handle of document.querySelectorAll('[data-drag-panel]')) {
      handle.removeAttribute('draggable');
      const what = handle.getAttribute('data-drag-panel');
      handle.addEventListener('pointerdown', onPointerDown(what === 'panel' ? 'panel' : 'sidebar', () => what));
    }
    for (const tabBtn of document.querySelectorAll('.panel-tab[data-dock]')) {
      tabBtn.draggable = false;
      tabBtn.addEventListener('pointerdown', onPointerDown('tab', (e) => e.currentTarget.dataset.dock));
    }

    $('panelSecondaryTab')?.addEventListener(
      'pointerdown',
      onPointerDown('tab', (e) => e.currentTarget.dataset.dock)
    );

    restorePanelTabOrder();
    applyLayoutLockUI();
    wireHScrollFade(tabStrip);
    wireHScrollFade(document.querySelector('#dockPanel .panel-actions'), { startAtEnd: true });
  }

  // --- Settings Application ---
  function applySettingsUI() {
    const s = state.settings;
    for (const out of [$('consoleOut'), $('arfOut')]) {
      out.classList.toggle('nowrap', s.consoleWrap === false);
      out.classList.toggle('scroll-blocks', s.consoleScroll === true);
    }
    const wrapMode = s.editorWordWrap !== false ? 'on' : 'off';
    for (const ed of state.editors) {
      ed?.updateOptions({ wordWrap: wrapMode });
    }
    $('btnWrap0')?.classList.toggle('active', s.editorWordWrap !== false);
    $('btnPanelLimitOutput')?.classList.toggle('active', Boolean(s.limitOutput));
    if ($('panelMaxPrintInput')) {
      $('panelMaxPrintInput').value = String(Number(s.maxOutputItems) || 24);
      $('panelMaxPrintInput').disabled = !s.limitOutput;
    }
    $('btnPanelSkipHelp')?.classList.toggle('active', Boolean(s.skipHelp));
    $('btnPanelFixedNotation')?.classList.toggle('active', Boolean(s.fixedNotation));
    $('btnPanelWordWrap')?.classList.toggle('active', s.consoleWrap !== false);
    $('btnRcmdrAutoClose')?.classList.toggle('active', Boolean(s.closeMenusAfterChoice));
    if ($('btnRcmdrMenuAction')) {
      $('btnRcmdrMenuAction').classList.toggle('active', s.menuAction !== 'run');
      $('btnRcmdrMenuAction').title = `${t('rcmdrMenuActionToggle')}: ${s.menuAction || 'both'}`;
    }
    $('btnProblemsToggleErrors')?.classList.toggle('active', s.showProblemErrors !== false);
    $('btnProblemsToggleWarnings')?.classList.toggle('active', s.showProblemWarnings !== false);
    for (const tab of state.tabs) {
      if (tab.kind === 'code') applyMarkersForUri(tab.uri);
    }
    renderProblemsPanel();

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
    if ($('btnTopLang')) $('btnTopLang').textContent = clean.toUpperCase();
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
      } else if (tab?.kind === 'rnote' && state.rnoteViewers[g]) {
        state.rnoteViewers[g].render();
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

  // --- ANSI Terminal Output Renderer + R Console Syntax Coloring + Top-Right (...) Hover Actions ---
  let activeOutputMenuBtn = null;
  let lastArfBlock = null;
  let lastArfBlockTime = 0;
  let lastRBlock = null;
  let lastRBlockTime = 0;

  function escapeHtmlText(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function colorizeRConsolePlain(text) {
    const lines = String(text || '').split('\n');
    return lines
      .map((line) => {
        if (!line) return '';
        if (/^\s*(Error\b|Error:)/i.test(line)) {
          return `<span class="rc-err">${escapeHtmlText(line)}</span>`;
        }
        if (/^\s*(Warning\b|Warning message|In addition:\s*Warning|Aviso)/i.test(line)) {
          return `<span class="rc-warn">${escapeHtmlText(line)}</span>`;
        }
        const promptMatch = line.match(/^([>+]\s)(.*)$/);
        if (promptMatch) {
          const promptHtml = `<span class="rc-prompt">${escapeHtmlText(promptMatch[1])}</span>`;
          const codeHtml = window.StudioMarkdownPreview?.highlightCode
            ? window.StudioMarkdownPreview.highlightCode(promptMatch[2], 'r')
            : escapeHtmlText(promptMatch[2]);
          return `${promptHtml}<span class="code-highlighted">${codeHtml}</span>`;
        }
        if (/^\s*#/.test(line)) {
          return `<span class="console-line-meta">${escapeHtmlText(line)}</span>`;
        }
        // Colorize vector indices [1], [1, ], strings, numbers, and R constants in output tables/summaries
        return escapeHtmlText(line)
          .replace(/^(\s*\[[0-9,\s]+\])/g, '<span class="rc-idx">$1</span>')
          .replace(/(&quot;[^&]*?&quot;|'[^']*?')/g, '<span class="rc-str">$1</span>')
          .replace(/\b(TRUE|FALSE|NA|NULL|Inf|NaN)\b/g, '<span class="rc-kw">$1</span>')
          .replace(/(^|[\s:(,=])(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi, '$1<span class="rc-num">$2</span>');
      })
      .join('\n');
  }

  function renderAnsiInto(targetEl, text, { syntaxHighlight = false } = {}) {
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
          if (classes.length) {
            span.className = classes.join(' ');
            span.textContent = part;
          } else if (syntaxHighlight && state.settings.syntaxColors !== false) {
            span.innerHTML = colorizeRConsolePlain(part);
          } else {
            span.textContent = part;
          }
          targetEl.append(span);
        }
      }
    } else if (syntaxHighlight && state.settings.syntaxColors !== false) {
      const span = document.createElement('span');
      span.innerHTML = colorizeRConsolePlain(text);
      targetEl.append(span);
    } else {
      targetEl.append(document.createTextNode(text));
    }
  }

  function stripAnsi(str) {
    return String(str || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  }

  function formatOutputForDocument(rawText, { lang = 'markdown', source = 'R' } = {}) {
    const clean = stripAnsi(rawText).trim();
    if (!clean) return '';
    if (lang === 'r') {
      const commented = clean
        .split(/\r?\n/)
        .map((l) => (l.startsWith('>') || l.startsWith('+') ? l.replace(/^[>+]\s?/, '') : `#> ${l}`))
        .join('\n');
      return `\n# --- ${source} Output ---\n${commented}\n`;
    }
    return `\n\n### ${source} Output\n\n\`\`\`text\n${clean}\n\`\`\`\n`;
  }

  function insertOutputIntoCodeTab(tab, rawText, source = 'R') {
    if (!tab || tab.kind !== 'code' || !tab.model) return;
    const snippet = formatOutputForDocument(rawText, { lang: tab.language, source });
    if (!snippet) return;
    const model = tab.model;
    const ed = state.editors[tab.groupIndex];
    const sel = ed?.getSelection();
    if (sel && !sel.isEmpty()) {
      model.pushEditOperations([], [{ range: sel, text: snippet }], () => null);
    } else {
      const lastLine = model.getLineCount();
      const lastCol = model.getLineMaxColumn(lastLine);
      model.pushEditOperations(
        [],
        [{ range: new state.monaco.Range(lastLine, lastCol, lastLine, lastCol), text: snippet }],
        () => null
      );
    }
    activateTab(tab.id);
    state.editors[tab.groupIndex]?.revealLine(model.getLineCount());
    showToast(t('outPastedToast', tab.name));
  }

  function collectWorkspaceDocuments(nodes, out = []) {
    for (const n of nodes || []) {
      if (n.isDir) collectWorkspaceDocuments(n.children, out);
      else if (/\.(rmd|qmd|md|markdown|r|txt)$/i.test(n.name)) out.push(n);
    }
    return out;
  }

  function openDocPickerModal(title, items, onPick) {
    const backdrop = $('docPickerBackdrop');
    const list = $('docPickerList');
    $('docPickerTitle').textContent = title;
    list.textContent = '';
    for (const item of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'palette-item';
      row.innerHTML =
        `<span class="palette-cat studio">${item.badge || 'DOC'}</span>` +
        `<span class="palette-main"><span class="palette-label"></span><span class="palette-detail"></span></span>`;
      row.querySelector('.palette-label').textContent = item.label;
      row.querySelector('.palette-detail').textContent = item.detail || '';
      row.addEventListener('click', () => {
        backdrop.hidden = true;
        onPick(item);
      });
      list.append(row);
    }
    backdrop.hidden = false;
  }

  function closeOutputActionMenu() {
    const menu = $('outputActionMenu');
    if (menu) menu.hidden = true;
    if (activeOutputMenuBtn) {
      activeOutputMenuBtn.classList.remove('menu-open');
      activeOutputMenuBtn = null;
    }
  }

  document.addEventListener('click', (e) => {
    const menu = $('outputActionMenu');
    if (menu && !menu.hidden && !menu.contains(e.target) && !e.target.closest('.console-block-more')) {
      closeOutputActionMenu();
    }
  });

  function openOutputActionMenu(btnEl, blockEl, source = 'R Console') {
    const menu = $('outputActionMenu');
    if (!menu) return;
    closeOutputActionMenu();
    activeOutputMenuBtn = btnEl;
    btnEl.classList.add('menu-open');

    const getRawText = () => stripAnsi(blockEl.querySelector('.console-block-content')?.textContent || blockEl.textContent || '').trim();
    const getHtmlContent = () => `<pre>${blockEl.querySelector('.console-block-content')?.innerHTML || blockEl.innerHTML}</pre>`;

    menu.textContent = '';
    const mkBtn = (iconName, label, onClick, isSub = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `output-action-btn${isSub ? ' sub-item' : ''}`;
      b.innerHTML = `<span class="ico">${svg(iconName, { size: 13 })}</span><span></span>`;
      b.querySelector('span:last-child').textContent = label;
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeOutputActionMenu();
        await onClick();
      });
      return b;
    };

    const mkSep = () => {
      const s = document.createElement('div');
      s.className = 'menubar-sep';
      return s;
    };

    const mkHead = (label) => {
      const h = document.createElement('div');
      h.className = 'output-action-header';
      h.textContent = label;
      return h;
    };

    menu.append(
      mkBtn('copy', t('outCopyText'), async () => {
        await navigator.clipboard.writeText(getRawText());
        showToast(t('outCopiedToast'));
      }),
      mkBtn('markdown', t('outCopyMarkdown'), async () => {
        const md = formatOutputForDocument(getRawText(), { lang: 'markdown', source }).trim();
        await navigator.clipboard.writeText(md);
        showToast(t('outCopiedToast'));
      }),
      mkBtn('new-window', t('outOpenNewWindow'), async () => {
        if (window.studio?.openOutputWindow) {
          await window.studio.openOutputWindow({
            title: `${source} — R Commander Studio`,
            sourceLabel: source,
            htmlContent: getHtmlContent(),
            rawText: getRawText(),
            isLight: state.theme === 'light'
          });
        }
      }),
      mkSep(),
      mkHead(t('outPasteIntoDoc')),
      mkBtn(
        'file',
        t('outPasteCurrentDoc'),
        async () => {
          const raw = getRawText();
          const codeTabs = state.tabs.filter((x) => x.kind === 'code');
          const cur = activeTab();
          if (cur && cur.kind === 'code' && codeTabs.length <= 1) {
            insertOutputIntoCodeTab(cur, raw, source);
          } else if (codeTabs.length > 1) {
            openDocPickerModal(
              t('outPickOpenDocTitle'),
              codeTabs.map((tab) => ({
                tab,
                badge: tab.language.toUpperCase(),
                label: tab.name + (tab.id === cur?.id ? ' (active)' : ''),
                detail: tab.filePath || `Group ${tab.groupIndex + 1}`
              })),
              (picked) => insertOutputIntoCodeTab(picked.tab, raw, source)
            );
          } else if (cur && cur.kind === 'code') {
            insertOutputIntoCodeTab(cur, raw, source);
          } else {
            const tab = createCodeTab({
              name: `output-${state.nextTabNum}.md`,
              content: `# ${source} Output\n${formatOutputForDocument(raw, { lang: 'markdown', source })}`,
              language: 'markdown',
              dirty: true
            });
            openPreview('live');
            showToast(t('outPastedToast', tab.name));
          }
        },
        true
      ),
      mkBtn(
        'folder-open',
        t('outPasteWorkspaceDoc'),
        async () => {
          const raw = getRawText();
          const wsDocs = collectWorkspaceDocuments(state.folderTree);
          if (wsDocs.length) {
            openDocPickerModal(
              t('outPickWorkspaceDocTitle'),
              wsDocs.map((d) => ({
                path: d.path,
                name: d.name,
                badge: (d.name.split('.').pop() || 'DOC').toUpperCase(),
                label: d.name,
                detail: d.path
              })),
              async (picked) => {
                const openTab = state.tabs.find((x) => x.kind === 'code' && x.filePath === picked.path);
                if (openTab) {
                  insertOutputIntoCodeTab(openTab, raw, source);
                  await saveFileAction(false);
                } else {
                  const file = await window.studio.openPath(picked.path);
                  if (file) {
                    const lang = detectLanguage(file.name);
                    const nextContent = `${file.content || ''}${formatOutputForDocument(raw, { lang, source })}`;
                    await window.studio.saveFile({ filePath: picked.path, content: nextContent });
                    createCodeTab({ name: file.name, filePath: picked.path, content: nextContent, language: lang, dirty: false });
                    showToast(t('outPastedToast', file.name));
                  }
                }
              }
            );
          } else {
            showToast(t('outNoWorkspaceDocs'));
            const files = await window.studio.openFile();
            if (files && files.length) {
              const f = files[0];
              const lang = detectLanguage(f.name);
              const nextContent = `${f.content || ''}${formatOutputForDocument(raw, { lang, source })}`;
              await window.studio.saveFile({ filePath: f.filePath, content: nextContent });
              createCodeTab({ name: f.name, filePath: f.filePath, content: nextContent, language: lang, dirty: false });
              showToast(t('outPastedToast', f.name));
            }
          }
        },
        true
      ),
      mkBtn(
        'new-file',
        t('outPasteNewDoc'),
        async () => {
          const raw = getRawText();
          const docName = `r-output-${state.nextTabNum}.md`;
          const mdContent = `---\ntitle: "${source} Output"\ndate: "AUTOMATIC"\n---\n${formatOutputForDocument(raw, { lang: 'markdown', source })}`;
          const tab = createCodeTab({ name: docName, content: mdContent, language: 'markdown', dirty: true });
          openPreview('live');
          showToast(t('outPastedToast', tab.name));
        },
        true
      )
    );

    menu.hidden = false;
    const rect = btnEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const top = Math.max(8, Math.min(window.innerHeight - menuRect.height - 8, rect.bottom + 4));
    const left = Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, rect.right - menuRect.width));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  }

  function createHoverableOutputBlock(container, cls = '', source = 'R Console') {
    const block = document.createElement('div');
    block.className = `console-block${cls ? ' ' + cls : ''}`;
    const contentSpan = document.createElement('span');
    contentSpan.className = 'console-block-content';
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'console-block-more';
    moreBtn.title = t('outMoreActions');
    moreBtn.innerHTML = svg('more', { size: 13 });
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openOutputActionMenu(moreBtn, block, source);
    });
    block.addEventListener('click', (e) => {
      if (e.shiftKey && window.studio?.openOutputWindow) {
        e.preventDefault();
        e.stopPropagation();
        const raw = stripAnsi(contentSpan.textContent || '').trim();
        window.studio.openOutputWindow({
          title: `${source} — R Commander Studio`,
          sourceLabel: source,
          htmlContent: `<pre>${contentSpan.innerHTML}</pre>`,
          rawText: raw,
          isLight: state.theme === 'light'
        });
      }
    });
    block.append(contentSpan, moreBtn);
    container.append(block);
    return { block, contentSpan };
  }

  function appendAnsi(container, text, cls = '', source = 'R Console', coalesceMs = 0) {
    if (!text) return;
    const now = Date.now();
    const isArf = source.includes('arf');
    const lastHolder = isArf ? lastArfBlock : lastRBlock;
    const lastTime = isArf ? lastArfBlockTime : lastRBlockTime;

    if (
      coalesceMs > 0 &&
      lastHolder &&
      lastHolder.block.parentElement === container &&
      now - lastTime < coalesceMs
    ) {
      renderAnsiInto(lastHolder.contentSpan, text, { syntaxHighlight: !isArf });
      if (isArf) lastArfBlockTime = now;
      else lastRBlockTime = now;
      container.scrollTop = container.scrollHeight;
      return;
    }

    const created = createHoverableOutputBlock(container, cls, source);
    renderAnsiInto(created.contentSpan, text, { syntaxHighlight: !isArf });
    if (coalesceMs > 0) {
      if (isArf) {
        lastArfBlock = created;
        lastArfBlockTime = now;
      } else {
        lastRBlock = created;
        lastRBlockTime = now;
      }
    }
    container.scrollTop = container.scrollHeight;
  }

  function appendConsole(text, cls = '') {
    appendAnsi($('consoleOut'), text, cls, 'R Console', 1500);
  }

  let arfTerm = null;
  let arfFitAddon = null;
  let arfResizeObserver = null;

  function initArfXterm() {
    if (arfTerm || typeof window.Terminal !== 'function') return;
    const host = $('arfXtermHost');
    if (!host) return;
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue('--bg-editor').trim() || '#282A36';
    const fg = cs.getPropertyValue('--fg').trim() || '#F8F8F2';
    arfTerm = new window.Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
      fontSize: Math.max(9, Math.min(24, Number(localStorage.getItem('rcs-arf-font-size')) || 12.5)),
      lineHeight: 1.35,
      scrollback: 5000,
      theme: {
        background: bg,
        foreground: fg,
        cursor: '#BD93F9',
        selectionBackground: 'rgba(189, 147, 249, 0.35)',
        black: '#21222C',
        red: '#FF5555',
        green: '#50FA7B',
        yellow: '#F1FA8C',
        blue: '#BD93F9',
        magenta: '#FF79C6',
        cyan: '#8BE9FD',
        white: '#F8F8F2',
        brightBlack: '#6272A4',
        brightRed: '#FF6E6E',
        brightGreen: '#69FF94',
        brightYellow: '#FFFFA5',
        brightBlue: '#D6ACFF',
        brightMagenta: '#FF92DF',
        brightCyan: '#A4FFFF',
        brightWhite: '#FFFFFF'
      }
    });
    if (window.FitAddon?.FitAddon) {
      arfFitAddon = new window.FitAddon.FitAddon();
      arfTerm.loadAddon(arfFitAddon);
    }
    arfTerm.open(host);
    arfTerm.onData((data) => {
      window.studio?.arfWrite?.(data);
    });
    arfTerm.attachCustomKeyEventHandler((ev) => {
      // Let Ctrl+Shift+C copy and Ctrl+Shift+V paste cleanly
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'c' && ev.type === 'keydown') {
        const sel = arfTerm.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'v' && ev.type === 'keydown') {
        navigator.clipboard.readText().then((clip) => {
          if (clip) window.studio?.arfWrite?.(clip);
        }).catch(() => {});
        return false;
      }
      return true;
    });
    host.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const isEs = getLang() === 'es';
      const sel = arfTerm?.getSelection?.() || '';
      showContextMenu(e.clientX, e.clientY, [
        ...(sel
          ? [
              {
                icon: 'copy',
                label: isEs ? 'Copiar selección' : 'Copy Selection',
                action: async () => {
                  await navigator.clipboard.writeText(sel);
                  showToast(t('outCopiedToast'));
                }
              },
              {
                icon: 'edit',
                label: isEs ? 'Insertar selección en editor' : 'Insert Selection in Editor',
                action: () => {
                  const ed = state.editors[state.focusedGroup];
                  if (ed) insertTextAtCursor(ed, sel);
                }
              }
            ]
          : []),
        {
          icon: 'paste-doc',
          label: isEs ? 'Pegar en arf' : 'Paste into arf',
          action: async () => {
            const clip = await navigator.clipboard.readText().catch(() => '');
            if (clip) window.studio?.arfWrite?.(clip);
            arfTerm?.focus();
          }
        },
        { sep: true },
        { icon: 'stop', label: isEs ? 'Interrumpir (Ctrl+C)' : 'Interrupt (Ctrl+C)', action: () => window.studio?.arfInterrupt?.() },
        { icon: 'clear', label: isEs ? 'Limpiar terminal arf' : 'Clear arf Terminal', action: () => arfTerm?.clear() },
        { icon: 'restart', label: isEs ? 'Reiniciar arf' : 'Restart arf', action: () => window.studio?.arfRestart?.() }
      ]);
    });
    if (typeof ResizeObserver !== 'undefined') {
      arfResizeObserver = new ResizeObserver(() => fitArfXterm());
      arfResizeObserver.observe(host);
    }
    fitArfXterm();
  }

  function syncArfXtermTheme() {
    if (!arfTerm) return;
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue('--bg-editor').trim() || '#282A36';
    const fg = cs.getPropertyValue('--fg').trim() || '#F8F8F2';
    arfTerm.options.theme = {
      ...(arfTerm.options.theme || {}),
      background: bg,
      foreground: fg
    };
  }

  function fitArfXterm() {
    if (!arfTerm || !arfFitAddon) return;
    const host = $('arfXtermHost');
    if (!host || host.offsetParent === null || host.clientWidth < 30 || host.clientHeight < 30) return;
    try {
      syncArfXtermTheme();
      arfFitAddon.fit();
      window.studio?.arfResize?.({ cols: arfTerm.cols, rows: arfTerm.rows });
    } catch {
      // ignore layout race
    }
  }

  function appendArf(text, cls = '', raw = null) {
    initArfXterm();
    if (arfTerm) {
      arfTerm.write(raw != null ? raw : String(text || '').replace(/\n/g, '\r\n'));
      return;
    }
    appendAnsi($('arfOut'), text, cls, 'arf Terminal', 1200);
  }

  async function ensureArfStarted() {
    initArfXterm();
    requestAnimationFrame(() => {
      fitArfXterm();
      setTimeout(fitArfXterm, 60);
      arfTerm?.focus();
    });
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
    if ($('btnPlotPopout')) $('btnPlotPopout').disabled = !hasPlot;
    $('btnPlotZoomReset').textContent = `${Math.round(state.plotZoom * 100)}%`;

    const canvas = $('plotsCanvas');
    canvas.textContent = '';
    $('actPlots')?.classList.toggle('needs-step', !hasPlot);
    if (!hasPlot) {
      const isEs = getLang() === 'es';
      const empty = document.createElement('div');
      empty.className = 'ws-empty';
      empty.innerHTML =
        `<div>${escapeHtmlText(t('plotsEmpty'))}</div>` +
        `<div class="prereq-card">` +
        `<strong>${isEs ? 'Paso previo requerido:' : 'Prerequisite step required:'}</strong> ` +
        `<span>${
          isEs
            ? 'Ejecuta código con plot() / ggplot() en el editor (Ctrl+Intro) o elige un gráfico en el menú Gráficas de R Commander.'
            : 'Run code with plot() / ggplot() in the editor (Ctrl+Enter) or choose a chart from the R Commander Graphs menu.'
        }</span>` +
        `<div class="prereq-actions">` +
        `<button type="button" class="dlg-btn primary" id="btnPrereqRunPlot">${isEs ? '1. Ejecutar script actual (Ctrl+Intro)' : '1. Run Current Script (Ctrl+Enter)'}</button>` +
        `<button type="button" class="dlg-btn" id="btnPrereqOpenGraphsMenu">${isEs ? '2. Ir al menú Gráficas de R Commander' : '2. Go to R Commander Graphs Menu'}</button>` +
        `</div></div>`;
      canvas.append(empty);
      canvas.querySelector('#btnPrereqRunPlot')?.addEventListener('click', () => handleStudioCommand('run-all'));
      canvas.querySelector('#btnPrereqOpenGraphsMenu')?.addEventListener('click', () => expandRcmdrCategory('Graphs'));
      return;
    }
    const frame = document.createElement('div');
    frame.className = 'plot-frame';
    frame.innerHTML = state.plots[state.plotIndex];
    const svgEl = frame.querySelector('svg');
    if (svgEl) {
      const vb = svgEl.viewBox?.baseVal;
      const baseW = (vb && vb.width > 0 ? vb.width : Number(svgEl.getAttribute('width')) || 640);
      const baseH = (vb && vb.height > 0 ? vb.height : Number(svgEl.getAttribute('height')) || 440);
      svgEl.style.width = `${Math.round(baseW * state.plotZoom)}px`;
      svgEl.style.height = `${Math.round(baseH * state.plotZoom)}px`;
      svgEl.style.maxWidth = 'none';
    } else {
      frame.style.transform = `scale(${state.plotZoom})`;
    }
    frame.addEventListener('click', (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        popoutCurrentPlot();
      }
    });
    canvas.append(frame);
  }

  async function popoutCurrentPlot() {
    const s = state.plots[state.plotIndex];
    if (!s || !window.studio?.openOutputWindow) return;
    await window.studio.openOutputWindow({
      title: `Plot ${state.plotIndex + 1} / ${state.plots.length} — R Commander Studio`,
      sourceLabel: 'R Plot',
      htmlContent: `<div style="display:grid;place-items:center;background:#fff;padding:12px;border-radius:4px">${s}</div>`,
      rawText: s,
      isLight: state.theme === 'light'
    });
  }

  // --- R Help Tab ---
  function renderHelpEmptyPrereq() {
    const isEs = getLang() === 'es';
    const host = $('helpContent');
    if (!host) return;
    host.innerHTML =
      `<div class="ws-empty">` +
      `<div>${escapeHtmlText(t('helpEmpty'))}</div>` +
      `<div class="prereq-card">` +
      `<strong>${isEs ? 'Paso previo requerido:' : 'Prerequisite step required:'}</strong> ` +
      `<span>${
        isEs
          ? 'Sitúa el cursor sobre cualquier función en el editor y pulsa F1, o busca una función arriba o abre uno de estos manuales:'
          : 'Place the cursor on any function in the editor and press F1, search above, or open one of these manuals:'
      }</span>` +
      `<div class="prereq-actions">` +
      `<button type="button" class="dlg-btn primary" data-help-topic="lm">?lm (Linear Model)</button>` +
      `<button type="button" class="dlg-btn" data-help-topic="t.test">?t.test</button>` +
      `<button type="button" class="dlg-btn" data-help-topic="boxplot">?boxplot</button>` +
      `<button type="button" class="dlg-btn" id="btnPrereqStartHelp">help.start()</button>` +
      `</div></div></div>`;
    for (const b of host.querySelectorAll('[data-help-topic]')) {
      b.addEventListener('click', () => openRDocs(b.getAttribute('data-help-topic')));
    }
    host.querySelector('#btnPrereqStartHelp')?.addEventListener('click', () => executeR('help.start()', { label: 'help.start()', fromMenu: true }));
  }

  function helpEscHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function highlightHelpMatch(text, query) {
    const raw = String(text ?? '');
    const q = String(query ?? '').trim();
    if (!q) return helpEscHtml(raw);
    const idx = raw.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return helpEscHtml(raw);
    return (
      helpEscHtml(raw.slice(0, idx)) +
      `<mark class="help-match-hl">${helpEscHtml(raw.slice(idx, idx + q.length))}</mark>` +
      helpEscHtml(raw.slice(idx + q.length))
    );
  }

  function highlightRCodeHtml(code) {
    const src = String(code ?? '');
    const tokenRe =
      /(#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(function|if|else|for|in|while|repeat|next|break|return|library|require)\b|\b(TRUE|FALSE|NULL|NA|NA_integer_|NA_real_|NA_character_|NA_complex_|NaN|Inf)\b|\b(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?L?)\b|\b([A-Za-z.][A-Za-z0-9._]*)(?=\s*\()|\b([A-Za-z.][A-Za-z0-9._]*)(?=\s*=[^=])|(<-|->|<<-|%>%|\|>|::|:::|%[^%\s]+%)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = tokenRe.exec(src)) !== null) {
      if (m.index > last) out += helpEscHtml(src.slice(last, m.index));
      const full = helpEscHtml(m[0]);
      if (m[1]) out += `<span class="hl-com">${full}</span>`;
      else if (m[2]) out += `<span class="hl-str">${full}</span>`;
      else if (m[3]) out += `<span class="hl-kw">${full}</span>`;
      else if (m[4]) out += `<span class="hl-const">${full}</span>`;
      else if (m[5]) out += `<span class="hl-num">${full}</span>`;
      else if (m[6]) out += `<span class="hl-fn">${full}</span>`;
      else if (m[7]) out += `<span class="hl-arg">${full}</span>`;
      else if (m[8]) out += `<span class="hl-op">${full}</span>`;
      else out += full;
      last = tokenRe.lastIndex;
    }
    if (last < src.length) out += helpEscHtml(src.slice(last));
    return out;
  }

  function renderFormattedRDoc(fullText) {
    const frag = document.createDocumentFragment();
    const lines = String(fullText || '').replace(/\r\n/g, '\n').split('\n');
    const secHeaderRe = /^([A-Z][A-Za-z0-9 ()/&-]{1,30}):$/;
    const sections = [];
    let titleLines = [];
    let current = null;

    for (const line of lines) {
      const hm = line.match(secHeaderRe);
      if (hm) {
        current = { name: hm[1], lines: [] };
        sections.push(current);
      } else if (!current) {
        if (line.trim()) titleLines.push(line.trim());
      } else {
        current.lines.push(line);
      }
    }

    if (titleLines.length) {
      const titleEl = document.createElement('div');
      titleEl.className = 'help-doc-title';
      titleEl.textContent = titleLines.join(' — ');
      frag.append(titleEl);
    }

    if (!sections.length) {
      const pre = document.createElement('pre');
      pre.className = 'help-doc-pre';
      pre.textContent = fullText;
      frag.append(pre);
      return frag;
    }

    const dedent = (arr) => {
      const trimmed = [...arr];
      while (trimmed.length && !trimmed[0].trim()) trimmed.shift();
      while (trimmed.length && !trimmed[trimmed.length - 1].trim()) trimmed.pop();
      const indents = trimmed.filter((l) => l.trim()).map((l) => (l.match(/^ */)?.[0].length || 0));
      const minIndent = indents.length ? Math.min(...indents) : 0;
      return trimmed.map((l) => l.slice(minIndent)).join('\n');
    };

    for (const sec of sections) {
      const bodyText = dedent(sec.lines);
      if (!bodyText) continue;
      const wrap = document.createElement('div');
      wrap.className = 'help-doc-sec';
      const h = document.createElement('div');
      h.className = 'help-doc-sec-title';
      h.textContent = sec.name;
      wrap.append(h);

      const lowerName = sec.name.toLowerCase();
      if (lowerName === 'usage' || lowerName === 'examples') {
        const pre = document.createElement('pre');
        pre.className = 'help-doc-code';
        pre.innerHTML = highlightRCodeHtml(bodyText);
        wrap.append(pre);
      } else if (lowerName === 'arguments') {
        const list = document.createElement('div');
        list.className = 'help-doc-args';
        const argLines = bodyText.split('\n');
        const entries = [];
        for (const l of argLines) {
          const am = l.match(/^([A-Za-z0-9._, `]+?):\s*(.*)$/);
          if (am && !l.startsWith('  ')) {
            entries.push({ name: am[1].trim(), desc: am[2] ? [am[2].trim()] : [] });
          } else if (entries.length) {
            entries[entries.length - 1].desc.push(l.trim());
          } else if (l.trim()) {
            entries.push({ name: '', desc: [l.trim()] });
          }
        }
        if (entries.length && entries.some((e) => e.name)) {
          for (const e of entries) {
            const row = document.createElement('div');
            row.className = 'help-doc-arg-row';
            const n = document.createElement('span');
            n.className = 'help-doc-arg-name';
            n.textContent = e.name;
            const d = document.createElement('span');
            d.className = 'help-doc-arg-desc';
            d.textContent = e.desc.filter(Boolean).join(' ');
            row.append(n, d);
            list.append(row);
          }
          wrap.append(list);
        } else {
          const p = document.createElement('pre');
          p.className = 'help-doc-text';
          p.textContent = bodyText;
          wrap.append(p);
        }
      } else {
        const p = document.createElement('pre');
        p.className = 'help-doc-text';
        p.textContent = bodyText;
        wrap.append(p);
      }
      frag.append(wrap);
    }
    return frag;
  }

  let helpSuggestTimer = null;
  let helpSuggestItems = [];
  let helpSuggestIndex = -1;
  let helpSuggestSeq = 0;

  function hideHelpSuggest() {
    const dd = $('helpSuggestDropdown');
    if (dd) {
      dd.hidden = true;
      dd.textContent = '';
    }
    helpSuggestItems = [];
    helpSuggestIndex = -1;
  }

  function renderHelpSuggest(query, items) {
    const dd = $('helpSuggestDropdown');
    if (!dd) return;
    helpSuggestItems = Array.isArray(items) ? items : [];
    helpSuggestIndex = -1;
    dd.textContent = '';
    if (!helpSuggestItems.length) {
      dd.hidden = true;
      return;
    }
    const qMatch = query.includes('::') ? query.split('::')[1] || '' : query;
    helpSuggestItems.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `help-suggest-item${item.kind === 'rcmdr' ? ' is-rcmdr' : ''}`;
      btn.dataset.idx = String(idx);
      const main = document.createElement('span');
      main.className = 'help-suggest-main';
      if (item.kind === 'rcmdr') {
        const badge = document.createElement('span');
        badge.className = 'help-suggest-badge';
        badge.textContent = 'Rcmdr';
        main.append(badge);
      }
      const topicEl = document.createElement('span');
      topicEl.className = 'help-suggest-topic';
      topicEl.innerHTML = highlightHelpMatch(item.topic, qMatch);
      main.append(topicEl);
      const pkgEl = document.createElement('span');
      pkgEl.className = 'help-suggest-pkg';
      pkgEl.textContent = item.kind === 'rcmdr' ? item.package : `{${item.package}}`;
      btn.append(main, pkgEl);
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectHelpSuggestItem(item);
      });
      dd.append(btn);
    });
    dd.hidden = false;
  }

  function setHelpSuggestActive(nextIdx) {
    const dd = $('helpSuggestDropdown');
    if (!dd || dd.hidden || !helpSuggestItems.length) return;
    const len = helpSuggestItems.length;
    helpSuggestIndex = ((nextIdx % len) + len) % len;
    const nodes = dd.querySelectorAll('.help-suggest-item');
    nodes.forEach((n, i) => {
      const isAct = i === helpSuggestIndex;
      n.classList.toggle('active', isAct);
      if (isAct) n.scrollIntoView({ block: 'nearest' });
    });
  }

  function selectHelpSuggestItem(item) {
    hideHelpSuggest();
    if (!item) return;
    if (item.kind === 'rcmdr') {
      if (Array.isArray(item.fns) && item.fns.length) {
        openRDocs(item.fns[0]);
      } else if (item.id) {
        triggerRcmdrCommand(item.id);
      }
      return;
    }
    const target = item.package && item.package !== '.GlobalEnv' ? `${item.package}::${item.topic}` : item.topic;
    openRDocs(target);
  }

  function scheduleHelpSuggest(raw) {
    if (helpSuggestTimer) clearTimeout(helpSuggestTimer);
    const q = String(raw || '').trim();
    if (!q) {
      hideHelpSuggest();
      return;
    }
    const seq = ++helpSuggestSeq;
    helpSuggestTimer = setTimeout(async () => {
      try {
        const res = await window.studio.rHelpSuggest(q);
        if (seq !== helpSuggestSeq) return;
        if ($('helpSearchInput')?.value.trim() !== q) return;
        renderHelpSuggest(q, res?.items || []);
      } catch {
        hideHelpSuggest();
      }
    }, 110);
  }

  async function openRDocs(topic) {
    const clean = String(topic || '').trim();
    if (!clean) return;
    hideHelpSuggest();
    state.lastHelpTopic = clean;
    $('actHelp')?.classList.remove('needs-step');
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
    if (Array.isArray(res.rcmdrMatches) && res.rcmdrMatches.length) {
      const box = document.createElement('div');
      box.className = 'help-rcmdr-matches';
      const boxTitle = document.createElement('div');
      boxTitle.className = 'help-rcmdr-title';
      boxTitle.textContent = `R Commander (${res.rcmdrMatches.length})`;
      box.append(boxTitle);
      for (const m of res.rcmdrMatches.slice(0, 6)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'help-rcmdr-btn';
        btn.innerHTML = `<span class="help-rcmdr-label"></span><span class="help-rcmdr-path"></span>`;
        btn.querySelector('.help-rcmdr-label').textContent = m.label + (m.altLabel ? ` (${m.altLabel})` : '');
        btn.querySelector('.help-rcmdr-path').textContent = m.path;
        btn.addEventListener('click', () => triggerRcmdrCommand(m.id));
        box.append(btn);
      }
      host.append(box);
    }

    if (res.kind === 'search') {
      const matches = Array.isArray(res.searchMatches) ? res.searchMatches : [];
      const header = document.createElement('div');
      header.className = 'help-search-header';
      const total = Number(res.total) || matches.length;
      const isEs = getLang() === 'es';
      header.textContent = isEs
        ? `Resultados de ayuda R para "${clean}" (${matches.length}${total > matches.length ? ` de ${total}` : ''})`
        : `R Help Matches for "${clean}" (${matches.length}${total > matches.length ? ` of ${total}` : ''})`;
      host.append(header);

      if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'ws-empty';
        empty.textContent = isEs
          ? `No se encontraron entradas de ayuda en R para "${clean}".`
          : `No R help entries found for "${clean}".`;
        host.append(empty);
        return;
      }

      const list = document.createElement('div');
      list.className = 'help-search-list';
      for (const m of matches) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'help-search-item';
        row.title = `${m.package}::${m.topic} — ${m.title}`;

        const topicSpan = document.createElement('span');
        topicSpan.className = 'help-search-topic';
        topicSpan.innerHTML = highlightHelpMatch(m.topic, clean);

        const pkgSpan = document.createElement('span');
        pkgSpan.className = 'help-search-pkg';
        pkgSpan.textContent = `{${m.package}}`;

        const titleSpan = document.createElement('span');
        titleSpan.className = 'help-search-title';
        titleSpan.innerHTML = highlightHelpMatch(m.title, clean);

        row.append(topicSpan, pkgSpan, titleSpan);
        row.addEventListener('click', () => openRDocs(`${m.package}::${m.topic}`));
        list.append(row);
      }
      host.append(list);
      return;
    }

    const head = document.createElement('div');
    head.className = 'help-doc-head';
    head.innerHTML =
      `<span class="help-doc-fn"></span><span class="help-doc-pkg"></span>` +
      `<span class="help-doc-head-spacer"></span>` +
      `<button type="button" class="help-doc-browser-btn" title="help.start()">help.start()</button>`;
    head.querySelector('.help-doc-fn').textContent = res.fn || clean;
    head.querySelector('.help-doc-pkg').textContent = res.package ? `{${res.package}}` : '';
    head.querySelector('.help-doc-browser-btn').addEventListener('click', () =>
      executeR('help.start()', { label: 'help.start()', fromMenu: true })
    );
    host.append(head, renderFormattedRDoc(res.fullText || res.description || res.usage || ''));
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

    const removeFromEnvironment = async (objName) => {
      if (!objName) return;
      const isEs = getLang() === 'es';
      const msg = isEs
        ? `¿Eliminar "${objName}" del entorno de R? (rm("${objName}"))`
        : `Remove "${objName}" from the R Environment? (rm("${objName}"))`;
      if (!window.confirm(msg)) return;
      const existing = state.tabs.find((x) => x.kind === 'table' && x.tableConfig?.objectName === objName);
      if (existing) closeTab(existing.id);
      await executeR(`rm(list = ${JSON.stringify(objName)}, envir = .GlobalEnv)`, { label: `rm(${objName})`, fromMenu: true });
    };

    if (dsEntries.length) {
      const gh = document.createElement('div');
      gh.className = 'ws-group-row';
      gh.innerHTML = `${svg('database', { size: 13, color: 'var(--chart-green)' })}<span>${t('wsDatasets')} (${dsEntries.length})</span>`;
      host.append(gh);

      for (const ds of dsEntries) {
        const row = document.createElement('div');
        row.className = `ws-item-row${ds.name === state.activeDataset ? ' active' : ''}`;
        const rmTitle = getLang() === 'es' ? `Eliminar ${ds.name} del entorno` : `Remove ${ds.name} from Environment`;
        row.innerHTML =
          `<span class="ws-item-name"></span>` +
          `<span class="ws-item-meta">${ds.rows} x ${ds.columns}</span>` +
          `<span class="ws-item-actions">` +
          `<button type="button" class="icon-btn ws-act-view" title="${t('viewDataTitle')}">${svg('eye', { size: 13 })}</button>` +
          `<button type="button" class="icon-btn ws-act-edit" title="${t('editDataTitle')}">${svg('edit', { size: 13 })}</button>` +
          `<button type="button" class="icon-btn ws-act-sum" title="${t('summaryDataTitle')}">${svg('list-summary', { size: 13 })}</button>` +
          `<button type="button" class="icon-btn ws-act-rm" title="${rmTitle}">${svg('close', { size: 12 })}</button>` +
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
          if (e.shiftKey) {
            popoutDatasetWindow(ds.name);
            return;
          }
          const existing = state.tabs.find((x) => x.kind === 'table' && x.tableConfig?.objectName === ds.name);
          if (existing) closeTab(existing.id);
          else openRTableTab({ objectName: ds.name, title: ds.name, editable: false });
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
        row.querySelector('.ws-act-rm').addEventListener('click', (e) => {
          e.stopPropagation();
          removeFromEnvironment(ds.name);
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const isEs = getLang() === 'es';
          const existing = state.tabs.find((x) => x.kind === 'table' && x.tableConfig?.objectName === ds.name);
          showContextMenu(e.clientX, e.clientY, [
            {
              icon: 'eye',
              label: existing ? (isEs ? 'Ocultar tabla' : 'Hide Table') : isEs ? 'Ver tabla' : 'View Table',
              action: () => (existing ? closeTab(existing.id) : openRTableTab({ objectName: ds.name, title: ds.name, editable: false }))
            },
            { icon: 'edit', label: isEs ? 'Editar tabla' : 'Edit Table', action: () => openRTableTab({ objectName: ds.name, title: ds.name, editable: true }) },
            {
              icon: 'list-summary',
              label: `summary(${ds.name})`,
              action: () => {
                openPanelTab('console');
                executeR(`summary(${ds.name})`, { label: `summary(${ds.name})`, fromMenu: true });
              }
            },
            { icon: 'new-window', label: isEs ? 'Abrir en ventana nueva' : 'Open in New Window', action: () => popoutDatasetWindow(ds.name) },
            { sep: true },
            { icon: 'clear', label: isEs ? 'Eliminar del entorno...' : 'Remove from Environment...', action: () => removeFromEnvironment(ds.name) }
          ]);
        });
        row.addEventListener('click', (e) => {
          if (e.shiftKey) {
            e.preventDefault();
            popoutDatasetWindow(ds.name);
            return;
          }
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
        const rmTitle = getLang() === 'es' ? `Eliminar ${m.name} del entorno` : `Remove ${m.name} from Environment`;
        row.innerHTML =
          `<span class="ws-item-name"></span><span class="ws-item-meta"></span>` +
          `<span class="ws-item-actions">` +
          `<button type="button" class="icon-btn ws-act-sum" title="${t('summaryModelTitle')}">${svg('list-summary', { size: 13 })}</button>` +
          `<button type="button" class="icon-btn ws-act-rm" title="${rmTitle}">${svg('close', { size: 12 })}</button>` +
          `</span>`;
        row.querySelector('.ws-item-name').textContent = m.name;
        row.querySelector('.ws-item-meta').textContent = m.cls;
        row.querySelector('.ws-act-sum').addEventListener('click', (e) => {
          e.stopPropagation();
          openPanelTab('console');
          executeR(`summary(${m.name})`, { label: `summary(${m.name})`, fromMenu: true });
        });
        row.querySelector('.ws-act-rm').addEventListener('click', (e) => {
          e.stopPropagation();
          removeFromEnvironment(m.name);
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const isEs = getLang() === 'es';
          showContextMenu(e.clientX, e.clientY, [
            {
              icon: 'list-summary',
              label: `summary(${m.name})`,
              action: () => {
                openPanelTab('console');
                executeR(`summary(${m.name})`, { label: `summary(${m.name})`, fromMenu: true });
              }
            },
            { sep: true },
            { icon: 'clear', label: isEs ? 'Eliminar del entorno...' : 'Remove from Environment...', action: () => removeFromEnvironment(m.name) }
          ]);
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
        const rmTitle = getLang() === 'es' ? `Eliminar ${name} del entorno` : `Remove ${name} from Environment`;
        row.innerHTML =
          `<span class="ws-item-name"></span><span class="ws-item-meta">${t('wsObjectKind')}</span>` +
          `<span class="ws-item-actions"><button type="button" class="icon-btn ws-act-rm" title="${rmTitle}">${svg('close', { size: 12 })}</button></span>`;
        row.querySelector('.ws-item-name').textContent = name;
        row.querySelector('.ws-act-rm').addEventListener('click', (e) => {
          e.stopPropagation();
          removeFromEnvironment(name);
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const isEs = getLang() === 'es';
          showContextMenu(e.clientX, e.clientY, [
            { icon: 'eye', label: isEs ? 'Ver objeto' : 'Inspect Object', action: () => openRTableTab({ objectName: name, title: name, editable: false }) },
            {
              icon: 'terminal',
              label: isEs ? `Imprimir ${name} en consola` : `Print ${name} in Console`,
              action: () => {
                openPanelTab('console');
                executeR(name, { label: name, fromMenu: true });
              }
            },
            { sep: true },
            { icon: 'clear', label: isEs ? 'Eliminar del entorno...' : 'Remove from Environment...', action: () => removeFromEnvironment(name) }
          ]);
        });
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

  const STYLE_LINT_RE = /trailing\s+(blank|whitespace)|remove\s+trailing|superfluous|more\s+than\s+\d+\s+characters|infix\s+operators|only\s+use\s+double-quotes|indentation|commented\s+code|commas\s+should|spaces\s+around|whitespace/i;

  function isStyleDiagnostic(d) {
    if (!d) return false;
    if (d.severity === 'info' || d.severity === 'hint') return true;
    return d.severity === 'warning' && STYLE_LINT_RE.test(String(d.message || ''));
  }

  function diagnosticRuleKey(d) {
    return String(d?.message || '').trim().toLowerCase();
  }

  function isDiagnosticVisible(d) {
    if (d.severity === 'error') return state.settings.showProblemErrors !== false;
    const muted = Array.isArray(state.settings.mutedWarnings) ? state.settings.mutedWarnings : [];
    if (muted.includes(diagnosticRuleKey(d))) return false;
    if (isStyleDiagnostic(d)) return state.settings.showStyleLints === true;
    return state.settings.showProblemWarnings !== false;
  }

  function muteDiagnosticType(d) {
    const key = diagnosticRuleKey(d);
    if (!key) return;
    const list = Array.isArray(state.settings.mutedWarnings) ? state.settings.mutedWarnings.slice() : [];
    if (!list.includes(key)) list.push(key);
    state.settings.mutedWarnings = list;
    saveSettings(state.settings);
    applySettingsUI();
  }

  function applyMarkersForUri(uri) {
    const tab = state.tabs.find((x) => x.kind === 'code' && x.uri === uri);
    if (!tab || !state.monaco) return;
    const diags = mergeDiagnostics(uri).filter(isDiagnosticVisible);
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
    const totalErrCount = all.filter((x) => x.severity === 'error').length;
    const totalStyleCount = all.filter((x) => x.severity !== 'error' && isStyleDiagnostic(x)).length;
    const totalWarnCount = all.filter((x) => x.severity !== 'error' && !isStyleDiagnostic(x)).length;
    if ($('problemsFilterErrCount')) $('problemsFilterErrCount').textContent = String(totalErrCount);
    if ($('problemsFilterWarnCount')) $('problemsFilterWarnCount').textContent = String(totalWarnCount);
    if ($('problemsFilterStyleCount')) $('problemsFilterStyleCount').textContent = String(totalStyleCount);
    $('btnProblemsToggleErrors')?.classList.toggle('active', state.settings.showProblemErrors !== false);
    $('btnProblemsToggleWarnings')?.classList.toggle('active', state.settings.showProblemWarnings !== false);
    $('btnProblemsToggleStyle')?.classList.toggle('active', state.settings.showStyleLints === true);
    const mutedCount = Array.isArray(state.settings.mutedWarnings) ? state.settings.mutedWarnings.length : 0;
    const unmuteBtn = $('btnProblemsUnmuteAll');
    if (unmuteBtn) {
      unmuteBtn.hidden = mutedCount === 0;
      unmuteBtn.textContent = getLang() === 'es' ? `Restaurar silenciados (${mutedCount})` : `Restore muted (${mutedCount})`;
    }

    const visible = all.filter(isDiagnosticVisible);
    const errCount = visible.filter((x) => x.severity === 'error').length;
    const warnCount = visible.filter((x) => x.severity === 'warning').length;
    $('statusErrCount').textContent = String(errCount);
    $('statusWarnCount').textContent = String(warnCount);

    const badge = $('problemsCount');
    badge.textContent = String(visible.length);
    badge.classList.toggle('has-errors', errCount > 0);

    listEl.textContent = '';
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'ws-empty';
      empty.textContent = t('problemsEmpty');
      listEl.append(empty);
      return;
    }

    for (const item of visible) {
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
      if (item.severity !== 'error') {
        const muteBtn = document.createElement('button');
        muteBtn.type = 'button';
        muteBtn.className = 'icon-btn';
        muteBtn.title = getLang() === 'es' ? 'Silenciar este tipo de aviso' : 'Mute this warning type';
        muteBtn.innerHTML = svg('close', { size: 11 });
        muteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          muteDiagnosticType(item);
        });
        row.append(muteBtn);
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const isEs = getLang() === 'es';
          showContextMenu(e.clientX, e.clientY, [
            { icon: 'close', label: isEs ? 'Silenciar este tipo de aviso' : 'Mute This Warning Type', action: () => muteDiagnosticType(item) },
            { icon: 'copy', label: isEs ? 'Copiar mensaje' : 'Copy Message', action: () => navigator.clipboard.writeText(item.message || '') }
          ]);
        });
      }
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
    if (tab) $('statusLang').textContent = tab.kind === 'rnote' ? 'RNOTE' : tab.kind === 'table' ? 'TABLE' : tab.language.toUpperCase();
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
    const rnHost = $(`rnoteHost${g}`);
    const emptyHost = $(`emptyHost${g}`);
    const bc = $(`breadcrumb${g}`);

    if (!tab) {
      bc.textContent = '';
      edHost.hidden = true;
      tblHost.hidden = true;
      if (rnHost) rnHost.hidden = true;
      emptyHost.hidden = false;
      emptyHost.textContent = t('emptyGroupHint');
      return;
    }

    const iconName = tab.kind === 'rnote' ? 'rnote' : tab.kind === 'table' ? 'table' : tab.language === 'r' ? 'r-logo' : 'file';
    const iconColor = tab.kind === 'rnote' ? 'var(--accent-pink)' : 'var(--accent-cyan)';
    bc.innerHTML = `${svg(iconName, { size: 12, color: iconColor })}<span></span>`;
    bc.querySelector('span').textContent = tab.filePath || tab.name;

    emptyHost.hidden = true;
    if (tab.kind === 'table') {
      edHost.hidden = true;
      if (rnHost) rnHost.hidden = true;
      tblHost.hidden = false;
      state.tableViewers[g]?.mount(tab);
    } else if (tab.kind === 'rnote') {
      edHost.hidden = true;
      tblHost.hidden = true;
      if (rnHost) rnHost.hidden = false;
      state.rnoteViewers[g]?.mount(tab);
    } else {
      tblHost.hidden = true;
      if (rnHost) rnHost.hidden = true;
      edHost.hidden = false;
      const ed = state.editors[g];
      if (ed) {
        // Restore the saved cursor/scroll only when switching to this tab: the
        // view state is from when the tab was last left, so restoring it on a
        // re-render of the visible tab (e.g. after Ctrl+S) jumps the cursor.
        if (ed.getModel() !== tab.model) {
          ed.setModel(tab.model);
          if (tab.viewState) ed.restoreViewState(tab.viewState);
        }
        ed.layout();
      }
    }
  }

  async function autoSaveTabIfEligible(tab) {
    if (!tab || tab.kind !== 'code' || !tab.dirty || !tab.filePath) return false;
    try {
      const res = await window.studio.saveFile({ filePath: tab.filePath, content: tab.model.getValue() });
      if (res?.ok) {
        tab.dirty = false;
        renderTabs(tab.groupIndex);
        renderFileGroupsPanel();
        return true;
      }
    } catch {
      // ignore transient auto-save error
    }
    return false;
  }

  function scheduleAutoSave(tab) {
    if (!tab || tab.kind !== 'code' || !tab.filePath) return;
    if (state.settings.autoSave !== 'afterDelay') return;
    clearTimeout(state.autoSaveTimers.get(tab.id));
    const delayMs = Math.max(300, Number(state.settings.autoSaveDelayMs) || 1500);
    state.autoSaveTimers.set(
      tab.id,
      setTimeout(() => {
        autoSaveTabIfEligible(tab);
      }, delayMs)
    );
  }

  function createCodeTab({ name, content = '', filePath = null, language = null, dirty = false, groupIndex = null, isStarter = false } = {}) {
    if (filePath) {
      const existing = state.tabs.find((x) => x.kind === 'code' && x.filePath === filePath);
      if (existing) {
        activateTab(existing.id);
        return existing;
      }
      // If opening a real file from disk and an untouched starter tab is still open, replace it
      // so Ctrl+S saves directly to the opened file instead of an untitled starter buffer!
      const langGuess = language || detectLanguage(name);
      const starterIdx = state.tabs.findIndex(
        (x) => x.kind === 'code' && x.isStarter && !x.dirty && !x.filePath && (x.language === langGuess || state.tabs.every((t) => t.isStarter && !t.dirty))
      );
      if (starterIdx !== -1 && state.tabs.length <= 2) {
        const [removed] = state.tabs.splice(starterIdx, 1);
        if (isRmdOrR(removed.language)) window.studio.lspDidClose({ uri: removed.uri });
        state.diagnosticsByUri.delete(removed.uri);
        removed.model.dispose();
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

    const tab = { id, kind: 'code', groupIndex: g, name, filePath, language: lang, uri, model, dirty, isStarter: Boolean(isStarter && !filePath), viewState: null };
    state.tabs.push(tab);

    model.onDidChangeContent(() => {
      tab.isStarter = false;
      if (!tab.dirty) {
        tab.dirty = true;
        renderTabs(tab.groupIndex);
        renderFileGroupsPanel();
      }
      scheduleAutoSave(tab);
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

  function openRnoteTab({ name, filePath = null, groupIndex = null } = {}) {
    if (filePath) {
      const existing = state.tabs.find((x) => x.kind === 'rnote' && x.filePath === filePath);
      if (existing) {
        activateTab(existing.id);
        return existing;
      }
    }
    const g = groupIndex !== null ? groupIndex : state.focusedGroup;
    const id = `tab-${state.nextTabNum++}`;
    const tab = {
      id,
      kind: 'rnote',
      groupIndex: g,
      name: name || (filePath ? filePath.split(/[\\/]/).pop() : 'note.rnote'),
      filePath,
      language: 'rnote',
      dirty: false,
      rnoteState: null
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
      if (prev.id !== id && state.settings.autoSave === 'onFocusChange') {
        autoSaveTabIfEligible(prev);
      }
    }
    state.activeTabByGroup[g] = id;
    setFocusedGroup(g);
    renderTabs(g);
    renderGroupStage(g);
    renderFileGroupsPanel();
    if (next.kind === 'code') state.editors[g]?.focus();
    if (state.previewOpen && state.previewMode === 'live' && next.kind === 'code') renderLivePreview();
    copilot?.updateContextPills?.();
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex((x) => x.id === id);
    if (idx === -1) return;
    const [tab] = state.tabs.splice(idx, 1);
    const g = tab.groupIndex;
    if (tab.kind === 'code') {
      if (!Array.isArray(state.closedTabs)) state.closedTabs = [];
      state.closedTabs.push({
        name: tab.name,
        filePath: tab.filePath,
        language: tab.language,
        content: tab.model ? tab.model.getValue() : '',
        groupIndex: g
      });
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
      el.draggable = true;
      el.dataset.tabId = String(tab.id);
      el.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        draggingEditorTabId = tab.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-rcs-tab', String(tab.id));
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        draggingEditorTabId = null;
        el.classList.remove('dragging');
        $('editorGroup0')?.classList.remove('tab-drop-left', 'tab-drop-right', 'tab-drop-highlight');
        $('editorGroup1')?.classList.remove('tab-drop-highlight');
      });

      const icoName = tab.kind === 'rnote' ? 'rnote' : tab.kind === 'table' ? 'table' : tab.language === 'r' ? 'r-logo' : 'file';
      const icoColor = tab.kind === 'rnote' ? 'var(--accent-pink)' : tab.kind === 'table' ? 'var(--accent-green)' : tab.language === 'rmd' ? 'var(--accent-purple)' : 'var(--accent-cyan)';
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

      el.addEventListener('dblclick', (e) => {
        const ns = el.querySelector('.tab-name');
        if (ns && (e.target === ns || e.target === el)) {
          e.stopPropagation();
          startInlineTabRename(tab, ns);
        }
      });

      el.addEventListener('click', (e) => {
        if (e.shiftKey) {
          e.preventDefault();
          popoutTabWindow(tab);
          return;
        }
        activateTab(tab.id);
      });
      bar.append(el);
    }
  }

  async function applyTabRename(tab, nextName) {
    const clean = String(nextName || '').trim();
    if (!tab || !clean || clean === tab.name) return;
    if (tab.filePath) {
      const res = await window.studio.renamePath({ oldPath: tab.filePath, newName: clean });
      if (res?.ok && res.newPath) {
        tab.filePath = res.newPath;
        tab.name = clean;
        await refreshFolderTree();
      } else if (res?.error) {
        showToast(res.error, 'error');
        return;
      }
    } else {
      tab.name = clean;
    }
    if (tab.kind === 'code') {
      tab.language = detectLanguage(tab.name);
      if (tab.model && window.monaco?.editor) {
        const monacoLang = tab.language === 'r' ? 'r' : tab.language === 'rmd' || tab.language === 'md' ? 'markdown' : 'plaintext';
        window.monaco.editor.setModelLanguage(tab.model, monacoLang);
      }
    }
    renderTabs(tab.groupIndex);
    renderBreadcrumb(tab.groupIndex);
    renderFileGroupsPanel();
  }

  function startInlineTabRename(tab, nameSpan) {
    if (!tab || !nameSpan || nameSpan.parentElement?.querySelector('.fs-rename-input')) return;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'fs-rename-input';
    inp.value = tab.name;
    nameSpan.hidden = true;
    nameSpan.insertAdjacentElement('afterend', inp);
    inp.focus();
    const dotIdx = tab.name.lastIndexOf('.');
    inp.setSelectionRange(0, dotIdx > 0 ? dotIdx : tab.name.length);
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const next = inp.value.trim();
      inp.remove();
      nameSpan.hidden = false;
      if (commit && next && next !== tab.name) {
        await applyTabRename(tab, next);
      }
    };
    inp.addEventListener('click', (ev) => ev.stopPropagation());
    inp.addEventListener('dblclick', (ev) => ev.stopPropagation());
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
      }
    });
    inp.addEventListener('blur', () => finish(true));
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
      const collapsed = groupObj
        ? groupObj.collapsed
        : localStorage.getItem('rcs-ungrouped-collapsed') === '1';
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
      } else {
        // "Ungrouped" bucket is not a stored group: keep its collapsed state separately.
        head.addEventListener('click', () => {
          localStorage.setItem('rcs-ungrouped-collapsed', collapsed ? '0' : '1');
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
          nameSpan.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            startInlineTabRename(tab, nameSpan);
          });

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
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isEs = getLang() === 'es';
            showContextMenu(e.clientX, e.clientY, [
              { icon: 'file', label: isEs ? 'Abrir / enfocar' : 'Open / Focus', action: () => activateTab(tab.id) },
              { icon: 'edit', label: isEs ? 'Renombrar' : 'Rename', action: () => startInlineTabRename(tab, nameSpan) },
              { icon: 'save', label: isEs ? 'Guardar como...' : 'Save As...', action: () => { activateTab(tab.id); saveFileAction(true); } },
              { icon: 'split', label: isEs ? 'Mover al otro editor' : 'Move to Other Split', action: () => moveTabToGroup(tab.id, tab.groupIndex === 0 ? 1 : 0) },
              ...(tab.filePath
                ? [{ icon: 'copy', label: isEs ? 'Copiar ruta' : 'Copy Path', action: () => navigator.clipboard.writeText(tab.filePath) }]
                : []),
              { icon: 'new-window', label: isEs ? 'Abrir en ventana nueva' : 'Open in New Window', action: () => popoutTabWindow(tab) },
              { sep: true },
              { icon: 'close', label: isEs ? 'Cerrar pestaña' : 'Close Tab', action: () => closeTab(tab.id) }
            ]);
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
      const actions = document.createElement('div');
      actions.className = 'ws-empty-actions';
      const btnFolder = document.createElement('button');
      btnFolder.type = 'button';
      btnFolder.className = 'dlg-btn primary';
      btnFolder.innerHTML = `${svg('folder-open', { size: 13 })}<span>${t('openFolderBtn')}</span>`;
      btnFolder.addEventListener('click', openFolderAction);
      const btnFile = document.createElement('button');
      btnFile.type = 'button';
      btnFile.className = 'dlg-btn';
      btnFile.innerHTML = `${svg('file', { size: 13 })}<span>${t('openFileBtn')}</span>`;
      btnFile.addEventListener('click', openFileAction);
      actions.append(btnFolder, btnFile);
      host.append(empty, actions);
      return;
    }

    const startInlineRename = (row, node) => {
      const nameSpan = row.querySelector('.fs-row-name');
      if (!nameSpan || row.querySelector('.fs-rename-input')) return;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'fs-rename-input';
      inp.value = node.name;
      nameSpan.hidden = true;
      nameSpan.insertAdjacentElement('afterend', inp);
      inp.focus();
      const dotIdx = !node.isDir ? node.name.lastIndexOf('.') : -1;
      inp.setSelectionRange(0, dotIdx > 0 ? dotIdx : node.name.length);
      let done = false;
      const finish = async (commit) => {
        if (done) return;
        done = true;
        const next = inp.value.trim();
        inp.remove();
        nameSpan.hidden = false;
        if (commit && next && next !== node.name) {
          await window.studio.renamePath({ oldPath: node.path, newName: next });
          await refreshFolderTree();
        }
      };
      inp.addEventListener('click', (ev) => ev.stopPropagation());
      inp.addEventListener('dblclick', (ev) => ev.stopPropagation());
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          finish(true);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          finish(false);
        }
      });
      inp.addEventListener('blur', () => finish(true));
    };

    const promptCreateInDir = async (dirPath, isDir) => {
      const targetDir = dirPath || state.workspaceRoot;
      if (!targetDir) {
        await openFolderAction();
        return;
      }
      const name = window.prompt(t(isDir ? 'newFolderPrompt' : 'newFilePrompt'), isDir ? 'data' : 'script.R');
      if (!name || !name.trim()) return;
      if (isDir) {
        await window.studio.createDir({ dir: targetDir, name: name.trim() });
      } else {
        const res = await window.studio.createFile({ dir: targetDir, name: name.trim(), content: '' });
        if (res?.ok && res.filePath) await openPathSmart(res.filePath);
      }
      await refreshFolderTree();
    };

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
          row.querySelector('.fs-row-name').addEventListener('dblclick', (e) => {
            e.stopPropagation();
            startInlineRename(row, node);
          });
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isEs = getLang() === 'es';
            showContextMenu(e.clientX, e.clientY, [
              { icon: 'new-file', label: isEs ? 'Nuevo archivo aquí...' : 'New File Here...', action: () => promptCreateInDir(node.path, false) },
              { icon: 'new-folder', label: isEs ? 'Nueva carpeta aquí...' : 'New Folder Here...', action: () => promptCreateInDir(node.path, true) },
              { sep: true },
              { icon: 'edit', label: isEs ? 'Renombrar' : 'Rename', action: () => startInlineRename(row, node) },
              { icon: 'copy', label: isEs ? 'Copiar ruta' : 'Copy Path', action: () => navigator.clipboard.writeText(node.path) },
              { sep: true },
              {
                icon: 'clear',
                label: isEs ? 'Eliminar carpeta' : 'Delete Folder',
                action: async () => {
                  if (window.confirm(t('deleteConfirm', node.name))) {
                    await window.studio.deletePath(node.path);
                    await refreshFolderTree();
                  }
                }
              }
            ]);
          });
          wrap.append(row, kids);
          parent.append(wrap);
        } else {
          const row = document.createElement('div');
          row.className = 'fs-row';
          row.style.paddingLeft = `${20 + depth * 12}px`;
          const ext = (node.name.split('.').pop() || '').toUpperCase();
          const fIco = isRnoteExt(node.name) ? 'rnote' : isDataBinaryExt(node.name) ? 'database' : isDelimitedExt(node.name) ? 'table' : 'file';
          const fColor = isRnoteExt(node.name) ? 'var(--accent-pink)' : 'var(--fg-muted)';
          row.innerHTML =
            `<span class="ico">${svg(fIco, { size: 13, color: fColor })}</span>` +
            `<span class="fs-row-name"></span>` +
            (isRnoteExt(node.name) || isDataBinaryExt(node.name) || isDelimitedExt(node.name) ? `<span class="fs-ext-tag">${ext}</span>` : '') +
            `<span class="fs-row-actions">` +
            `<button type="button" class="icon-btn fs-act-ren" title="${t('renamePrompt')}">${svg('edit', { size: 12 })}</button>` +
            `<button type="button" class="icon-btn fs-act-del" title="${t('deleteConfirm', node.name)}">${svg('clear', { size: 12 })}</button>` +
            `</span>`;
          row.querySelector('.fs-row-name').textContent = node.name;

          row.querySelector('.fs-act-ren').addEventListener('click', (e) => {
            e.stopPropagation();
            startInlineRename(row, node);
          });
          row.querySelector('.fs-row-name').addEventListener('dblclick', (e) => {
            e.stopPropagation();
            startInlineRename(row, node);
          });
          row.querySelector('.fs-act-del').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (window.confirm(t('deleteConfirm', node.name))) {
              await window.studio.deletePath(node.path);
              await refreshFolderTree();
            }
          });
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isEs = getLang() === 'es';
            showContextMenu(e.clientX, e.clientY, [
              { icon: 'file', label: isEs ? 'Abrir' : 'Open', action: () => openPathSmart(node.path) },
              {
                icon: 'new-window',
                label: isEs ? 'Abrir en ventana nueva' : 'Open in New Window',
                action: async () => {
                  await openPathSmart(node.path);
                  const opened = state.tabs.find((x) => x.filePath === node.path);
                  if (opened) popoutTabWindow(opened);
                }
              },
              {
                icon: 'sparkle',
                label: isEs ? 'Adjuntar a T3 Code Copilot' : 'Attach to T3 Code Copilot',
                action: async () => {
                  const f = await window.studio.openPath(node.path);
                  if (f?.content && copilot) {
                    copilot.addAttachment({ name: f.name, kind: 'file', content: f.content, language: /\.rmd$/i.test(f.name) ? 'rmd' : 'r' });
                    copilot.toggleWindow(true);
                  }
                }
              },
              { sep: true },
              { icon: 'edit', label: isEs ? 'Renombrar' : 'Rename', action: () => startInlineRename(row, node) },
              { icon: 'copy', label: isEs ? 'Copiar ruta' : 'Copy Path', action: () => navigator.clipboard.writeText(node.path) },
              { sep: true },
              {
                icon: 'clear',
                label: isEs ? 'Eliminar archivo' : 'Delete File',
                action: async () => {
                  if (window.confirm(t('deleteConfirm', node.name))) {
                    await window.studio.deletePath(node.path);
                    await refreshFolderTree();
                  }
                }
              }
            ]);
          });
          row.addEventListener('click', (e) => {
            dismissPeekAfterSelection('explorer');
            if (e.shiftKey) {
              e.preventDefault();
              openPathSmart(node.path).then(() => {
                const opened = state.tabs.find((x) => x.filePath === node.path);
                if (opened) popoutTabWindow(opened);
              });
              return;
            }
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
    if (!forceCode && isRnoteExt(filePath)) {
      const name = filePath.split(/[\\/]/).pop() || 'note.rnote';
      openRnoteTab({ name, filePath });
      return;
    }
    if (!forceCode && isDataBinaryExt(filePath)) {
      await loadDataFileIntoR(filePath);
      return;
    }
    const file = await window.studio.openPath(filePath);
    if (!file) return;
    if (!forceCode && (file.isRnote || isRnoteExt(file.name))) {
      openRnoteTab({ name: file.name, filePath: file.filePath });
    } else if (!forceCode && isDelimitedExt(file.name)) {
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

    // Auto-save dirty files before execution if configured
    if (state.settings.autoSave === 'onRun' || state.settings.autoSave === 'afterDelay') {
      for (const tab of state.tabs) {
        if (tab.kind === 'code' && tab.dirty && tab.filePath) {
          await autoSaveTabIfEligible(tab);
        }
      }
    }

    // Start a fresh coalesced output block for this execution
    lastRBlock = null;
    lastRBlockTime = 0;

    // Route ad-hoc runs to interactive arf terminal if user chose arf as run target OR is currently viewing the arf tab
    if (!fromMenu && (state.runTarget === 'arf' || state.activePanelTab === 'arf') && state.arfAvailable) {
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

  // --- On-demand Math Adaptation (shorthand -> LaTeX) & Cheat Sheet ---
  function isEditableTextInput(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.closest?.('.monaco-editor') || el.closest?.('.math-adapt-sheet')) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const tp = (el.type || 'text').toLowerCase();
      return tp === 'text' || tp === 'search' || tp === 'url' || tp === 'email';
    }
    return false;
  }

  function replaceTextInputRange(el, start, end, text) {
    el.focus();
    el.setSelectionRange(start, end);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      el.setRangeText(text, start, end, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function adaptSelectionInMonaco(ed, wrap = 'inline') {
    if (!ed || !window.StudioMathAdapt?.adaptMath) return false;
    const model = ed.getModel();
    const sel = ed.getSelection();
    if (!model || !sel || sel.isEmpty()) {
      showToast(t('mathAdaptNoSelection'), 'warn');
      return false;
    }
    const selected = model.getValueInRange(sel);
    if (!selected.trim()) {
      showToast(t('mathAdaptNoSelection'), 'warn');
      return false;
    }
    const startOff = model.getOffsetAt(sel.getStartPosition());
    const endOff = model.getOffsetAt(sel.getEndPosition());
    const insideMath =
      wrap === 'inline' &&
      Boolean(window.StudioMathAdapt.isInsideMathDelimiters?.(model.getValue(), startOff, endOff));
    const adapted = window.StudioMathAdapt.adaptMath(selected, { wrap: insideMath ? 'none' : wrap });
    if (!adapted) return false;
    ed.pushUndoStop();
    ed.executeEdits('math-adapt', [{ range: sel, text: adapted, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    ed.focus();
    showToast(t('mathAdaptDone'));
    return true;
  }

  function adaptSelectionInTextInput(el, wrap = 'inline') {
    if (!isEditableTextInput(el) || !window.StudioMathAdapt?.adaptMath) return false;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (end <= start) {
      showToast(t('mathAdaptNoSelection'), 'warn');
      return false;
    }
    const selected = el.value.slice(start, end);
    if (!selected.trim()) {
      showToast(t('mathAdaptNoSelection'), 'warn');
      return false;
    }
    const insideMath =
      wrap === 'inline' &&
      Boolean(window.StudioMathAdapt.isInsideMathDelimiters?.(el.value, start, end));
    const adapted = window.StudioMathAdapt.adaptMath(selected, { wrap: insideMath ? 'none' : wrap });
    if (!adapted) return false;
    replaceTextInputRange(el, start, end, adapted);
    showToast(t('mathAdaptDone'));
    return true;
  }

  function adaptMathSelection(wrap = 'inline') {
    const activeEl = document.activeElement;
    if (isEditableTextInput(activeEl)) {
      return adaptSelectionInTextInput(activeEl, wrap);
    }
    return adaptSelectionInMonaco(state.editors[state.focusedGroup], wrap);
  }

  function openMathCheatSheet(anchor = null, targetInput = null) {
    if (!window.StudioMathAdaptSheet?.openMathAdaptSheet) return;
    const inputEl = targetInput && isEditableTextInput(targetInput)
      ? targetInput
      : isEditableTextInput(document.activeElement)
        ? document.activeElement
        : null;
    const savedStart = inputEl ? (inputEl.selectionStart ?? inputEl.value.length) : 0;
    const savedEnd = inputEl ? (inputEl.selectionEnd ?? inputEl.value.length) : 0;
    const targetEd = state.editors[state.focusedGroup];

    window.StudioMathAdaptSheet.openMathAdaptSheet({
      anchor,
      onInsert: (snippet) => {
        if (inputEl && inputEl.isConnected) {
          replaceTextInputRange(inputEl, savedStart, savedEnd, snippet);
        } else if (targetEd) {
          const sel = targetEd.getSelection();
          if (sel) {
            targetEd.pushUndoStop();
            targetEd.executeEdits('math-adapt', [{ range: sel, text: snippet, forceMoveMarkers: true }]);
            targetEd.pushUndoStop();
            targetEd.focus();
          }
        }
      },
      status: (msg, isErr) => showToast(msg, isErr ? 'error' : 'info')
    });
  }

  // --- Preview, Rich Markdown Viewer (NoteComplete-grade) & Knit ---
  function renderLivePreview() {
    const tab = activeTab();
    if (!tab || tab.kind !== 'code') return;
    $('previewTitle').textContent = t('previewLiveTitle', tab.name);
    $('previewBody').hidden = false;
    $('previewIframe').hidden = true;
    $('btnPreviewModeLive').classList.toggle('active', state.previewMode === 'live');
    $('btnPreviewModeFull')?.classList.toggle('active', state.previewMode === 'full');
    $('btnPreviewModeKnit').classList.remove('active');

    const { html, chunks, headings } = window.StudioMarkdownPreview.renderMarkdown(tab.model.getValue());
    $('previewBody').innerHTML = html;

    // Populate Outline / TOC bar
    const outlineBar = $('previewOutlineBar');
    if (outlineBar) {
      outlineBar.textContent = '';
      if (headings && headings.length) {
        for (const h of headings) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'preview-toc-item';
          b.textContent = `${'·'.repeat(Math.max(0, h.level - 1))} ${h.text}`;
          b.addEventListener('click', () => {
            const target = $('previewBody').querySelector(`[id="${CSS.escape(h.slug)}"]`);
            target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          outlineBar.append(b);
        }
      } else {
        outlineBar.hidden = true;
      }
    }

    // Wire Run Chunk buttons
    for (const btn of $('previewBody').querySelectorAll('[data-run-chunk]')) {
      btn.title = t('runChunkBtn');
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-run-chunk'));
        if (chunks[idx]) executeR(chunks[idx], { label: `Chunk ${idx + 1}` });
      });
    }

    // Wire Copy Code buttons (keeping existing copy buttons functional!)
    for (const btn of $('previewBody').querySelectorAll('[data-copy-code]')) {
      btn.addEventListener('click', async () => {
        const raw = decodeURIComponent(btn.getAttribute('data-copy-code') || '');
        await navigator.clipboard.writeText(raw);
        showToast(t('outCopiedToast'));
      });
    }

    // Wire internal #anchor links inside the Markdown Viewer (NoteComplete headingFor)
    for (const a of $('previewBody').querySelectorAll('a[href^="#"]')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const frag = (a.getAttribute('href') || '').slice(1);
        let target = [...$('previewBody').querySelectorAll('[id]')].find((el) => el.id === frag);
        if (!target && headings?.length) {
          const idx = window.StudioMarkdownPreview.headingFor(headings, frag);
          if (idx >= 0) {
            const hEls = $('previewBody').querySelectorAll('h1, h2, h3, h4, h5, h6');
            target = hEls[idx];
          }
        }
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  function openPreview(mode = 'live') {
    state.previewOpen = true;
    state.previewMode = mode;
    const pane = $('previewPane');
    const edGroups = $('editorGroups');
    pane.hidden = false;
    pane.classList.toggle('full-viewer', mode === 'full');
    edGroups.hidden = mode === 'full';
    $('btnPreview').classList.add('active');
    if (mode === 'live' || mode === 'full') {
      renderLivePreview();
    } else {
      $('previewBody').hidden = true;
      $('previewIframe').hidden = false;
      $('btnPreviewModeLive').classList.remove('active');
      $('btnPreviewModeFull')?.classList.remove('active');
      $('btnPreviewModeKnit').classList.add('active');
      $('previewIframe').srcdoc =
        state.knittedHtml || `<p style="font-family:sans-serif;padding:16px;color:#6272a4">${t('previewKnitEmpty')}</p>`;
    }
    state.editors.forEach((ed) => ed?.layout());
  }

  function closePreview() {
    state.previewOpen = false;
    $('previewPane').hidden = true;
    $('previewPane').classList.remove('full-viewer');
    $('editorGroups').hidden = false;
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
        const fns = Array.isArray(node.fns) ? node.fns : [];
        const hay = fold([...parents, en, es, node.id || '', node.target || '', ...fns].join(' '));
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

  // --- Panel Tabs & Split Bottom Dock (e.g., arf + Plots simultaneously) ---
  const DOCK_PANE_MAP = {
    console: 'dockConsole',
    arf: 'dockArf',
    plots: 'dockPlots',
    problems: 'dockProblems',
    help: 'dockHelp'
  };
  let splitPanelTab = localStorage.getItem('rcs-split-panel-tab') || null;
  let lastRenderedSecondary = null;
  let splitAnimTimer = null;

  function renderDockPanes() {
    const primary = state.activePanelTab || 'console';
    const secondary = splitPanelTab && splitPanelTab !== primary && DOCK_PANE_MAP[splitPanelTab] ? splitPanelTab : null;
    const primaryCol = $('panelPrimaryCol');
    const secondaryCol = $('panelSecondaryCol');
    const secondaryHost = $('panelSecondaryHost');

    for (const [key, id] of Object.entries(DOCK_PANE_MAP)) {
      const el = $(id);
      if (!el) continue;
      if (key === secondary && secondaryHost) {
        if (el.parentElement !== secondaryHost) secondaryHost.append(el);
        el.hidden = false;
      } else {
        if (primaryCol && el.parentElement !== primaryCol) primaryCol.append(el);
        el.hidden = key !== primary;
      }
    }

    const splitChanged = (lastRenderedSecondary || null) !== (secondary || null);
    const panelBodyEl = $('panelBody');
    if (splitChanged && panelBodyEl && primaryCol) {
      // Animate the split opening/closing (and swapping which pane is on the right).
      panelBodyEl.classList.add('split-animating');
      clearTimeout(splitAnimTimer);
      splitAnimTimer = setTimeout(() => {
        panelBodyEl.classList.remove('split-animating');
        syncSplitHeaderWidth();
        $('panelTabs')?._hscrollUpdate?.();
        document.querySelector('#dockPanel .panel-actions')?._hscrollUpdate?.();
        fitArfXterm();
      }, 260);
    }
    if (secondaryCol) {
      const wasHidden = secondaryCol.hidden;
      secondaryCol.hidden = !secondary;
      if (secondary && (wasHidden || splitChanged)) {
        secondaryCol.animate(
          [
            { opacity: 0, transform: 'translateX(24px)' },
            { opacity: 1, transform: 'none' }
          ],
          { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
        );
      }
    }
    lastRenderedSecondary = secondary;
    const dockPanelEl = $('dockPanel');
    dockPanelEl?.classList.toggle('is-split', Boolean(secondary));
    const secTitle = $('panelSecondaryTitle');
    if (secTitle) {
      secTitle.hidden = !secondary;
      if (secondary) {
        const srcTab = document.querySelector(`.panel-tab[data-dock="${secondary}"]`);
        $('panelSecondaryIco').innerHTML = srcTab?.querySelector('.ico')?.innerHTML || '';
        $('panelSecondaryLabel').textContent = srcTab?.querySelector('.panel-tab-label')?.textContent || secondary;
        $('panelSecondaryTab').dataset.dock = secondary;
        $('panelSecondaryTab').title = srcTab?.title || '';
      }
    }
    syncSplitHeaderWidth();
    if ($('panelSplitGrip')) $('panelSplitGrip').hidden = !secondary;
    if (primaryCol && secondaryCol) {
      if (secondary) {
        const ratio = Math.max(0.18, Math.min(0.82, Number(localStorage.getItem('rcs-panel-split-ratio')) || 0.5));
        primaryCol.style.flex = `0 0 ${(ratio * 100).toFixed(2)}%`;
        secondaryCol.style.flex = '1 1 auto';
      } else {
        primaryCol.style.flex = '0 0 100%';
        secondaryCol.style.flex = '';
      }
    }
    $('btnPanelSplit')?.classList.toggle('active', Boolean(secondary));
    requestAnimationFrame(() => fitArfXterm());

    for (const btn of document.querySelectorAll('.panel-tab')) {
      const dk = btn.dataset.dock;
      btn.classList.toggle('active', dk === primary || dk === secondary);
      btn.classList.toggle('split-secondary', dk === secondary);
      // The right pane's tab is shown in the header above that pane instead.
      btn.classList.toggle('split-hidden', dk === secondary);
    }

    // Clarify Console vs arf tooltips
    const isEs = getLang() === 'es';
    const conTab = document.querySelector('.panel-tab[data-dock="console"]');
    const arfTab = document.querySelector('.panel-tab[data-dock="arf"]');
    if (conTab) {
      conTab.title = isEs
        ? 'Consola R integrada: captura gráficas SVG, tablas View(), entorno y diálogos de R Commander automáticamente.'
        : 'Integrated R Console: auto-captures SVG plots, View() tables, Workspace snapshot, and R Commander dialogs.';
    }
    if (arfTab) {
      arfTab.title = isEs
        ? 'Terminal interactiva arf (PTY): REPL avanzado de R con autocompletado y edición multilínea (puedes abrirla junto a Gráficas usando Dividir).'
        : 'Interactive arf terminal (PTY): enhanced R REPL with tab completion and multiline editing (split with Plots to view both side by side).';
    }
  }

  // Keep the tab strip exactly as wide as the left pane so the right pane's
  // title sits right above it.
  // (Uses the split ratio, not measured pixels, so CSS keeps it aligned on resize.)
  function syncSplitHeaderWidth() {
    const dp = $('dockPanel');
    if (!dp) return;
    const ratio = Math.max(0.18, Math.min(0.82, Number(localStorage.getItem('rcs-panel-split-ratio')) || 0.5));
    dp.style.setProperty('--split-ratio', ratio.toFixed(4));
  }

  function setSplitPanelTab(tabKey) {
    if (!tabKey || !DOCK_PANE_MAP[tabKey]) {
      splitPanelTab = null;
      localStorage.removeItem('rcs-split-panel-tab');
    } else {
      splitPanelTab = tabKey === state.activePanelTab ? (tabKey === 'plots' ? 'arf' : 'plots') : tabKey;
      localStorage.setItem('rcs-split-panel-tab', splitPanelTab);
      if (splitPanelTab === 'arf') ensureArfStarted();
    }
    renderDockPanes();
  }

  function openPanelTab(which) {
    if (splitPanelTab && which === splitPanelTab) {
      state.layout.setPanelOpen(true);
      applyWorkbenchLayout();
      renderDockPanes();
      if (which === 'arf') ensureArfStarted();
      return;
    }
    state.activePanelTab = which;
    if (splitPanelTab === which) {
      splitPanelTab = which === 'plots' ? 'console' : 'plots';
      localStorage.setItem('rcs-split-panel-tab', splitPanelTab);
    }
    state.layout.setPanelOpen(true);
    applyWorkbenchLayout();
    renderDockPanes();
    if (which === 'arf') ensureArfStarted();
  }

  // --- Universal Floating Context Menu (Explorer, Console, arf, Tabs, Plots) ---
  function hideContextMenu() {
    const m = $('studioContextMenu');
    if (m) m.hidden = true;
  }

  function showContextMenu(x, y, items) {
    const menu = $('studioContextMenu');
    if (!menu || !Array.isArray(items) || !items.length) return;
    menu.textContent = '';
    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'menubar-sep';
        menu.append(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'output-action-btn';
      if (item.disabled) btn.disabled = true;
      btn.innerHTML = `${item.icon ? `<span class="ico">${svg(item.icon, { size: 13 })}</span>` : ''}<span></span>`;
      btn.querySelector('span:last-child').textContent = item.label;
      btn.addEventListener('click', async () => {
        hideContextMenu();
        await item.action?.();
      });
      menu.append(btn);
    }
    menu.hidden = false;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(x, vw - rect.width - 8))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, vh - rect.height - 8))}px`;
  }

  document.addEventListener('click', (e) => {
    const m = $('studioContextMenu');
    if (m && !m.hidden && !m.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });

  // --- File Actions ---
  async function openFileAction() {
    const files = await window.studio.openFile({ defaultDir: state.workspaceRoot || undefined });
    if (!files || !files.length) return;
    for (const file of files) {
      if (file.isRnote || isRnoteExt(file.name)) openRnoteTab({ name: file.name, filePath: file.filePath });
      else if (file.isBinaryData) await loadDataFileIntoR(file.filePath);
      else if (isDelimitedExt(file.name)) openCsvTableTab({ name: file.name, filePath: file.filePath, rawText: file.content });
      else createCodeTab({ name: file.name, filePath: file.filePath, content: file.content, dirty: false });
    }
  }

  async function importRnoteAction() {
    const paths = await window.studio.openRnoteDialog?.({ defaultDir: state.workspaceRoot || undefined });
    if (!paths || !paths.length) return;
    for (const filePath of paths) {
      const name = filePath.split(/[\\/]/).pop() || 'note.rnote';
      openRnoteTab({ name, filePath });
    }
  }

  async function autoOpenWorkspaceStarterFiles() {
    if (!state.workspaceRoot || !Array.isArray(state.folderTree)) return;
    const onlyStarters = state.tabs.every((t) => t.isStarter && !t.dirty && !t.filePath);
    if (!onlyStarters) return;
    const docs = collectWorkspaceDocuments(state.folderTree).filter((d) => /\.(r|rmd|qmd)$/i.test(d.name));
    if (docs.length) {
      for (const doc of docs.slice(0, 2)) {
        await openPathSmart(doc.path);
      }
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
    await autoOpenWorkspaceStarterFiles();
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
    if (tab.kind === 'rnote') {
      if (forceAs) await state.rnoteViewers[tab.groupIndex]?.exportPng();
      else showToast(t('rnoteReadOnlyHint'));
      return;
    }
    const content = tab.model.getValue();
    // If tab has no filePath yet, but a workspace folder is open and the file with tab.name already exists inside it, bind it
    if (!forceAs && !tab.filePath && state.workspaceRoot) {
      const matchInFolder = collectWorkspaceDocuments(state.folderTree).find((d) => d.name === tab.name);
      if (matchInFolder && !tab.isStarter) {
        tab.filePath = matchInFolder.path;
      }
    }
    if (!forceAs && tab.filePath) {
      const res = await window.studio.saveFile({ filePath: tab.filePath, content });
      if (res?.ok) {
        tab.dirty = false;
        tab.isStarter = false;
        renderTabs(tab.groupIndex);
        renderFileGroupsPanel();
        renderGroupStage(tab.groupIndex);
        showToast(t('toastSaved', tab.name));
      }
    } else {
      const res = await window.studio.saveFileAs({
        defaultName: tab.name,
        defaultDir: state.workspaceRoot || undefined,
        content
      });
      if (res?.ok) {
        tab.filePath = res.filePath;
        tab.name = res.name;
        tab.isStarter = false;
        tab.language = detectLanguage(res.name);
        state.monaco.editor.setModelLanguage(tab.model, tab.language);
        tab.dirty = false;
        renderTabs(tab.groupIndex);
        renderFileGroupsPanel();
        renderGroupStage(tab.groupIndex);
        if (state.workspaceRoot) await refreshFolderTree();
        showToast(t('toastSaved', tab.name));
      }
    }
  }

  // --- Studio Commands ---
  async function handleStudioCommand(cmd, arg) {
    switch (cmd) {
      case 'open-url':
        if (arg) window.studio?.openExternal(arg);
        break;
      case 'refresh-builds':
        await loadBuildsMenu(true);
        break;
      case 'copy-build-info': {
        const b = menuBar.builds?.info;
        if (b) {
          const txt = `R Commander Studio v${b.version}${b.commit ? ` (${b.commit}${b.dirty ? '+dirty' : ''})` : ''}${b.date ? ` built ${b.date}` : ''} — ${b.installPath || ''}`;
          try {
            await navigator.clipboard.writeText(txt);
          } catch {
            /* clipboard unavailable */
          }
          showToast(t('buildInfoCopied', txt));
        }
        break;
      }
      case 'new-r':
      case 'new-tab':
        createCodeTab({ name: `script-${state.nextTabNum}.R`, content: '', language: 'r' });
        break;
      case 'reopen-closed-tab': {
        const last = Array.isArray(state.closedTabs) ? state.closedTabs.pop() : null;
        if (last) {
          createCodeTab({
            name: last.name,
            filePath: last.filePath || null,
            content: last.content || '',
            language: last.language || 'r',
            dirty: !last.filePath,
            groupIndex: last.groupIndex ?? state.focusedGroup
          });
        } else {
          createCodeTab({ name: `script-${state.nextTabNum}.R`, content: '', language: 'r' });
        }
        break;
      }
      case 'close-tab': {
        const cur = activeTab();
        if (cur) closeTab(cur.id);
        break;
      }
      case 'new-rmd':
        createCodeTab({ name: `report-${state.nextTabNum}.Rmd`, content: '', language: 'rmd' });
        break;
      case 'new-rmd-template':
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
      case 'import-rnote':
        await importRnoteAction();
        break;
      case 'save':
        await saveFileAction(false);
        break;
      case 'save-as':
        await saveFileAction(true);
        break;
      case 'toggle-autosave': {
        const nextMode = state.settings.autoSave === 'off' ? 'afterDelay' : 'off';
        state.settings.autoSave = nextMode;
        saveSettings(state.settings);
        showToast(t('toastAutoSaveToggle', nextMode === 'off' ? 'OFF' : 'ON (1.5s)'));
        break;
      }
      case 'toggle-copilot':
        copilot?.toggleWindow();
        break;
      case 'inline-copilot':
        copilot?.openInlineFix();
        break;
      case 'install-t3code':
        copilot?.toggleWindow(true);
        await copilot?.installT3Code();
        break;
      case 'open-guide':
        openGuideModal(false);
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
        if (state.activePanelTab === 'arf') {
          if (arfTerm) arfTerm.clear();
          else $('arfOut').textContent = '';
        } else $('consoleOut').textContent = '';
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
      case 'toggle-layout-lock': {
        const locked = !isLayoutLocked();
        localStorage.setItem(LAYOUT_LOCK_KEY, locked ? '1' : '0');
        applyLayoutLockUI();
        menuBar.render();
        showToast(t(locked ? 'toastLayoutLocked' : 'toastLayoutUnlocked'));
        break;
      }
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
      case 'open-setup-wizard':
        setupWizard.open();
        break;
      case 'r-help':
        openDocsForCursor();
        break;
      case 'check-updates':
        await checkAndPromptForUpdate(true);
        break;
      case 'toggle-update-on-open': {
        if (window.studio?.updaterSettings) {
          const cur = await window.studio.updaterSettings();
          const next = !cur.checkOnOpen;
          await window.studio.updaterSetCheckOnOpen(next);
          showToast(`${t('checkForUpdatesOnOpen')}: ${next ? 'ON' : 'OFF'}`);
        }
        break;
      }
      case 'install-desktop': {
        if (window.studio?.installDesktop) {
          const res = await window.studio.installDesktop();
          if (res?.ok) showToast(t('desktopInstalledToast'));
        }
        break;
      }
      case 'open-my-github':
        window.studio?.openExternal('https://github.com/Emefedez');
        break;
      case 'open-repo-github':
        window.studio?.openExternal('https://github.com/Emefedez/r-commander-studio');
        break;
      case 'open-vscode-ext-github':
        window.studio?.openExternal('https://github.com/Emefedez/r-commander-in-vscode');
        break;
      case 'undo':
      case 'redo':
      case 'find':
        state.editors[state.focusedGroup]?.trigger('menu', cmd === 'find' ? 'actions.find' : cmd, null);
        break;
      case 'math-adapt-inline':
        adaptMathSelection('inline');
        break;
      case 'math-adapt-block':
        adaptMathSelection('block');
        break;
      case 'math-adapt-sheet':
        openMathCheatSheet($('btnMathSheet'));
        break;
      default:
        if (typeof cmd === 'string' && cmd.startsWith('set-ai-harness:')) {
          const prov = cmd.slice('set-ai-harness:'.length);
          await copilot?.setProvider(prov);
        }
        break;
    }
  }

  async function checkAndPromptForUpdate(manual = true, preloadedInfo = null) {
    if (!window.studio?.updaterCheck) return;
    if (manual) showToast(t('updateChecking'));
    try {
      const info = preloadedInfo || (await window.studio.updaterCheck({ manual }));
      if (!info || !info.version) {
        if (manual) showToast(t('updateUpToDate', info?.current || '0.1.0'));
        return;
      }
      const yes = window.confirm(t('updateAvailablePrompt', info.version, info.current || '0.1.0'));
      if (!yes) return;
      if (info.install === 'appimage') {
        showToast(t('updateInstalling', info.version));
        const stopProgress = window.studio.onUpdaterProgress?.((pct) => {
          if (pct > 0) showToast(`${t('updateInstalling', info.version)} ${Math.round(pct * 100)}%`);
        });
        let installed;
        try {
          installed = await window.studio.updaterInstall();
        } catch (err) {
          showToast(err.message || 'Update failed', 'error');
          await window.studio.openExternal(info.assetUrl || info.page || 'https://github.com/Emefedez/r-commander-studio/releases/latest');
          return;
        } finally {
          if (typeof stopProgress === 'function') stopProgress();
        }
        // The AppImage was replaced in place: relaunch straight into the new version.
        showToast(t('updateInstalledRestarting', installed.version));
        setTimeout(() => window.studio.updaterRestart(), 1200);
      } else {
        await window.studio.openExternal(info.assetUrl || info.page || 'https://github.com/Emefedez/r-commander-studio/releases/latest');
      }
    } catch (err) {
      if (manual) showToast(err.message || 'Update check failed', 'error');
    }
  }

  function getStudioCommandsList() {
    const dictEn = window.STUDIO_I18N_DICT?.en || {};
    const dictEs = window.STUDIO_I18N_DICT?.es || {};
    const cmdEntry = (id, key, accel = '') => ({
      id,
      label: t(key),
      labelAlt: `${dictEn[key] || ''} ${dictEs[key] || ''}`,
      accel
    });
    return [
      cmdEntry('new-r', 'newRScript', 'Ctrl+N / Ctrl+T'),
      cmdEntry('new-rmd', 'newRmdDoc', 'Ctrl+Shift+N'),
      cmdEntry('close-tab', 'closeTab', 'Ctrl+W'),
      cmdEntry('open', 'openFile', 'Ctrl+O'),
      cmdEntry('open-folder', 'openFolder', 'Ctrl+Shift+O'),
      cmdEntry('load-workspace', 'loadWorkspace'),
      cmdEntry('load-dataset-file', 'loadDatasetFile'),
      cmdEntry('save', 'save', 'Ctrl+S'),
      cmdEntry('save-as', 'saveAs', 'Ctrl+Shift+S'),
      cmdEntry('run-selection', 'runSelection', 'Ctrl+Enter'),
      cmdEntry('run-all', 'runAll', 'Ctrl+Shift+Enter'),
      cmdEntry('knit', 'knitRmd', 'Ctrl+Shift+K'),
      cmdEntry('toggle-split', 'splitEditor', 'Ctrl+\\'),
      cmdEntry('move-tab-group', 'moveTabOtherGroup'),
      cmdEntry('toggle-preview', 'togglePreview', 'Ctrl+Shift+V'),
      cmdEntry('toggle-explorer-sidebar', 'toggleSidebar'),
      cmdEntry('toggle-rcmdr-sidebar', 'toggleRcmdrSidebar'),
      cmdEntry('toggle-panel', 'togglePanel'),
      cmdEntry('toggle-panel-orientation', 'togglePanelOrientation'),
      cmdEntry('toggle-layout-lock', 'lockLayout'),
      cmdEntry('layout-both-left', 'layoutBothLeft'),
      cmdEntry('layout-explorer-left-rcmdr-right', 'layoutExplorerLeftRcmdrRight'),
      cmdEntry('layout-rcmdr-left-explorer-right', 'layoutRcmdrLeftExplorerRight'),
      cmdEntry('layout-both-right', 'layoutBothRight'),
      cmdEntry('toggle-theme', 'toggleTheme'),
      cmdEntry('switch-language', 'switchLanguage'),
      cmdEntry('open-settings', 'openSettings', 'Ctrl+,'),
      cmdEntry('open-setup-wizard', 'wizardMenuItem'),
      cmdEntry('toggle-copilot', 'copilotToggle', 'Ctrl+Alt+B'),
      cmdEntry('inline-copilot', 'copilotInlineFix', 'Ctrl+I'),
      cmdEntry('install-t3code', 'copilotInstallBtn'),
      cmdEntry('open-guide', 'guideBtnTitle'),
      cmdEntry('math-adapt-inline', 'mathAdaptInline', 'Ctrl+Alt+M'),
      cmdEntry('math-adapt-block', 'mathAdaptBlock', 'Ctrl+Alt+Shift+M'),
      cmdEntry('math-adapt-sheet', 'mathAdaptSheet'),
      cmdEntry('toggle-autosave', 'menuAutoSave'),
      cmdEntry('r-help', 'rHelpMenu', 'F1'),
      cmdEntry('interrupt-r', 'interruptR'),
      cmdEntry('restart-r', 'restartR'),
      cmdEntry('clear-console', 'clearConsole'),
      cmdEntry('refresh-workspace', 'refreshWorkspace'),
      cmdEntry('check-updates', 'checkForUpdates'),
      cmdEntry('install-desktop', 'installDesktopEntry'),
      cmdEntry('open-repo-github', 'repoGithub'),
      cmdEntry('open-vscode-ext-github', 'vscodeExtGithub'),
      cmdEntry('open-my-github', 'myGithub')
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
          const nextW = Math.max(185, Math.min(540, startW + delta));
          targetEl.style.width = `${nextW}px`;
          targetEl.style.setProperty('--sb-width', `${nextW}px`);
          for (const child of targetEl.querySelectorAll(':scope > .dockable-sidebar, :scope > .dock-panel')) {
            child.style.width = '100%';
          }
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
        const h = Math.max(90, Math.min(window.innerHeight * 0.85, startH - (ev.clientY - startY)));
        bSlot.style.height = `${h}px`;
        state.layout.panel.size = Math.round(h);
        state.editors.forEach((ed) => ed?.layout());
        fitArfXterm();
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
  // Help > Builds: installed build info + recent GitHub releases.
  menuBar.builds = { info: null, releases: [], state: 'loading' };
  async function loadBuildsMenu(force = false) {
    try {
      menuBar.builds.info = (await window.studio?.buildInfo?.()) || null;
    } catch {
      /* ignore */
    }
    if (force) menuBar.builds.state = 'loading';
    menuBar.render();
    try {
      const list = (await window.studio?.updaterListReleases?.()) || [];
      menuBar.builds.releases = list;
      menuBar.builds.state = 'ok';
    } catch {
      menuBar.builds.state = 'error';
    }
    menuBar.render();
  }
  setTimeout(() => loadBuildsMenu(), 2500);

  const palette = new window.StudioCommandPalette({
    getStudioCommands: getStudioCommandsList,
    onStudioCommand: handleStudioCommand,
    onRcmdrCommand: triggerRcmdrCommand
  });
  function commitSettings(next, toastMsg) {
    state.settings = next;
    applyThemePreset(next.themePreset, next.themeOverrides);
    applySettingsUI();
    if (toastMsg) showToast(toastMsg);
  }

  const settingsModal = new StudioSettingsModal({
    getSettings: () => state.settings,
    onSave: (next) => commitSettings(next, t('settingsSavedToast')),
    onPreviewTheme: (presetId, overrides) => applyThemePreset(presetId, overrides),
    getLang,
    onSetLang: switchLanguage
  });

  const setupWizard = new StudioSetupWizard({
    getSettings: () => state.settings,
    onSave: (next, { skipped } = {}) => commitSettings(next, skipped ? t('wizardSkippedToast') : ''),
    onPreviewTheme: (presetId, overrides) => applyThemePreset(presetId, overrides),
    getLang,
    onSetLang: switchLanguage,
    onSetAiProvider: (id) => {
      if (!copilot) return;
      copilot.selectedProvider = id;
      copilot.refreshProviders?.();
    },
    getVersion: () => state.appVersion || ''
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
    state.rnoteViewers[g] = new window.StudioRnoteViewer($(`rnoteHost${g}`), {
      onToast: showToast
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
  if ($('btnTopLang')) $('btnTopLang').textContent = getLang().toUpperCase();

  menuBar.setTree(state.tree);
  renderRcmdrTree();
  renderWorkspace();
  renderFolderTree();
  renderPlotPane();
  renderHelpEmptyPrereq();
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
      fontSize: state.editorFontSize,
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
    ed.addCommand(state.monaco.KeyMod.Alt | state.monaco.KeyCode.LeftArrow, () => ed.trigger('keyboard', 'cursorHome', null));
    ed.addCommand(state.monaco.KeyMod.Alt | state.monaco.KeyCode.RightArrow, () => ed.trigger('keyboard', 'cursorEnd', null));
    ed.addCommand(state.monaco.KeyMod.Alt | state.monaco.KeyMod.Shift | state.monaco.KeyCode.LeftArrow, () => ed.trigger('keyboard', 'cursorHomeSelect', null));
    ed.addCommand(state.monaco.KeyMod.Alt | state.monaco.KeyMod.Shift | state.monaco.KeyCode.RightArrow, () => ed.trigger('keyboard', 'cursorEndSelect', null));
    ed.addCommand(state.monaco.KeyMod.CtrlCmd | state.monaco.KeyMod.Shift | state.monaco.KeyCode.KeyM, () => insertTextAtCursor(ed, ' |> '));
    ed.addCommand(state.monaco.KeyMod.CtrlCmd | state.monaco.KeyCode.KeyT, () => handleStudioCommand('new-r'));
    ed.addCommand(state.monaco.KeyMod.CtrlCmd | state.monaco.KeyMod.Shift | state.monaco.KeyCode.KeyT, () => handleStudioCommand('reopen-closed-tab'));
    ed.addCommand(state.monaco.KeyMod.CtrlCmd | state.monaco.KeyCode.KeyW, () => handleStudioCommand('close-tab'));
    ed.addCommand(state.monaco.KeyMod.CtrlCmd | state.monaco.KeyCode.KeyI, () => copilot?.openInlineFix());
    ed.addCommand(state.monaco.KeyCode.F1, () => openDocsForCursor());
    ed.addAction({
      id: 'studio.context.t3InlineFix',
      label: t('copilotInlineFix'),
      keybindings: [state.monaco.KeyMod.CtrlCmd | state.monaco.KeyCode.KeyI],
      contextMenuGroupId: 'navigation',
      run: () => copilot?.openInlineFix()
    });
    ed.addAction({
      id: 'studio.context.openRDocs',
      label: t('openDocsBtn'),
      contextMenuGroupId: 'navigation',
      run: () => openDocsForCursor()
    });
    ed.addAction({
      id: 'studio.context.mathAdaptInline',
      label: t('mathAdaptInline'),
      precondition: 'editorHasSelection',
      keybindings: [state.monaco.KeyMod.CtrlCmd | state.monaco.KeyMod.Alt | state.monaco.KeyCode.KeyM],
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 2.1,
      run: (editor) => adaptSelectionInMonaco(editor, 'inline')
    });
    ed.addAction({
      id: 'studio.context.mathAdaptBlock',
      label: t('mathAdaptBlock'),
      precondition: 'editorHasSelection',
      keybindings: [
        state.monaco.KeyMod.CtrlCmd | state.monaco.KeyMod.Alt | state.monaco.KeyMod.Shift | state.monaco.KeyCode.KeyM
      ],
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 2.2,
      run: (editor) => adaptSelectionInMonaco(editor, 'block')
    });
    ed.addAction({
      id: 'studio.context.mathAdaptSheet',
      label: t('mathAdaptSheet'),
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 2.3,
      run: () => openMathCheatSheet($('btnMathSheet'))
    });
    ed.getDomNode()?.addEventListener(
      'contextmenu',
      (e) => {
        if (!e.shiftKey) return;
        const model = ed.getModel();
        const sel = ed.getSelection();
        if (!model || !sel || sel.isEmpty()) return;
        const selected = model.getValueInRange(sel);
        if (!selected.trim() || /[\u3400-\u9FFF]/.test(selected)) return;
        e.preventDefault();
        e.stopPropagation();
        adaptSelectionInMonaco(ed, 'inline');
      },
      true
    );
    state.editors[g] = ed;
  }

  // Apply active custom/preset theme to Monaco immediately after editor creation
  applyThemePreset(state.settings.themePreset || 'dracula', state.settings.themeOverrides || {});
  if (state.uiZoomFactor !== 1 && window.studio?.setUiZoom) {
    window.studio.setUiZoom(state.uiZoomFactor);
  }

  // Starter tabs (marked isStarter: true so opening a real file or workspace folder replaces them cleanly!)
  createCodeTab({ name: 'report.Rmd', content: '', language: 'rmd', dirty: false, groupIndex: 0, isStarter: true });
  createCodeTab({ name: 'analysis.R', content: DEFAULT_R_SCRIPT, language: 'r', dirty: false, groupIndex: 0, isStarter: true });

  // --- Wire Main Process Events ---
  if (hasBridge) {
    window.studio.onROutput(({ stream, text }) => appendConsole(text, stream === 'stderr' ? 'console-line-err' : ''));
    window.studio.onArfOutput(({ stream, raw, text }) => appendArf(text, stream === 'stderr' ? 'console-line-err' : '', raw));
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
          await autoOpenWorkspaceStarterFiles();
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
    window.studio.onZoomStep?.(({ kind, step }) => applyZoomStep(kind, step));
    if (window.studio.onUpdaterAvailable) {
      window.studio.onUpdaterAvailable((info) => checkAndPromptForUpdate(false, info));
    }

    // Session persistence: save workspace + open files and offer 1-click restore on startup if still on disk
    const saveLastSession = () => {
      try {
        const openFiles = state.tabs.filter((x) => x.filePath).map((x) => x.filePath);
        if (!state.workspaceRoot && !openFiles.length) return;
        const activeFile = activeTab()?.filePath || '';
        localStorage.setItem(
          'rcs-last-session',
          JSON.stringify({ workspaceRoot: state.workspaceRoot || '', openFiles, activeFile, savedAt: Date.now() })
        );
      } catch {
        // ignore storage errors
      }
    };
    window.addEventListener('beforeunload', saveLastSession);
    setInterval(saveLastSession, 15000);

    // Prompt to save unsaved changes before closing the window
    window.studio.onRequestClose?.(async () => {
      saveLastSession();
      const dirtyTabs = state.tabs.filter((x) => x.kind === 'code' && x.dirty);
      if (!dirtyTabs.length) {
        await window.studio.allowClose();
        return;
      }
      const choice = await window.studio.confirmCloseDialog({
        count: dirtyTabs.length,
        names: dirtyTabs.map((x) => x.name),
        lang: getLang()
      });
      if (choice === 0) {
        for (const dt of dirtyTabs) {
          activateTab(dt.id);
          await saveFileAction(false);
          if (dt.dirty) return; // User canceled Save As -> abort close
        }
        saveLastSession();
        await window.studio.allowClose();
      } else if (choice === 1) {
        await window.studio.allowClose();
      }
    });

    // Offer to retrieve latest work on startup if those paths still exist
    if (!Array.isArray(init.pendingOpenPaths) || !init.pendingOpenPaths.length) {
      try {
        const raw = localStorage.getItem('rcs-last-session');
        const last = raw ? JSON.parse(raw) : null;
        if (last && (last.workspaceRoot || (Array.isArray(last.openFiles) && last.openFiles.length))) {
          const check = await window.studio.checkSessionPaths?.({
            workspaceRoot: last.workspaceRoot || '',
            openFiles: last.openFiles || []
          });
          if (check && (check.workspaceExists || check.existingFiles?.length)) {
            const bar = $('restoreSessionBar');
            const txt = $('restoreSessionText');
            const btn = $('btnRestoreSession');
            const dismiss = $('btnDismissRestore');
            const isEs = getLang() === 'es';
            const folderLabel = check.workspaceExists ? last.workspaceRoot.split(/[\\/]/).pop() : '';
            const nFiles = check.existingFiles?.length || 0;
            const summary = [
              folderLabel ? `${isEs ? 'Carpeta' : 'Folder'}: ${folderLabel}` : '',
              nFiles ? `${nFiles} ${isEs ? 'archivo(s)' : 'file(s)'}` : ''
            ]
              .filter(Boolean)
              .join(' · ');
            if (bar && txt && btn) {
              txt.textContent = isEs
                ? `¿Recuperar tu último trabajo? (${summary})`
                : `Retrieve your latest work? (${summary})`;
              btn.textContent = isEs ? 'Restaurar sesión' : 'Restore Session';
              bar.hidden = false;
              btn.onclick = async () => {
                bar.hidden = true;
                if (check.workspaceExists) {
                  await handleOpenPathTarget({ folderPath: last.workspaceRoot });
                }
                for (const fp of check.existingFiles || []) {
                  await openPathSmart(fp);
                }
                if (last.activeFile) {
                  const found = state.tabs.find((x) => x.filePath === last.activeFile);
                  if (found) activateTab(found.id);
                }
              };
              dismiss.onclick = () => {
                bar.hidden = true;
              };
            }
          }
        }
      } catch {
        // ignore invalid saved session
      }
    }
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
    // Prevent Ctrl+A from selecting UI chrome when not focused in an input/editor/terminal
    if (!e.altKey && !e.shiftKey && key === 'a') {
      const ae = document.activeElement;
      const inEditable =
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable ||
          ae.closest?.('.monaco-editor') ||
          ae.closest?.('.xterm'));
      if (!inEditable) {
        e.preventDefault();
        const inConsole = ae?.closest?.('#dockConsole') || e.target?.closest?.('#dockConsole');
        if (inConsole && $('consoleOut')) {
          const range = document.createRange();
          range.selectNodeContents($('consoleOut'));
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        } else {
          const ed = state.editors[state.focusedGroup];
          if (ed && activeTab()?.kind === 'code') {
            ed.focus();
            ed.trigger('keyboard', 'editor.action.selectAll', null);
          }
        }
        return;
      }
    }
    // Ctrl + / Ctrl - / Ctrl 0 (no Shift) -> change ONLY Editor text size
    // Ctrl + Shift + + / Ctrl + Shift + - / Ctrl + Shift + 0 -> change both Editor and UI zoom factor
    // Recognizes US, Spanish (BracketRight '+' / '*', Slash '-' / '_', Digit0 '0' / '='), and Numpad keys.
    const isZoomReset =
      e.key === '0' || e.key === ')' || e.code === 'Digit0' || e.code === 'Numpad0';
    const isZoomPlus =
      !isZoomReset &&
      (e.key === '+' ||
        e.key === '*' ||
        e.key === ']' ||
        e.key === '=' ||
        e.code === 'Equal' ||
        e.code === 'BracketRight' ||
        e.code === 'NumpadAdd');
    const isZoomMinus =
      e.key === '-' ||
      e.key === '_' ||
      e.code === 'Minus' ||
      e.code === 'Slash' ||
      e.code === 'NumpadSubtract';
    if (!e.altKey && (isZoomPlus || isZoomMinus || isZoomReset)) {
      e.preventDefault();
      const step = isZoomReset ? 0 : isZoomMinus ? -1 : 1;
      applyZoomStep(e.shiftKey ? 'ui' : 'editor', step);
      return;
    }
    if (e.altKey && key === 'b') {
      e.preventDefault();
      copilot?.toggleWindow();
      return;
    }
    if (!e.altKey && !e.shiftKey && key === 'i') {
      e.preventDefault();
      copilot?.openInlineFix();
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
    } else if (!e.altKey && key === 't') {
      e.preventDefault();
      handleStudioCommand(e.shiftKey ? 'reopen-closed-tab' : 'new-r');
    } else if (!e.altKey && !e.shiftKey && key === 'w') {
      e.preventDefault();
      handleStudioCommand('close-tab');
    } else if (e.shiftKey && key === 'v') {
      e.preventDefault();
      handleStudioCommand('toggle-preview');
    } else if (e.shiftKey && key === 'k') {
      e.preventDefault();
      handleStudioCommand('knit');
    }
  });

  // --- Standalone Popout Helpers (Shift+Click opens in a separate window by default) ---
  async function popoutTabWindow(tab) {
    if (!tab || !window.studio?.openOutputWindow) return;
    if (tab.kind === 'table' && tab.tableConfig?.objectName) {
      await popoutDatasetWindow(tab.tableConfig.objectName);
      return;
    }
    const raw = tab.model?.getValue() || '';
    const html =
      tab.language === 'rmd' || tab.language === 'markdown'
        ? window.StudioMarkdownPreview.renderMarkdown(raw).html
        : `<pre class="code-highlighted">${window.StudioMarkdownPreview.highlightCode(raw, tab.language || 'r')}</pre>`;
    await window.studio.openOutputWindow({
      title: `${tab.name} — R Commander Studio`,
      sourceLabel: (tab.language || 'FILE').toUpperCase(),
      htmlContent: html,
      rawText: raw,
      isLight: state.theme === 'light'
    });
  }

  async function popoutDatasetWindow(objectName) {
    if (!objectName || !window.studio?.tableGetPage || !window.studio?.openOutputWindow) return;
    const page = await window.studio.tableGetPage({ name: objectName, source: 'global', page: 1, pageSize: 200 });
    if (!page?.ok) return;
    const cols = (page.columns || []).map((c) => `<th>${escapeHtmlText(c.name)} <small style="opacity:.7">(${escapeHtmlText(c.type)})</small></th>`).join('');
    const rows = (page.rows || [])
      .map(
        (r) =>
          `<tr><td><b>${escapeHtmlText(r.rowName)}</b></td>${(r.values || [])
            .map((v) => `<td>${v === null ? '<i>NA</i>' : escapeHtmlText(v)}</td>`)
            .join('')}</tr>`
      )
      .join('');
    const html = `<table><thead><tr><th>#</th>${cols}</tr></thead><tbody>${rows}</tbody></table>`;
    await window.studio.openOutputWindow({
      title: `Data Set: ${objectName} (${page.totalRows} x ${page.totalCols}) — R Commander Studio`,
      sourceLabel: 'Table Viewer',
      htmlContent: html,
      rawText: `${objectName} (${page.totalRows} rows, ${page.totalCols} cols)`,
      isLight: state.theme === 'light'
    });
  }

  async function popoutPanelSection(which) {
    if (!window.studio?.openOutputWindow) return;
    if (which === 'plots') {
      if (state.plots.length) await popoutCurrentPlot();
      return;
    }
    if (which === 'console') {
      await window.studio.openOutputWindow({
        title: `${t('dockRConsole')} — R Commander Studio`,
        sourceLabel: 'R Console',
        htmlContent: `<pre>${$('consoleOut').innerHTML}</pre>`,
        rawText: $('consoleOut').innerText,
        isLight: state.theme === 'light'
      });
      return;
    }
    if (which === 'arf') {
      await window.studio.openOutputWindow({
        title: `arf Terminal — R Commander Studio`,
        sourceLabel: 'arf',
        htmlContent: `<pre>${$('arfOut').innerHTML}</pre>`,
        rawText: $('arfOut').innerText,
        isLight: state.theme === 'light'
      });
      return;
    }
    if (which === 'help') {
      await window.studio.openOutputWindow({
        title: `${t('dockHelp')} — R Commander Studio`,
        sourceLabel: 'R Help',
        htmlContent: $('helpContent').innerHTML,
        rawText: $('helpContent').innerText,
        isLight: state.theme === 'light'
      });
      return;
    }
    if (which === 'problems') {
      await window.studio.openOutputWindow({
        title: `${t('dockProblems')} — R Commander Studio`,
        sourceLabel: 'Problems',
        htmlContent: $('problemsList').innerHTML,
        rawText: $('problemsList').innerText,
        isLight: state.theme === 'light'
      });
    }
  }

  // --- Interactive Bilingual User Guide Modal (? button in Activity Bar) ---
  function buildGuideHtml() {
    const isEs = getLang() === 'es';
    if (isEs) {
      return `
        <p>Bienvenido a <strong>R Commander Studio</strong>. Toda la interfaz, los <strong>371 diálogos de R Commander &amp; TeachStat</strong> y la ayuda están disponibles en <strong>Español</strong> e <strong>Inglés</strong> (botón <code>ES / EN</code> arriba a la derecha).</p>
        <div class="guide-grid">
          <div class="guide-card">
            <h3>Shift + Clic: Abrir en ventana aparte</h3>
            <ul>
              <li>Mantén pulsado <kbd>Shift</kbd> y haz clic en cualquier <strong>gráfica</strong>, <strong>bloque de salida de la consola / arf</strong>, <strong>conjunto de datos</strong>, <strong>pestaña del panel</strong> (<kbd>Consola</kbd>, <kbd>Gráficas</kbd>, <kbd>Ayuda</kbd>) o <strong>archivo</strong> para abrirlo directamente en una <strong>ventana independiente</strong>.</li>
            </ul>
          </div>
          <div class="guide-card">
            <h3>Zoom del Editor vs. Zoom de la Interfaz</h3>
            <ul>
              <li><kbd>Ctrl +</kbd> y <kbd>Ctrl -</kbd> (<kbd>Ctrl 0</kbd> reinicia): cambia <strong>únicamente el tamaño de letra del editor</strong>.</li>
              <li><kbd>Ctrl + Shift + +</kbd> y <kbd>Ctrl + Shift + -</kbd>: escala <strong>tanto el editor como toda la interfaz</strong> sin recortar bordes.</li>
            </ul>
          </div>
          <div class="guide-card">
            <h3>T3 Code Copilot e Instalador</h3>
            <ul>
              <li><kbd>Ctrl + Alt + B</kbd>: abre la ventana de chat de <strong>T3 Code Copilot</strong> con comandos rápidos (<code>/fix</code>, <code>/explain</code>, <code>/plot</code>, <code>/rmd</code>) y botones para aplicar o ejecutar en R.</li>
              <li><kbd>Ctrl + I</kbd>: abre la barra de corrección rápida en línea dentro del editor.</li>
              <li>Incluye un <strong>Instalador multiplataforma de T3 Code</strong> (Linux, macOS y Windows con soporte automático de WSL2).</li>
            </ul>
          </div>
          <div class="guide-card">
            <h3>Carpetas, Archivos y Autoguardado</h3>
            <ul>
              <li>Abre archivos (<kbd>Ctrl + O</kbd>) o carpetas (<kbd>Ctrl + Shift + O</kbd>) desde los iconos de la barra superior o desde el panel lateral <strong>Archivos y Entorno</strong>.</li>
              <li><kbd>Ctrl + S</kbd> guarda directamente en la carpeta abierta. El <strong>Autoguardado</strong> (configurable en Ajustes y menú Fichero) guarda automáticamente tus cambios.</li>
            </ul>
          </div>
          <div class="guide-card">
            <h3>Árbol de R Commander e Instalador CRAN</h3>
            <ul>
              <li>En la cabecera de la barra lateral de <strong>R Commander</strong> tienes accesos directos para <strong>Instalar paquetes de CRAN</strong>, <strong>plegar menús automáticamente al elegir</strong> y alternar si los diálogos insertan código en el script.</li>
            </ul>
          </div>
          <div class="guide-card">
            <h3>Errores (Rojo), Warnings (Amarillo) y Paneles</h3>
            <ul>
              <li>Los errores de sintaxis se subrayan en <strong>rojo</strong> y los avisos (warnings) en <strong>amarillo</strong> como en VS Code. En la pestaña <strong>Problemas</strong> puedes activar o desactivar cada uno.</li>
              <li>Arrastra las cabeceras de las barras laterales o del panel inferior para acoplarlos a la izquierda, derecha o abajo, o pulsa el botón de <strong>Maximizar panel</strong>.</li>
            </ul>
          </div>
        </div>
      `;
    }
    return `
      <p>Welcome to <strong>R Commander Studio</strong>. The entire IDE, all <strong>371 R Commander &amp; TeachStat dialogs</strong>, and documentation search work in both <strong>English</strong> and <strong>Spanish</strong> (toggle <code>EN / ES</code> in the top bar).</p>
      <div class="guide-grid">
        <div class="guide-card">
          <h3>Shift + Click: Open in Separate Window</h3>
          <ul>
            <li>Hold <kbd>Shift</kbd> and click any <strong>plot</strong>, <strong>R Console / arf output block</strong>, <strong>workspace dataset</strong>, <strong>panel tab</strong> (<kbd>Console</kbd>, <kbd>Plots</kbd>, <kbd>Help</kbd>), or <strong>file tab</strong> to pop it out into a <strong>standalone window</strong> by default.</li>
          </ul>
        </div>
        <div class="guide-card">
          <h3>Editor Text Zoom vs. Full UI Zoom</h3>
          <ul>
            <li><kbd>Ctrl +</kbd> and <kbd>Ctrl -</kbd> (<kbd>Ctrl 0</kbd> resets): changes <strong>only the Editor text size</strong>.</li>
            <li><kbd>Ctrl + Shift + +</kbd> and <kbd>Ctrl + Shift + -</kbd>: scales <strong>both the Editor and the entire UI</strong> cleanly without clipping.</li>
          </ul>
        </div>
        <div class="guide-card">
          <h3>T3 Code Copilot &amp; Installer Tool</h3>
          <ul>
            <li><kbd>Ctrl + Alt + B</kbd>: opens the <strong>T3 Code Copilot</strong> chat window with slash commands (<code>/fix</code>, <code>/explain</code>, <code>/plot</code>, <code>/rmd</code>) and 1-click Apply / Run buttons.</li>
            <li><kbd>Ctrl + I</kbd>: opens the inline code fix prompt right inside the active editor.</li>
            <li>Includes a built-in <strong>Cross-Platform T3 Code Installer Tool</strong> (Linux, macOS, and Windows with automatic WSL2 setup).</li>
          </ul>
        </div>
        <div class="guide-card">
          <h3>Folders, Files &amp; Auto-Save</h3>
          <ul>
            <li>Open files (<kbd>Ctrl + O</kbd>) or folders (<kbd>Ctrl + Shift + O</kbd>) from either the Top Bar icons or the <strong>Explorer &amp; Workspace</strong> sidebar.</li>
            <li><kbd>Ctrl + S</kbd> saves directly in place. <strong>Auto-Save</strong> (configurable in Settings and the File menu) saves your edits automatically.</li>
          </ul>
        </div>
        <div class="guide-card">
          <h3>R Commander Tree &amp; CRAN Package Installer</h3>
          <ul>
            <li>The <strong>R Commander</strong> sidebar header includes 1-click buttons to open the <strong>CRAN Package Installer</strong>, toggle <strong>auto-closing menus after selection</strong>, and switch menu code insertion mode.</li>
          </ul>
        </div>
        <div class="guide-card">
          <h3>Errors (Red), Warnings (Yellow) &amp; Docking</h3>
          <ul>
            <li>Syntax errors are underlined in <strong>red</strong> and R warnings in <strong>yellow</strong> like VS Code. Use the toggles inside the <strong>Problems</strong> tab to hide or show warnings/errors anytime.</li>
            <li>Drag sidebar or panel headers to dock Left, Right, or Bottom, or click the <strong>Maximize Panel</strong> button.</li>
          </ul>
        </div>
      </div>
    `;
  }

  function expandRcmdrCategory(enCategoryName) {
    state.layout.setSidebarOpen('rcmdr', true);
    applyWorkbenchLayout();
    $('rcmdrSearch').value = '';
    for (const node of state.tree || []) {
      if (!node.sep && node.children && node.label?.en === enCategoryName) {
        node._expanded = true;
      }
    }
    renderRcmdrTree();
  }

  function applyZoomStep(kind, step) {
    if (kind === 'ui') {
      const curZ = state.uiZoomFactor || 1;
      const nextZ = step === 0 ? 1 : step < 0 ? Math.max(0.7, +(curZ - 0.1).toFixed(2)) : Math.min(1.6, +(curZ + 0.1).toFixed(2));
      state.uiZoomFactor = nextZ;
      localStorage.setItem('rcs-ui-zoom-factor', String(nextZ));
      if (window.studio?.setUiZoom) {
        window.studio.setUiZoom(nextZ);
      } else {
        document.documentElement.style.zoom = nextZ === 1 ? '' : String(nextZ);
      }
      state.editors.forEach((ed) => ed?.layout());
      showToast(`UI + Editor Zoom: ${Math.round(nextZ * 100)}%`);
    } else {
      const curF = state.editorFontSize || 13.5;
      const nextF = step === 0 ? 13.5 : step < 0 ? Math.max(10, +(curF - 1).toFixed(1)) : Math.min(28, +(curF + 1).toFixed(1));
      state.editorFontSize = nextF;
      localStorage.setItem('rcs-editor-font-size', String(nextF));
      state.editors.forEach((ed) => ed?.updateOptions({ fontSize: nextF }));
      showToast(`Editor Font Size: ${nextF}px`);
    }
  }
  function openGuideModal(popout = false) {
    const html = buildGuideHtml();
    if (popout && window.studio?.openOutputWindow) {
      window.studio.openOutputWindow({
        title: t('guideTitle'),
        sourceLabel: 'Guide',
        htmlContent: html,
        rawText: '',
        isLight: state.theme === 'light'
      });
      return;
    }
    $('guideModalTitle').textContent = t('guideTitle');
    $('guideBody').innerHTML = html;
    $('guideBackdrop').hidden = false;
  }

  $('guideCloseBtn')?.addEventListener('click', () => {
    $('guideBackdrop').hidden = true;
  });
  $('guideOkBtn')?.addEventListener('click', () => {
    $('guideBackdrop').hidden = true;
  });
  $('guidePopoutBtn')?.addEventListener('click', () => {
    $('guideBackdrop').hidden = true;
    openGuideModal(true);
  });
  $('guideBackdrop')?.addEventListener('click', (e) => {
    if (e.target === $('guideBackdrop')) $('guideBackdrop').hidden = true;
  });

  // Initialize T3 Code Copilot (Ctrl+Alt+B Chat Window & Ctrl+I Inline Fix)
  copilot = window.StudioT3Copilot
    ? new window.StudioT3Copilot({
        getState: () => state,
        getActiveTab: () => activeTab(),
        getSelectedCode: () => {
          const tab = activeTab();
          if (!tab || tab.kind !== 'code') return '';
          const ed = state.editors[tab.groupIndex];
          const sel = ed?.getSelection();
          return sel && !sel.isEmpty() ? tab.model.getValueInRange(sel) : '';
        },
        applyCodeToEditor: (newCode) => {
          const tab = activeTab();
          if (!tab || tab.kind !== 'code' || !tab.model) return;
          const ed = state.editors[tab.groupIndex];
          const sel = ed?.getSelection();
          if (sel && !sel.isEmpty()) {
            ed.executeEdits('t3-copilot', [{ range: sel, text: newCode, forceMoveMarkers: true }]);
          } else {
            const pos = ed?.getPosition();
            if (pos) {
              const lineRange = new state.monaco.Range(pos.lineNumber, 1, pos.lineNumber, tab.model.getLineMaxColumn(pos.lineNumber));
              ed.executeEdits('t3-copilot', [{ range: lineRange, text: newCode, forceMoveMarkers: true }]);
            } else {
              tab.model.setValue(newCode);
            }
          }
          ed?.focus();
        },
        insertCodeAtCursor: (snippet) => {
          const ed = state.editors[state.focusedGroup];
          if (ed) insertTextAtCursor(ed, snippet);
        },
        runCodeInR: (rCode) => executeR(rCode, { label: 'T3 Code Copilot' }),
        showToast,
        openStandaloneWindow: (payload) =>
          window.studio?.openOutputWindow?.({
            ...payload,
            isLight: state.theme === 'light'
          })
      })
    : null;

  // --- Wire UI Buttons ---
  $('topSearchTrigger').addEventListener('click', () => palette.open(''));
  $('btnTopOpenFile')?.addEventListener('click', openFileAction);
  $('btnTopOpenFolder')?.addEventListener('click', openFolderAction);
  $('btnTopCopilot')?.addEventListener('click', (e) => {
    if (e.shiftKey) copilot?.popoutWindow();
    else copilot?.toggleWindow();
  });
  $('btnTopLang')?.addEventListener('click', () => handleStudioCommand('switch-language'));
  $('btnRun').addEventListener('click', () => handleStudioCommand('run-selection'));
  $('btnRunAll').addEventListener('click', () => handleStudioCommand('run-all'));
  $('btnInterrupt').addEventListener('click', () => handleStudioCommand('interrupt-r'));
  $('btnPreview').addEventListener('click', (e) => {
    if (e.shiftKey) $('btnPreviewPopout')?.click();
    else handleStudioCommand('toggle-preview');
  });
  $('btnKnit').addEventListener('click', () => handleStudioCommand('knit'));
  $('btnMathSheet')?.addEventListener('click', (e) => openMathCheatSheet(e.currentTarget));
  $('btnDocsCursor').addEventListener('click', openDocsForCursor);

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const active = document.activeElement;
    if (!isEditableTextInput(active)) return;
    e.preventDefault();
    e.stopPropagation();
    const a = active.selectionStart ?? 0;
    const b = active.selectionEnd ?? 0;
    const dir = active.selectionDirection || 'forward';
    const head = dir === 'backward' ? a : b;
    const anchor = dir === 'backward' ? b : a;
    let next = head;
    if (e.key === 'ArrowLeft') {
      const nl = head > 0 ? active.value.lastIndexOf('\n', head - 1) : -1;
      next = nl === -1 ? 0 : nl + 1;
    } else {
      const nl = active.value.indexOf('\n', head);
      next = nl === -1 ? active.value.length : nl;
    }
    if (e.shiftKey) {
      if (next < anchor) active.setSelectionRange(next, anchor, 'backward');
      else active.setSelectionRange(anchor, next, 'forward');
    } else {
      active.setSelectionRange(next, next, 'none');
    }
  }, true);

  document.addEventListener('contextmenu', (e) => {
    const target = e.target;
    if (!isEditableTextInput(target)) return;
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    const selText = end > start ? target.value.slice(start, end) : '';
    const hasSel = selText.trim().length > 0;
    if (e.shiftKey && hasSel && !/[\u3400-\u9FFF]/.test(selText)) {
      e.preventDefault();
      e.stopPropagation();
      adaptSelectionInTextInput(target, 'inline');
      return;
    }
    if (!hasSel && target.tagName !== 'TEXTAREA') return;
    e.preventDefault();
    e.stopPropagation();
    const items = [];
    if (hasSel) {
      items.push(
        { label: t('mathAdaptInline'), action: () => adaptSelectionInTextInput(target, 'inline') },
        { label: t('mathAdaptBlock'), action: () => adaptSelectionInTextInput(target, 'block') },
        { sep: true }
      );
    }
    items.push({ label: t('mathAdaptSheet'), action: () => openMathCheatSheet(target, target) });
    showContextMenu(e.clientX, e.clientY, items);
  });
  $('btnSplit')?.addEventListener('click', () => handleStudioCommand('toggle-split'));
  $('btnToggleExplorer').addEventListener('click', () => handleStudioCommand('toggle-explorer-sidebar'));
  $('btnToggleRcmdr').addEventListener('click', () => handleStudioCommand('toggle-rcmdr-sidebar'));
  $('btnTogglePanel').addEventListener('click', () => handleStudioCommand('toggle-panel'));

  // Activity Bar (when an item is in .needs-step state, clicking it navigates to the required prerequisite step and explains how to proceed!)
  $('actExplorer').addEventListener('click', () => handleStudioCommand('toggle-explorer-sidebar'));
  $('actRcmdr').addEventListener('click', () => handleStudioCommand('toggle-rcmdr-sidebar'));
  $('actPlots').addEventListener('click', (e) => {
    if (e.shiftKey && state.plots.length) {
      popoutPanelSection('plots');
      return;
    }
    openPanelTab('plots');
    if (!state.plots.length) {
      const isEs = getLang() === 'es';
      expandRcmdrCategory('Graphs');
      const tab = activeTab();
      if (tab && tab.kind === 'code') state.editors[tab.groupIndex]?.focus();
      showToast(
        isEs
          ? 'Paso requerido para Gráficas: Ejecuta un script con plot()/ggplot() (Ctrl+Intro) o elige una gráfica en el menú Gráficas abierto a la derecha.'
          : 'Prerequisite for Plots: Run a script with plot()/ggplot() (Ctrl+Enter) or pick a chart from the Graphs menu opened on the right.'
      );
    }
  });
  $('actHelp').addEventListener('click', (e) => {
    if (e.shiftKey && state.lastHelpTopic) {
      popoutPanelSection('help');
      return;
    }
    const tab = activeTab();
    const ed = tab && tab.kind === 'code' ? state.editors[tab.groupIndex] : null;
    const pos = ed?.getPosition();
    const word = pos && tab?.model ? tab.model.getWordAtPosition(pos) : null;
    if (word?.word) {
      openRDocs(word.word);
      return;
    }
    openPanelTab('help');
    $('helpSearchInput')?.focus();
    if (!state.lastHelpTopic) {
      const isEs = getLang() === 'es';
      showToast(
        isEs
          ? 'Paso requerido para Manual: Escribe una función de R en el buscador de Ayuda (ahora enfocado) o sitúa el cursor sobre una función en el editor y pulsa F1.'
          : 'Prerequisite for Manual: Type an R function in the focused Help search box, or place the cursor on a function in the editor and press F1.'
      );
    }
  });
  $('actCopilot')?.addEventListener('click', (e) => {
    if (e.shiftKey) {
      copilot?.popoutWindow();
      return;
    }
    copilot?.toggleWindow();
    if (copilot?.windowOpen && !copilot?.status?.t3Running) {
      const isEs = getLang() === 'es';
      document.querySelector('.t3-status-bar')?.classList.add('needs-action');
      showToast(
        isEs
          ? 'Paso requerido para T3 Code: Pulsa "Instalar T3 Code" (o "Iniciar T3 Code") en la cabecera del panel, o usa directamente /fix, /explain, /plot, /rmd.'
          : 'Prerequisite for T3 Code: Click "Install T3 Code" (or "Start T3 Code") at the top of the panel, or use /fix, /explain, /plot, /rmd directly.'
      );
    }
  });
  $('actGuide')?.addEventListener('click', (e) => openGuideModal(Boolean(e.shiftKey)));
  $('actTheme').addEventListener('click', () => handleStudioCommand('toggle-theme'));
  $('actSettings').addEventListener('click', () => settingsModal.open());
  $('btnTopSettings')?.addEventListener('click', () => settingsModal.open());
  $('btnWrap0')?.addEventListener('click', () => {
    state.settings.editorWordWrap = state.settings.editorWordWrap === false;
    saveSettings(state.settings);
    applySettingsUI();
  });

  // Independent Ctrl + Scrollwheel zoom per pane (Console, arf, Plots, Editor) + Ctrl + Shift + Scrollwheel for full UI
  let consoleFontSize = Math.max(9, Math.min(24, Number(localStorage.getItem('rcs-console-font-size')) || 12.5));
  let arfFontSize = Math.max(9, Math.min(24, Number(localStorage.getItem('rcs-arf-font-size')) || 12.5));
  if ($('consoleOut')) $('consoleOut').style.fontSize = `${consoleFontSize}px`;

  window.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.deltaY === 0) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 1 : -1;
      if (e.shiftKey) {
        applyZoomStep('ui', step);
        return;
      }
      const target = e.target;
      if (target?.closest?.('#dockPlots')) {
        state.plotZoom = Math.max(0.25, Math.min(4, Number((state.plotZoom + step * 0.12).toFixed(2))));
        renderPlotPane();
        return;
      }
      if (target?.closest?.('#dockConsole')) {
        consoleFontSize = Math.max(9, Math.min(24, Number((consoleFontSize + step * 0.8).toFixed(1))));
        localStorage.setItem('rcs-console-font-size', String(consoleFontSize));
        if ($('consoleOut')) $('consoleOut').style.fontSize = `${consoleFontSize}px`;
        return;
      }
      if (target?.closest?.('#dockArf')) {
        arfFontSize = Math.max(9, Math.min(24, Number((arfFontSize + step * 0.8).toFixed(1))));
        localStorage.setItem('rcs-arf-font-size', String(arfFontSize));
        if (arfTerm) {
          arfTerm.options.fontSize = arfFontSize;
          fitArfXterm();
        }
        return;
      }
      applyZoomStep('editor', step);
    },
    { passive: false, capture: true }
  );

  // Draggable vertical splitter between left and right Bottom Dock panes (e.g. arf vs Plots)
  const panelSplitGrip = $('panelSplitGrip');
  if (panelSplitGrip) {
    panelSplitGrip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      panelSplitGrip.classList.add('dragging');
      const body = $('panelBody');
      const pCol = $('panelPrimaryCol');
      const sCol = $('panelSecondaryCol');
      if (!body || !pCol || !sCol) return;
      const bodyRect = body.getBoundingClientRect();
      const onMove = (ev) => {
        const rel = (ev.clientX - bodyRect.left) / Math.max(1, bodyRect.width);
        const ratio = Math.max(0.18, Math.min(0.82, rel));
        pCol.style.flex = `0 0 ${(ratio * 100).toFixed(2)}%`;
        sCol.style.flex = '1 1 auto';
        localStorage.setItem('rcs-panel-split-ratio', ratio.toFixed(4));
        syncSplitHeaderWidth();
        fitArfXterm();
      };
      const onUp = () => {
        panelSplitGrip.classList.remove('dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // Split Bottom Dock controls & Drag-and-Drop tabs between sides (Editor Tabs & Dock Tabs)
  let draggingEditorTabId = null;

  for (const grpIdx of [0, 1]) {
    const grpEl = $(`editorGroup${grpIdx}`);
    if (!grpEl) continue;
    grpEl.addEventListener('dragover', (e) => {
      if (draggingEditorTabId == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (grpIdx === 0 && !state.splitOpen) {
        const rect = grpEl.getBoundingClientRect();
        const isRightEdge = e.clientX > rect.left + rect.width * 0.62;
        grpEl.classList.toggle('tab-drop-right', isRightEdge);
        grpEl.classList.toggle('tab-drop-highlight', !isRightEdge);
      } else {
        grpEl.classList.add('tab-drop-highlight');
      }
    });
    grpEl.addEventListener('dragleave', (e) => {
      if (!grpEl.contains(e.relatedTarget)) {
        grpEl.classList.remove('tab-drop-left', 'tab-drop-right', 'tab-drop-highlight');
      }
    });
    grpEl.addEventListener('drop', (e) => {
      if (draggingEditorTabId == null) return;
      e.preventDefault();
      e.stopPropagation();
      const tabId = draggingEditorTabId;
      draggingEditorTabId = null;
      const rect = grpEl.getBoundingClientRect();
      const dropRightSplit = grpIdx === 0 && !state.splitOpen && e.clientX > rect.left + rect.width * 0.62;
      grpEl.classList.remove('tab-drop-left', 'tab-drop-right', 'tab-drop-highlight');
      moveTabToGroup(tabId, dropRightSplit ? 1 : grpIdx);
    });
  }

  $('btnPanelSplit')?.addEventListener('click', () => {
    if (splitPanelTab) {
      setSplitPanelTab(null);
    } else {
      const companion = state.activePanelTab === 'plots' ? 'arf' : 'plots';
      setSplitPanelTab(companion);
    }
  });
  $('panelSplitSelect')?.addEventListener('change', (e) => {
    setSplitPanelTab(e.target.value);
  });
  $('btnPanelSplitClose')?.addEventListener('click', () => {
    setSplitPanelTab(null);
  });

  // Quick bottom-bar toggles: max.print entries, skip ?, fixed notation
  $('panelMaxPrintInput')?.addEventListener('change', (e) => {
    const val = Math.max(1, Math.min(1000000, parseInt(e.target.value, 10) || 24));
    state.settings.maxOutputItems = val;
    saveSettings(state.settings);
    applySettingsUI();
  });
  $('btnPanelSkipHelp')?.addEventListener('click', () => {
    state.settings.skipHelp = !state.settings.skipHelp;
    saveSettings(state.settings);
    applySettingsUI();
  });
  $('btnPanelFixedNotation')?.addEventListener('click', () => {
    state.settings.fixedNotation = !state.settings.fixedNotation;
    saveSettings(state.settings);
    applySettingsUI();
  });

  $('workspaceContent')?.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.ws-item-row')) return;
    e.preventDefault();
    const isEs = getLang() === 'es';
    showContextMenu(e.clientX, e.clientY, [
      { icon: 'refresh', label: isEs ? 'Actualizar entorno' : 'Refresh Environment', action: () => $('btnRefreshWs')?.click() },
      { icon: 'folder-open', label: isEs ? 'Cargar .RData / datos...' : 'Load .RData / Data...', action: () => $('btnWsLoadRData')?.click() },
      { icon: 'save', label: isEs ? 'Guardar entorno como...' : 'Save Environment As...', action: () => $('btnWsSaveRData')?.click() },
      { sep: true },
      {
        icon: 'clear',
        label: isEs ? 'Limpiar todo el entorno (rm)...' : 'Clear All Environment (rm)...',
        action: async () => {
          const msg = isEs
            ? '¿Eliminar TODOS los objetos del entorno de R? (rm(list = ls()))'
            : 'Remove ALL objects from the R Environment? (rm(list = ls()))';
          if (!window.confirm(msg)) return;
          await executeR('rm(list = ls(envir = .GlobalEnv), envir = .GlobalEnv)', { label: 'rm(list = ls())', fromMenu: true });
        }
      }
    ]);
  });

  $('fileGroupsList')?.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.fg-item')) return;
    e.preventDefault();
    const isEs = getLang() === 'es';
    showContextMenu(e.clientX, e.clientY, [
      { icon: 'new-file', label: isEs ? 'Nuevo script R' : 'New R Script', action: () => handleStudioCommand('new-r') },
      { icon: 'markdown', label: isEs ? 'Nuevo R Markdown (.Rmd)' : 'New R Markdown (.Rmd)', action: () => handleStudioCommand('new-rmd') },
      { icon: 'file', label: isEs ? 'Abrir archivo...' : 'Open File...', action: () => openFileAction() },
      { sep: true },
      { icon: 'group', label: isEs ? 'Nuevo grupo de archivos...' : 'New File Group...', action: () => $('btnNewFileGroup')?.click() }
    ]);
  });

  // Right-click context menus: File Explorer background, Console, arf, Plots, Editor Tabs
  $('folderTree')?.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.fs-row')) return;
    e.preventDefault();
    const isEs = getLang() === 'es';
    showContextMenu(e.clientX, e.clientY, [
      {
        icon: 'new-file',
        label: isEs ? 'Nuevo archivo...' : 'New File...',
        action: async () => {
          if (!state.workspaceRoot) return openFolderAction();
          const name = window.prompt(t('newFilePrompt'), 'script.R');
          if (!name || !name.trim()) return;
          const res = await window.studio.createFile({ dir: state.workspaceRoot, name: name.trim(), content: '' });
          if (res?.ok && res.filePath) await openPathSmart(res.filePath);
          await refreshFolderTree();
        }
      },
      {
        icon: 'new-folder',
        label: isEs ? 'Nueva carpeta...' : 'New Folder...',
        action: async () => {
          if (!state.workspaceRoot) return openFolderAction();
          const name = window.prompt(t('newFolderPrompt'), 'data');
          if (!name || !name.trim()) return;
          await window.studio.createDir({ dir: state.workspaceRoot, name: name.trim() });
          await refreshFolderTree();
        }
      },
      { sep: true },
      { icon: 'file', label: isEs ? 'Abrir archivo...' : 'Open File...', action: () => openFileAction() },
      { icon: 'folder-open', label: isEs ? 'Abrir carpeta...' : 'Open Folder...', action: () => openFolderAction() },
      { icon: 'refresh', label: isEs ? 'Actualizar árbol' : 'Refresh Tree', action: () => refreshFolderTree() }
    ]);
  });

  const bindTerminalContextMenu = (outEl, inputEl, isArf) => {
    const handler = (e) => {
      e.preventDefault();
      const isEs = getLang() === 'es';
      const sel = window.getSelection()?.toString() || '';
      const hasSel = Boolean(sel.trim());
      showContextMenu(e.clientX, e.clientY, [
        {
          icon: 'copy',
          label: hasSel ? (isEs ? 'Copiar selección' : 'Copy Selection') : isEs ? 'Copiar todo' : 'Copy All',
          action: async () => {
            await navigator.clipboard.writeText(hasSel ? sel : outEl.innerText || '');
            showToast(t('outCopiedToast'));
          }
        },
        {
          icon: 'paste-doc',
          label: isEs ? 'Pegar en línea de entrada' : 'Paste into Input',
          action: async () => {
            const clip = await navigator.clipboard.readText().catch(() => '');
            if (clip && inputEl) {
              inputEl.value = `${inputEl.value}${clip}`;
              inputEl.focus();
            }
          }
        },
        ...(hasSel
          ? [
              {
                icon: 'edit',
                label: isEs ? 'Insertar selección en editor' : 'Insert Selection in Editor',
                action: () => {
                  const ed = state.editors[state.focusedGroup];
                  if (ed) insertTextAtCursor(ed, sel);
                }
              }
            ]
          : []),
        { sep: true },
        {
          icon: 'clear',
          label: isEs ? 'Limpiar consola' : 'Clear Console',
          action: () => {
            outEl.textContent = '';
          }
        },
        {
          icon: 'restart',
          label: isArf ? (isEs ? 'Reiniciar arf' : 'Restart arf') : isEs ? 'Reiniciar sesión R' : 'Restart R Session',
          action: () => (isArf ? window.studio.arfRestart() : handleStudioCommand('restart-r'))
        }
      ]);
    };
    outEl?.addEventListener('contextmenu', handler);
    inputEl?.addEventListener('contextmenu', handler);
  };
  bindTerminalContextMenu($('consoleOut'), $('consoleInput'), false);
  bindTerminalContextMenu($('arfOut'), $('arfInput'), true);

  $('plotsCanvas')?.addEventListener('pointerdown', (e) => {
    // Middle-click (wheel click, button === 1) drag to pan the zoomed plot
    if (e.button !== 1) return;
    const canvas = $('plotsCanvas');
    if (!canvas) return;
    e.preventDefault();
    canvas.classList.add('panning');
    const startX = e.clientX;
    const startY = e.clientY;
    const startSL = canvas.scrollLeft;
    const startST = canvas.scrollTop;
    const onMove = (ev) => {
      canvas.scrollLeft = startSL - (ev.clientX - startX);
      canvas.scrollTop = startST - (ev.clientY - startY);
    };
    const onUp = () => {
      canvas.classList.remove('panning');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  $('plotsCanvas')?.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });

  $('plotsCanvas')?.addEventListener('contextmenu', (e) => {
    if (!state.plots.length) return;
    e.preventDefault();
    const isEs = getLang() === 'es';
    showContextMenu(e.clientX, e.clientY, [
      { icon: 'copy', label: isEs ? 'Copiar gráfica (PNG)' : 'Copy Plot (PNG)', action: () => $('btnPlotCopyPng')?.click() },
      { icon: 'download', label: isEs ? 'Guardar como SVG...' : 'Save as SVG...', action: () => $('btnPlotSaveSvg')?.click() },
      { icon: 'download', label: isEs ? 'Exportar PNG (2x)...' : 'Export PNG (2x)...', action: () => $('btnPlotSavePng')?.click() },
      { icon: 'download', label: isEs ? 'Exportar PDF...' : 'Export PDF...', action: () => $('btnPlotSavePdf')?.click() },
      { sep: true },
      { icon: 'new-window', label: isEs ? 'Abrir en ventana nueva' : 'Open in New Window', action: () => $('btnPlotPopout')?.click() },
      { icon: 'clear', label: isEs ? 'Limpiar gráficas' : 'Clear Plots', action: () => $('btnPlotClear')?.click() }
    ]);
  });

  for (const barId of ['tabBar0', 'tabBar1']) {
    $(barId)?.addEventListener('contextmenu', (e) => {
      const itemEl = e.target.closest('.tab-item');
      if (!itemEl) return;
      e.preventDefault();
      const idx = Array.from(itemEl.parentElement.children).indexOf(itemEl);
      const groupIdx = barId === 'tabBar1' ? 1 : 0;
      const groupTabs = state.tabs.filter((x) => x.groupIndex === groupIdx);
      const tab = groupTabs[idx];
      if (!tab) return;
      const isEs = getLang() === 'es';
      showContextMenu(e.clientX, e.clientY, [
        {
          icon: 'edit',
          label: isEs ? 'Renombrar' : 'Rename',
          action: () => {
            const ns = itemEl.querySelector('.tab-name');
            if (ns) startInlineTabRename(tab, ns);
            else {
              const next = window.prompt(t('renamePrompt'), tab.name);
              if (next) applyTabRename(tab, next);
            }
          }
        },
        { icon: 'close', label: isEs ? 'Cerrar pestaña' : 'Close Tab', action: () => closeTab(tab.id) },
        {
          icon: 'close',
          label: isEs ? 'Cerrar otras pestañas' : 'Close Other Tabs',
          action: () => {
            for (const other of groupTabs) {
              if (other.id !== tab.id) closeTab(other.id);
            }
          }
        },
        { sep: true },
        { icon: 'save', label: isEs ? 'Guardar como...' : 'Save As...', action: () => { activateTab(tab.id); saveFileAction(true); } },
        ...(tab.filePath
          ? [{ icon: 'copy', label: isEs ? 'Copiar ruta' : 'Copy Path', action: () => navigator.clipboard.writeText(tab.filePath) }]
          : []),
        { icon: 'new-window', label: isEs ? 'Abrir en ventana nueva' : 'Open in New Window', action: () => popoutTabWindow(tab) }
      ]);
    });
  }

  renderDockPanes();

  // Sidebar header dock/close actions
  $('btnFlipExplorer').addEventListener('click', (e) => {
    e.stopPropagation();
    clearTimeout(peekOpenTimer);
    clearTimeout(peekCloseTimer);
    state.layout.closePeek('explorer');
    state.layout.flipSidebarDock('explorer');
    applyWorkbenchLayout();
  });
  $('btnCloseExplorer').addEventListener('click', (e) => {
    e.stopPropagation();
    clearTimeout(peekOpenTimer);
    clearTimeout(peekCloseTimer);
    state.layout.closePeek('explorer');
    state.layout.setSidebarOpen('explorer', false);
    applyWorkbenchLayout();
  });
  $('btnFlipRcmdr').addEventListener('click', (e) => {
    e.stopPropagation();
    clearTimeout(peekOpenTimer);
    clearTimeout(peekCloseTimer);
    state.layout.closePeek('rcmdr');
    state.layout.flipSidebarDock('rcmdr');
    applyWorkbenchLayout();
  });
  $('btnCloseRcmdr').addEventListener('click', (e) => {
    e.stopPropagation();
    clearTimeout(peekOpenTimer);
    clearTimeout(peekCloseTimer);
    state.layout.closePeek('rcmdr');
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
  $('btnPreviewModeFull')?.addEventListener('click', () => openPreview('full'));
  $('btnPreviewModeKnit').addEventListener('click', () => openPreview('knit'));
  $('btnPreviewOutline')?.addEventListener('click', () => {
    const bar = $('previewOutlineBar');
    if (bar && bar.children.length) bar.hidden = !bar.hidden;
  });
  $('btnPreviewPopout')?.addEventListener('click', async () => {
    const tab = activeTab();
    if (!tab || !window.studio?.openOutputWindow) return;
    await window.studio.openOutputWindow({
      title: `${tab.name} — Markdown Viewer`,
      sourceLabel: 'Markdown Viewer',
      htmlContent: $('previewBody').innerHTML,
      rawText: tab.model?.getValue() || '',
      isLight: state.theme === 'light'
    });
  });
  $('docPickerClose')?.addEventListener('click', () => {
    $('docPickerBackdrop').hidden = true;
  });
  $('docPickerBackdrop')?.addEventListener('click', (e) => {
    if (e.target === $('docPickerBackdrop')) $('docPickerBackdrop').hidden = true;
  });

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
  $('btnExplorerOpenFile')?.addEventListener('click', openFileAction);
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

  // R Commander Search, Header Toggles & Package Installer
  $('rcmdrSearch').addEventListener('input', renderRcmdrTree);
  $('btnRcmdrFocusSearch').addEventListener('click', () => $('rcmdrSearch').focus());
  $('btnRcmdrInstallPkg')?.addEventListener('click', () => triggerRcmdrCommand('installPackages'));
  $('btnRcmdrAutoClose')?.addEventListener('click', () => {
    state.settings.closeMenusAfterChoice = !state.settings.closeMenusAfterChoice;
    saveSettings(state.settings);
    applySettingsUI();
    showToast(`${t('rcmdrCloseMenusToggle')}: ${state.settings.closeMenusAfterChoice ? 'ON' : 'OFF'}`);
  });
  $('btnRcmdrMenuAction')?.addEventListener('click', () => {
    const order = ['both', 'run', 'insert'];
    const cur = state.settings.menuAction || 'both';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    state.settings.menuAction = next;
    saveSettings(state.settings);
    applySettingsUI();
    const labelMap = {
      both: t('settingsMenuActionBoth'),
      run: t('settingsMenuActionRun'),
      insert: t('settingsMenuActionInsert')
    };
    showToast(labelMap[next] || next);
  });
  $('btnRcmdrClear').addEventListener('click', () => {
    $('rcmdrSearch').value = '';
    renderRcmdrTree();
  });
  $('btnRcmdrCollapse').addEventListener('click', () => {
    $('rcmdrSearch').value = '';
    renderRcmdrTree();
  });

  // Panel tabs & header controls (Shift+Click pops out any panel tab into a separate window!)
  for (const btn of document.querySelectorAll('.panel-tab')) {
    btn.addEventListener('click', (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        popoutPanelSection(btn.dataset.dock);
        return;
      }
      openPanelTab(btn.dataset.dock);
    });
  }
  $('btnProblemsToggleErrors')?.addEventListener('click', () => {
    state.settings.showProblemErrors = state.settings.showProblemErrors === false;
    saveSettings(state.settings);
    applySettingsUI();
  });
  $('btnProblemsToggleWarnings')?.addEventListener('click', () => {
    state.settings.showProblemWarnings = state.settings.showProblemWarnings === false;
    saveSettings(state.settings);
    applySettingsUI();
  });
  $('btnProblemsToggleStyle')?.addEventListener('click', () => {
    state.settings.showStyleLints = state.settings.showStyleLints !== true;
    saveSettings(state.settings);
    applySettingsUI();
  });
  $('btnProblemsUnmuteAll')?.addEventListener('click', () => {
    state.settings.mutedWarnings = [];
    saveSettings(state.settings);
    applySettingsUI();
  });
  $('btnPanelMaximize')?.addEventListener('click', () => {
    state.panelMaximized = !state.panelMaximized;
    applyWorkbenchLayout();
  });
  $('btnPlotPopout')?.addEventListener('click', popoutCurrentPlot);
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

  // Help search input + live autocomplete
  const helpInput = $('helpSearchInput');
  helpInput.addEventListener('input', () => scheduleHelpSuggest(helpInput.value));
  helpInput.addEventListener('focus', () => {
    if (helpInput.value.trim()) scheduleHelpSuggest(helpInput.value);
  });
  helpInput.addEventListener('blur', () => {
    setTimeout(hideHelpSuggest, 120);
  });
  helpInput.addEventListener('keydown', (e) => {
    const dd = $('helpSuggestDropdown');
    const open = dd && !dd.hidden && helpSuggestItems.length > 0;
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      setHelpSuggestActive(helpSuggestIndex + 1);
      return;
    }
    if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      setHelpSuggestActive(helpSuggestIndex <= 0 ? helpSuggestItems.length - 1 : helpSuggestIndex - 1);
      return;
    }
    if (e.key === 'Tab' && open) {
      const picked = helpSuggestItems[helpSuggestIndex >= 0 ? helpSuggestIndex : 0];
      if (picked && picked.kind !== 'rcmdr') {
        e.preventDefault();
        helpInput.value = picked.topic;
        scheduleHelpSuggest(picked.topic);
      }
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      hideHelpSuggest();
      return;
    }
    if (e.key === 'Enter') {
      if (open && helpSuggestIndex >= 0 && helpSuggestItems[helpSuggestIndex]) {
        e.preventDefault();
        selectHelpSuggestItem(helpSuggestItems[helpSuggestIndex]);
      } else {
        hideHelpSuggest();
        openRDocs(helpInput.value);
      }
    }
  });
  $('btnHelpGo').addEventListener('click', () => {
    hideHelpSuggest();
    openRDocs(helpInput.value);
  });

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

  // First launch: open the Setup Wizard once the workbench is fully rendered.
  if (!isSetupComplete()) {
    window.studio?.buildInfo?.().then((b) => { state.appVersion = b?.version || ''; }).catch(() => {});
    setupWizard.open();
  }
})();
