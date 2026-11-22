'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.Rproj.user', '__pycache__', '.cache']);

function readDirTree(rootDir, maxDepth = 4, depth = 0) {
  if (!rootDir || !fs.existsSync(rootDir) || depth > maxDepth) return [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && IGNORED_DIRS.has(entry.name)) continue;
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: fullPath,
        isDir: true,
        children: depth < maxDepth ? readDirTree(fullPath, maxDepth, depth + 1) : []
      });
    } else {
      result.push({
        name: entry.name,
        path: fullPath,
        isDir: false
      });
    }
  }
  return result;
}

function createFile(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return { ok: true, path: filePath, name: path.basename(filePath) };
}

function createDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return { ok: true, path: dirPath, name: path.basename(dirPath) };
}

function renamePath(oldPath, newPath) {
  fs.renameSync(oldPath, newPath);
  return { ok: true, oldPath, newPath, name: path.basename(newPath) };
}

function deletePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  return { ok: true, path: targetPath };
}

/**
 * RFC-4180 compliant CSV/TSV parser supporting quoted fields, embedded commas/newlines, and escaped quotes.
 */
function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text ?? '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing empty row
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }
  if (!rows.length) {
    return { columns: [], rows: [] };
  }
  const headers = rows[0].map((h, idx) => h.trim() || `V${idx + 1}`);
  const dataRows = rows.slice(1).map((r) => headers.map((_, idx) => (r[idx] !== undefined ? r[idx] : '')));
  return { columns: headers, rows: dataRows };
}

function escapeCsvCell(val, delimiter = ',') {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function serializeDelimited(columns, rows, delimiter = ',') {
  const lines = [columns.map((c) => escapeCsvCell(c, delimiter)).join(delimiter)];
  for (const r of rows) {
    lines.push(r.map((cell) => escapeCsvCell(cell, delimiter)).join(delimiter));
  }
  return lines.join('\n') + '\n';
}

function toMarkdownTable(columns, rows, maxRows = 200) {
  const escMd = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const head = `| ${columns.map(escMd).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.slice(0, maxRows).map((r) => `| ${r.map(escMd).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

module.exports = {
  readDirTree,
  createFile,
  createDir,
  renamePath,
  deletePath,
  parseDelimited,
  serializeDelimited,
  toMarkdownTable
};
