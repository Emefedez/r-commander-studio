(function () {
  'use strict';

  // Rich Markdown & R Markdown Viewer adapted from NoteComplete's markdown/rich-text/text-view
  // and code-highlight engines (without any Chinese/Pinyin/Hanzi modules).
  // Supports:
  // - YAML Frontmatter metadata header
  // - GitHub-style heading anchors (headingSlug & headingFor) + automatic Outline/TOC extraction
  // - GFM Alerts / Callouts (> [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION])
  // - Task lists (- [ ] / - [x]), nested lists, tables with alignment + Copy Table button
  // - Syntax-highlighted code blocks (R, {r}, Python, JS/TS, C/C++, Java, Rust, SQL, Bash, JSON, YAML)
  // - One-click Run Chunk button on {r} blocks + Copy Code button on every code block
  // - Inline ($...$, \(...\)) and Display ($$...$$, \[...\]) LaTeX math typesetting

  function esc(str) {
    return String(str ?? '').replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;'
    }[ch]));
  }

  // GitHub-style heading anchors from NoteComplete's text-view.js
  function headingSlug(text) {
    return String(text || '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-');
  }

  const looseSlug = (slug) =>
    String(slug || '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[-_]+/g, '-')
      .replace(/^-|-$/g, '');

  function headingFor(headings, fragment) {
    let wanted = String(fragment || '');
    try {
      wanted = decodeURIComponent(wanted);
    } catch {
      // keep raw
    }
    wanted = wanted.toLowerCase();
    const seen = new Map();
    const slugs = (headings || []).map((h) => {
      const text = typeof h === 'string' ? h : h.text;
      const base = headingSlug(text);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      return n ? `${base}-${n}` : base;
    });
    const exact = slugs.indexOf(wanted);
    return exact >= 0 ? exact : slugs.findIndex((s) => looseSlug(s) === looseSlug(wanted));
  }

  // LaTeX symbols & math typesetting (from NoteComplete's rich-text.js, using HTML entities for arrows so zero Unicode Emoji codepoints appear)
  const SYMBOLS = {
    rightarrow: '&rarr;', to: '&rarr;', longrightarrow: '&xrarr;', leftarrow: '&larr;', gets: '&larr;', Rightarrow: '&rArr;', Leftarrow: '&lArr;',
    leftrightarrow: '&harr;', Leftrightarrow: '&hArr;', implies: '&rArr;', iff: '&hArr;', mapsto: '&#8614;', mid: '|',
    times: '&times;', cdot: '&middot;', div: '&divide;', pm: '&plusmn;', mp: '&#8723;', le: '&le;', leq: '&le;', ge: '&ge;', geq: '&ge;',
    neq: '&ne;', ne: '&ne;', approx: '&asymp;', equiv: '&equiv;', sim: '&sim;', propto: '&prop;',
    infty: '&infin;', sum: '&sum;', prod: '&prod;', int: '&int;', oint: '&#8750;', partial: '&part;', nabla: '&nabla;', lim: 'lim',
    in: '&isin;', notin: '&notin;', subset: '&sub;', subseteq: '&sube;', cup: '&cup;', cap: '&cap;', emptyset: '&empty;',
    forall: '&forall;', exists: '&exist;', neg: '&not;', land: '&and;', lor: '&or;', oplus: '&oplus;', otimes: '&otimes;',
    ldots: '&hellip;', cdots: '&#8943;', dots: '&hellip;', degree: '&deg;', circ: '&#8728;',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
    upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
  };

  function renderTexHtml(tex, displayMode = false) {
    let s = esc(String(tex || '').trim());
    // \text{...}, \mathrm{...}, \mathbf{...}
    s = s.replace(/\\(?:text|mathrm|operatorname)\{([^{}]*)\}/g, '<span class="math-rm">$1</span>');
    s = s.replace(/\\mathbf\{([^{}]*)\}/g, '<strong>$1</strong>');
    s = s.replace(/\\mathit\{([^{}]*)\}/g, '<em>$1</em>');
    // \overset{top}{op}
    s = s.replace(
      /\\overset\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{([^{}]*)\}/g,
      '<span class="math-overset"><span class="math-over-top">$1</span><span class="math-over-base">$2</span></span>'
    );
    // \binom{a}{b}
    s = s.replace(
      /\\binom\{([^{}]*)\}\{([^{}]*)\}/g,
      '<span class="math-binom">(<span class="math-binom-col"><span>$1</span><span>$2</span></span>)</span>'
    );
    // \hat{x}, \widehat{...}, \bar{x}, \overline{...}, \tilde{x}, \widetilde{...}, \vec{x}, \overrightarrow{...}
    s = s.replace(/\\overline\{([^{}]*)\}/g, '<span class="math-overline">$1</span>');
    s = s.replace(/\\bar\{([^{}]*)\}/g, '<span class="math-bar">$1&#772;</span>');
    s = s.replace(/\\(?:wide)?hat\{([^{}]*)\}/g, '$1&#770;');
    s = s.replace(/\\(?:wide)?tilde\{([^{}]*)\}/g, '$1&#771;');
    s = s.replace(/\\(?:vec|overrightarrow)\{([^{}]*)\}/g, '<span class="math-vec">$1</span>');
    // \sqrt[n]{...} and \sqrt{...}
    s = s.replace(/\\sqrt\[([^\]]+)\]\{([^{}]*)\}/g, '<span class="math-sqrt"><sup class="math-sqrt-idx">$1</sup>&radic;<span class="math-radicand">$2</span></span>');
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, '<span class="math-sqrt">&radic;<span class="math-radicand">$1</span></span>');
    // \frac{a}{b} (two passes for nested fractions)
    for (let pass = 0; pass < 2; pass++) {
      s = s.replace(
        /\\frac\{([^{}]*)\}\{([^{}]*)\}/g,
        '<span class="math-frac"><span class="math-num">$1</span><span class="math-den">$2</span></span>'
      );
    }
    // Superscripts and subscripts: ^{...}, _{...}, ^x, _x
    s = s.replace(/\^\{([^{}]*)\}/g, '<sup>$1</sup>');
    s = s.replace(/_\{([^{}]*)\}/g, '<sub>$1</sub>');
    s = s.replace(/\^([A-Za-z0-9+-])/g, '<sup>$1</sup>');
    s = s.replace(/_([A-Za-z0-9+-])/g, '<sub>$1</sub>');
    // Commands \alpha, \sum, etc.
    s = s.replace(/\\([A-Za-z]+)/g, (whole, name) => SYMBOLS[name] ?? whole.slice(1));
    s = s.replace(/\\[,;:! ]/g, '&thinsp;').replace(/[{}]/g, '');
    return `<span class="md-math ${displayMode ? 'md-math-display' : 'md-math-inline'}" data-tex="${esc(tex)}">${s}</span>`;
  }

  // Lightweight syntax highlighter ripped from NoteComplete's code-highlight.js
  const R_KW = new Set([
    'if', 'else', 'for', 'in', 'while', 'repeat', 'function', 'return', 'next', 'break',
    'library', 'require', 'source', 'local', 'try', 'tryCatch', 'stop', 'warning', 'message'
  ]);
  const R_CONST = new Set([
    'TRUE', 'FALSE', 'T', 'F', 'NULL', 'NA', 'NA_integer_', 'NA_real_', 'NA_complex_', 'NA_character_',
    'Inf', 'NaN', 'pi', 'letters', 'LETTERS'
  ]);
  const GENERIC_KW = new Set([
    'if', 'else', 'elif', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
    'return', 'function', 'def', 'fn', 'class', 'struct', 'enum', 'interface', 'impl', 'trait',
    'import', 'from', 'export', 'as', 'const', 'let', 'var', 'mut', 'pub', 'private', 'public',
    'protected', 'static', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'raise', 'new',
    'in', 'of', 'where', 'select', 'insert', 'update', 'delete', 'join', 'group', 'by', 'order',
    'limit', 'create', 'table', 'drop', 'alter', 'with', 'yield', 'lambda'
  ]);
  const GENERIC_CONST = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'self', 'this']);

  function highlightCodeHtml(code, lang = 'r') {
    const cleanLang = String(lang || '').toLowerCase().replace(/^\{?\s*([a-z0-9_+-]+).*$/i, '$1');
    const isR = cleanLang === 'r' || cleanLang === 'rmd' || cleanLang === 'webr';
    const kwSet = isR ? R_KW : GENERIC_KW;
    const constSet = isR ? R_CONST : GENERIC_CONST;

    const tokenRe = isR
      ? /(#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?L?)\b)|(<-|<<->>|->>|->|\|>|%[^%\s]+%|:::|::|==|!=|<=|>=|&&|\|\||[$@~:=+\-*/^<>!&|])|(\b[A-Za-z.][A-Za-z0-9._]*\b)/g
      : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b)|(===|!==|==|!=|<=|>=|=>|->|::|&&|\|\||[+\-*/%=<>!&|^~?:]+)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

    let out = '';
    let last = 0;
    const str = String(code ?? '');
    let m;
    while ((m = tokenRe.exec(str)) !== null) {
      if (m.index > last) out += esc(str.slice(last, m.index));
      const [full, com, strLit, num, op, ident] = m;
      if (com) {
        out += `<span class="tk-com">${esc(full)}</span>`;
      } else if (strLit) {
        out += `<span class="tk-str">${esc(full)}</span>`;
      } else if (num) {
        out += `<span class="tk-num">${esc(full)}</span>`;
      } else if (op) {
        out += `<span class="tk-op">${esc(full)}</span>`;
      } else if (ident) {
        const after = str.slice(m.index + full.length);
        if (kwSet.has(ident)) {
          out += `<span class="tk-kw">${esc(full)}</span>`;
        } else if (constSet.has(ident)) {
          out += `<span class="tk-num">${esc(full)}</span>`;
        } else if (/^\s*\(/.test(after)) {
          out += `<span class="tk-fn">${esc(full)}</span>`;
        } else if (/^\s*=[^=]/.test(after)) {
          out += `<span class="tk-type">${esc(full)}</span>`;
        } else {
          out += esc(full);
        }
      } else {
        out += esc(full);
      }
      last = m.index + full.length;
    }
    if (last < str.length) out += esc(str.slice(last));
    return out;
  }

  function renderInline(text) {
    // Protect inline code and inline math first
    const tokens = [];
    const stash = (html) => {
      const id = `\x00TK${tokens.length}\x00`;
      tokens.push(html);
      return id;
    };

    let raw = String(text ?? '');

    // Inline code `...`
    raw = raw.replace(/`([^`\n]+)`/g, (_, c) => {
      // R inline code `r expr`
      if (/^r\s+/i.test(c)) {
        return stash(`<code class="md-inline-r" title="Inline R expression">${ highlightCodeHtml(c.replace(/^r\s+/i, ''), 'r') }</code>`);
      }
      return stash(`<code>${esc(c)}</code>`);
    });

    // Inline math $...$ or \(...\)
    raw = raw.replace(/\\\(([^\n]+?)\\\)|\$(?!\$)\s*([^$\n]+?)\s*\$(?![$\d])/g, (whole, paren, dollar) => {
      const tex = paren ?? dollar;
      if (!tex || /^\d+\s+[A-Za-z]{2,}/.test(tex.trim())) return whole;
      return stash(renderTexHtml(tex, false));
    });

    // Images ![alt](url)
    raw = raw.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, url, title) => {
      const tAttr = title ? ` title="${esc(title)}"` : '';
      return stash(`<img class="md-img" src="${esc(url)}" alt="${esc(alt)}"${tAttr} loading="lazy">`);
    });

    // Links [text](url)
    raw = raw.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, url, title) => {
      const isExt = /^https?:\/\//i.test(url);
      const tAttr = title ? ` title="${esc(title)}"` : '';
      const targetAttr = isExt ? ' target="_blank" rel="noopener noreferrer"' : '';
      return stash(`<a href="${esc(url)}"${tAttr}${targetAttr}>${esc(label)}</a>`);
    });

    let s = esc(raw);
    // Bold + Italic
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    // Italic
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    // Strikethrough
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // Restore stashed HTML tokens
    s = s.replace(/\x00TK(\d+)\x00/g, (_, idx) => tokens[Number(idx)] || '');
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

  const ALERT_TYPES = {
    NOTE: { cls: 'note', icon: 'info', label: 'Note' },
    TIP: { cls: 'tip', icon: 'beaker', label: 'Tip' },
    IMPORTANT: { cls: 'important', icon: 'book', label: 'Important' },
    WARNING: { cls: 'warning', icon: 'warning', label: 'Warning' },
    CAUTION: { cls: 'caution', icon: 'error', label: 'Caution' }
  };

  function renderMarkdown(source, { onRunChunk } = {}) {
    const { meta, body } = parseFrontmatter(String(source ?? ''));
    const parts = [];
    const chunks = [];
    const headings = [];
    const slugCounts = new Map();

    const ico = (name, size = 13) => (window.StudioIcons ? window.StudioIcons.svg(name, { size }) : '');

    if (meta && (meta.title || meta.author || meta.date || meta.output || meta.subtitle)) {
      parts.push('<div class="md-frontmatter">');
      if (meta.title) parts.push(`<h1>${esc(meta.title)}</h1>`);
      if (meta.subtitle) parts.push(`<div class="md-subtitle">${esc(meta.subtitle)}</div>`);
      const info = [
        meta.author && `<span><strong>Author:</strong> ${esc(meta.author)}</span>`,
        meta.date && `<span><strong>Date:</strong> ${esc(meta.date === 'AUTOMATIC' ? new Date().toISOString().slice(0, 10) : meta.date)}</span>`,
        meta.output && `<span><strong>Output:</strong> <code>${esc(meta.output)}</code></span>`
      ].filter(Boolean);
      if (info.length) parts.push(`<div class="md-meta">${info.join('')}</div>`);
      parts.push('</div>');
    }

    const lines = body.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Display Math block $$...$$ or \[...\]
      const mathBlockMatch = line.match(/^\s*(\$\$|\\\[)\s*(.*)$/);
      if (mathBlockMatch) {
        const closeToken = mathBlockMatch[1] === '$$' ? '$$' : '\\]';
        const mathLines = [];
        const firstRest = mathBlockMatch[2];
        if (firstRest && firstRest.includes(closeToken)) {
          const inner = firstRest.slice(0, firstRest.indexOf(closeToken));
          parts.push(`<div class="md-math-block">${renderTexHtml(inner, true)}</div>`);
          i++;
          continue;
        }
        if (firstRest) mathLines.push(firstRest);
        i++;
        while (i < lines.length && !lines[i].includes(closeToken)) {
          mathLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) {
          const lastPart = lines[i].slice(0, lines[i].indexOf(closeToken));
          if (lastPart.trim()) mathLines.push(lastPart);
          i++;
        }
        parts.push(`<div class="md-math-block">${renderTexHtml(mathLines.join('\n'), true)}</div>`);
        continue;
      }

      // Fenced code block or R chunk
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
      if (fenceMatch) {
        const fenceChars = fenceMatch[1];
        const header = fenceMatch[2].trim();
        const isR = /^\{[ \t]*r\b/i.test(header) || /^r$/i.test(header) || /^\{[ \t]*webr\b/i.test(header);
        const langMatch = header.match(/^\{?\s*([A-Za-z0-9_+-]+)/);
        const lang = isR ? 'r' : (langMatch ? langMatch[1].toLowerCase() : 'plaintext');
        const codeLines = [];
        i++;
        const closeRe = new RegExp(`^\\s*${fenceChars[0]}{${fenceChars.length},}\\s*$`);
        while (i < lines.length && !closeRe.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        const code = codeLines.join('\n');
        const highlighted = highlightCodeHtml(code, lang);
        const copyIcon = ico('copy', 12);
        const encodedCode = encodeURIComponent(code);

        if (isR) {
          const idx = chunks.length;
          chunks.push(code);
          const playIcon = ico('play', 12);
          parts.push(
            `<div class="md-chunk" data-chunk-index="${idx}">` +
              `<div class="md-chunk-bar">` +
                `<span class="md-chunk-label">${ico('r-logo', 12)} <span>${esc(header || '{r}')}</span></span>` +
                `<div class="md-chunk-actions">` +
                  `<button type="button" class="icon-btn" data-copy-code="${encodedCode}" title="Copy Code">${copyIcon}</button>` +
                  `<button type="button" class="icon-btn run-accent" data-run-chunk="${idx}" title="Run Chunk">${playIcon}</button>` +
                `</div>` +
              `</div>` +
              `<pre class="md-code-pre"><code class="code-highlighted" data-lang="r">${highlighted}</code></pre>` +
            `</div>`
          );
        } else {
          parts.push(
            `<div class="md-chunk md-code-card">` +
              `<div class="md-chunk-bar">` +
                `<span class="md-chunk-label">${esc(lang || 'text')}</span>` +
                `<div class="md-chunk-actions">` +
                  `<button type="button" class="icon-btn" data-copy-code="${encodedCode}" title="Copy Code">${copyIcon}</button>` +
                `</div>` +
              `</div>` +
              `<pre class="md-code-pre"><code class="code-highlighted" data-lang="${esc(lang)}">${highlighted}</code></pre>` +
            `</div>`
          );
        }
        continue;
      }

      // Headings (# .. ######) with GitHub-style anchors
      const hMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        const rawText = hMatch[2].replace(/\s+#+\s*$/, '').trim();
        const base = headingSlug(rawText) || `section-${headings.length + 1}`;
        const count = slugCounts.get(base) || 0;
        slugCounts.set(base, count + 1);
        const slug = count ? `${base}-${count}` : base;
        headings.push({ level, text: rawText, slug });
        parts.push(`<h${level} id="${esc(slug)}" class="md-heading"><a class="md-anchor" href="#${esc(slug)}" aria-hidden="true">#</a>${renderInline(rawText)}</h${level}>`);
        i++;
        continue;
      }

      // Horizontal rule
      if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
        parts.push('<hr>');
        i++;
        continue;
      }

      // Blockquote or GitHub GFM Alert (> [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION])
      if (/^\s*>\s?/.test(line)) {
        const qLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          qLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        const alertMatch = (qLines[0] || '').match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
        if (alertMatch) {
          const kind = alertMatch[1].toUpperCase();
          const def = ALERT_TYPES[kind] || ALERT_TYPES.NOTE;
          const customTitle = alertMatch[2]?.trim() || def.label;
          const bodyLines = qLines.slice(1).filter((l, idx, arr) => !(idx === 0 && !l.trim() && arr.length > 1));
          parts.push(
            `<div class="md-alert md-alert-${def.cls}">` +
              `<div class="md-alert-title">${ico(def.icon, 14)}<span>${esc(customTitle)}</span></div>` +
              `<div class="md-alert-body">${renderInline(bodyLines.join(' '))}</div>` +
            `</div>`
          );
        } else {
          parts.push(`<blockquote>${qLines.map((l) => (l.trim() ? `<p>${renderInline(l)}</p>` : '')).join('')}</blockquote>`);
        }
        continue;
      }

      // Markdown table with column alignments
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
        const splitCells = (row) =>
          row
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim());
        const headers = splitCells(line);
        const aligns = splitCells(lines[i + 1]).map((a) => {
          if (/^:-+:$/.test(a)) return 'center';
          if (/^-+:$/.test(a)) return 'right';
          return 'left';
        });
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          rows.push(splitCells(lines[i]));
          i++;
        }
        parts.push(
          `<div class="md-table-wrap"><table><thead><tr>` +
            headers.map((h, colIdx) => `<th style="text-align:${aligns[colIdx] || 'left'}">${renderInline(h)}</th>`).join('') +
            `</tr></thead><tbody>` +
            rows
              .map(
                (r) =>
                  `<tr>${headers
                    .map((_, colIdx) => `<td style="text-align:${aligns[colIdx] || 'left'}">${renderInline(r[colIdx] ?? '')}</td>`)
                    .join('')}</tr>`
              )
              .join('') +
            `</tbody></table></div>`
        );
        continue;
      }

      // Unordered list (with GFM task list - [ ] / - [x] support)
      if (/^\s*[*+-]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[*+-]\s+/.test(lines[i])) {
          const itemText = lines[i].replace(/^\s*[*+-]\s+/, '');
          const taskMatch = itemText.match(/^\[([ xX])\]\s+(.*)$/);
          if (taskMatch) {
            const checked = taskMatch[1].toLowerCase() === 'x';
            items.push(
              `<li class="md-task-item"><input type="checkbox" disabled${checked ? ' checked' : ''}><span>${renderInline(taskMatch[2])}</span></li>`
            );
          } else {
            items.push(`<li>${renderInline(itemText)}</li>`);
          }
          i++;
        }
        parts.push(`<ul>${items.join('')}</ul>`);
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
        !/^\s*(?:#{1,6}\s|`{3,}|~{3,}|\$\$|\\\[|>\s?|[*+-]\s+|\d+\.\s+|(?:[-*_]\s*){3,}$)/.test(lines[i])
      ) {
        pLines.push(lines[i]);
        i++;
      }
      parts.push(`<p>${renderInline(pLines.join(' '))}</p>`);
    }

    return { html: parts.join('\n'), chunks, headings, meta, onRunChunk };
  }

  window.StudioMarkdownPreview = {
    renderMarkdown,
    highlightCodeHtml,
    renderTexHtml,
    headingSlug,
    headingFor
  };
})();
