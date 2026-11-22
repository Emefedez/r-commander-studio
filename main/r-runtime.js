'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const DEFAULT_PACKAGES = [
  'svglite',
  'ggplot2',
  'RcmdrMisc',
  'car',
  'rmarkdown',
  'knitr',
  'languageserver'
];

function findExecutable(name, extraPaths = []) {
  const candidates = [];
  for (const p of extraPaths) {
    if (p && fs.existsSync(p)) candidates.push(p);
  }
  const envPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of envPath) {
    for (const ext of exts) {
      candidates.push(path.join(dir, name + ext));
    }
  }
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function findRscript() {
  const extra =
    process.platform === 'win32'
      ? []
      : ['/usr/bin/Rscript', '/usr/local/bin/Rscript', '/opt/homebrew/bin/Rscript'];
  return process.env.RSCRIPT_PATH || findExecutable('Rscript', extra);
}

function findRBinary() {
  const extra =
    process.platform === 'win32'
      ? []
      : ['/usr/bin/R', '/usr/local/bin/R', '/opt/homebrew/bin/R'];
  return process.env.R_PATH || findExecutable('R', extra);
}

function findArf() {
  const home = os.homedir();
  const extra = [
    path.join(home, '.cargo', 'bin', process.platform === 'win32' ? 'arf.exe' : 'arf'),
    '/usr/local/bin/arf',
    '/usr/bin/arf'
  ];
  return findExecutable('arf', extra);
}

function rawRString(text) {
  let dashes = '-';
  const str = String(text ?? '');
  while (str.includes(`)${dashes}"`)) dashes += '-';
  return `r"${dashes}(${str})${dashes}"`;
}

function resolveVendorPath(...segments) {
  const candidate = path.join(__dirname, '..', 'vendor', 'rcmdr', ...segments);
  const unpacked = candidate.replace('app.asar', 'app.asar.unpacked');
  if (unpacked !== candidate && fs.existsSync(unpacked)) return unpacked;
  return candidate;
}

function parseSessionInfo(lines) {
  const state = { datasets: {}, models: [], hclusts: [], objects: [] };
  for (const line of lines || []) {
    if (!line) continue;
    const [type, a, b, c, d, e] = line.split('\t');
    if (type === 'O' && a) state.objects.push(a);
    else if (type === 'D' && a) {
      state.datasets[a] = { name: a, rows: Number(b), columns: Number(c), vars: [] };
    } else if (type === 'V' && state.datasets[a]) {
      state.datasets[a].vars.push({
        name: b,
        kind: c,
        levels: Number(d),
        discrete: e === '1'
      });
    } else if (type === 'M' && a) {
      state.models.push({ name: a, cls: b || 'model' });
    } else if (type === 'H' && a) {
      state.hclusts.push(a);
    }
  }
  return state;
}

/**
 * Runs an isolated one-shot Rscript subprocess with strict timeout and clean stdout/stderr collection.
 */
function runRscriptOnce(scriptSource, { rscriptPath, timeoutMs = 10000, cwd, env } = {}) {
  const bin = rscriptPath || findRscript();
  if (!bin) {
    return Promise.resolve({
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr: 'Rscript executable not found on PATH.',
      timedOut: false,
      elapsedMs: 0
    });
  }

  return new Promise((resolve) => {
    const start = Date.now();
    const tmpFile = path.join(os.tmpdir(), `rcs-once-${process.pid}-${crypto.randomBytes(6).toString('hex')}.R`);
    try {
      fs.writeFileSync(tmpFile, scriptSource, 'utf8');
    } catch (err) {
      resolve({
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: `Failed to write temp R script: ${err.message}`,
        timedOut: false,
        elapsedMs: 0
      });
      return;
    }

    const child = spawn(bin, ['--vanilla', tmpFile], {
      cwd: cwd || os.tmpdir(),
      env: { ...process.env, LC_ALL: 'C.UTF-8', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const cleanup = () => {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }, timeoutMs)
        : null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const finish = (exitCode, errMsg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup();
      resolve({
        ok: !timedOut && exitCode === 0 && !errMsg,
        exitCode: exitCode ?? -1,
        stdout,
        stderr: errMsg ? (stderr ? `${stderr}\n${errMsg}` : errMsg) : stderr,
        timedOut,
        elapsedMs: Date.now() - start
      });
    };

    child.on('error', (err) => finish(-1, err.message));
    child.on('close', (code) => finish(code));
  });
}

class RRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rscriptPath = options.rscriptPath || findRscript();
    this.rPath = options.rPath || findRBinary();
    this.arfPath = options.arfPath || findArf();
    this.runnerPath = options.runnerPath || resolveVendorPath('runner.R');
    this.rcmdrNamesPath = options.rcmdrNamesPath || resolveVendorPath('data', 'rcmdr-names.txt');
    this.cwd = options.cwd || process.cwd();

    this._envCache = null;
    this._proc = null;
    this._ready = false;
    this._queue = [];
    this._activeJob = null;
    this._stdoutBuf = '';
    this._stderrBuf = '';
    this._jobDir = null;
  }

  async probeEnvironment(force = false) {
    if (this._envCache && !force) return this._envCache;

    const rscriptPath = this.rscriptPath || findRscript();
    const arfPath = this.arfPath || findArf();
    this.rscriptPath = rscriptPath;
    this.arfPath = arfPath;

    const pkgVec = `c(${DEFAULT_PACKAGES.map((p) => JSON.stringify(p)).join(', ')})`;
    const probeScript = `
ver <- paste(R.version$major, R.version$minor, sep = ".")
pkgs <- ${pkgVec}
installed <- vapply(pkgs, function(p) requireNamespace(p, quietly = TRUE), logical(1))
cat("__RCS_VER__", ver, "\\n", sep = "")
for (i in seq_along(pkgs)) {
  cat("__RCS_PKG__", pkgs[[i]], "=", if (installed[[i]]) "1" else "0", "\\n", sep = "")
}
`;

    let rVersion = null;
    const packages = Object.fromEntries(DEFAULT_PACKAGES.map((p) => [p, false]));

    if (rscriptPath) {
      const res = await runRscriptOnce(probeScript, { rscriptPath, timeoutMs: 8000 });
      if (res.ok) {
        for (const line of res.stdout.split(/\r?\n/)) {
          if (line.startsWith('__RCS_VER__')) {
            rVersion = line.slice('__RCS_VER__'.length).trim();
          } else if (line.startsWith('__RCS_PKG__')) {
            const pair = line.slice('__RCS_PKG__'.length);
            const eq = pair.indexOf('=');
            if (eq > 0) {
              packages[pair.slice(0, eq)] = pair.slice(eq + 1).trim() === '1';
            }
          }
        }
      } else {
        try {
          const verOut = execFileSync(rscriptPath, ['--version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
          });
          const m = verOut.match(/version\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
          if (m) rVersion = m[1];
        } catch {
          // ignore
        }
      }
    }

    this._envCache = {
      rVersion,
      rscriptPath,
      arfAvailable: Boolean(arfPath),
      arfPath,
      packages
    };
    return this._envCache;
  }

  /**
   * Persistent interactive R session powered by a clean command-loop harness sourcing vendor/rcmdr/runner.R.
   */
  async ensureSession() {
    if (this._proc && !this._proc.killed && this._ready) return;
    await this.startSession();
  }

  async startSession() {
    this.stopSession();
    const bin = this.rscriptPath || findRscript();
    if (!bin) throw new Error('Rscript not found. Please install R and ensure Rscript is on PATH.');

    this._jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-session-'));
    const harnessPath = path.join(this._jobDir, 'harness.R');
    const runnerPath = this.runnerPath;

    const harness = `
options(device = function(...) {
  grDevices::pdf(NULL)
})
if (file.exists(${JSON.stringify(runnerPath)})) {
  if ("R Play" %in% search()) detach("R Play", character.only = TRUE)
  e <- attach(NULL, name = "R Play")
  sys.source(${JSON.stringify(runnerPath)}, envir = e)
}
con <- file("stdin", open = "r")
cat("__RCS_READY__\\n")
flush.console()
repeat {
  line <- readLines(con, n = 1L, warn = FALSE)
  if (!length(line)) break
  line <- trimws(line)
  if (!nzchar(line)) next
  parts <- strsplit(line, "\\t", fixed = TRUE)[[1L]]
  token <- parts[[1L]]
  job_file <- if (length(parts) >= 2L) parts[[2L]] else ""
  if (nzchar(job_file) && file.exists(job_file)) {
    tryCatch({
      sys.source(job_file, envir = new.env(parent = globalenv()))
    }, error = function(e) {
      cat("Error: ", conditionMessage(e), "\\n", sep = "", file = stderr())
    })
  }
  flush.console()
  cat("\\n__RCS_DONE__", token, "\\n", sep = "")
  flush.console()
}
`;
    fs.writeFileSync(harnessPath, harness, 'utf8');

    const proc = spawn(bin, ['--vanilla', harnessPath], {
      cwd: this.cwd,
      env: { ...process.env, LC_ALL: 'C.UTF-8', R_DEFAULT_PACKAGES: 'datasets,utils,grDevices,graphics,stats,methods' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this._proc = proc;
    this._ready = false;

    await new Promise((resolve, reject) => {
      let initBuf = '';
      const onData = (chunk) => {
        const text = chunk.toString('utf8');
        if (!this._ready) {
          initBuf += text;
          if (initBuf.includes('__RCS_READY__')) {
            this._ready = true;
            const after = initBuf.split('__RCS_READY__').slice(1).join('__RCS_READY__').replace(/^\r?\n/, '');
            if (after) this._handleStdout(after);
            resolve();
          }
          return;
        }
        this._handleStdout(text);
      };

      proc.stdout.on('data', onData);
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        this._stderrBuf += text;
        if (this._activeJob && this._activeJob.stream) {
          this.emit('output', { stream: 'stderr', text });
        }
      });
      proc.on('error', (err) => {
        if (!this._ready) reject(err);
        this._failActiveJob(err.message);
      });
      proc.on('exit', (code, signal) => {
        const wasReady = this._ready;
        this._ready = false;
        this._proc = null;
        const msg = signal ? `R session exited (${signal})` : `R session exited (code ${code})`;
        if (!wasReady) reject(new Error(msg));
        this._failActiveJob(msg);
        this.emit('exit', { code, signal });
      });
    });

    this.emit('ready');
  }

  _handleStdout(text) {
    this._stdoutBuf += text;
    if (!this._activeJob) return;
    const marker = `__RCS_DONE__${this._activeJob.token}`;
    const idx = this._stdoutBuf.indexOf(marker);
    if (idx !== -1) {
      const before = this._stdoutBuf.slice(0, idx);
      const afterMarker = this._stdoutBuf.slice(idx + marker.length).replace(/^\r?\n/, '');
      this._stdoutBuf = afterMarker;
      if (before && this._activeJob.stream) {
        this.emit('output', { stream: 'stdout', text: before });
      }
      const job = this._activeJob;
      job.stdout += before;
      job.stderr += this._stderrBuf;
      this._stderrBuf = '';
      this._activeJob = null;
      if (job.timer) clearTimeout(job.timer);
      job.resolve({ stdout: job.stdout, stderr: job.stderr });
      this._drainQueue();
    } else {
      // Stream safely keeping tail in case marker spans chunks
      const safeLen = Math.max(0, this._stdoutBuf.length - (marker.length + 8));
      if (safeLen > 0) {
        const emitChunk = this._stdoutBuf.slice(0, safeLen);
        this._stdoutBuf = this._stdoutBuf.slice(safeLen);
        this._activeJob.stdout += emitChunk;
        if (this._activeJob.stream) {
          this.emit('output', { stream: 'stdout', text: emitChunk });
        }
      }
    }
  }

  _failActiveJob(message) {
    if (this._activeJob) {
      const job = this._activeJob;
      this._activeJob = null;
      if (job.timer) clearTimeout(job.timer);
      job.reject(new Error(message));
    }
    while (this._queue.length) {
      const queued = this._queue.shift();
      queued.reject(new Error(message));
    }
  }

  async _enqueueJob(rJobScript, { timeoutMs = 60000, stream = false } = {}) {
    await this.ensureSession();
    return new Promise((resolve, reject) => {
      const token = crypto.randomBytes(8).toString('hex');
      const jobFile = path.join(this._jobDir, `job-${token}.R`);
      fs.writeFileSync(jobFile, rJobScript, 'utf8');

      const item = {
        token,
        jobFile,
        timeoutMs,
        stream,
        stdout: '',
        stderr: '',
        resolve: (res) => {
          try {
            fs.unlinkSync(jobFile);
          } catch {
            // ignore
          }
          resolve(res);
        },
        reject: (err) => {
          try {
            fs.unlinkSync(jobFile);
          } catch {
            // ignore
          }
          reject(err);
        },
        timer: null
      };

      this._queue.push(item);
      this._drainQueue();
    });
  }

  _drainQueue() {
    if (this._activeJob || !this._queue.length) return;
    if (!this._proc || !this._ready) return;

    const job = this._queue.shift();
    this._activeJob = job;
    this._stdoutBuf = '';
    this._stderrBuf = '';

    if (job.timeoutMs > 0) {
      job.timer = setTimeout(() => {
        if (this._activeJob === job) {
          this.interrupt();
        }
      }, job.timeoutMs);
    }

    try {
      this._proc.stdin.write(`${job.token}\t${job.jobFile}\n`);
    } catch (err) {
      this._failActiveJob(err.message);
    }
  }

  async runCode(
    code,
    {
      require: reqPkgs = [],
      capturePlots = true,
      plotWidth = 640,
      plotHeight = 440,
      limitOutput = false,
      maxOutputItems = 200,
      skipHelp = true,
      timeoutMs = 120000
    } = {}
  ) {
    const start = Date.now();
    const plotDir = capturePlots ? fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-plots-')) : null;
    const wIn = Math.max(1.5, Number(plotWidth || 640) / 72).toFixed(3);
    const hIn = Math.max(1.5, Number(plotHeight || 440) / 72).toFixed(3);
    const pkgsVec = reqPkgs.length ? `c(${reqPkgs.map((p) => JSON.stringify(p)).join(', ')})` : 'character()';
    const namesPath = JSON.stringify(this.rcmdrNamesPath);

    const openDeviceSnippet = capturePlots
      ? `
.rcs_plot_dir <- ${JSON.stringify(plotDir)}
.rcs_plot_pattern <- file.path(.rcs_plot_dir, "plot-%03d.svg")
.rcs_dev_opened <- FALSE
if (requireNamespace("svglite", quietly = TRUE)) {
  svglite::svglite(filename = .rcs_plot_pattern, width = ${wIn}, height = ${hIn}, bg = "#ffffff")
  .rcs_dev_opened <- TRUE
} else if (capabilities("cairo")) {
  grDevices::svg(filename = .rcs_plot_pattern, width = ${wIn}, height = ${hIn}, bg = "#ffffff", onefile = FALSE)
  .rcs_dev_opened <- TRUE
}
on.exit({
  if (isTRUE(.rcs_dev_opened) && grDevices::dev.cur() > 1L) {
    try(grDevices::dev.off(), silent = TRUE)
  }
}, add = TRUE)
`
      : '';

    const jobScript = `
local({
  ${openDeviceSnippet}
  .rcs_code <- ${rawRString(code)}
  if (exists("attach_rcmdr_if_used")) {
    tryCatch(attach_rcmdr_if_used(.rcs_code, ${namesPath}), error = function(e) NULL)
  }
  if (exists("run_code")) {
    run_code(
      .rcs_code,
      skip_help = ${skipHelp ? 'TRUE' : 'FALSE'},
      limit_output = ${limitOutput ? 'TRUE' : 'FALSE'},
      max_output_items = ${Number(maxOutputItems) || 200}L,
      require = ${pkgsVec},
      quiet = TRUE,
      syntax_colors = FALSE
    )
  } else {
    exprs <- parse(text = .rcs_code, keep.source = TRUE)
    for (expr in exprs) {
      res <- withVisible(eval(expr, globalenv()))
      if (res$visible) print(res$value)
    }
  }
})
`;

    try {
      const { stdout, stderr } = await this._enqueueJob(jobScript, { timeoutMs, stream: true });
      const plots = [];
      if (plotDir && fs.existsSync(plotDir)) {
        const files = fs
          .readdirSync(plotDir)
          .filter((f) => f.endsWith('.svg'))
          .sort();
        for (const f of files) {
          const svg = fs.readFileSync(path.join(plotDir, f), 'utf8');
          if (svg && svg.includes('<svg')) plots.push(svg);
        }
      }
      return {
        ok: !/\bError\b\s*:/m.test(stderr),
        stdout,
        stderr,
        plots,
        elapsedMs: Date.now() - start
      };
    } catch (err) {
      return {
        ok: false,
        stdout: '',
        stderr: err.message,
        plots: [],
        elapsedMs: Date.now() - start
      };
    } finally {
      if (plotDir) {
        try {
          fs.rmSync(plotDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  async query(expression, timeoutMs = 15000) {
    const outFile = path.join(os.tmpdir(), `rcs-q-${process.pid}-${crypto.randomBytes(6).toString('hex')}.txt`);
    const jobScript = `
local({
  .out <- tryCatch(as.character(eval(parse(text = ${rawRString(expression)}), globalenv())), error = function(e) character())
  writeLines(enc2utf8(.out), ${JSON.stringify(outFile)}, useBytes = TRUE)
})
`;
    try {
      await this._enqueueJob(jobScript, { timeoutMs, stream: false });
      if (!fs.existsSync(outFile)) return [];
      const raw = fs.readFileSync(outFile, 'utf8');
      const lines = raw.split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      return lines;
    } catch {
      return undefined;
    } finally {
      try {
        fs.unlinkSync(outFile);
      } catch {
        // ignore
      }
    }
  }

  async snapshot() {
    const lines = await this.query('session_info()', 10000);
    if (!lines) return { datasets: {}, models: [], hclusts: [], objects: [] };
    return parseSessionInfo(lines);
  }

  interrupt() {
    if (!this._proc) return false;
    try {
      this._proc.kill('SIGINT');
      // If active job doesn't unwind quickly, restart cleanly
      setTimeout(() => {
        if (this._activeJob) {
          this.restartSession().catch(() => {});
        }
      }, 600);
      return true;
    } catch {
      return false;
    }
  }

  async restartSession() {
    this.stopSession();
    await this.startSession();
  }

  stopSession() {
    if (this._proc) {
      try {
        this._proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      this._proc = null;
    }
    this._ready = false;
    this._failActiveJob('R session stopped');
    if (this._jobDir) {
      try {
        fs.rmSync(this._jobDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      this._jobDir = null;
    }
  }

  /**
   * Knits an R Markdown document to standalone HTML using rmarkdown::render in a temp dir.
   */
  async knitRmd({ content, filename = 'document.Rmd', timeoutMs = 60000 } = {}) {
    const start = Date.now();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-knit-'));
    const safeName = path.basename(filename || 'document.Rmd').replace(/[^a-zA-Z0-9._-]/g, '_');
    const inFile = path.join(tmpDir, safeName.endsWith('.Rmd') || safeName.endsWith('.rmd') ? safeName : `${safeName}.Rmd`);
    const outFile = path.join(tmpDir, 'output.html');
    fs.writeFileSync(inFile, String(content || ''), 'utf8');

    const script = `
if (!requireNamespace("rmarkdown", quietly = TRUE)) {
  stop("Package 'rmarkdown' is not installed.")
}
rmarkdown::render(
  input = ${JSON.stringify(inFile)},
  output_format = rmarkdown::html_document(self_contained = TRUE),
  output_file = ${JSON.stringify(outFile)},
  quiet = TRUE,
  envir = new.env(parent = globalenv())
)
`;
    try {
      const res = await runRscriptOnce(script, { rscriptPath: this.rscriptPath, timeoutMs, cwd: tmpDir });
      if (res.ok && fs.existsSync(outFile)) {
        const html = fs.readFileSync(outFile, 'utf8');
        return { ok: true, html, log: res.stdout + res.stderr, elapsedMs: Date.now() - start };
      }
      return {
        ok: false,
        error: res.timedOut ? `Knit timed out after ${timeoutMs}ms` : res.stderr || 'rmarkdown::render failed',
        log: res.stdout + res.stderr,
        elapsedMs: Date.now() - start
      };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Bridge endpoint helper: evaluates R code in an isolated Rscript subprocess, capturing SVG output.
   */
  async evalFigure({ rCode, width = 480, height = 320, bg = '#ffffff', timeoutMs = 10000, require: reqPkgs = [] } = {}) {
    const start = Date.now();
    const envInfo = await this.probeEnvironment();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-fig-'));
    const svgPath = path.join(tmpDir, 'figure.svg');
    const warnPath = path.join(tmpDir, 'warnings.txt');
    const errPath = path.join(tmpDir, 'error.txt');
    const wIn = Math.max(1, Number(width || 480) / 72).toFixed(4);
    const hIn = Math.max(1, Number(height || 320) / 72).toFixed(4);
    const bgStr = JSON.stringify(String(bg || '#ffffff'));
    const pkgsVec = Array.isArray(reqPkgs) && reqPkgs.length
      ? `c(${reqPkgs.map((p) => JSON.stringify(String(p))).join(', ')})`
      : 'character()';

    const script = `
.rcs_warns <- character()
.rcs_err <- NULL
.rcs_open_svg <- function() {
  if (requireNamespace("svglite", quietly = TRUE)) {
    svglite::svglite(filename = ${JSON.stringify(svgPath)}, width = ${wIn}, height = ${hIn}, bg = ${bgStr})
  } else {
    grDevices::svg(filename = ${JSON.stringify(svgPath)}, width = ${wIn}, height = ${hIn}, bg = ${bgStr}, onefile = FALSE)
  }
}
.rcs_req <- ${pkgsVec}
for (.p in .rcs_req) {
  if (!requireNamespace(.p, quietly = TRUE)) {
    writeLines(paste0("Required package not installed: ", .p), ${JSON.stringify(errPath)}, useBytes = TRUE)
    quit(status = 1L)
  }
}
.rcs_open_svg()
.rcs_code <- ${rawRString(rCode)}
tryCatch(
  withCallingHandlers({
    .exprs <- parse(text = .rcs_code, keep.source = TRUE)
    .env <- new.env(parent = globalenv())
    for (.e in .exprs) {
      .res <- withVisible(eval(.e, envir = .env))
      if (.res$visible && !is.null(.res$value)) {
        print(.res$value)
      }
    }
  }, warning = function(w) {
    .rcs_warns <<- c(.rcs_warns, conditionMessage(w))
    invokeRestart("muffleWarning")
  }),
  error = function(e) {
    .rcs_err <<- conditionMessage(e)
  }
)
if (grDevices::dev.cur() > 1L) try(grDevices::dev.off(), silent = TRUE)
if (length(.rcs_warns)) writeLines(enc2utf8(.rcs_warns), ${JSON.stringify(warnPath)}, useBytes = TRUE)
if (!is.null(.rcs_err)) {
  writeLines(enc2utf8(.rcs_err), ${JSON.stringify(errPath)}, useBytes = TRUE)
  quit(status = 1L)
}
`;

    try {
      const res = await runRscriptOnce(script, {
        rscriptPath: this.rscriptPath,
        timeoutMs: Math.max(500, Math.min(Number(timeoutMs) || 10000, 120000)),
        cwd: tmpDir
      });
      const warnings = fs.existsSync(warnPath)
        ? fs.readFileSync(warnPath, 'utf8').split(/\r?\n/).filter(Boolean)
        : [];
      const errText = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8').trim() : '';

      if (res.timedOut) {
        return {
          ok: false,
          error: `R figure evaluation timed out after ${timeoutMs}ms`,
          stdout: res.stdout,
          warnings,
          elapsedMs: Date.now() - start
        };
      }

      if (!res.ok || errText) {
        return {
          ok: false,
          error: errText || res.stderr.trim() || 'R figure evaluation failed',
          stdout: res.stdout,
          warnings,
          elapsedMs: Date.now() - start
        };
      }

      if (!fs.existsSync(svgPath)) {
        return {
          ok: false,
          error: 'R code completed without producing a graphic.',
          stdout: res.stdout,
          warnings,
          elapsedMs: Date.now() - start
        };
      }

      const svg = fs.readFileSync(svgPath, 'utf8');
      if (!svg.includes('<svg')) {
        return {
          ok: false,
          error: 'Generated SVG output was empty or invalid.',
          stdout: res.stdout,
          warnings,
          elapsedMs: Date.now() - start
        };
      }

      return {
        ok: true,
        svg,
        stdout: res.stdout,
        warnings,
        rVersion: envInfo.rVersion,
        elapsedMs: Date.now() - start
      };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Bridge endpoint helper: evaluates R code in an isolated Rscript subprocess, returning stdout + warnings.
   */
  async evalCode({ rCode, timeoutMs = 10000, require: reqPkgs = [] } = {}) {
    const start = Date.now();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-code-'));
    const warnPath = path.join(tmpDir, 'warnings.txt');
    const errPath = path.join(tmpDir, 'error.txt');
    const pkgsVec = Array.isArray(reqPkgs) && reqPkgs.length
      ? `c(${reqPkgs.map((p) => JSON.stringify(String(p))).join(', ')})`
      : 'character()';

    const script = `
.rcs_warns <- character()
.rcs_err <- NULL
.rcs_req <- ${pkgsVec}
for (.p in .rcs_req) {
  if (!requireNamespace(.p, quietly = TRUE)) {
    writeLines(paste0("Required package not installed: ", .p), ${JSON.stringify(errPath)}, useBytes = TRUE)
    quit(status = 1L)
  }
}
.rcs_code <- ${rawRString(rCode)}
tryCatch(
  withCallingHandlers({
    .exprs <- parse(text = .rcs_code, keep.source = TRUE)
    .env <- new.env(parent = globalenv())
    for (.e in .exprs) {
      .res <- withVisible(eval(.e, envir = .env))
      if (.res$visible) print(.res$value)
    }
  }, warning = function(w) {
    .rcs_warns <<- c(.rcs_warns, conditionMessage(w))
    invokeRestart("muffleWarning")
  }),
  error = function(e) {
    .rcs_err <<- conditionMessage(e)
  }
)
if (length(.rcs_warns)) writeLines(enc2utf8(.rcs_warns), ${JSON.stringify(warnPath)}, useBytes = TRUE)
if (!is.null(.rcs_err)) {
  writeLines(enc2utf8(.rcs_err), ${JSON.stringify(errPath)}, useBytes = TRUE)
  quit(status = 1L)
}
`;

    try {
      const res = await runRscriptOnce(script, {
        rscriptPath: this.rscriptPath,
        timeoutMs: Math.max(500, Math.min(Number(timeoutMs) || 10000, 120000)),
        cwd: tmpDir
      });
      const warnings = fs.existsSync(warnPath)
        ? fs.readFileSync(warnPath, 'utf8').split(/\r?\n/).filter(Boolean)
        : [];
      const errText = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8').trim() : '';

      if (res.timedOut) {
        return {
          ok: false,
          error: `R evaluation timed out after ${timeoutMs}ms`,
          stdout: res.stdout,
          warnings,
          elapsedMs: Date.now() - start
        };
      }
      if (!res.ok || errText) {
        return {
          ok: false,
          error: errText || res.stderr.trim() || 'R evaluation failed',
          stdout: res.stdout,
          warnings,
          elapsedMs: Date.now() - start
        };
      }
      return {
        ok: true,
        stdout: res.stdout,
        warnings,
        elapsedMs: Date.now() - start
      };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

module.exports = {
  RRuntime,
  findRscript,
  findRBinary,
  findArf,
  parseSessionInfo,
  rawRString,
  runRscriptOnce,
  resolveVendorPath
};
