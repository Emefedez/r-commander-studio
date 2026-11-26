'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');

const { loadRnoteFile, parseRnoteBuffer, encodeRgbaToPng } = require('../main/rnote-service');

test('encodeRgbaToPng produces a valid PNG buffer with signature and IHDR/IDAT/IEND', () => {
  const rgba = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 128
  ]);
  const png = encodeRgbaToPng(rgba, 2, 2);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 2);
  assert.ok(png.includes(Buffer.from('IDAT', 'ascii')));
  assert.ok(png.includes(Buffer.from('IEND', 'ascii')));
});

test('parseRnoteBuffer parses gzipped Rnote JSON, sorts document layer below user layers, and encodes bitmaps', () => {
  const pixelBuf = Buffer.from([128, 64, 0, 128, 255, 255, 255, 255]); // 2x1 R8g8b8a8Premultiplied
  const sample = {
    version: '0.14.2',
    data: {
      engine_snapshot: {
        document: {
          config: {
            layout: 'infinite',
            background: {
              color: { r: 0, g: 0, b: 0, a: 1 },
              pattern: 'grid',
              pattern_size: [32, 32],
              pattern_color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }
            },
            format: { width: 1000, height: 1400, dpi: 96, orientation: 'portrait' }
          }
        },
        stroke_components: [
          {
            value: {
              brushstroke: {
                path: {
                  start: { pos: [10, 20], pressure: 0.5 },
                  segments: [
                    { lineto: { end: { pos: [50, 60], pressure: 0.6 } } },
                    { quadbezto: { cp: [70, 80], end: { pos: [90, 40], pressure: 0.4 } } }
                  ]
                },
                style: {
                  smooth: {
                    stroke_width: 4,
                    stroke_color: { r: 1, g: 1, b: 1, a: 1 },
                    pressure_curve: 'linear',
                    line_style: 'solid'
                  }
                }
              }
            }
          },
          {
            value: {
              bitmapimage: {
                image: {
                  data: pixelBuf.toString('base64'),
                  pixel_width: 2,
                  pixel_height: 1,
                  memory_format: 'R8g8b8a8Premultiplied'
                },
                rectangle: {
                  cuboid: { half_extents: [100, 50] },
                  transform: { affine: [1, 0, 0, 0, 1, 0, 200, 150, 1] }
                }
              }
            }
          },
          {
            value: {
              textstroke: {
                text: 'Exercise 1',
                transform: { affine: [1, 0, 0, 0, 1, 0, 30, 40, 1] },
                text_style: { font_family: 'sans-serif', font_size: 20, color: { r: 1, g: 0, b: 0, a: 1 } }
              }
            }
          },
          { value: null }
        ],
        chrono_components: [
          { value: { t: 10, layer: { user_layer: 0 } } },
          { value: { t: 20, layer: 'document' } },
          { value: { t: 30, layer: { user_layer: 1 } } },
          { value: null }
        ]
      }
    }
  };

  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(sample), 'utf8'));
  const doc = parseRnoteBuffer(gz, 'sample.rnote');

  assert.equal(doc.ok, true);
  assert.equal(doc.version, '0.14.2');
  assert.equal(doc.stats.totalItems, 3);
  assert.equal(doc.stats.bitmaps, 1);
  assert.equal(doc.stats.brushstrokes, 1);
  assert.equal(doc.stats.texts, 1);

  // Document layer bitmap must come BEFORE user_layer 0 brushstroke and user_layer 1 text
  assert.equal(doc.items[0].type, 'bitmap');
  assert.ok(doc.items[0].dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(doc.items[1].type, 'brush');
  assert.equal(doc.items[1].segs.length, 2);
  assert.equal(doc.items[2].type, 'text');
  assert.equal(doc.items[2].text, 'Exercise 1');
});

test('loadRnoteFile returns a clean error for missing files', () => {
  const res = loadRnoteFile('/nonexistent/path/does-not-exist.rnote');
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/i);
});

test('loadRnoteFile opens the real Exercises.rnote file cleanly when present', () => {
  const realPath = '/home/m1-max/Documents/Universidad/2_1 School/EST/Examen 2/T3/Exercises.rnote';
  if (!fs.existsSync(realPath)) return;

  const t0 = Date.now();
  const doc = loadRnoteFile(realPath);
  const elapsedMs = Date.now() - t0;

  assert.equal(doc.ok, true, doc.error || 'expected ok=true');
  assert.equal(doc.stats.bitmaps, 5);
  assert.equal(doc.stats.brushstrokes, 590);
  assert.equal(doc.items.length, 595);
  // First 5 items must be the 5 document-layer pages
  for (let i = 0; i < 5; i++) {
    assert.equal(doc.items[i].type, 'bitmap');
    assert.ok(doc.items[i].dataUrl.startsWith('data:image/png;base64,'));
  }
  assert.ok(doc.bounds.width > 1000 && doc.bounds.height > 5000);
  assert.ok(elapsedMs < 10000, `Expected fast parse (<10s), took ${elapsedMs}ms`);
});
