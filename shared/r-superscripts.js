// Unicode superscripts in R code (6*1.8093², x⁻¹, 2¹⁰, e⁽ⁿ⁺¹⁾) are not valid R.
// rewriteSuperscripts() turns each run of superscript characters into R's ^
// operator before the code reaches R. Strings, raw strings, backtick names and
// comments are left untouched.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StudioSuperscripts = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SUP = {
    '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
    '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
    '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')',
    'ⁿ': 'n', 'ⁱ': 'i', '·': '.'
  };
  // '·' only counts as a decimal point inside a run that already started.
  const STARTERS = new Set(Object.keys(SUP).filter((c) => c !== '·'));
  const SUP_RE = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]/;

  function convertRun(run) {
    const plain = run.replace(/./gu, (c) => SUP[c]);
    // A bare number (x², 2¹⁰, 1.5²·⁵) needs no parentheses: ^ binds tightest.
    if (/^\d+(\.\d+)?$/.test(plain)) return `^${plain}`;
    if (/^\(.*\)$/.test(plain) && balanced(plain)) return `^${plain}`;
    return `^(${plain})`;
  }

  function balanced(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      if (depth === 0 && i < s.length - 1) return false;
    }
    return depth === 0;
  }

  function rewriteSuperscripts(code) {
    const src = String(code ?? '');
    if (!SUP_RE.test(src)) return src;
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      // Comment: copy to end of line
      if (c === '#') {
        const end = src.indexOf('\n', i);
        const stop = end === -1 ? n : end;
        out += src.slice(i, stop);
        i = stop;
        continue;
      }
      // Raw strings: r"(...)", R'[...]', r"---{...}---"
      if ((c === 'r' || c === 'R') && (src[i + 1] === '"' || src[i + 1] === "'") && !/[\w.]/.test(src[i - 1] || '')) {
        const m = /^[rR](["'])(-*)([([{])/.exec(src.slice(i, i + 64));
        if (m) {
          const close = { '(': ')', '[': ']', '{': '}' }[m[3]] + m[2] + m[1];
          const end = src.indexOf(close, i + m[0].length);
          const stop = end === -1 ? n : end + close.length;
          out += src.slice(i, stop);
          i = stop;
          continue;
        }
      }
      // Quoted strings and `backtick names`
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
        const stop = Math.min(n, j + 1);
        out += src.slice(i, stop);
        i = stop;
        continue;
      }
      if (STARTERS.has(c)) {
        let j = i;
        while (j < n && SUP[src[j]] !== undefined) j++;
        // A trailing '·' is a middle dot, not part of the exponent
        while (j > i && src[j - 1] === '·') j--;
        out += convertRun(src.slice(i, j));
        i = j;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  // R Markdown: rewrite only the code inside ```{r ...} chunks and `r inline` code.
  function rewriteSuperscriptsInRmd(text) {
    const src = String(text ?? '');
    if (!SUP_RE.test(src)) return src;
    const lines = src.split('\n');
    const out = [];
    let chunk = null; // lines of the R chunk being read
    let fence = '';
    for (const line of lines) {
      if (!chunk) {
        const open = /^(\s*)(`{3,})\s*\{\s*r\b/i.exec(line);
        if (open) {
          chunk = [];
          fence = open[2];
          out.push(line);
        } else {
          out.push(line.replace(/`r ([^`]*)`/g, (_m, expr) => '`r ' + rewriteSuperscripts(expr) + '`'));
        }
      } else if (new RegExp('^\\s*' + fence + '\\s*$').test(line)) {
        if (chunk.length) out.push(rewriteSuperscripts(chunk.join('\n')));
        out.push(line);
        chunk = null;
      } else {
        chunk.push(line);
      }
    }
    if (chunk && chunk.length) out.push(rewriteSuperscripts(chunk.join('\n')));
    return out.join('\n');
  }

  return { rewriteSuperscripts, rewriteSuperscriptsInRmd };
});
