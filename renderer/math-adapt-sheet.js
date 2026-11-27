(function () {
  'use strict';

  // Searchable bilingual Math Notation & LaTeX cheat sheet floating panel.
  // Shows custom shorthand notation alongside equivalent LaTeX, a live preview,
  // and bilingual EN / ES descriptions. Clicking an item inserts or copies it.

  let activeSheet = null;

  function el(tag, cls = '', text = '') {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function norm(s) {
    return String(s ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function renderLatexInto(target, latex) {
    if (!latex) {
      target.textContent = '';
      return;
    }
    if (window.katex && typeof window.katex.renderToString === 'function') {
      try {
        target.innerHTML = window.katex.renderToString(latex, { throwOnError: false, displayMode: false });
        return;
      } catch {
        // fall through
      }
    }
    if (window.StudioMarkdownPreview && typeof window.StudioMarkdownPreview.renderTexHtml === 'function') {
      try {
        target.innerHTML = window.StudioMarkdownPreview.renderTexHtml(latex, false);
        return;
      } catch {
        // fall through
      }
    }
    target.textContent = latex;
  }

  function positionSheet(sheet, anchor) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m = 10;
    const w = sheet.offsetWidth || Math.min(560, vw - m * 2);
    const h = sheet.offsetHeight || Math.min(480, vh - m * 2);
    let left = (vw - w) / 2;
    let top = Math.max(m, (vh - h) / 2);

    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      const r = anchor.getBoundingClientRect();
      if (r.width || r.height) {
        const spaceBelow = vh - r.bottom - m;
        const spaceAbove = r.top - m;
        if (spaceBelow >= Math.min(h, 260) || spaceBelow >= spaceAbove) {
          top = r.bottom + 6;
        } else {
          top = r.top - h - 6;
        }
        left = r.left;
        if (left + w + m > vw) left = r.right - w;
      }
    }

    left = Math.max(m, Math.min(vw - w - m, left));
    top = Math.max(m, Math.min(vh - h - m, top));
    sheet.style.left = `${left}px`;
    sheet.style.top = `${top}px`;
  }

  async function copyText(text, label, status) {
    try {
      await navigator.clipboard.writeText(text);
      status?.(`Copied ${label}: ${text}`);
    } catch {
      status?.('Could not copy to clipboard.', true);
    }
  }

  function closeMathAdaptSheet() {
    if (!activeSheet) return;
    const { sheet, cleanup } = activeSheet;
    activeSheet = null;
    cleanup();
    sheet.remove();
  }

  function openMathAdaptSheet({ anchor = null, onInsert = null, status = () => {} } = {}) {
    closeMathAdaptSheet();

    const sheet = el('div', 'math-adapt-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Math Notation & LaTeX');

    const head = el('div', 'math-sheet-head');
    const title = el('div', 'math-sheet-title', 'Math Notation & LaTeX / Notación matemática');
    const closeBtn = el('button', 'icon-btn math-sheet-close');
    closeBtn.type = 'button';
    closeBtn.title = 'Close (Esc)';
    closeBtn.setAttribute('aria-label', 'Close');
    if (window.StudioIcons?.svg) {
      closeBtn.innerHTML = window.StudioIcons.svg('close', { size: 14 });
    } else {
      closeBtn.textContent = 'x';
    }
    closeBtn.onclick = () => closeMathAdaptSheet();
    head.append(title, closeBtn);

    const searchWrap = el('div', 'math-sheet-search');
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search ES / EN, notation or LaTeX (e.g. sobre, desv, lim, binom)...';
    searchInput.setAttribute('aria-label', 'Search math notation or LaTeX');
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;
    searchWrap.append(searchInput);

    const list = el('div', 'math-sheet-list');
    sheet.append(head, searchWrap, list);

    document.body.append(sheet);

    const sections = Array.isArray(window.StudioMathAdapt?.MATH_ADAPT_CHEATSHEET)
      ? window.StudioMathAdapt.MATH_ADAPT_CHEATSHEET
      : [];

    function matchesItem(sec, item, terms) {
      if (!terms.length) return true;
      const tags = Array.isArray(item.tags) ? item.tags.join(' ') : String(item.tags || '');
      const hay = norm(
        [sec.titleEn, sec.titleEs, item.notation, item.example, item.latex, item.en, item.es, tags]
          .filter(Boolean)
          .join(' ')
      );
      return terms.every((t) => hay.includes(t));
    }

    function renderList() {
      const q = norm(searchInput.value.trim());
      const terms = q ? q.split(/\s+/).filter(Boolean) : [];
      const frag = document.createDocumentFragment();
      let count = 0;

      for (const sec of sections) {
        const items = (sec.items || []).filter((it) => matchesItem(sec, it, terms));
        if (!items.length) continue;
        count += items.length;

        const secEl = el('section', 'math-sheet-section');
        const secTitle = [sec.titleEn, sec.titleEs].filter(Boolean).join(' · ');
        secEl.append(el('div', 'math-sheet-section-title', secTitle));

        for (const item of items) {
          const snippet = item.example || item.notation || '';
          const latex = item.latex || '';
          const row = el('div', 'math-sheet-item');
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
          row.title = onInsert ? `Click to insert ${snippet}` : `Click to copy ${snippet}`;

          const top = el('div', 'math-sheet-item-top');
          const notationBadge = el('code', 'math-sheet-notation', item.notation || snippet);
          if (item.example && item.example !== item.notation) {
            notationBadge.title = `Example: ${item.example}`;
          }
          const latexBadge = el('code', 'math-sheet-latex', latex);
          const renderBox = el('div', 'math-sheet-render');
          renderBox.dataset.latex = latex;
          renderLatexInto(renderBox, latex);
          top.append(notationBadge, latexBadge, renderBox);

          const bottom = el('div', 'math-sheet-item-bottom');
          const descText = [item.en, item.es].filter(Boolean).join(' · ');
          const desc = el('div', 'math-sheet-desc', descText);

          const actions = el('div', 'math-sheet-actions');
          const copyNotBtn = el('button', 'math-sheet-copy', 'Notation');
          copyNotBtn.type = 'button';
          copyNotBtn.title = `Copy notation: ${snippet}`;
          copyNotBtn.onclick = (e) => {
            e.stopPropagation();
            copyText(snippet, 'notation', status);
          };
          const copyTexBtn = el('button', 'math-sheet-copy', 'LaTeX');
          copyTexBtn.type = 'button';
          copyTexBtn.title = `Copy LaTeX: ${latex}`;
          copyTexBtn.onclick = (e) => {
            e.stopPropagation();
            copyText(latex, 'LaTeX', status);
          };
          actions.append(copyNotBtn, copyTexBtn);

          bottom.append(desc, actions);
          row.append(top, bottom);

          const activate = async () => {
            if (typeof onInsert === 'function') {
              closeMathAdaptSheet();
              try {
                await onInsert(snippet);
                status?.(`Inserted: ${snippet}`);
              } catch (err) {
                status?.(err?.message || 'Could not insert notation.', true);
              }
            } else {
              await copyText(snippet || latex, snippet ? 'notation' : 'LaTeX', status);
            }
          };

          row.onclick = () => {
            activate();
          };
          row.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activate();
            }
          };

          secEl.append(row);
        }
        frag.append(secEl);
      }

      if (!count) {
        frag.append(el('div', 'math-sheet-empty', 'No matching notation / Sin resultados'));
      }
      list.replaceChildren(frag);
    }

    renderList();
    positionSheet(sheet, anchor);

    searchInput.addEventListener('input', renderList);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMathAdaptSheet();
      }
    });

    const onOutside = (e) => {
      if (!sheet.contains(e.target)) closeMathAdaptSheet();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMathAdaptSheet();
      }
    };
    const onResize = () => {
      if (sheet.isConnected) positionSheet(sheet, anchor);
    };

    const armTimer = setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
    }, 0);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);

    activeSheet = {
      sheet,
      cleanup: () => {
        clearTimeout(armTimer);
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onResize);
      }
    };

    requestAnimationFrame(() => {
      if (sheet.isConnected) searchInput.focus({ preventScroll: true });
    });

    return { close: closeMathAdaptSheet, el: sheet };
  }

  window.StudioMathAdaptSheet = {
    openMathAdaptSheet,
    closeMathAdaptSheet
  };
})();
