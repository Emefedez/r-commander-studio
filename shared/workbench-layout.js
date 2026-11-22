(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StudioWorkbenchLayout = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VALID_SIDES = new Set(['left', 'right']);
  const VALID_PANEL_DOCKS = new Set(['bottom', 'left', 'right']);
  const VALID_ORIENTS = new Set(['horizontal', 'vertical']);

  class WorkbenchLayoutModel {
    constructor(initial) {
      this.sidebars = {
        explorer: { open: true, dock: 'left', width: 268 },
        rcmdr: { open: true, dock: 'right', width: 278 }
      };
      this.panel = {
        open: true,
        dock: 'bottom',
        orientation: 'horizontal',
        size: 240
      };
      this.sidebarOrder = ['explorer', 'rcmdr']; // left-to-right order within a shared dock
      this.peekingSidebar = null; // transient hover-peek sidebar id ('explorer' | 'rcmdr' | null)
      if (initial) this.load(initial);
    }

    load(data) {
      if (!data || typeof data !== 'object') return;
      if (data.sidebars && typeof data.sidebars === 'object') {
        for (const id of ['explorer', 'rcmdr']) {
          const src = data.sidebars[id];
          if (!src || typeof src !== 'object') continue;
          if (typeof src.open === 'boolean') this.sidebars[id].open = src.open;
          if (VALID_SIDES.has(src.dock)) this.sidebars[id].dock = src.dock;
          if (Number.isFinite(Number(src.width))) {
            this.sidebars[id].width = Math.max(190, Math.min(480, Number(src.width)));
          }
        }
      }
      if (Array.isArray(data.sidebarOrder)) {
        const ord = data.sidebarOrder.filter((id) => id === 'explorer' || id === 'rcmdr');
        if (ord.length === 2 && ord[0] !== ord[1]) this.sidebarOrder = ord;
      }
      if (data.panel && typeof data.panel === 'object') {
        const p = data.panel;
        if (typeof p.open === 'boolean') this.panel.open = p.open;
        if (VALID_PANEL_DOCKS.has(p.dock)) this.panel.dock = p.dock;
        if (VALID_ORIENTS.has(p.orientation)) this.panel.orientation = p.orientation;
        if (Number.isFinite(Number(p.size))) {
          this.panel.size = Math.max(120, Math.min(700, Number(p.size)));
        }
      }
    }

    serialize() {
      return {
        sidebars: {
          explorer: { ...this.sidebars.explorer },
          rcmdr: { ...this.sidebars.rcmdr }
        },
        sidebarOrder: [...this.sidebarOrder],
        panel: { ...this.panel }
      };
    }

    toggleSidebar(id) {
      if (!this.sidebars[id]) return false;
      this.sidebars[id].open = !this.sidebars[id].open;
      return this.sidebars[id].open;
    }

    setSidebarOpen(id, open) {
      if (!this.sidebars[id]) return false;
      this.sidebars[id].open = Boolean(open);
      if (this.peekingSidebar === id) this.peekingSidebar = null;
      return this.sidebars[id].open;
    }

    setSidebarDock(id, side) {
      if (!this.sidebars[id] || !VALID_SIDES.has(side)) return false;
      this.sidebars[id].dock = side;
      this.sidebars[id].open = true;
      return true;
    }

    /**
     * Dock a sidebar on `side`, placed just before `beforeId` (another sidebar
     * id) or at the end of that dock when `beforeId` is null. 'start' puts it
     * first on that side.
     */
    placeSidebar(id, side, beforeId = null) {
      if (!this.setSidebarDock(id, side)) return false;
      const rest = this.sidebarOrder.filter((x) => x !== id);
      let idx;
      if (beforeId === 'start') idx = 0;
      else if (beforeId && rest.includes(beforeId)) idx = rest.indexOf(beforeId);
      else idx = rest.length;
      rest.splice(idx, 0, id);
      this.sidebarOrder = rest;
      return true;
    }

    flipSidebarDock(id) {
      if (!this.sidebars[id]) return null;
      const next = this.sidebars[id].dock === 'left' ? 'right' : 'left';
      this.setSidebarDock(id, next);
      return next;
    }

    applyPreset(preset) {
      switch (preset) {
        case 'both-left':
          this.sidebars.explorer.dock = 'left';
          this.sidebars.rcmdr.dock = 'left';
          this.sidebars.explorer.open = true;
          this.sidebars.rcmdr.open = true;
          return true;
        case 'both-right':
          this.sidebars.explorer.dock = 'right';
          this.sidebars.rcmdr.dock = 'right';
          this.sidebars.explorer.open = true;
          this.sidebars.rcmdr.open = true;
          return true;
        case 'explorer-left-rcmdr-right':
          this.sidebars.explorer.dock = 'left';
          this.sidebars.rcmdr.dock = 'right';
          this.sidebars.explorer.open = true;
          this.sidebars.rcmdr.open = true;
          return true;
        case 'rcmdr-left-explorer-right':
          this.sidebars.rcmdr.dock = 'left';
          this.sidebars.explorer.dock = 'right';
          this.sidebars.explorer.open = true;
          this.sidebars.rcmdr.open = true;
          return true;
        default:
          return false;
      }
    }

    getSidebarsOn(side) {
      return this.sidebarOrder.filter(
        (id) => this.sidebars[id].dock === side && this.sidebars[id].open
      );
    }

    togglePanel() {
      this.panel.open = !this.panel.open;
      return this.panel.open;
    }

    setPanelOpen(open) {
      this.panel.open = Boolean(open);
      return this.panel.open;
    }

    setPanelDock(dock) {
      if (!VALID_PANEL_DOCKS.has(dock)) return false;
      this.panel.dock = dock;
      this.panel.open = true;
      this.panel.orientation = dock === 'bottom' ? 'horizontal' : 'vertical';
      return true;
    }

    setPanelOrientation(orientation) {
      if (!VALID_ORIENTS.has(orientation)) return false;
      this.panel.orientation = orientation;
      return true;
    }

    togglePanelOrientation() {
      this.panel.orientation = this.panel.orientation === 'horizontal' ? 'vertical' : 'horizontal';
      return this.panel.orientation;
    }

    openPeek(id) {
      if (!this.sidebars[id] || this.sidebars[id].open) return false;
      this.peekingSidebar = id;
      return true;
    }

    closePeek(id = null) {
      if (!id || this.peekingSidebar === id) {
        const had = Boolean(this.peekingSidebar);
        this.peekingSidebar = null;
        return had;
      }
      return false;
    }

    isPeeking(id) {
      return this.peekingSidebar === id && Boolean(this.sidebars[id]) && !this.sidebars[id].open;
    }

    onSelectionInSidebar(id) {
      if (this.peekingSidebar === id) {
        this.peekingSidebar = null;
        return true;
      }
      return false;
    }
  }

  return { WorkbenchLayoutModel };
});
