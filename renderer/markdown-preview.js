(function () {
  'use strict';

  function esc(str) {
    return String(str ?? '').replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;'
    }[ch]));
  }

  function renderInline(text) {
    let s = esc(text);
    // Inline code
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Links [text](url)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    // Bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    // Italic
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return s;
  }

  function parseFrontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { meta: null, body: text };
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (kv) {
        meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
      }
    }
    return { meta, body: text.slice(m[0].length) };
  }

  function renderMarkdown(source, { onRunChunk } = {}) {
    const { meta, body } = parseFrontmatter(String(source ?? ''));
    const parts = [];
    const chunks = [];

    if (meta && (meta.title || meta.author || meta.date)) {
      parts.push('<div class="md-frontmatter">');
      if (meta.title) parts.push(`<h1>${esc(meta.title)}</h1>`);
      const info = [meta.author && `Author: ${esc(meta.author)}`, meta.date && `Date: ${esc(meta.date)}`, meta.output && `Output: ${esc(meta.output)}`]
        .filter(Boolean);
      if (info.length) parts.push(`<div class="md-meta">${info.map((x) => `<span>${x}</span>`).join('')}</div>`);
      parts.push('</div>');
    }

    const lines = body.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block or R chunk
      const fenceMatch = line.match(/^\s*```+\s*(.*)$/);
      if (fenceMatch) {
        const header = fenceMatch[1].trim();
        const isR = /^\{[ \t]*r\b/i.test(header) || /^r$/i.test(header);
        const codeLines = [];
        i++;
        while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        const code = codeLines.join('\n');
        if (isR) {
          const idx = chunks.length;
          chunks.push(code);
          const playIcon = window.StudioIcons ? window.StudioIcons.svg('play', { size: 12 }) : '';
          parts.push(
            `<div class="md-chunk">` +
              `<div class="md-chunk-bar"><span>${esc(header || '{r}')}</span>` +
              `<button class="icon-btn" data-run-chunk="${idx}" title="Run Chunk">${playIcon}</button></div>` +
              `<pre><code>${esc(code)}</code></pre>` +
            `</div>`
          );
        } else {
          parts.push(`<pre><code>${esc(code)}</code></pre>`);
        }
        continue;
      }

      // Headings
      const hMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        parts.push(`<h${level}>${renderInline(hMatch[2])}</h${level}>`);
        i++;
        continue;
      }

      // Horizontal rule
      if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
        parts.push('<hr>');
        i++;
        continue;
      }

      // Blockquote
      if (/^\s*>\s?/.test(line)) {
        const qLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          qLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        parts.push(`<blockquote>${renderInline(qLines.join(' '))}</blockquote>`);
        continue;
      }

      // Markdown table
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
        const splitCells = (row) =>
          row
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim());
        const headers = splitCells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          rows.push(splitCells(lines[i]));
          i++;
        }
        parts.push(
          `<table><thead><tr>${headers.map((h) => `<th>${renderInline(h)}</th>`).join('')}</tr></thead>` +
            `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
        );
        continue;
      }

      // Unordered list
      if (/^\s*[*+-]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[*+-]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[*+-]\s+/, ''));
          i++;
        }
        parts.push(`<ul>${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ul>`);
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
          i++;
        }
        parts.push(`<ol>${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ol>`);
        continue;
      }

      // Blank line
      if (!line.trim()) {
        i++;
        continue;
      }

      // Paragraph
      const pLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(?:#{1,6}\s|```|>\s?|[*+-]\s+|\d+\.\s+|(?:[-*_]\s*){3,}$)/.test(lines[i])
      ) {
        pLines.push(lines[i]);
        i++;
      }
      parts.push(`<p>${renderInline(pLines.join(' '))}</p>`);
    }

    return { html: parts.join('\n'), chunks, onRunChunk };
  }

  window.StudioMarkdownPreview = { renderMarkdown };
})();
