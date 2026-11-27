'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { findRscript, runRscriptOnce } = require('./r-runtime');

/**
 * Encodes an LSP JSON-RPC payload with proper Content-Length byte framing.
 */
function encodeLspMessage(payload) {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * Incremental Content-Length JSON-RPC stream parser for LSP stdio.
 */
class LspMessageParser extends EventEmitter {
  constructor() {
    super();
    this._buffer = Buffer.alloc(0);
    this._contentLength = null;
  }

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this._buffer = Buffer.concat([this._buffer, buf]);

    while (true) {
      if (this._contentLength === null) {
        const headerEnd = this._buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headerStr = this._buffer.slice(0, headerEnd).toString('ascii');
        const match = headerStr.match(/Content-Length\s*:\s*(\d+)/i);
        if (!match) {
          // Discard malformed header block
          this._buffer = this._buffer.slice(headerEnd + 4);
          continue;
        }
        this._contentLength = Number(match[1]);
        this._buffer = this._buffer.slice(headerEnd + 4);
      }

      if (this._buffer.length < this._contentLength) return;

      const body = this._buffer.slice(0, this._contentLength).toString('utf8');
      this._buffer = this._buffer.slice(this._contentLength);
      this._contentLength = null;

      try {
        const msg = JSON.parse(body);
        this.emit('message', msg);
      } catch (err) {
        this.emit('parseError', err);
      }
    }
  }
}

/**
 * Extracts fenced `{r ...}` code chunks from `.Rmd` / `.qmd` text into a synthetic R source
 * with identical 1-based line numbers (non-R lines become blank lines) so both `Rscript`
 * and `languageserver` report errors at exact `.Rmd` line coordinates!
 */
function extractRmdChunks(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = new Array(lines.length).fill('');
  const chunks = [];
  let inRChunk = false;
  let chunkStartLine = 0;
  let chunkHeader = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inRChunk) {
      const openMatch = line.match(/^[ \t]*```+[ \t]*\{[ \t]*r\b([^}]*)\}[ \t]*$/i);
      if (openMatch) {
        inRChunk = true;
        chunkStartLine = i + 2; // 1-based first code line inside chunk
        chunkHeader = openMatch[1].trim();
      }
    } else {
      if (/^[ \t]*```+[ \t]*$/.test(line)) {
        chunks.push({
          startLine: chunkStartLine,
          endLine: i, // 1-based inclusive last code line
          header: chunkHeader
        });
        inRChunk = false;
        chunkHeader = '';
      } else {
        out[i] = line;
      }
    }
  }

  if (inRChunk) {
    chunks.push({
      startLine: chunkStartLine,
      endLine: lines.length,
      header: chunkHeader,
      unclosed: true
    });
  }

  return {
    code: out.join('\n'),
    chunks,
    hasR: chunks.length > 0
  };
}

/**
 * Parses an R `parse()` error message into Monaco-compatible diagnostic markers.
 */
function parseRSyntaxError(errorText, sourceText = '') {
  const text = String(errorText || '').trim();
  if (!text) return [];
  const srcLines = String(sourceText || '').split(/\r?\n/);

  // Typical R format: `<text>:3:12: unexpected symbol` or `3:12: unexpected ')'`
  const match = text.match(/(?:<text>:|\b)(\d+):(\d+):\s*([^\r\n]+)/);
  if (match) {
    const lineNum = Math.max(1, Number(match[1]));
    const colNum = Math.max(1, Number(match[2]));
    const message = match[3].trim();
    const lineStr = srcLines[lineNum - 1] || '';
    const endCol = Math.max(colNum + 1, Math.min(lineStr.length + 1, colNum + 6));
    return [
      {
        startLineNumber: lineNum,
        startColumn: colNum,
        endLineNumber: lineNum,
        endColumn: endCol,
        message,
        severity: 'error',
        source: 'R parse'
      }
    ];
  }

  // Fallback: e.g. unexpected end of input
  const lastLine = Math.max(1, srcLines.length);
  const lastCol = Math.max(1, (srcLines[lastLine - 1] || '').length + 1);
  return [
    {
      startLineNumber: lastLine,
      startColumn: Math.max(1, lastCol - 1),
      endLineNumber: lastLine,
      endColumn: lastCol,
      message: text.replace(/^Error[^:]*:\s*/, ''),
      severity: 'error',
      source: 'R parse'
    }
  ];
}

/**
 * Lightweight R static lint checks for common warnings (yellow wavy underline in Monaco, like VS Code).
 */
function lintRWarnings(rSource = '') {
  const lines = String(rSource || '').split(/\r?\n/);
  const warnings = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || /^\s*#/.test(raw)) continue;
    // Strip strings and trailing comments for token scanning
    const codeOnly = raw
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
      .replace(/#.*$/, '');
    const lineNum = i + 1;

    // 1. Short-form T / F boolean literals (prone to accidental shadowing in R)
    const tfRegex = /(?:^|[=(,\s])([TF])(?=[),\s]|$)/g;
    let m;
    while ((m = tfRegex.exec(codeOnly)) !== null) {
      const col = m.index + m[0].lastIndexOf(m[1]) + 1;
      warnings.push({
        startLineNumber: lineNum,
        startColumn: col,
        endLineNumber: lineNum,
        endColumn: col + 1,
        message: `Use ${m[1] === 'T' ? 'TRUE' : 'FALSE'} instead of '${m[1]}' (which can be overwritten as a variable).`,
        severity: 'warning',
        source: 'R lint'
      });
    }

    // 2. Direct == / != comparison with NA, NULL, or NaN
    const naRegex = /(?:==|!=)\s*(NA|NULL|NaN)\b|\b(NA|NULL|NaN)\s*(?:==|!=)/g;
    while ((m = naRegex.exec(codeOnly)) !== null) {
      const target = m[1] || m[2] || 'NA';
      const fn = target === 'NULL' ? 'is.null(x)' : target === 'NaN' ? 'is.nan(x)' : 'is.na(x)';
      const col = m.index + 1;
      warnings.push({
        startLineNumber: lineNum,
        startColumn: col,
        endLineNumber: lineNum,
        endColumn: col + m[0].length,
        message: `Use ${fn} instead of '==' or '!=' with ${target}.`,
        severity: 'warning',
        source: 'R lint'
      });
    }

    // 3. 1:length(...) or 1:nrow(...) in loops (unsafe when empty)
    const seqRegex = /\b1\s*:\s*(length|nrow|ncol|NROW|NCOL)\s*\(/g;
    while ((m = seqRegex.exec(codeOnly)) !== null) {
      const col = m.index + 1;
      warnings.push({
        startLineNumber: lineNum,
        startColumn: col,
        endLineNumber: lineNum,
        endColumn: col + m[0].length,
        message: `Prefer seq_along() or seq_len() over 1:${m[1]}(...), which counts backwards to 0 when empty.`,
        severity: 'warning',
        source: 'R lint'
      });
    }

    // 4. sapply(...) warning in scripts where vapply/lapply is safer
    const sapplyRegex = /\bsapply\s*\(/g;
    while ((m = sapplyRegex.exec(codeOnly)) !== null) {
      const col = m.index + 1;
      warnings.push({
        startLineNumber: lineNum,
        startColumn: col,
        endLineNumber: lineNum,
        endColumn: col + 6,
        message: `Consider vapply() or lapply() when return type stability matters.`,
        severity: 'warning',
        source: 'R lint'
      });
    }
  }
  return warnings;
}

/**
 * Fast Rscript syntax checker (`parse(text=..., keep.source=TRUE)`).
 * Always works immediately even if `languageserver` is absent or still starting up.
 */
function checkRSyntax(source, { isRmd = false, rscriptPath, timeoutMs = 4000 } = {}) {
  const bin = rscriptPath || findRscript();
  const rSource = isRmd ? extractRmdChunks(source).code : String(source ?? '');

  if (!rSource.trim()) {
    return Promise.resolve({ ok: true, diagnostics: [] });
  }
  const warningDiags = lintRWarnings(rSource);
  if (!bin) {
    return Promise.resolve({ ok: false, diagnostics: warningDiags, error: 'Rscript not found' });
  }

  // Reads source via stdin so there is zero temp-file overhead.
  const checkerExpr =
    'src <- paste(readLines(file("stdin"), warn = FALSE), collapse = "\\n"); ' +
    'tryCatch({ parse(text = src, keep.source = TRUE); cat("OK\\n") }, ' +
    'error = function(e) { cat("ERR:", conditionMessage(e), "\\n", sep = "") })';

  return new Promise((resolve) => {
    const child = spawn(bin, ['--vanilla', '-e', checkerExpr], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C.UTF-8' }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const errIdx = stdout.indexOf('ERR:');
      if (errIdx !== -1) {
        const errMsg = stdout.slice(errIdx + 4).trim();
        resolve({
          ok: true,
          diagnostics: [...parseRSyntaxError(errMsg, rSource), ...warningDiags]
        });
        return;
      }
      if (stdout.includes('OK')) {
        resolve({ ok: true, diagnostics: warningDiags });
        return;
      }
      if (stderr.trim()) {
        resolve({ ok: true, diagnostics: [...parseRSyntaxError(stderr, rSource), ...warningDiags] });
        return;
      }
      resolve({ ok: true, diagnostics: warningDiags });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, diagnostics: warningDiags, error: err.message });
    });
    child.on('close', finish);

    try {
      child.stdin.end(rSource, 'utf8');
    } catch {
      finish();
    }
  });
}

function lspSeverityToString(sev) {
  switch (sev) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    default:
      return 'warning';
  }
}

function convertLspDiagnostics(lspDiags = []) {
  return lspDiags.map((d) => ({
    startLineNumber: (d.range?.start?.line ?? 0) + 1,
    startColumn: (d.range?.start?.character ?? 0) + 1,
    endLineNumber: (d.range?.end?.line ?? 0) + 1,
    endColumn: Math.max((d.range?.end?.character ?? 0) + 1, (d.range?.start?.character ?? 0) + 2),
    message: d.message || 'Diagnostic',
    severity: lspSeverityToString(d.severity),
    source: d.source || 'R languageserver'
  }));
}

/**
 * R Language Server client (`languageserver::run()`) with seamless fallback to `checkRSyntax`.
 */
class RLanguageServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rscriptPath = options.rscriptPath || findRscript();
    this.rootUri = options.rootUri || `file://${process.cwd()}`;
    this._proc = null;
    this._parser = null;
    this._nextId = 1;
    this._pending = new Map();
    this._initialized = false;
    this._starting = false;
    this._available = null;
    this._docs = new Map(); // uri -> { version, isRmd, text }
    this._syntaxSeq = new Map(); // uri -> monotonic sequence
  }

  get status() {
    if (this._initialized) return 'ready';
    if (this._starting) return 'starting';
    if (this._available === false) return 'fallback';
    return 'idle';
  }

  async start() {
    if (this._initialized || this._starting) return this._initialized;
    const bin = this.rscriptPath || findRscript();
    if (!bin) {
      this._available = false;
      this.emit('status', 'fallback');
      return false;
    }

    this._starting = true;
    this.emit('status', 'starting');

    const proc = spawn(
      bin,
      ['--vanilla', '-e', 'if (!requireNamespace("languageserver", quietly = TRUE)) quit(status = 42L); languageserver::run()'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C.UTF-8' }
      }
    );

    this._proc = proc;
    const parser = new LspMessageParser();
    this._parser = parser;

    parser.on('message', (msg) => this._onMessage(msg));
    proc.stdout.on('data', (chunk) => parser.push(chunk));
    proc.stderr.on('data', () => {
      // languageserver may log diagnostic chatter on stderr; ignore quietly
    });

    proc.on('exit', (code) => {
      this._proc = null;
      this._initialized = false;
      this._starting = false;
      if (code === 42) this._available = false;
      for (const [, req] of this._pending) {
        clearTimeout(req.timer);
        req.reject(new Error(`R languageserver exited (code ${code})`));
      }
      this._pending.clear();
      this.emit('status', this._available === false ? 'fallback' : 'idle');
    });

    proc.on('error', () => {
      this._available = false;
      this._starting = false;
      this.emit('status', 'fallback');
    });

    try {
      await this._request(
        'initialize',
        {
          processId: process.pid,
          rootUri: this.rootUri,
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: true },
              completion: {
                completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] }
              },
              hover: { contentFormat: ['markdown', 'plaintext'] },
              publishDiagnostics: {}
            }
          }
        },
        10000
      );
      this._notify('initialized', {});
      this._initialized = true;
      this._available = true;
      this._starting = false;
      this.emit('status', 'ready');

      // Sync any documents that were opened before initialization completed
      for (const [uri, doc] of this._docs) {
        this._sendDidOpen(uri, doc.rText, doc.version);
      }
      return true;
    } catch {
      this._starting = false;
      this._initialized = false;
      this._available = false;
      this.stop();
      this.emit('status', 'fallback');
      return false;
    }
  }

  _send(msg) {
    if (!this._proc || !this._proc.stdin.writable) return false;
    try {
      this._proc.stdin.write(encodeLspMessage(msg));
      return true;
    } catch {
      return false;
    }
  }

  _notify(method, params) {
    return this._send({ jsonrpc: '2.0', method, params });
  }

  _request(method, params, timeoutMs = 4000) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`LSP request ${method} timed out`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      if (!this._send({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error('LSP transport unavailable'));
      }
    });
  }

  _onMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const req = this._pending.get(msg.id);
      if (req) {
        this._pending.delete(msg.id);
        clearTimeout(req.timer);
        if (msg.error) req.reject(new Error(msg.error.message || 'LSP error'));
        else req.resolve(msg.result);
      }
      return;
    }

    if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
      const uri = msg.params.uri;
      const diagnostics = convertLspDiagnostics(msg.params.diagnostics || []);
      this.emit('diagnostics', { uri, diagnostics, source: 'lsp' });
    }
  }

  _sendDidOpen(uri, rText, version) {
    this._notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'r',
        version,
        text: rText
      }
    });
  }

  async didOpen(uri, text, { isRmd = false } = {}) {
    const rText = isRmd ? extractRmdChunks(text).code : String(text ?? '');
    const version = 1;
    this._docs.set(uri, { version, isRmd, text, rText });

    if (this._initialized) {
      this._sendDidOpen(uri, rText, version);
    } else if (!this._starting && this._available !== false) {
      this.start().catch(() => {});
    }

    return this._runFastSyntaxCheck(uri, text, isRmd);
  }

  async didChange(uri, text, { isRmd = false } = {}) {
    const prev = this._docs.get(uri);
    const version = prev ? prev.version + 1 : 1;
    const rText = isRmd ? extractRmdChunks(text).code : String(text ?? '');
    this._docs.set(uri, { version, isRmd, text, rText });

    if (this._initialized) {
      if (!prev) {
        this._sendDidOpen(uri, rText, version);
      } else {
        this._notify('textDocument/didChange', {
          textDocument: { uri, version },
          contentChanges: [{ text: rText }]
        });
      }
    }

    return this._runFastSyntaxCheck(uri, text, isRmd);
  }

  didClose(uri) {
    this._docs.delete(uri);
    if (this._initialized) {
      this._notify('textDocument/didClose', { textDocument: { uri } });
    }
  }

  async _runFastSyntaxCheck(uri, text, isRmd) {
    const seq = (this._syntaxSeq.get(uri) || 0) + 1;
    this._syntaxSeq.set(uri, seq);
    const res = await checkRSyntax(text, { isRmd, rscriptPath: this.rscriptPath });
    if (this._syntaxSeq.get(uri) !== seq) return res.diagnostics;
    this.emit('diagnostics', { uri, diagnostics: res.diagnostics, source: 'syntax' });
    return res.diagnostics;
  }

  async hover(uri, line, character) {
    if (!this._initialized) return null;
    try {
      const result = await this._request(
        'textDocument/hover',
        {
          textDocument: { uri },
          position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }
        },
        2500
      );
      if (!result || !result.contents) return null;
      const contents = result.contents;
      if (typeof contents === 'string') return { markdown: contents };
      if (Array.isArray(contents)) {
        return {
          markdown: contents
            .map((c) => (typeof c === 'string' ? c : c.value || ''))
            .filter(Boolean)
            .join('\n\n')
        };
      }
      return { markdown: contents.value || '' };
    } catch {
      return null;
    }
  }

  syncDocument(uri, text, { isRmd = false } = {}) {
    if (!this._initialized || typeof text !== 'string') return;
    const prev = this._docs.get(uri);
    const rText = isRmd ? extractRmdChunks(text).code : text;
    if (prev && prev.rText === rText) return;
    const version = (prev?.version || 0) + 1;
    this._docs.set(uri, { version, isRmd, text, rText });
    if (!prev) {
      this._sendDidOpen(uri, rText, version);
    } else {
      this._notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: rText }]
      });
    }
  }

  async completion(uri, line, character, { text, isRmd = false, prefix = '', timeoutMs = 450 } = {}) {
    if (!this._initialized) return [];
    try {
      if (typeof text === 'string') {
        this.syncDocument(uri, text, { isRmd });
      }
      const result = await this._request(
        'textDocument/completion',
        {
          textDocument: { uri },
          position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }
        },
        timeoutMs
      );
      const list = Array.isArray(result) ? result : result?.items || [];
      const pLow = String(prefix || '').toLowerCase();
      let filtered = list;
      if (pLow) {
        filtered = list.filter((item) => String(item.label || '').toLowerCase().includes(pLow));
        filtered.sort((a, b) => {
          const al = String(a.label || '').toLowerCase();
          const bl = String(b.label || '').toLowerCase();
          const ar = al === pLow ? 0 : al.startsWith(pLow) ? 1 : 2;
          const br = bl === pLow ? 0 : bl.startsWith(pLow) ? 1 : 2;
          if (ar !== br) return ar - br;
          return al.length - bl.length || al.localeCompare(bl);
        });
      }
      return filtered.slice(0, 100).map((item) => ({
        label: item.label,
        kind: item.kind || 3,
        detail: item.detail || '',
        documentation:
          typeof item.documentation === 'string'
            ? item.documentation
            : item.documentation?.value || '',
        insertText: item.insertText || item.label
      }));
    } catch {
      return [];
    }
  }

  /**
   * Reports whether R and the `languageserver` package are available (used by the first-run setup wizard).
   */
  async checkPackage() {
    const bin = this.rscriptPath || findRscript();
    if (!bin) return { ok: true, rAvailable: false, installed: false, version: null, status: this.status };
    const res = await runRscriptOnce(
      [
        'cat("__RCS_RVER__", paste(R.version$major, R.version$minor, sep = "."), "\\n", sep = "")',
        'if (requireNamespace("languageserver", quietly = TRUE)) {',
        '  cat("__RCS_LS__", as.character(utils::packageVersion("languageserver")), "\\n", sep = "")',
        '}'
      ].join('\n'),
      { rscriptPath: bin, timeoutMs: 15000 }
    );
    const rVer = /__RCS_RVER__(\S+)/.exec(res.stdout || '');
    const lsVer = /__RCS_LS__(\S+)/.exec(res.stdout || '');
    return {
      ok: true,
      rAvailable: Boolean(rVer),
      rVersion: rVer ? rVer[1] : null,
      installed: Boolean(lsVer),
      version: lsVer ? lsVer[1] : null,
      status: this.status
    };
  }

  /**
   * Installs `languageserver` from CRAN into the user library (created if missing), streaming
   * progress lines through `onProgress`, then restarts the language server so completion works
   * without relaunching the app.
   */
  installPackage({ repos = 'https://cloud.r-project.org', onProgress } = {}) {
    const bin = this.rscriptPath || findRscript();
    if (!bin) return Promise.resolve({ ok: false, error: 'Rscript executable not found on PATH.' });
    const cleanRepos = /^https?:\/\/[^\s"'\\]+$/i.test(String(repos || '')) ? repos : 'https://cloud.r-project.org';
    const script = [
      'options(repos = c(CRAN = ' + JSON.stringify(cleanRepos) + '), Ncpus = max(1L, parallel::detectCores() - 1L))',
      'lib <- .libPaths()[1]',
      'if (file.access(lib, 2) != 0) {',
      '  lib <- Sys.getenv("R_LIBS_USER")',
      '  if (!nzchar(lib)) lib <- file.path(path.expand("~"), "R", "library")',
      '  dir.create(lib, recursive = TRUE, showWarnings = FALSE)',
      '  .libPaths(c(lib, .libPaths()))',
      '}',
      'cat("Installing languageserver into", lib, "\\n")',
      'utils::install.packages("languageserver", lib = lib)',
      'if (!requireNamespace("languageserver", quietly = TRUE)) quit(status = 3L)',
      'cat("__RCS_LS__", as.character(utils::packageVersion("languageserver")), "\\n", sep = "")'
    ].join('\n');

    return new Promise((resolve) => {
      const child = spawn(bin, ['--vanilla', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C.UTF-8' }
      });
      let tail = '';
      const onChunk = (chunk) => {
        const text = chunk.toString('utf8');
        tail = (tail + text).slice(-4000);
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length && onProgress) onProgress(lines[lines.length - 1]);
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
      child.on('exit', async (code) => {
        const ver = /__RCS_LS__(\S+)/.exec(tail);
        if (code === 0 && ver) {
          if (!this._initialized && !this._proc) {
            this._available = null;
            this.start().catch(() => {});
          }
          resolve({ ok: true, version: ver[1] });
        } else {
          resolve({ ok: false, error: tail.trim().split(/\r?\n/).slice(-6).join('\n') || `Rscript exited (code ${code})` });
        }
      });
    });
  }

  stop() {
    if (this._proc) {
      try {
        this._notify('exit', null);
      } catch {
        // ignore
      }
      try {
        this._proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      this._proc = null;
    }
    this._initialized = false;
    this._starting = false;
    for (const [, req] of this._pending) {
      clearTimeout(req.timer);
      req.reject(new Error('LSP stopped'));
    }
    this._pending.clear();
  }
}

module.exports = {
  encodeLspMessage,
  LspMessageParser,
  extractRmdChunks,
  parseRSyntaxError,
  checkRSyntax,
  convertLspDiagnostics,
  RLanguageServer
};
