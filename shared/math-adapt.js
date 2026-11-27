(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StudioMathAdapt = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // On-demand "Math Adaptation" shorthand-to-LaTeX converter.
  // Turns fast keyboard shorthand (inspired by EST statistics/probability notes
  // and Omarchy Unicode quirks) into clean KaTeX/LaTeX.

  const SUPERSCRIPT_MAP = {
    '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
    '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
    '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')',
    'ⁿ': 'n', 'ⁱ': 'i', 'ˣ': 'x'
  };

  const SUBSCRIPT_MAP = {
    '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
    '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
    '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
    'ₐ': 'a', 'ₑ': 'e', 'ₓ': 'x', 'ᵢ': 'i', 'ⱼ': 'j', 'ₙ': 'n'
  };

  const SUPER_CHARS = Object.keys(SUPERSCRIPT_MAP).join('');
  const SUB_CHARS = Object.keys(SUBSCRIPT_MAP).join('');
  const SUPER_RUN_RE = new RegExp(`[${SUPER_CHARS}]+`, 'g');
  const SUB_RUN_RE = new RegExp(`[${SUB_CHARS}]+`, 'g');

  const GREEK_NAMES = [
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu',
    'pi', 'rho', 'sigma', 'tau', 'phi', 'chi', 'omega',
    'Sigma', 'Omega', 'Delta'
  ];
  const GREEK_SET = new Set(GREEK_NAMES);
  const GREEK_RE = new RegExp(
    `(?<![\\\\a-zA-Z\\u00C0-\\u024F])(${GREEK_NAMES.join('|')})(?![a-zA-Z\\u00C0-\\u024F])`,
    'g'
  );

  const UNICODE_GREEK = {
    'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
    'ε': '\\epsilon', 'θ': '\\theta', 'λ': '\\lambda', 'μ': '\\mu',
    'π': '\\pi', 'ρ': '\\rho', 'σ': '\\sigma', 'τ': '\\tau',
    'φ': '\\phi', 'χ': '\\chi', 'ω': '\\omega',
    'Σ': '\\Sigma', 'Ω': '\\Omega', 'Δ': '\\Delta'
  };
  const UNICODE_GREEK_RE = new RegExp(`[${Object.keys(UNICODE_GREEK).join('')}]`, 'g');

  const MATH_KEYWORDS = new Set([
    ...GREEK_NAMES,
    'sqrt', 'intr', 'int', 'lim', 'sum', 'prod', 'inf',
    'desv', 'sd', 'std', 'var', 'Var', 'cov', 'Cov', 'corr', 'Corr',
    'ECM', 'MSE', 'mediana', 'median', 'moda', 'mode', 'esp', 'Esp',
    'hat', 'vec', 'contraryOf', 'contraryof', 'sobre', 'over',
    'sin', 'cos', 'tan', 'log', 'ln', 'exp',
    'Bin', 'Exp', 'Pois', 'Geom', 'Unif', 'Hyper', 'Beta', 'Gamma'
  ]);

  const EST_OPERATORS = {
    desv: 'desv',
    sd: 'sd',
    std: 'std',
    var: 'Var',
    Var: 'Var',
    cov: 'Cov',
    Cov: 'Cov',
    corr: 'corr',
    Corr: 'corr',
    ECM: 'ECM',
    MSE: 'MSE',
    mediana: 'mediana',
    median: 'median',
    moda: 'moda',
    mode: 'mode'
  };

  function decodeMap(str, map) {
    return [...str].map((ch) => map[ch] ?? ch).join('');
  }

  function findMatchingDelim(str, openIdx, openCh = '(', closeCh = ')') {
    let depth = 0;
    for (let i = openIdx; i < str.length; i++) {
      const ch = str[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function splitTopLevel(str, sep = ',') {
    const parts = [];
    let depthParen = 0;
    let depthBracket = 0;
    let depthBrace = 0;
    let start = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '(') depthParen++;
      else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
      else if (ch === '[') depthBracket++;
      else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
      else if (ch === '{') depthBrace++;
      else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
      else if (depthParen === 0 && depthBracket === 0 && depthBrace === 0 && str.startsWith(sep, i)) {
        parts.push(str.slice(start, i));
        i += sep.length - 1;
        start = i + 1;
      }
    }
    parts.push(str.slice(start));
    return parts;
  }

  function hasTopLevelAddSub(str) {
    let depth = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
      else if (depth === 0 && i > 0 && (ch === '+' || ch === '-')) return true;
    }
    return false;
  }

  function stripOuterParens(raw) {
    let s = raw.trim();
    while (s.startsWith('(') && s.endsWith(')')) {
      const match = findMatchingDelim(s, 0, '(', ')');
      if (match === s.length - 1) {
        s = s.slice(1, -1).trim();
      } else {
        break;
      }
    }
    while (s.endsWith(')')) {
      let depth = 0;
      let unbalancedAtEnd = false;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') {
          depth--;
          if (depth < 0 && i === s.length - 1) unbalancedAtEnd = true;
        }
      }
      if (unbalancedAtEnd) {
        s = s.slice(0, -1).trim();
      } else {
        break;
      }
    }
    return s;
  }

  function isProseWord(token) {
    if (!/^[a-zA-Z\u00C0-\u024F]{2,}$/.test(token)) return false;
    if (MATH_KEYWORDS.has(token)) return false;
    return true;
  }

  function formatAnnotationNote(rawNote) {
    const note = stripOuterParens(rawNote);
    if (!note) return '';

    const hasMathSyntax = /[=<>+\-*/^_()[\]{}~\\0-9≤≥≠≈]/.test(note);
    if (!hasMathSyntax) {
      const words = note.split(/\s+/);
      const hasGreekOrInf = words.some((w) => GREEK_SET.has(w) || w === 'inf');
      if (!hasGreekOrInf) {
        return `\\text{${note}}`;
      }
    }

    const tokens = note.split(/(\s+)/);
    const kinds = tokens.map((tok) => {
      if (/^\s+$/.test(tok)) return 'space';
      if (isProseWord(tok)) return 'prose';
      if (/^[ayoeuAYOEU]$/.test(tok)) return 'connector';
      return 'math';
    });

    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] !== 'connector') continue;
      let prevKind = null;
      for (let j = i - 1; j >= 0; j--) {
        if (kinds[j] !== 'space') { prevKind = kinds[j]; break; }
      }
      let nextKind = null;
      for (let j = i + 1; j < kinds.length; j++) {
        if (kinds[j] !== 'space') { nextKind = kinds[j]; break; }
      }
      if (prevKind === 'prose' && nextKind === 'prose') {
        kinds[i] = 'prose';
      } else {
        kinds[i] = 'math';
      }
    }

    const out = [];
    let i = 0;
    while (i < tokens.length) {
      if (kinds[i] === 'space') {
        i++;
        continue;
      }
      if (kinds[i] === 'prose') {
        let buf = '';
        while (i < tokens.length && (kinds[i] === 'prose' || kinds[i] === 'space')) {
          if (kinds[i] === 'space') {
            let nextNonSpace = i + 1;
            while (nextNonSpace < tokens.length && kinds[nextNonSpace] === 'space') nextNonSpace++;
            if (nextNonSpace >= tokens.length) {
              i = nextNonSpace;
              break;
            }
            if (kinds[nextNonSpace] === 'math') {
              buf += ' ';
              i = nextNonSpace;
              break;
            }
            buf += ' ';
            i++;
          } else {
            buf += tokens[i];
            i++;
          }
        }
        out.push(`\\text{${buf}}`);
      } else {
        let buf = '';
        while (i < tokens.length && (kinds[i] === 'math' || kinds[i] === 'space')) {
          if (kinds[i] === 'space') {
            let nextNonSpace = i + 1;
            while (nextNonSpace < tokens.length && kinds[nextNonSpace] === 'space') nextNonSpace++;
            if (nextNonSpace >= tokens.length || kinds[nextNonSpace] === 'prose') {
              i = nextNonSpace;
              break;
            }
            buf += ' ';
            i++;
          } else {
            buf += tokens[i];
            i++;
          }
        }
        const adapted = adaptMathToLatex(buf.trim());
        if (out.length > 0) {
          out.push(' ');
        }
        out.push(adapted);
        if (i < tokens.length && kinds[i] === 'prose') {
          out.push(' ');
        }
      }
    }

    return out.join('').replace(/\s+/g, ' ').trim();
  }

  function replaceAnnotatedOperators(str, protect) {
    let s = str;

    s = s.replace(/(?:<=|≤)(\S[^\n]*?\S|\S)=>/g, (full, body) => {
      if (body.includes('=>') || body.includes('<=')) return full;
      const note = formatAnnotationNote(body);
      return protect(`\\overset{${note}}{\\iff}`);
    });

    s = s.replace(/(?<![<>=!])=(\S[^\n]*?\S|\S)=>/g, (full, body) => {
      if (body.includes('=>') || body.includes('<=')) return full;
      const note = formatAnnotationNote(body);
      return protect(`\\overset{${note}}{\\Rightarrow}`);
    });

    s = s.replace(/(?:->|(?<=^|\s)-)\(([^\n)]+)\)->/g, (full, body) => {
      const note = formatAnnotationNote(body);
      return protect(`\\overset{${note}}{\\longrightarrow}`);
    });
    s = s.replace(/(?<=^|\s)-(\S[^\n]*?\S)->/g, (full, body) => {
      if (body.includes('->')) return full;
      if (!/[a-zA-Z\u00C0-\u024F]/.test(body)) return full;
      const note = formatAnnotationNote(body);
      return protect(`\\overset{${note}}{\\longrightarrow}`);
    });

    s = s.replace(/(?<![<>=!])=\(([^\n)]+)\)=(?![=>])/g, (full, body) => {
      const note = formatAnnotationNote(body);
      return protect(`\\overset{${note}}{=}`);
    });
    s = s.replace(/(?<=^|\s)=(\S[^\n]*?\S)=(?=\s|$)/g, (full, body) => {
      if (!/[a-zA-Z\u00C0-\u024F]{2,}/.test(body)) return full;
      const note = formatAnnotationNote(body);
      return protect(`\\overset{${note}}{=}`);
    });

    return s;
  }

  function repairOmarchyAndUnicode(str) {
    let s = str;

    s = s.replace(/[−]/g, '-');
    s = s.replace(/[×]/g, '*');
    s = s.replace(/[÷]/g, '/');

    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '⁽') {
        let depth = 1;
        let j = i + 1;
        while (j < s.length && depth > 0) {
          if (s[j] === '(' || s[j] === '⁽') depth++;
          else if (s[j] === ')' || s[j] === '⁾') depth--;
          j++;
        }
        if (depth === 0) {
          const inner = decodeMap(s.slice(i + 1, j - 1), SUPERSCRIPT_MAP);
          out += `^(${inner})`;
          i = j - 1;
          continue;
        }
      }
      if (s[i] === '₍') {
        let depth = 1;
        let j = i + 1;
        while (j < s.length && depth > 0) {
          if (s[j] === '(' || s[j] === '₍') depth++;
          else if (s[j] === ')' || s[j] === '₎') depth--;
          j++;
        }
        if (depth === 0) {
          const inner = decodeMap(s.slice(i + 1, j - 1), SUBSCRIPT_MAP);
          out += `_(${inner})`;
          i = j - 1;
          continue;
        }
      }
      out += s[i];
    }
    s = out;

    out = '';
    for (let i = 0; i < s.length; i++) {
      if ((s[i] === '⁻' || s[i] === '⁺') && (s[i + 1] === '(' || (s[i + 1] === '^' && s[i + 2] === '('))) {
        const sign = s[i] === '⁻' ? '-' : '+';
        const parenIdx = s[i + 1] === '(' ? i + 1 : i + 2;
        const closeIdx = findMatchingDelim(s, parenIdx, '(', ')');
        if (closeIdx !== -1) {
          const inner = decodeMap(s.slice(parenIdx + 1, closeIdx), SUPERSCRIPT_MAP);
          const body = hasTopLevelAddSub(inner) ? `${sign}(${inner})` : `${sign}${inner}`;
          out += `^(${body})`;
          i = closeIdx;
          continue;
        }
      }
      if ((s[i] === '⁻' || s[i] === '⁺') && s[i + 1] === '^') {
        const sign = s[i] === '⁻' ? '-' : '+';
        out += `^${sign}`;
        i++;
        continue;
      }
      out += s[i];
    }
    s = out;

    s = s.replace(SUPER_RUN_RE, (run) => {
      let decoded = decodeMap(run, SUPERSCRIPT_MAP);
      if (decoded.startsWith('(') && decoded.endsWith(')') && findMatchingDelim(decoded, 0) === decoded.length - 1) {
        decoded = decoded.slice(1, -1);
      }
      return `^{${decoded}}`;
    });

    s = s.replace(SUB_RUN_RE, (run) => {
      let decoded = decodeMap(run, SUBSCRIPT_MAP);
      if (decoded.startsWith('(') && decoded.endsWith(')') && findMatchingDelim(decoded, 0) === decoded.length - 1) {
        decoded = decoded.slice(1, -1);
      }
      return `_{${decoded}}`;
    });

    s = s.replace(/≤/g, '<=');
    s = s.replace(/≥/g, '>=');
    s = s.replace(/≠/g, '!=');
    s = s.replace(/≈/g, '\\approx');
    s = s.replace(/±/g, '\\pm');
    s = s.replace(/∞/g, '\\infty');
    s = s.replace(/√\(/g, 'sqrt(');
    s = s.replace(/√([a-zA-Z0-9]+)/g, 'sqrt($1)');
    s = s.replace(UNICODE_GREEK_RE, (ch) => UNICODE_GREEK[ch]);

    return s;
  }

  function isSingleMathSymbol(s) {
    const t = s.trim();
    if (t.length === 1) return true;
    if (GREEK_SET.has(t)) return true;
    if (/^\\[a-zA-Z]+$/.test(t)) return true;
    return false;
  }

  function applyDiacritic(singleCmd, wideCmd, target) {
    const t = target.trim();
    const cmd = isSingleMathSymbol(t) ? singleCmd : wideCmd;
    return `\\${cmd}{${t}}`;
  }

  function replaceNamedCall(str, nameRegex, handler) {
    let s = str;
    let safety = 0;
    while (safety++ < 64) {
      nameRegex.lastIndex = 0;
      const m = nameRegex.exec(s);
      if (!m) break;
      const matchStart = m.index;
      const openIdx = matchStart + m[0].length - 1;
      const openCh = s[openIdx];
      const closeCh = openCh === '(' ? ')' : openCh === '{' ? '}' : ']';
      const closeIdx = findMatchingDelim(s, openIdx, openCh, closeCh);
      if (closeIdx === -1) break;
      const inner = s.slice(openIdx + 1, closeIdx);
      const replacement = handler(m, inner, openCh, closeCh);
      if (replacement === null) break;
      s = s.slice(0, matchStart) + replacement + s.slice(closeIdx + 1);
    }
    return s;
  }

  function replacePrefixDiacritics(str) {
    let s = str;

    s = s.replace(/~\^=|~=/g, '\\approx');

    const replacePrefixOp = (input, prefixRe, singleCmd, wideCmd) => {
      let cur = input;
      let safety = 0;
      while (safety++ < 64) {
        prefixRe.lastIndex = 0;
        const m = prefixRe.exec(cur);
        if (!m) break;
        const start = m.index;
        const afterPrefix = start + m[0].length;
        if (cur[afterPrefix] === '(') {
          const closeIdx = findMatchingDelim(cur, afterPrefix, '(', ')');
          if (closeIdx === -1) break;
          const inner = cur.slice(afterPrefix + 1, closeIdx);
          const rep = `\\${wideCmd}{${inner}}`;
          cur = cur.slice(0, start) + rep + cur.slice(closeIdx + 1);
        } else {
          const rest = cur.slice(afterPrefix);
          const tokMatch = rest.match(/^(\\[a-zA-Z]+|[a-zA-Z]+|\d+)/);
          if (!tokMatch) break;
          const tok = tokMatch[1];
          const rep = applyDiacritic(singleCmd, wideCmd, tok);
          cur = cur.slice(0, start) + rep + cur.slice(afterPrefix + tok.length);
        }
      }
      return cur;
    };

    s = replacePrefixOp(s, /->\^/g, 'vec', 'overrightarrow');
    s = replacePrefixOp(s, /-\^/g, 'bar', 'overline');
    s = replacePrefixOp(s, /~\^/g, 'tilde', 'widetilde');
    s = replacePrefixOp(s, /\^\^/g, 'hat', 'widehat');

    s = replaceNamedCall(s, /(?<![\\a-zA-Z0-9_])contrary[Oo]f\(/g, (_m, inner) =>
      applyDiacritic('bar', 'overline', inner)
    );
    s = replaceNamedCall(s, /(?<![\\a-zA-Z0-9_])hat\(/g, (_m, inner) =>
      applyDiacritic('hat', 'widehat', inner)
    );
    s = replaceNamedCall(s, /(?<![\\a-zA-Z0-9_])vec\(/g, (_m, inner) =>
      applyDiacritic('vec', 'overrightarrow', inner)
    );

    return s;
  }

  function findTopLevelKeyword(str, kwRe) {
    let depthParen = 0;
    let depthBracket = 0;
    let depthBrace = 0;
    const globalRe = new RegExp(kwRe.source, kwRe.flags.includes('g') ? kwRe.flags : kwRe.flags + 'g');
    const depths = new Int32Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      depths[i] = depthParen + depthBracket + depthBrace;
      if (ch === '(') depthParen++;
      else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
      else if (ch === '[') depthBracket++;
      else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
      else if (ch === '{') depthBrace++;
      else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    }
    let m;
    while ((m = globalRe.exec(str)) !== null) {
      if (depths[m.index] === 0) {
        return { start: m.index, end: m.index + m[0].length };
      }
    }
    return null;
  }

  function replaceCombinations(str) {
    let s = str;
    let safety = 0;
    while (safety++ < 64) {
      let changed = false;
      for (let i = 0; i < s.length; i++) {
        if (s[i] !== '(') continue;
        const closeIdx = findMatchingDelim(s, i, '(', ')');
        if (closeIdx === -1) continue;
        const inner = s.slice(i + 1, closeIdx);
        const splitMatch = findTopLevelKeyword(inner, /\b(?:sobre|over)\b/i);
        if (!splitMatch) continue;
        const top = inner.slice(0, splitMatch.start).trim();
        const bot = inner.slice(splitMatch.end).trim();
        if (!top || !bot) continue;

        let replaceStart = i;
        if (i > 0 && s[i - 1] === 'C' && (i === 1 || !/[a-zA-Z0-9_\\]/.test(s[i - 2]))) {
          replaceStart = i - 1;
        }
        const rep = `\\binom{${top}}{${bot}}`;
        s = s.slice(0, replaceStart) + rep + s.slice(closeIdx + 1);
        changed = true;
        break;
      }
      if (!changed) break;
    }
    return s;
  }

  function replaceCalculusAndFunctions(str) {
    let s = str;

    s = replaceNamedCall(s, /(?<![\\a-zA-Z0-9_])sqrt\[([^\]]+)\]\(/g, (m, inner) => {
      return `\\sqrt[${m[1].trim()}]{${inner.trim()}}`;
    });

    s = replaceNamedCall(s, /(?<![\\a-zA-Z0-9_])sqrt\(/g, (_m, inner) => {
      return `\\sqrt{${inner.trim()}}`;
    });

    s = replaceNamedCall(s, /(?<![\\a-zA-Z0-9_])intr?\(/g, (_m, inner) => {
      const trimmed = inner.trim();
      if (!trimmed) return '\\int';
      const args = splitTopLevel(trimmed, ',').map((a) => a.trim());
      const appendDiff = (expr, varName) => {
        if (/(?:\\,)?d[a-zA-Z]$/.test(expr)) return expr;
        return `${expr}\\,d${varName}`;
      };
      if (args.length === 1) {
        return `\\int ${appendDiff(args[0], 'x')}`;
      }
      if (args.length === 2) {
        if (/^[a-zA-Z]$/.test(args[1])) {
          return `\\int ${appendDiff(args[0], args[1])}`;
        }
        return `\\int_{${args[0]}}^{${args[1]}}`;
      }
      if (args.length === 3) {
        return `\\int_{${args[0]}}^{${args[1]}} ${appendDiff(args[2], 'x')}`;
      }
      return `\\int_{${args[0]}}^{${args[1]}} ${appendDiff(args[2], args[3])}`;
    });

    s = replaceNamedCall(s, /(?<![\\a-zA-Z0-9_])lim\(/g, (_m, inner) => {
      const t = inner.trim();
      if (!t) return '\\lim';
      const arrowMatch = t.match(/^(.+?)\s*->\s*(.+)$/);
      if (arrowMatch) {
        return `\\lim_{${arrowMatch[1].trim()} \\to ${arrowMatch[2].trim()}}`;
      }
      return `\\lim_{${t} \\to \\infty}`;
    });

    for (const fn of ['sum', 'prod']) {
      const re = new RegExp(`(?<![\\\\a-zA-Z0-9_])${fn}\\(`, 'g');
      s = replaceNamedCall(s, re, (_m, inner) => {
        const t = inner.trim();
        if (!t) return `\\${fn}`;
        const rangeParts = splitTopLevel(t, '..');
        if (rangeParts.length === 2) {
          return `\\${fn}_{${rangeParts[0].trim()}}^{${rangeParts[1].trim()}}`;
        }
        const args = splitTopLevel(t, ',').map((a) => a.trim());
        if (args.length === 1) return `\\${fn}_{${args[0]}}`;
        if (args.length === 2) return `\\${fn}_{${args[0]}}^{${args[1]}}`;
        return `\\${fn}_{${args[0]}}^{${args[1]}} ${args.slice(2).join(', ')}`;
      });
    }

    return s;
  }

  function findTopLevelChar(str, target) {
    let depthParen = 0;
    let depthBracket = 0;
    let depthBrace = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '\\') { i++; continue; }
      if (ch === '(') depthParen++;
      else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
      else if (ch === '[') depthBracket++;
      else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
      else if (ch === '{') depthBrace++;
      else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
      else if (depthParen === 0 && depthBracket === 0 && depthBrace === 0 && ch === target) {
        return i;
      }
    }
    return -1;
  }

  function replaceConditionalProbability(str) {
    let s = str;
    const re = /(?<![\\a-zA-Z0-9_])P\(/g;
    let searchFrom = 0;
    let safety = 0;
    while (safety++ < 64) {
      re.lastIndex = searchFrom;
      const m = re.exec(s);
      if (!m) break;
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingDelim(s, openIdx, '(', ')');
      if (closeIdx === -1) break;
      const inner = s.slice(openIdx + 1, closeIdx);
      const slashIdx = findTopLevelChar(inner, '/');
      if (slashIdx !== -1) {
        const left = inner.slice(0, slashIdx).trim();
        const right = inner.slice(slashIdx + 1).trim();
        const hasRel = (part) => /(?:<=|>=|!=|[<> =]|\\le|\\ge|\\neq)/.test(part.replace(/\s+/g, ''));
        const hasSpacesAroundSlash = inner[slashIdx - 1] === ' ' && inner[slashIdx + 1] === ' ';
        const isBareNumber = (part) => /^\d+(?:\.\d+)?$/.test(part);
        const isConditional =
          (hasRel(left) && hasRel(right)) ||
          (hasSpacesAroundSlash && left.length > 0 && right.length > 0 && !isBareNumber(left) && !isBareNumber(right));

        if (isConditional) {
          const formatEvent = (ev) =>
            ev.replace(/\s*(<=|>=|!=|<|>|=)\s*/g, ' $1 ').replace(/\s+/g, ' ').trim();
          const newInner = `${formatEvent(left)} \\mid ${formatEvent(right)}`;
          s = s.slice(0, openIdx + 1) + newInner + s.slice(closeIdx);
          searchFrom = openIdx + 1 + newInner.length + 1;
          continue;
        }
      }
      searchFrom = openIdx + 1;
    }
    return s;
  }

  function replaceEstOperators(str) {
    let s = str;

    s = replaceNamedCall(s, /(?<![\\a-zA-Z0-9_])[Ee]sp\s*[(\[]/g, (_m, inner) => {
      return `E[${inner.trim()}]`;
    });

    s = s.replace(/(?<![\\a-zA-Z0-9_])IC(?=_)/g, '\\text{IC}');

    const opNames = Object.keys(EST_OPERATORS).join('|');
    const opRe = new RegExp(`(?<![\\\\a-zA-Z0-9_])(${opNames})([(\\[])`, 'g');
    s = s.replace(opRe, (_full, name, delim) => {
      return `\\operatorname{${EST_OPERATORS[name]}}${delim}`;
    });

    return s;
  }

  function replaceExponentsAndSubscripts(str) {
    let s = str;

    let safety = 0;
    while (safety++ < 64) {
      const idx = s.indexOf('^(');
      if (idx === -1) break;
      const closeIdx = findMatchingDelim(s, idx + 1, '(', ')');
      if (closeIdx === -1) break;
      const inner = s.slice(idx + 2, closeIdx);
      s = s.slice(0, idx) + `^{${inner}}` + s.slice(closeIdx + 1);
    }

    safety = 0;
    while (safety++ < 64) {
      const idx = s.indexOf('_(');
      if (idx === -1) break;
      const closeIdx = findMatchingDelim(s, idx + 1, '(', ')');
      if (closeIdx === -1) break;
      const inner = s.slice(idx + 2, closeIdx).replace(/;\s*/g, ';\\,');
      s = s.slice(0, idx) + `_{${inner}}` + s.slice(closeIdx + 1);
    }

    s = s.replace(/\^(?!\{)([+-]?(?:\d+(?:\.\d+)?|\\[a-zA-Z]+|[a-zA-Z]+))/g, '^{$1}');
    s = s.replace(/_(?!\{)(\d+(?:\.\d+)?|\\[a-zA-Z]+|[a-zA-Z]+)/g, '_{$1}');

    return s;
  }

  function replaceParenthesizedFractions(str) {
    let s = str;
    let safety = 0;
    while (safety++ < 64) {
      let changed = false;
      for (let i = 0; i < s.length; i++) {
        if (s[i] !== '/') continue;

        let leftEnd = i - 1;
        while (leftEnd >= 0 && s[leftEnd] === ' ') leftEnd--;
        if (leftEnd < 0 || s[leftEnd] !== ')') continue;

        let depth = 0;
        let leftStart = -1;
        for (let j = leftEnd; j >= 0; j--) {
          if (s[j] === ')') depth++;
          else if (s[j] === '(') {
            depth--;
            if (depth === 0) { leftStart = j; break; }
          }
        }
        if (leftStart === -1) continue;
        if (leftStart > 0 && /[a-zA-Z0-9_}]/.test(s[leftStart - 1])) continue;

        let rightStart = i + 1;
        while (rightStart < s.length && s[rightStart] === ' ') rightStart++;
        if (rightStart >= s.length || s[rightStart] !== '(') continue;

        const rightEnd = findMatchingDelim(s, rightStart, '(', ')');
        if (rightEnd === -1) continue;

        const num = s.slice(leftStart + 1, leftEnd).trim();
        const den = s.slice(rightStart + 1, rightEnd).trim();
        const rep = `\\frac{${num}}{${den}}`;
        s = s.slice(0, leftStart) + rep + s.slice(rightEnd + 1);
        changed = true;
        break;
      }
      if (!changed) break;
    }
    return s;
  }

  function replaceRelationsAndSymbols(str) {
    let s = str;

    s = s.replace(/(?<!\\)~(?![=^])/g, '\\sim');

    s = s.replace(/<=>/g, '\\iff');
    s = s.replace(/=>/g, '\\Rightarrow');
    s = s.replace(/->/g, '\\to');
    s = s.replace(/<-/g, '\\leftarrow');
    s = s.replace(/<=/g, '\\le');
    s = s.replace(/>=/g, '\\ge');
    s = s.replace(/!=/g, '\\neq');
    s = s.replace(/\+-/g, '\\pm');

    s = s.replace(/\s*\*\s*/g, ' \\cdot ');
    s = s.replace(/(?<![\\a-zA-Z0-9\u00C0-\u024F])inf(?![a-zA-Z0-9\u00C0-\u024F])/g, '\\infty');
    s = s.replace(GREEK_RE, (_m, name) => `\\${name}`);

    return s;
  }

  /**
   * Pure function converting shorthand math notation to clean LaTeX (without `$` delimiters).
   * @param {string} input
   * @returns {string}
   */
  function adaptMathToLatex(input) {
    if (input == null) return '';
    let s = String(input).replace(/\r\n/g, '\n').trim();
    if (!s) return '';

    const placeholders = [];
    const protect = (latex) => {
      const token = `\x00MA${placeholders.length}\x00`;
      placeholders.push(latex);
      return token;
    };

    s = replaceNamedCall(s, /\\text\{/g, (_m, inner) => protect(`\\text{${inner}}`));
    s = replaceAnnotatedOperators(s, protect);
    s = repairOmarchyAndUnicode(s);
    s = replacePrefixDiacritics(s);
    s = replaceCombinations(s);
    s = replaceCalculusAndFunctions(s);
    s = replaceConditionalProbability(s);
    s = replaceEstOperators(s);
    s = replaceExponentsAndSubscripts(s);
    s = replaceParenthesizedFractions(s);
    s = replaceRelationsAndSymbols(s);

    s = s.replace(/\x00MA(\d+)\x00/g, (_m, idx) => placeholders[Number(idx)]);
    s = s.replace(/[ \t]{2,}/g, ' ').trim();

    return s;
  }

  /**
   * Adapts shorthand math to LaTeX and wraps it with `$...$` or `$$...$$`.
   * @param {string} input
   * @param {{ wrap?: 'auto' | 'inline' | 'block' | 'none' }} [options]
   * @returns {string}
   */
  function adaptMath(input, { wrap = 'auto' } = {}) {
    if (input == null) return '';
    let raw = String(input).replace(/\r\n/g, '\n').trim();
    if (!raw) return '';

    let wasBlock = false;

    if (raw.startsWith('$$') && raw.endsWith('$$') && raw.length >= 4) {
      const inner = raw.slice(2, -2);
      if (!inner.includes('$$')) {
        raw = inner.trim();
        wasBlock = true;
      }
    } else if (raw.startsWith('$') && raw.endsWith('$') && raw.length >= 2) {
      const inner = raw.slice(1, -1);
      if (!/(?<!\\)\$/.test(inner)) {
        raw = inner.trim();
      }
    }

    if (!raw) return '';

    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) return '';

    const isMultiline = lines.length > 1;
    const effectiveWrap = wrap === 'auto' ? (isMultiline || wasBlock ? 'block' : 'inline') : wrap;

    const adaptedLines = lines.map((line) => adaptMathToLatex(line));

    if (effectiveWrap === 'none') {
      return adaptedLines.join('\n');
    }

    if (effectiveWrap === 'inline') {
      return `$${adaptedLines.join(' \\\\ ')}$`;
    }

    if (isMultiline) {
      const alreadyAligned =
        adaptedLines[0].startsWith('\\begin{aligned}') &&
        adaptedLines[adaptedLines.length - 1].endsWith('\\end{aligned}');
      if (alreadyAligned) {
        return `$$\n${adaptedLines.join('\n')}\n$$`;
      }
      return `$$\n\\begin{aligned}\n${adaptedLines.join(' \\\\\n')}\n\\end{aligned}\n$$`;
    }

    return `$$${adaptedLines[0]}$$`;
  }

  /**
   * Bilingual (English + Spanish) cheatsheet for Math Adaptation UI & search.
   */
  const MATH_ADAPT_CHEATSHEET = [
    {
      titleEn: 'Diacritics & Prefix-Over Marks',
      titleEs: 'Diacríticos y marcas superiores',
      items: [
        {
          notation: '-^x / -^(x+y)',
          example: '-^X',
          latex: '\\bar{X}',
          en: 'Sample mean / bar over symbol',
          es: 'Media muestral / barra superior',
          tags: ['bar', 'mean', 'media', 'barra', 'overline', 'complement']
        },
        {
          notation: 'contraryOf(x)',
          example: 'contraryOf(A)',
          latex: '\\bar{A}',
          en: 'Complement / contrary event',
          es: 'Suceso contrario / complementario',
          tags: ['complement', 'contrary', 'contrario', 'suceso', 'bar']
        },
        {
          notation: '~^X / ~^(X+Y)',
          example: '~^X',
          latex: '\\tilde{X}',
          en: 'Tilde over symbol or expression',
          es: 'Virgulilla / tilde superior',
          tags: ['tilde', 'virgulilla', 'median', 'mediana']
        },
        {
          notation: '^^theta / hat(p)',
          example: '^^theta',
          latex: '\\hat{\\theta}',
          en: 'Estimator hat accent',
          es: 'Estimador / sombrero (hat)',
          tags: ['hat', 'estimator', 'estimador', 'sombrero', 'gorro']
        },
        {
          notation: '->^v / vec(v)',
          example: '->^v',
          latex: '\\vec{v}',
          en: 'Vector arrow over symbol',
          es: 'Flecha de vector',
          tags: ['vec', 'vector', 'arrow', 'flecha']
        },
        {
          notation: '~^= / ~=',
          example: 'pi ~= 3.14',
          latex: '\\pi \\approx 3.14',
          en: 'Approximately equal',
          es: 'Aproximadamente igual',
          tags: ['approx', 'aproximado', 'casi igual']
        }
      ]
    },
    {
      titleEn: 'Exponents, Subscripts & Unicode Repair',
      titleEs: 'Exponentes, subíndices y reparación Unicode',
      items: [
        {
          notation: 'x^(n-1) / 10^-2',
          example: '(1-p)^(n-k)',
          latex: '(1-p)^{n-k}',
          en: 'Parenthesized and negative exponents',
          es: 'Exponentes con paréntesis y negativos',
          tags: ['power', 'exponent', 'potencia', 'exponente']
        },
        {
          notation: '0.82⁵ / (1-0.82)⁽8-5⁾',
          example: '(1-0.82)⁽8-5⁾',
          latex: '(1-0.82)^{8-5}',
          en: 'Repairs Unicode and partial Omarchy superscripts',
          es: 'Repara superíndices Unicode y parciales de Omarchy',
          tags: ['unicode', 'omarchy', 'superscript', 'superindice']
        },
        {
          notation: 'e⁻^(lambda*15)',
          example: 'e⁻^(lambda*15)',
          latex: 'e^{-\\lambda \\cdot 15}',
          en: 'Repairs split negative Unicode exponents',
          es: 'Repara exponentes negativos partidos',
          tags: ['exponential', 'exponencial', 'omarchy', 'unicode']
        },
        {
          notation: 't_(n-1; alpha/2)',
          example: 't_(n-1; alpha/2)',
          latex: 't_{n-1;\\,\\alpha/2}',
          en: 'Grouped subscripts with semicolon spacing',
          es: 'Subíndices agrupados con punto y coma',
          tags: ['subscript', 'subindice', 'student', 'cuantil', 'quantile']
        },
        {
          notation: 'C_(5,6) / IC_(1-alpha)',
          example: 'IC_(1-alpha)',
          latex: '\\text{IC}_{1-\\alpha}',
          en: 'Indexed symbols and confidence intervals',
          es: 'Símbolos indexados e intervalos de confianza',
          tags: ['ic', 'ci', 'confidence', 'confianza', 'intervalo', 'subscript']
        }
      ]
    },
    {
      titleEn: 'Combinations & Fractions',
      titleEs: 'Combinaciones y fracciones',
      items: [
        {
          notation: '(n sobre k) / (n over k)',
          example: '(8 sobre 5)',
          latex: '\\binom{8}{5}',
          en: 'Binomial coefficient (Spanish or English)',
          es: 'Número combinatorio (sobre / over)',
          tags: ['binom', 'combinatoria', 'combinations', 'sobre', 'over']
        },
        {
          notation: 'C(k sobre n)',
          example: 'C(5 sobre 8)',
          latex: '\\binom{5}{8}',
          en: 'Combination shorthand with C(...)',
          es: 'Combinaciones con C(...)',
          tags: ['binom', 'combinaciones', 'combinations']
        },
        {
          notation: '(a + b) / (c + d)',
          example: '(a + b) / (c + d)',
          latex: '\\frac{a + b}{c + d}',
          en: 'Parenthesized fraction',
          es: 'Fracción entre paréntesis',
          tags: ['frac', 'fraction', 'fraccion', 'division']
        }
      ]
    },
    {
      titleEn: 'Calculus & Big Operators',
      titleEs: 'Cálculo y operadores grandes',
      items: [
        {
          notation: 'sqrt(x) / sqrt[n](x)',
          example: 'sqrt[3](x)',
          latex: '\\sqrt[3]{x}',
          en: 'Square root and n-th root',
          es: 'Raíz cuadrada y raíz n-ésima',
          tags: ['sqrt', 'root', 'raiz']
        },
        {
          notation: 'intr(a, b, f(x))',
          example: 'intr(0, inf, f(x))',
          latex: '\\int_{0}^{\\infty} f(x)\\,dx',
          en: 'Indefinite or definite integral (intr or int)',
          es: 'Integral indefinida o definida (intr o int)',
          tags: ['integral', 'intr', 'int', 'calculus', 'calculo']
        },
        {
          notation: 'lim(x->inf) / lim(x)',
          example: 'lim(x)',
          latex: '\\lim_{x \\to \\infty}',
          en: 'Limit (defaults to infinity if target omitted)',
          es: 'Límite (por defecto tiende a infinito)',
          tags: ['lim', 'limit', 'limite', 'infinity', 'infinito']
        },
        {
          notation: 'sum(i=1, n) / prod(i=1..n)',
          example: 'sum(i=1, n)',
          latex: '\\sum_{i=1}^{n}',
          en: 'Summation and product notation',
          es: 'Sumatorio y productorio',
          tags: ['sum', 'prod', 'sumatorio', 'productorio', 'sigma']
        }
      ]
    },
    {
      titleEn: 'Statistics & Probability (EST)',
      titleEs: 'Estadística y probabilidad (EST)',
      items: [
        {
          notation: 'var(X) / desv(X) / cov(X,Y)',
          example: 'var(X)',
          latex: '\\operatorname{Var}(X)',
          en: 'Variance, standard deviation, covariance, correlation',
          es: 'Varianza, desviación típica, covarianza, correlación',
          tags: ['var', 'desv', 'sd', 'std', 'cov', 'corr', 'estadistica']
        },
        {
          notation: 'ECM(theta) / MSE(theta)',
          example: 'ECM(theta)',
          latex: '\\operatorname{ECM}(\\theta)',
          en: 'Mean squared error (Spanish & English)',
          es: 'Error cuadrático medio',
          tags: ['ecm', 'mse', 'error', 'estimator', 'estimador']
        },
        {
          notation: 'esp(X) / mediana(X) / moda(X)',
          example: 'esp(X)',
          latex: 'E[X]',
          en: 'Expected value, median, and mode',
          es: 'Esperanza matemática, mediana y moda',
          tags: ['esp', 'esperanza', 'expected', 'mediana', 'median', 'moda', 'mode']
        },
        {
          notation: 'P(X>8 / X>5)',
          example: 'P(X>8 / X>5)',
          latex: 'P(X > 8 \\mid X > 5)',
          en: 'Conditional probability bar inside P(...)',
          es: 'Probabilidad condicionada dentro de P(...)',
          tags: ['probability', 'probabilidad', 'conditional', 'condicionada', 'mid']
        },
        {
          notation: 'X ~ N(0,1)',
          example: 'X ~ N(0,1)',
          latex: 'X \\sim N(0,1)',
          en: 'Follows distribution (~ -> \\sim)',
          es: 'Sigue una distribución (~ -> \\sim)',
          tags: ['sim', 'distribution', 'distribucion', 'normal', 'binomial']
        }
      ]
    },
    {
      titleEn: 'Annotated Equals & Arrows',
      titleEs: 'Igualdades y flechas anotadas',
      items: [
        {
          notation: '=(como y=7)= / =como y=7=',
          example: '=(como y=7)=',
          latex: '\\overset{\\text{como } y=7}{=}',
          en: 'Annotated equals with prose and math',
          es: 'Igualdad anotada con texto y matemáticas',
          tags: ['overset', 'equals', 'igualdad', 'annotation', 'anotacion']
        },
        {
          notation: '=(propiedad)=> / =propiedad=>',
          example: '=(propiedad noseque)=>',
          latex: '\\overset{\\text{propiedad noseque}}{\\Rightarrow}',
          en: 'Annotated implication arrow',
          es: 'Implicación anotada',
          tags: ['implies', 'implica', 'overset', 'arrow', 'flecha']
        },
        {
          notation: '<=(motivo)=> / <=motivo=>',
          example: '<=(debido a noseque)=>',
          latex: '\\overset{\\text{debido a noseque}}{\\iff}',
          en: 'Annotated equivalence (if and only if)',
          es: 'Equivalencia anotada (si y solo si)',
          tags: ['iff', 'equivalence', 'equivalencia', 'overset']
        },
        {
          notation: '-(por def)-> / ->(por def)->',
          example: '-(por def)->',
          latex: '\\overset{\\text{por def}}{\\longrightarrow}',
          en: 'Annotated long arrow',
          es: 'Flecha larga anotada',
          tags: ['arrow', 'flecha', 'longrightarrow', 'overset', 'def']
        }
      ]
    },
    {
      titleEn: 'Relations, Greek Letters & Operators',
      titleEs: 'Relaciones, letras griegas y operadores',
      items: [
        {
          notation: '+- / <= / >= / !=',
          example: 'x <= y != z',
          latex: 'x \\le y \\neq z',
          en: 'Plus-minus and inequality relations',
          es: 'Más-menos y desigualdades',
          tags: ['pm', 'le', 'ge', 'neq', 'inequality', 'desigualdad']
        },
        {
          notation: '<=> / => / -> / <-',
          example: 'A <=> B',
          latex: 'A \\iff B',
          en: 'Logical and mapping arrows',
          es: 'Flechas lógicas y de correspondencia',
          tags: ['iff', 'implies', 'arrow', 'flecha']
        },
        {
          notation: 'alpha, beta, theta, lambda, sigma...',
          example: 'mu +- 1.96 * sigma',
          latex: '\\mu \\pm 1.96 \\cdot \\sigma',
          en: 'Greek letters (word-bounded) and multiplication dot',
          es: 'Letras griegas (solo palabras completas) y producto',
          tags: ['greek', 'griegas', 'alpha', 'theta', 'lambda', 'sigma', 'cdot']
        }
      ]
    }
  ];

  return { adaptMathToLatex, adaptMath, MATH_ADAPT_CHEATSHEET };
});
