(function () {
  'use strict';

  function applyPressureCurve(width, curve, p) {
    const pressure = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0.5));
    let w = width;
    switch (curve) {
      case 'linear':
        w = width * 2 * pressure;
        break;
      case 'pow2':
        w = width * 4 * pressure * pressure;
        break;
      case 'sqrt':
        w = width * Math.sqrt(2 * pressure);
        break;
      case 'cubic':
        w = width * 8 * pressure * pressure * pressure;
        break;
      case 'cbrt':
        w = width * Math.cbrt(2 * pressure);
        break;
      case 'const':
      default:
        w = width;
        break;
    }
    return Math.max(0.5, w);
  }

  function applyLineDash(ctx, lineStyle, width) {
    if (lineStyle === 'dashed') ctx.setLineDash([width * 3, width * 2]);
    else if (lineStyle === 'dotted') ctx.setLineDash([width, width * 1.5]);
    else if (lineStyle === 'dashdot') ctx.setLineDash([width * 3, width * 1.5, width, width * 1.5]);
    else ctx.setLineDash([]);
  }

  class StudioRnoteViewer {
    constructor(hostEl, { onToast } = {}) {
      this.host = hostEl;
      this.onToast = onToast || (() => {});
      this.tab = null;
      this._canvas = null;
      this._stage = null;
      this._zoomLabel = null;
      this._statsLabel = null;
      this._statusEl = null;
      this._raf = 0;
      this._ro = null;
      this._dragging = false;
      this._dragStart = null;
    }

    mount(tab) {
      this.tab = tab;
      if (!tab.rnoteState) {
        tab.rnoteState = {
          loading: false,
          error: null,
          doc: null,
          images: new Map(),
          zoom: 1,
          panX: 0,
          panY: 0,
          initializedView: false
        };
      }
      this._buildDom();
      const st = tab.rnoteState;
      if (!st.doc && !st.loading && !st.error && tab.filePath) {
        this._loadFromDisk(tab);
      } else {
        this._syncUi();
        this._scheduleDraw();
      }
    }

    render() {
      if (!this.tab) return;
      this._buildDom();
      this._syncUi();
      this._scheduleDraw();
    }

    async reload() {
      if (!this.tab?.filePath) return;
      await this._loadFromDisk(this.tab, true);
    }

    async exportPng() {
      if (!this._canvas || !this.tab?.rnoteState?.doc) return;
      const { t } = window.StudioI18n;
      const dataUrl = this._canvas.toDataURL('image/png');
      const stem = (this.tab.name || 'note').replace(/\.rnote$/i, '');
      const res = await window.studio?.savePlotPng?.({ dataUrl, defaultName: `${stem}.png` });
      if (res?.ok) {
        this.onToast(t('rnoteExportedPng', res.name || `${stem}.png`));
      }
    }

    _buildDom() {
      const { t } = window.StudioI18n;
      const { svg } = window.StudioIcons;
      if (this._ro) {
        this._ro.disconnect();
        this._ro = null;
      }

      this.host.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'rnote-wrap';

      const bar = document.createElement('div');
      bar.className = 'rnote-bar';

      const title = document.createElement('span');
      title.className = 'rnote-title';
      title.textContent = this.tab?.name || 'Rnote';

      const badge = document.createElement('span');
      badge.className = 'rnote-badge';
      badge.textContent = 'RNOTE';

      const stats = document.createElement('span');
      stats.className = 'rnote-stats';
      this._statsLabel = stats;

      const spacer = document.createElement('span');
      spacer.className = 'spacer';

      const mkBtn = (icon, titleKey, onClick, textLabel = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = textLabel ? 'rnote-btn rnote-btn-text' : 'icon-btn';
        b.title = t(titleKey);
        b.innerHTML = icon ? `${svg(icon, { size: 14 })}${textLabel ? `<span>${textLabel}</span>` : ''}` : textLabel;
        b.addEventListener('click', onClick);
        return b;
      };

      const btnZoomOut = mkBtn('zoom-out', 'rnoteZoomOut', () => this._zoomBy(1 / 1.25));
      const zoomLbl = document.createElement('button');
      zoomLbl.type = 'button';
      zoomLbl.className = 'rnote-zoom-pill';
      zoomLbl.title = t('rnoteZoomReset');
      zoomLbl.textContent = '100%';
      zoomLbl.addEventListener('click', () => this._setZoom(1));
      this._zoomLabel = zoomLbl;

      const btnZoomIn = mkBtn('zoom-in', 'rnoteZoomIn', () => this._zoomBy(1.25));
      const btnFitW = mkBtn('', 'rnoteFitWidth', () => this.fitToWidth(), t('rnoteFitWidth'));
      const btnFitAll = mkBtn('', 'rnoteFitAll', () => this.fitAll(), t('rnoteFitAll'));
      const btnReload = mkBtn('refresh', 'rnoteReload', () => this.reload());
      const btnExport = mkBtn('download', 'rnoteExportPng', () => this.exportPng());

      bar.append(title, badge, stats, spacer, btnZoomOut, zoomLbl, btnZoomIn, btnFitW, btnFitAll, btnReload, btnExport);

      const stage = document.createElement('div');
      stage.className = 'rnote-stage';
      stage.tabIndex = 0;
      this._stage = stage;

      const canvas = document.createElement('canvas');
      canvas.className = 'rnote-canvas';
      this._canvas = canvas;

      const status = document.createElement('div');
      status.className = 'rnote-status';
      status.hidden = true;
      this._statusEl = status;

      stage.append(canvas, status);
      wrap.append(bar, stage);
      this.host.append(wrap);

      this._wireInteractions(stage);

      this._ro = new ResizeObserver(() => {
        this._resizeCanvas();
        const st = this.tab?.rnoteState;
        if (st?.doc && !st.initializedView && stage.clientWidth > 0 && stage.clientHeight > 0) {
          this.fitToWidth();
        } else {
          this._scheduleDraw();
        }
      });
      this._ro.observe(stage);
      this._resizeCanvas();
    }

    _wireInteractions(stage) {
      stage.addEventListener('wheel', (e) => {
        const st = this.tab?.rnoteState;
        if (!st?.doc) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const rect = stage.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;
          const factor = Math.exp(-e.deltaY * 0.0022);
          this._zoomAt(cx, cy, st.zoom * factor);
        } else if (e.shiftKey) {
          st.panX -= (e.deltaY || e.deltaX) / st.zoom;
          this._scheduleDraw();
        } else {
          st.panX -= e.deltaX / st.zoom;
          st.panY -= e.deltaY / st.zoom;
          this._scheduleDraw();
        }
      }, { passive: false });

      stage.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        const st = this.tab?.rnoteState;
        if (!st?.doc) return;
        this._dragging = true;
        this._dragStart = { x: e.clientX, y: e.clientY, panX: st.panX, panY: st.panY };
        stage.classList.add('grabbing');
        stage.setPointerCapture?.(e.pointerId);
      });

      stage.addEventListener('pointermove', (e) => {
        if (!this._dragging || !this._dragStart) return;
        const st = this.tab?.rnoteState;
        if (!st?.doc) return;
        st.panX = this._dragStart.panX + (e.clientX - this._dragStart.x) / st.zoom;
        st.panY = this._dragStart.panY + (e.clientY - this._dragStart.y) / st.zoom;
        this._scheduleDraw();
      });

      const endDrag = (e) => {
        if (!this._dragging) return;
        this._dragging = false;
        this._dragStart = null;
        stage.classList.remove('grabbing');
        if (e?.pointerId !== undefined) {
          try { stage.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        }
      };
      stage.addEventListener('pointerup', endDrag);
      stage.addEventListener('pointercancel', endDrag);

      stage.addEventListener('keydown', (e) => {
        const st = this.tab?.rnoteState;
        if (!st?.doc) return;
        const step = 120 / st.zoom;
        if (e.key === '+' || e.key === '=') { e.preventDefault(); this._zoomBy(1.25); }
        else if (e.key === '-') { e.preventDefault(); this._zoomBy(1 / 1.25); }
        else if (e.key === '0') { e.preventDefault(); this.fitToWidth(); }
        else if (e.key === '1') { e.preventDefault(); this._setZoom(1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); st.panY -= step; this._scheduleDraw(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); st.panY += step; this._scheduleDraw(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); st.panX -= step; this._scheduleDraw(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); st.panX += step; this._scheduleDraw(); }
        else if (e.key === 'PageDown') { e.preventDefault(); st.panY -= (stage.clientHeight * 0.85) / st.zoom; this._scheduleDraw(); }
        else if (e.key === 'PageUp') { e.preventDefault(); st.panY += (stage.clientHeight * 0.85) / st.zoom; this._scheduleDraw(); }
      });
    }

    async _loadFromDisk(tab, keepView = false) {
      const { t } = window.StudioI18n;
      const st = tab.rnoteState;
      st.loading = true;
      st.error = null;
      this._syncUi();

      try {
        const res = await window.studio?.loadRnote?.(tab.filePath);
        if (!res || !res.ok) {
          st.loading = false;
          st.error = res?.error || 'Unknown error';
          this._syncUi();
          this.onToast(t('rnoteLoadError', st.error), 'error');
          return;
        }
        st.doc = res;
        st.loading = false;
        st.error = null;
        st.images = new Map();

        // Preload decoded PNG/SVG images
        for (let i = 0; i < res.items.length; i++) {
          const item = res.items[i];
          if ((item.type === 'bitmap' || item.type === 'vector') && item.dataUrl) {
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => {
              if (this.tab === tab) this._scheduleDraw();
            };
            img.src = item.dataUrl;
            st.images.set(i, img);
          }
        }

        if (this.tab === tab) {
          this._syncUi();
          if (!keepView || !st.initializedView) {
            this.fitToWidth();
          } else {
            this._scheduleDraw();
          }
        }
      } catch (err) {
        st.loading = false;
        st.error = err?.message || String(err);
        if (this.tab === tab) this._syncUi();
      }
    }

    _syncUi() {
      const { t } = window.StudioI18n;
      const st = this.tab?.rnoteState;
      if (!st) return;

      if (this._zoomLabel) {
        this._zoomLabel.textContent = `${Math.round((st.zoom || 1) * 100)}%`;
      }
      if (this._statsLabel) {
        if (st.doc?.stats) {
          const s = st.doc.stats;
          const imgCount = (s.bitmaps || 0) + (s.vectors || 0);
          const strokeCount = (s.brushstrokes || 0) + (s.shapes || 0) + (s.texts || 0);
          this._statsLabel.textContent = t('rnoteStats', imgCount, strokeCount);
        } else {
          this._statsLabel.textContent = '';
        }
      }
      if (this._statusEl) {
        if (st.loading) {
          this._statusEl.hidden = false;
          this._statusEl.className = 'rnote-status';
          this._statusEl.textContent = t('rnoteLoading');
        } else if (st.error) {
          this._statusEl.hidden = false;
          this._statusEl.className = 'rnote-status error';
          this._statusEl.textContent = t('rnoteLoadError', st.error);
        } else if (st.doc && st.doc.items.length === 0) {
          this._statusEl.hidden = false;
          this._statusEl.className = 'rnote-status';
          this._statusEl.textContent = t('rnoteEmpty');
        } else {
          this._statusEl.hidden = true;
        }
      }
    }

    _resizeCanvas() {
      if (!this._canvas || !this._stage) return;
      const w = this._stage.clientWidth;
      const h = this._stage.clientHeight;
      if (w <= 0 || h <= 0) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const targetW = Math.round(w * dpr);
      const targetH = Math.round(h * dpr);
      if (this._canvas.width !== targetW || this._canvas.height !== targetH) {
        this._canvas.width = targetW;
        this._canvas.height = targetH;
      }
    }

    fitToWidth() {
      const st = this.tab?.rnoteState;
      if (!st?.doc || !this._stage) return;
      const vw = this._stage.clientWidth;
      const vh = this._stage.clientHeight;
      if (vw <= 0 || vh <= 0) return;
      const b = st.doc.bounds;
      const pad = 40;
      const zoom = Math.max(0.05, Math.min(4, (vw - pad * 2) / Math.max(1, b.width)));
      st.zoom = zoom;
      const contentScreenW = b.width * zoom;
      const offsetX = (vw - contentScreenW) / (2 * zoom);
      st.panX = offsetX - b.minX;
      st.panY = (pad / zoom) - b.minY;
      st.initializedView = true;
      this._syncUi();
      this._scheduleDraw();
    }

    fitAll() {
      const st = this.tab?.rnoteState;
      if (!st?.doc || !this._stage) return;
      const vw = this._stage.clientWidth;
      const vh = this._stage.clientHeight;
      if (vw <= 0 || vh <= 0) return;
      const b = st.doc.bounds;
      const pad = 32;
      const zx = (vw - pad * 2) / Math.max(1, b.width);
      const zy = (vh - pad * 2) / Math.max(1, b.height);
      const zoom = Math.max(0.03, Math.min(4, Math.min(zx, zy)));
      st.zoom = zoom;
      st.panX = (vw / zoom - b.width) / 2 - b.minX;
      st.panY = (vh / zoom - b.height) / 2 - b.minY;
      st.initializedView = true;
      this._syncUi();
      this._scheduleDraw();
    }

    _zoomBy(factor) {
      if (!this._stage || !this.tab?.rnoteState?.doc) return;
      const cx = this._stage.clientWidth / 2;
      const cy = this._stage.clientHeight / 2;
      this._zoomAt(cx, cy, this.tab.rnoteState.zoom * factor);
    }

    _setZoom(nextZoom) {
      if (!this._stage || !this.tab?.rnoteState?.doc) return;
      const cx = this._stage.clientWidth / 2;
      const cy = this._stage.clientHeight / 2;
      this._zoomAt(cx, cy, nextZoom);
    }

    _zoomAt(cx, cy, nextZoom) {
      const st = this.tab?.rnoteState;
      if (!st?.doc) return;
      const clamped = Math.max(0.03, Math.min(8, nextZoom));
      const worldX = cx / st.zoom - st.panX;
      const worldY = cy / st.zoom - st.panY;
      st.zoom = clamped;
      st.panX = cx / st.zoom - worldX;
      st.panY = cy / st.zoom - worldY;
      this._syncUi();
      this._scheduleDraw();
    }

    _scheduleDraw() {
      if (this._raf) return;
      this._raf = window.requestAnimationFrame(() => {
        this._raf = 0;
        this._draw();
      });
    }

    _draw() {
      const st = this.tab?.rnoteState;
      if (!this._canvas || !this._stage) return;
      this._resizeCanvas();
      const ctx = this._canvas.getContext('2d');
      if (!ctx) return;

      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const vw = this._stage.clientWidth;
      const vh = this._stage.clientHeight;
      if (vw <= 0 || vh <= 0) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const bg = st?.doc?.document?.background;
      ctx.fillStyle = bg?.color || '#181920';
      ctx.fillRect(0, 0, vw, vh);

      if (!st?.doc) return;

      const { zoom, panX, panY } = st;
      ctx.save();
      ctx.scale(zoom, zoom);
      ctx.translate(panX, panY);

      const viewMinX = -panX;
      const viewMinY = -panY;
      const viewMaxX = viewMinX + vw / zoom;
      const viewMaxY = viewMinY + vh / zoom;

      // Optional background pattern (lines, grid, dots)
      this._drawBackgroundPattern(ctx, bg, viewMinX, viewMinY, viewMaxX, viewMaxY, zoom);

      const items = st.doc.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type === 'bitmap' || item.type === 'vector') {
          const img = st.images.get(i);
          if (!img || !img.complete || !img.naturalWidth) continue;
          const [hx, hy] = item.halfExtents;
          const a = item.affine;
          ctx.save();
          ctx.transform(a[0], a[1], a[2], a[3], a[4], a[5]);
          ctx.drawImage(img, -hx, -hy, hx * 2, hy * 2);
          ctx.restore();
        } else if (item.type === 'brush') {
          this._drawBrushStroke(ctx, item);
        } else if (item.type === 'shape') {
          this._drawShapeStroke(ctx, item);
        } else if (item.type === 'text') {
          this._drawTextStroke(ctx, item);
        }
      }

      ctx.restore();
    }

    _drawBackgroundPattern(ctx, bg, minX, minY, maxX, maxY, zoom) {
      if (!bg || !bg.pattern || bg.pattern === 'none') return;
      const pw = Math.max(4, Number(bg.patternSize?.[0]) || 32);
      const ph = Math.max(4, Number(bg.patternSize?.[1]) || 32);
      // Skip drawing ultra-dense patterns when zoomed far out
      if (pw * zoom < 4 && ph * zoom < 4) return;

      ctx.save();
      ctx.strokeStyle = bg.patternColor || 'rgba(128,128,128,0.25)';
      ctx.fillStyle = bg.patternColor || 'rgba(128,128,128,0.35)';
      ctx.lineWidth = Math.max(0.5, 1 / zoom);

      const startX = Math.floor(minX / pw) * pw;
      const startY = Math.floor(minY / ph) * ph;

      if (bg.pattern === 'lines' || bg.pattern === 'grid') {
        ctx.beginPath();
        for (let y = startY; y <= maxY; y += ph) {
          ctx.moveTo(minX, y);
          ctx.lineTo(maxX, y);
        }
        if (bg.pattern === 'grid') {
          for (let x = startX; x <= maxX; x += pw) {
            ctx.moveTo(x, minY);
            ctx.lineTo(x, maxY);
          }
        }
        ctx.stroke();
      } else if (bg.pattern === 'dots') {
        const r = Math.max(0.8, 1.2 / zoom);
        for (let y = startY; y <= maxY; y += ph) {
          for (let x = startX; x <= maxX; x += pw) {
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    _drawBrushStroke(ctx, item) {
      const { style, start, segs } = item;
      if (!style.strokeColor && !style.fillColor) return;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      applyLineDash(ctx, style.lineStyle, style.width);

      // Single dot stroke
      if (!segs.length) {
        if (style.strokeColor) {
          const r = applyPressureCurve(style.width, style.pressureCurve, start[2]) / 2;
          ctx.fillStyle = style.strokeColor;
          ctx.beginPath();
          ctx.arc(start[0], start[1], r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        return;
      }

      // Fast single-path render when constant width or fill is present
      if (style.fillColor || style.pressureCurve === 'const') {
        ctx.beginPath();
        ctx.moveTo(start[0], start[1]);
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (s[0] === 'L') ctx.lineTo(s[1], s[2]);
          else if (s[0] === 'Q') ctx.quadraticCurveTo(s[1], s[2], s[3], s[4]);
          else if (s[0] === 'C') ctx.bezierCurveTo(s[1], s[2], s[3], s[4], s[5], s[6]);
        }
        if (style.fillColor) {
          ctx.fillStyle = style.fillColor;
          ctx.fill();
        }
        if (style.strokeColor && style.pressureCurve === 'const') {
          ctx.strokeStyle = style.strokeColor;
          ctx.lineWidth = Math.max(0.5, style.width);
          ctx.stroke();
          ctx.restore();
          return;
        }
      }

      // Variable pressure per-segment rendering
      if (style.strokeColor) {
        ctx.strokeStyle = style.strokeColor;
        let px = start[0];
        let py = start[1];
        let pp = start[2];
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          const ep = s[s.length - 1];
          const w = applyPressureCurve(style.width, style.pressureCurve, (pp + ep) * 0.5);
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.moveTo(px, py);
          if (s[0] === 'L') {
            ctx.lineTo(s[1], s[2]);
            px = s[1];
            py = s[2];
          } else if (s[0] === 'Q') {
            ctx.quadraticCurveTo(s[1], s[2], s[3], s[4]);
            px = s[3];
            py = s[4];
          } else if (s[0] === 'C') {
            ctx.bezierCurveTo(s[1], s[2], s[3], s[4], s[5], s[6]);
            px = s[5];
            py = s[6];
          }
          pp = ep;
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    _drawShapeStroke(ctx, item) {
      const { style, shapeKind, shape, affine } = item;
      if (!shape) return;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(0.5, style.width);
      applyLineDash(ctx, style.lineStyle, style.width);

      const finish = () => {
        if (style.fillColor) {
          ctx.fillStyle = style.fillColor;
          ctx.fill();
        }
        if (style.strokeColor) {
          ctx.strokeStyle = style.strokeColor;
          ctx.stroke();
        }
      };

      if (shapeKind === 'line' && shape.start && shape.end) {
        ctx.beginPath();
        ctx.moveTo(shape.start[0], shape.start[1]);
        ctx.lineTo(shape.end[0], shape.end[1]);
        finish();
      } else if (shapeKind === 'arrow' && shape.start && shape.tip) {
        const [x1, y1] = shape.start;
        const [x2, y2] = shape.tip;
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(10, style.width * 3.5);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.moveTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
        finish();
      } else if (shapeKind === 'rect' && shape.cuboid?.half_extents && affine) {
        const [hx, hy] = shape.cuboid.half_extents;
        ctx.transform(affine[0], affine[1], affine[2], affine[3], affine[4], affine[5]);
        ctx.beginPath();
        ctx.rect(-hx, -hy, hx * 2, hy * 2);
        finish();
      } else if (shapeKind === 'ellipse' && shape.radii && affine) {
        ctx.transform(affine[0], affine[1], affine[2], affine[3], affine[4], affine[5]);
        ctx.beginPath();
        ctx.ellipse(0, 0, Math.abs(shape.radii[0]), Math.abs(shape.radii[1]), 0, 0, Math.PI * 2);
        finish();
      } else if (shapeKind === 'quadbez' && shape.start && shape.cp && shape.end) {
        ctx.beginPath();
        ctx.moveTo(shape.start[0], shape.start[1]);
        ctx.quadraticCurveTo(shape.cp[0], shape.cp[1], shape.end[0], shape.end[1]);
        finish();
      } else if (shapeKind === 'cubbez' && shape.start && shape.cp1 && shape.cp2 && shape.end) {
        ctx.beginPath();
        ctx.moveTo(shape.start[0], shape.start[1]);
        ctx.bezierCurveTo(shape.cp1[0], shape.cp1[1], shape.cp2[0], shape.cp2[1], shape.end[0], shape.end[1]);
        finish();
      } else if ((shapeKind === 'polygon' || shapeKind === 'polyline') && Array.isArray(shape.path)) {
        ctx.beginPath();
        if (Array.isArray(shape.start)) ctx.moveTo(shape.start[0], shape.start[1]);
        for (const pt of shape.path) {
          if (Array.isArray(pt)) ctx.lineTo(pt[0], pt[1]);
        }
        if (shapeKind === 'polygon') ctx.closePath();
        finish();
      }
      ctx.restore();
    }

    _drawTextStroke(ctx, item) {
      const { text, affine, style } = item;
      if (!text || !affine) return;
      ctx.save();
      ctx.transform(affine[0], affine[1], affine[2], affine[3], affine[4], affine[5]);
      const weight = style.fontWeight === 'bold' ? 'bold' : 'normal';
      const italic = style.fontStyle === 'italic' ? 'italic' : 'normal';
      ctx.font = `${italic} ${weight} ${style.fontSize}px ${style.fontFamily}`;
      ctx.fillStyle = style.color || '#ffffff';
      ctx.textBaseline = 'top';
      const lines = text.split(/\r?\n/);
      const lineH = style.fontSize * 1.25;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], 0, i * lineH);
      }
      ctx.restore();
    }
  }

  window.StudioRnoteViewer = StudioRnoteViewer;
})();
