'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// --- Pure-JS PNG encoder (zero external dependencies, ~45ms for 2470x3493 via zlib level 1) ---
const CRC32_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(typeStr, data) {
  const type = Buffer.from(typeStr, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([type, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, crcInput, crcBuf]);
}

function encodeRgbaToPng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // Filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 1 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function normalizePixelsToRgba(buf, width, height, memoryFormat) {
  const pixelCount = width * height;
  const fmt = String(memoryFormat || 'R8g8b8a8Premultiplied');
  const isBgr = /^B8g8r8/i.test(fmt);
  const isPremul = /Premultiplied/i.test(fmt);
  const hasAlpha = /a8/i.test(fmt);

  let rgba;
  if (hasAlpha) {
    const expected = pixelCount * 4;
    if (buf.length < expected) return null;
    if (!isBgr && !isPremul) return buf.subarray(0, expected);
    rgba = Buffer.from(buf.subarray(0, expected));
    if (isBgr) {
      for (let i = 0; i < expected; i += 4) {
        const b = rgba[i];
        rgba[i] = rgba[i + 2];
        rgba[i + 2] = b;
      }
    }
    if (isPremul) {
      for (let i = 0; i < expected; i += 4) {
        const a = rgba[i + 3];
        if (a > 0 && a < 255) {
          rgba[i] = Math.min(255, Math.round((rgba[i] * 255) / a));
          rgba[i + 1] = Math.min(255, Math.round((rgba[i + 1] * 255) / a));
          rgba[i + 2] = Math.min(255, Math.round((rgba[i + 2] * 255) / a));
        }
      }
    }
    return rgba;
  }

  // 3-byte RGB / BGR
  const expected3 = pixelCount * 3;
  if (buf.length < expected3) return null;
  rgba = Buffer.alloc(pixelCount * 4);
  for (let p = 0; p < pixelCount; p++) {
    const s = p * 3;
    const d = p * 4;
    rgba[d] = isBgr ? buf[s + 2] : buf[s];
    rgba[d + 1] = buf[s + 1];
    rgba[d + 2] = isBgr ? buf[s] : buf[s + 2];
    rgba[d + 3] = 255;
  }
  return rgba;
}

function bitmapImageToDataUrl(img) {
  if (!img || !img.data) return null;
  const buf = typeof img.data === 'string'
    ? Buffer.from(img.data, 'base64')
    : Array.isArray(img.data)
      ? Buffer.from(img.data)
      : null;
  if (!buf || !buf.length) return null;

  // Already-encoded image bytes?
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return `data:image/png;base64,${buf.toString('base64')}`;
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return `data:image/webp;base64,${buf.toString('base64')}`;
  }

  const w = Number(img.pixel_width) || 0;
  const h = Number(img.pixel_height) || 0;
  if (w <= 0 || h <= 0) return null;

  const rgba = normalizePixelsToRgba(buf, w, h, img.memory_format);
  if (!rgba) return null;
  const png = encodeRgbaToPng(rgba, w, h);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function colorToCss(c) {
  if (!c || typeof c !== 'object') return null;
  const r = Math.round(Math.max(0, Math.min(1, Number(c.r) || 0)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, Number(c.g) || 0)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, Number(c.b) || 0)) * 255);
  const a = Math.max(0, Math.min(1, c.a === undefined ? 1 : Number(c.a)));
  if (a <= 0.001) return null;
  if (a >= 0.999) return `rgb(${r},${g},${b})`;
  return `rgba(${r},${g},${b},${Number(a.toFixed(3))})`;
}

// Rnote stores nalgebra 3x3 column-major affine: [m00, m10, m20, m01, m11, m21, m02, m12, m22]
// Canvas2D transform(a, b, c, d, e, f) uses [m00, m10, m01, m11, m02, m12].
function extractAffine2d(transform) {
  const a = transform?.affine;
  if (Array.isArray(a) && a.length >= 9) {
    return [a[0], a[1], a[3], a[4], a[6], a[7]];
  }
  return [1, 0, 0, 1, 0, 0];
}

function applyAffinePoint(aff, x, y) {
  return [aff[0] * x + aff[2] * y + aff[4], aff[1] * x + aff[3] * y + aff[5]];
}

function extractStyle(styleObj) {
  if (!styleObj || typeof styleObj !== 'object') {
    return { width: 2, strokeColor: '#ffffff', fillColor: null, pressureCurve: 'const', lineStyle: 'solid', lineCap: 'round' };
  }
  const inner = styleObj.smooth || styleObj.rough || styleObj.textured || styleObj.solid || Object.values(styleObj)[0] || {};
  const strokeWidth = Number(inner.stroke_width ?? inner.width ?? 2) || 2;
  const strokeColor = colorToCss(inner.stroke_color ?? inner.color);
  const fillColor = colorToCss(inner.fill_color);
  const pressureCurve = typeof inner.pressure_curve === 'string' ? inner.pressure_curve : 'const';
  const lineStyle = typeof inner.line_style === 'string' ? inner.line_style : 'solid';
  const lineCap = typeof inner.line_cap === 'string' ? inner.line_cap : 'round';
  return { width: strokeWidth, strokeColor, fillColor, pressureCurve, lineStyle, lineCap };
}

function layerRank(layer) {
  if (!layer) return 0;
  if (layer === 'document') return -1;
  if (typeof layer === 'object' && typeof layer.user_layer === 'number') return layer.user_layer;
  if (typeof layer === 'number') return layer;
  return 0;
}

function parseRnoteBuffer(buf, fileName = 'note.rnote') {
  if (!Buffer.isBuffer(buf) || !buf.length) {
    throw new Error('Empty .rnote file');
  }

  let jsonBytes = buf;
  // Gzip magic bytes 0x1f 0x8b
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    jsonBytes = zlib.gunzipSync(buf);
  }
  const parsed = JSON.parse(jsonBytes.toString('utf8'));
  const es = parsed?.data?.engine_snapshot || parsed?.engine_snapshot || parsed?.data || parsed;
  if (!es || typeof es !== 'object') {
    throw new Error('Unrecognized .rnote document structure');
  }

  const doc = es.document || {};
  const bg = doc.config?.background || {};
  const fmt = doc.config?.format || {};

  const strokeComponents = Array.isArray(es.stroke_components) ? es.stroke_components : [];
  const chronoComponents = Array.isArray(es.chrono_components) ? es.chrono_components : [];

  const entries = [];
  for (let i = 0; i < strokeComponents.length; i++) {
    const sc = strokeComponents[i];
    if (!sc || !sc.value) continue;
    const cc = chronoComponents[i]?.value || null;
    entries.push({
      idx: i,
      layer: layerRank(cc?.layer),
      t: typeof cc?.t === 'number' ? cc.t : i,
      value: sc.value
    });
  }
  entries.sort((a, b) => (a.layer - b.layer) || (a.t - b.t) || (a.idx - b.idx));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const expand = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  const expandRect = (aff, hx, hy) => {
    for (const [cx, cy] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) {
      const [px, py] = applyAffinePoint(aff, cx, cy);
      expand(px, py);
    }
  };

  const items = [];
  const stats = {
    totalItems: 0,
    bitmaps: 0,
    vectors: 0,
    brushstrokes: 0,
    shapes: 0,
    texts: 0,
    fileSizeBytes: buf.length
  };

  for (const entry of entries) {
    const v = entry.value;

    if (v.bitmapimage) {
      const bm = v.bitmapimage;
      const hx = Number(bm.rectangle?.cuboid?.half_extents?.[0]) || 0;
      const hy = Number(bm.rectangle?.cuboid?.half_extents?.[1]) || 0;
      const affine = extractAffine2d(bm.rectangle?.transform);
      const dataUrl = bitmapImageToDataUrl(bm.image);
      if (!dataUrl || hx <= 0 || hy <= 0) continue;
      expandRect(affine, hx, hy);
      items.push({
        type: 'bitmap',
        halfExtents: [hx, hy],
        affine,
        width: Number(bm.image?.pixel_width) || Math.round(hx * 2),
        height: Number(bm.image?.pixel_height) || Math.round(hy * 2),
        dataUrl
      });
      stats.bitmaps++;
      continue;
    }

    if (v.vectorimage) {
      const vi = v.vectorimage;
      const hx = Number(vi.rectangle?.cuboid?.half_extents?.[0]) || 0;
      const hy = Number(vi.rectangle?.cuboid?.half_extents?.[1]) || 0;
      const affine = extractAffine2d(vi.rectangle?.transform);
      const svgData = typeof vi.svg_data === 'string' ? vi.svg_data : '';
      if (!svgData || hx <= 0 || hy <= 0) continue;
      expandRect(affine, hx, hy);
      items.push({
        type: 'vector',
        halfExtents: [hx, hy],
        affine,
        dataUrl: `data:image/svg+xml;base64,${Buffer.from(svgData, 'utf8').toString('base64')}`
      });
      stats.vectors++;
      continue;
    }

    if (v.brushstroke) {
      const bs = v.brushstroke;
      const p = bs.path;
      if (!p || !p.start || !Array.isArray(p.start.pos)) continue;
      const style = extractStyle(bs.style);
      const sx = Number(p.start.pos[0]) || 0;
      const sy = Number(p.start.pos[1]) || 0;
      const sp = p.start.pressure === undefined ? 0.5 : Number(p.start.pressure);
      expand(sx, sy);

      const segs = [];
      for (const s of p.segments || []) {
        if (!s || typeof s !== 'object') continue;
        if (s.lineto?.end?.pos) {
          const ex = Number(s.lineto.end.pos[0]) || 0;
          const ey = Number(s.lineto.end.pos[1]) || 0;
          const ep = s.lineto.end.pressure === undefined ? 0.5 : Number(s.lineto.end.pressure);
          expand(ex, ey);
          segs.push(['L', ex, ey, ep]);
        } else if (s.quadbezto?.end?.pos && Array.isArray(s.quadbezto.cp)) {
          const cpx = Number(s.quadbezto.cp[0]) || 0;
          const cpy = Number(s.quadbezto.cp[1]) || 0;
          const ex = Number(s.quadbezto.end.pos[0]) || 0;
          const ey = Number(s.quadbezto.end.pos[1]) || 0;
          const ep = s.quadbezto.end.pressure === undefined ? 0.5 : Number(s.quadbezto.end.pressure);
          expand(cpx, cpy);
          expand(ex, ey);
          segs.push(['Q', cpx, cpy, ex, ey, ep]);
        } else if (s.cubbezto?.end?.pos && Array.isArray(s.cubbezto.cp1) && Array.isArray(s.cubbezto.cp2)) {
          const cp1x = Number(s.cubbezto.cp1[0]) || 0;
          const cp1y = Number(s.cubbezto.cp1[1]) || 0;
          const cp2x = Number(s.cubbezto.cp2[0]) || 0;
          const cp2y = Number(s.cubbezto.cp2[1]) || 0;
          const ex = Number(s.cubbezto.end.pos[0]) || 0;
          const ey = Number(s.cubbezto.end.pos[1]) || 0;
          const ep = s.cubbezto.end.pressure === undefined ? 0.5 : Number(s.cubbezto.end.pressure);
          expand(cp1x, cp1y);
          expand(cp2x, cp2y);
          expand(ex, ey);
          segs.push(['C', cp1x, cp1y, cp2x, cp2y, ex, ey, ep]);
        }
      }

      items.push({
        type: 'brush',
        style,
        start: [sx, sy, sp],
        segs
      });
      stats.brushstrokes++;
      continue;
    }

    if (v.shapestroke) {
      const sh = v.shapestroke;
      const style = extractStyle(sh.style);
      const shape = sh.shape || {};
      const shapeKind = Object.keys(shape)[0];
      if (!shapeKind) continue;
      const sdata = shape[shapeKind];
      if (shapeKind === 'line' && Array.isArray(sdata?.start) && Array.isArray(sdata?.end)) {
        expand(sdata.start[0], sdata.start[1]);
        expand(sdata.end[0], sdata.end[1]);
      } else if (shapeKind === 'arrow' && Array.isArray(sdata?.start) && Array.isArray(sdata?.tip)) {
        expand(sdata.start[0], sdata.start[1]);
        expand(sdata.tip[0], sdata.tip[1]);
      } else if (shapeKind === 'rect' && sdata?.cuboid?.half_extents) {
        expandRect(extractAffine2d(sdata.transform), sdata.cuboid.half_extents[0], sdata.cuboid.half_extents[1]);
      } else if (shapeKind === 'ellipse' && Array.isArray(sdata?.radii)) {
        expandRect(extractAffine2d(sdata.transform), sdata.radii[0], sdata.radii[1]);
      } else if (shapeKind === 'quadbez' && Array.isArray(sdata?.start) && Array.isArray(sdata?.end)) {
        expand(sdata.start[0], sdata.start[1]);
        if (Array.isArray(sdata.cp)) expand(sdata.cp[0], sdata.cp[1]);
        expand(sdata.end[0], sdata.end[1]);
      } else if (shapeKind === 'cubbez' && Array.isArray(sdata?.start) && Array.isArray(sdata?.end)) {
        expand(sdata.start[0], sdata.start[1]);
        if (Array.isArray(sdata.cp1)) expand(sdata.cp1[0], sdata.cp1[1]);
        if (Array.isArray(sdata.cp2)) expand(sdata.cp2[0], sdata.cp2[1]);
        expand(sdata.end[0], sdata.end[1]);
      } else if ((shapeKind === 'polygon' || shapeKind === 'polyline') && Array.isArray(sdata?.path)) {
        if (Array.isArray(sdata.start)) expand(sdata.start[0], sdata.start[1]);
        for (const pt of sdata.path) {
          if (Array.isArray(pt)) expand(pt[0], pt[1]);
        }
      }
      items.push({
        type: 'shape',
        style,
        shapeKind,
        shape: sdata,
        affine: sdata?.transform ? extractAffine2d(sdata.transform) : null
      });
      stats.shapes++;
      continue;
    }

    if (v.textstroke) {
      const ts = v.textstroke;
      const text = typeof ts.text === 'string' ? ts.text : '';
      if (!text) continue;
      const affine = extractAffine2d(ts.transform);
      const tstyle = ts.text_style || {};
      const fontSize = Number(tstyle.font_size) || 24;
      const lines = text.split(/\r?\n/);
      const estW = Math.max(...lines.map((l) => l.length), 1) * fontSize * 0.6;
      const estH = lines.length * fontSize * 1.25;
      expandRect(affine, estW, estH);
      items.push({
        type: 'text',
        text,
        affine,
        style: {
          fontFamily: tstyle.font_family || 'sans-serif',
          fontSize,
          color: colorToCss(tstyle.color) || '#ffffff',
          alignment: tstyle.alignment || 'start',
          fontWeight: tstyle.font_weight || 'normal',
          fontStyle: tstyle.font_style || 'normal'
        }
      });
      stats.texts++;
    }
  }

  stats.totalItems = items.length;

  // Fallback bounds if the note is empty
  if (!Number.isFinite(minX)) {
    minX = Number(doc.x) || 0;
    minY = Number(doc.y) || 0;
    maxX = minX + (Number(doc.width) || Number(fmt.width) || 1200);
    maxY = minY + (Number(doc.height) || Number(fmt.height) || 900);
  }

  return {
    ok: true,
    name: fileName,
    version: parsed.version || 'unknown',
    document: {
      layout: doc.config?.layout || 'infinite',
      format: {
        width: Number(fmt.width) || 0,
        height: Number(fmt.height) || 0,
        dpi: Number(fmt.dpi) || 96,
        orientation: fmt.orientation || 'portrait'
      },
      background: {
        color: colorToCss(bg.color) || '#111111',
        pattern: bg.pattern || 'none',
        patternSize: Array.isArray(bg.pattern_size) ? bg.pattern_size : [32, 32],
        patternColor: colorToCss(bg.pattern_color) || 'rgba(128,128,128,0.2)'
      }
    },
    camera: es.camera || null,
    bounds: {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY)
    },
    stats,
    items
  };
}

function loadRnoteFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }
  try {
    const buf = fs.readFileSync(filePath);
    const result = parseRnoteBuffer(buf, path.basename(filePath));
    result.filePath = filePath;
    return result;
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

module.exports = {
  loadRnoteFile,
  parseRnoteBuffer,
  encodeRgbaToPng
};
