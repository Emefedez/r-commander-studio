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
    this._fnHelpCache = new Map();
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
   * Persistent interactive R session powered by a clean command-loop harness sourcing vendor/rcmdr/runner.R,
   * with hooked utils::View() for automatic Table Viewer integration and rich table RPC helpers.
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
options(
  device = function(...) {
    grDevices::pdf(NULL)
  },
  browser = function(url) {
    u <- as.character(url)[1L]
    cat("\\n__RCS_BROWSE__", u, "__RCS_BROWSE_END__\\n", sep = "")
    cat("Opening in browser: ", u, "\\n", sep = "")
    flush.console()
    invisible(u)
  }
)
if (file.exists(${JSON.stringify(runnerPath)})) {
  if ("R Play" %in% search()) detach("R Play", character.only = TRUE)
  e <- attach(NULL, name = "R Play")
  sys.source(${JSON.stringify(runnerPath)}, envir = e)
  # Install Studio table helpers & View() hook inside "R Play" search entry
  e$.rcs_view_cache <- new.env(parent = emptyenv())
  e$.rcs_view_seq <- 0L
  e$.rcs_to_df <- function(x) {
    if (is.data.frame(x)) return(x)
    if (is.matrix(x) || is.table(x)) return(as.data.frame(x, stringsAsFactors = FALSE))
    if (is.atomic(x)) return(data.frame(value = x, stringsAsFactors = FALSE))
    tryCatch(as.data.frame(x, stringsAsFactors = FALSE), error = function(err) {
      data.frame(summary = utils::capture.output(utils::str(x)), stringsAsFactors = FALSE)
    })
  }
  e$.rcs_resolve_table <- function(name, source = "global") {
    if (identical(source, "cache")) {
      if (!exists(name, envir = e$.rcs_view_cache, inherits = FALSE)) stop("Cached table not found: ", name)
      return(e$.rcs_to_df(get(name, envir = e$.rcs_view_cache, inherits = FALSE)))
    }
    if (!exists(name, envir = globalenv(), inherits = TRUE)) stop("Object not found: ", name)
    e$.rcs_to_df(get(name, envir = globalenv(), inherits = TRUE))
  }
  e$.rcs_col_type <- function(x) {
    if (is.ordered(x)) return(paste0("Ord(", nlevels(x), ")"))
    if (is.factor(x)) return(paste0("Factor(", nlevels(x), ")"))
    if (inherits(x, "Date")) return("Date")
    if (inherits(x, "POSIXt")) return("POSIXt")
    if (is.integer(x)) return("int")
    if (is.numeric(x)) return("num")
    if (is.logical(x)) return("logi")
    if (is.character(x)) return("chr")
    class(x)[1L]
  }
  e$.rcs_table_page <- function(name, source = "global", page = 1L, page_size = 100L, sort_col = "", sort_dir = "asc", filter = "") {
    df <- e$.rcs_resolve_table(name, source)
    total_rows <- nrow(df)
    total_cols <- ncol(df)
    rn <- rownames(df)
    if (is.null(rn)) rn <- as.character(seq_len(total_rows))
    row_indices <- seq_len(total_rows)
    if (nzchar(filter) && total_rows > 0L && total_cols > 0L) {
      q <- tolower(filter)
      keep <- grepl(q, tolower(rn), fixed = TRUE)
      for (j in seq_len(total_cols)) {
        col_txt <- tolower(as.character(df[[j]]))
        col_txt[is.na(col_txt)] <- "na"
        keep <- keep | grepl(q, col_txt, fixed = TRUE)
      }
      row_indices <- row_indices[keep]
    }
    filtered_rows <- length(row_indices)
    if (nzchar(sort_col) && sort_col %in% names(df) && filtered_rows > 1L) {
      vec <- df[[sort_col]][row_indices]
      ord <- order(vec, decreasing = identical(sort_dir, "desc"), na.last = TRUE)
      row_indices <- row_indices[ord]
    }
    page <- max(1L, as.integer(page))
    page_size <- max(1L, min(1000L, as.integer(page_size)))
    start_idx <- (page - 1L) * page_size + 1L
    end_idx <- min(filtered_rows, page * page_size)
    slice_idx <- if (filtered_rows > 0L && start_idx <= filtered_rows) row_indices[seq.int(start_idx, end_idx)] else integer()
    cols_meta <- lapply(names(df), function(cn) {
      x <- df[[cn]]
      list(name = cn, type = e$.rcs_col_type(x), naCount = sum(is.na(x)))
    })
    rows_out <- lapply(slice_idx, function(ri) {
      vals <- lapply(seq_len(total_cols), function(j) {
        v <- df[[j]][[ri]]
        if (is.na(v)) NULL else as.character(v)
      })
      list(rowIndex = ri, rowName = rn[[ri]], values = vals)
    })
    editable <- identical(source, "global") && exists(name, envir = globalenv(), inherits = FALSE) && is.data.frame(get(name, envir = globalenv()))
    list(
      ok = TRUE,
      name = name,
      source = source,
      editable = editable,
      totalRows = total_rows,
      filteredRows = filtered_rows,
      totalCols = total_cols,
      page = page,
      pageSize = page_size,
      columns = cols_meta,
      rows = rows_out
    )
  }
  e$.rcs_col_summary <- function(name, source = "global", col) {
    df <- e$.rcs_resolve_table(name, source)
    if (!col %in% names(df)) stop("Column not found: ", col)
    x <- df[[col]]
    na_count <- sum(is.na(x))
    n_total <- length(x)
    valid <- x[!is.na(x)]
    if (is.numeric(x)) {
      if (!length(valid)) {
        return(list(ok = TRUE, col = col, kind = "numeric", type = e$.rcs_col_type(x), n = n_total, naCount = na_count))
      }
      qs <- as.numeric(stats::quantile(valid, probs = c(0, 0.25, 0.5, 0.75, 1), names = FALSE))
      return(list(
        ok = TRUE, col = col, kind = "numeric", type = e$.rcs_col_type(x),
        n = n_total, naCount = na_count,
        min = qs[1], q1 = qs[2], median = qs[3], mean = mean(valid),
        q3 = qs[4], max = qs[5], sd = if (length(valid) > 1L) stats::sd(valid) else 0
      ))
    }
    tab <- sort(table(as.character(valid)), decreasing = TRUE)
    top_n <- head(tab, 6L)
    top_levels <- lapply(names(top_n), function(k) list(label = k, count = as.integer(top_n[[k]])))
    list(
      ok = TRUE, col = col, kind = "categorical", type = e$.rcs_col_type(x),
      n = n_total, naCount = na_count, nUnique = length(tab), topLevels = top_levels
    )
  }
  e$.rcs_edit_cell <- function(name, row_idx, col_name, raw_val) {
    if (!exists(name, envir = globalenv(), inherits = FALSE)) stop("Data frame not found: ", name)
    df <- get(name, envir = globalenv())
    if (!is.data.frame(df)) stop("Object is not a data.frame: ", name)
    if (!col_name %in% names(df)) stop("Column not found: ", col_name)
    ri <- as.integer(row_idx)
    if (is.na(ri) || ri < 1L || ri > nrow(df)) stop("Row index out of range")
    col <- df[[col_name]]
    is_na <- is.null(raw_val) || identical(trimws(as.character(raw_val)), "") || identical(trimws(as.character(raw_val)), "NA")
    if (is_na) {
      col[ri] <- NA
    } else if (is.factor(col)) {
      s <- as.character(raw_val)
      if (!s %in% levels(col)) levels(col) <- c(levels(col), s)
      col[ri] <- s
    } else if (is.integer(col)) {
      v <- suppressWarnings(as.integer(raw_val))
      if (is.na(v)) v <- suppressWarnings(as.numeric(raw_val))
      if (is.na(v)) stop("Invalid integer value: ", raw_val)
      col[ri] <- v
    } else if (is.numeric(col)) {
      v <- suppressWarnings(as.numeric(raw_val))
      if (is.na(v)) stop("Invalid numeric value: ", raw_val)
      col[ri] <- v
    } else if (is.logical(col)) {
      v <- as.logical(toupper(trimws(as.character(raw_val))))
      if (is.na(v)) stop("Invalid logical value (use TRUE or FALSE)")
      col[ri] <- v
    } else if (inherits(col, "Date")) {
      col[ri] <- as.Date(raw_val)
    } else {
      col[ri] <- as.character(raw_val)
    }
    df[[col_name]] <- col
    assign(name, df, envir = globalenv())
    list(ok = TRUE, name = name, rowIndex = ri, colName = col_name, value = if (is.na(df[[col_name]][ri])) NULL else as.character(df[[col_name]][ri]))
  }
  e$.rcs_add_row <- function(name) {
    if (!exists(name, envir = globalenv(), inherits = FALSE)) stop("Data frame not found: ", name)
    df <- get(name, envir = globalenv())
    if (!is.data.frame(df)) stop("Object is not a data.frame: ", name)
    new_row <- lapply(df, function(col) {
      if (is.factor(col)) factor(NA, levels = levels(col), ordered = is.ordered(col))
      else if (is.integer(col)) NA_integer_
      else if (is.numeric(col)) NA_real_
      else if (is.logical(col)) NA
      else if (inherits(col, "Date")) as.Date(NA)
      else NA_character_
    })
    df <- rbind(df, as.data.frame(new_row, stringsAsFactors = FALSE))
    assign(name, df, envir = globalenv())
    list(ok = TRUE, name = name, totalRows = nrow(df))
  }
  e$.rcs_add_col <- function(name, col_name, default_val = "NA") {
    if (!exists(name, envir = globalenv(), inherits = FALSE)) stop("Data frame not found: ", name)
    df <- get(name, envir = globalenv())
    if (!is.data.frame(df)) stop("Object is not a data.frame: ", name)
    col_name <- make.names(trimws(as.character(col_name)))
    if (!nzchar(col_name)) stop("Invalid column name")
    dv <- trimws(as.character(default_val))
    if (!nzchar(dv) || identical(dv, "NA")) {
      vec <- rep(NA_real_, nrow(df))
    } else if (!is.na(suppressWarnings(as.numeric(dv)))) {
      vec <- rep(as.numeric(dv), nrow(df))
    } else if (toupper(dv) %in% c("TRUE", "FALSE")) {
      vec <- rep(as.logical(toupper(dv)), nrow(df))
    } else {
      vec <- rep(dv, nrow(df))
    }
    df[[col_name]] <- vec
    assign(name, df, envir = globalenv())
    list(ok = TRUE, name = name, colName = col_name, totalCols = ncol(df))
  }

  # Override utils::View and attach directly in "R Play" so View(x) ALWAYS opens Studio Table Viewer!
  studio_view <- function(x, title) {
    expr <- substitute(x)
    if (missing(title)) title <- paste(deparse(expr), collapse = " ")
    sym_name <- if (is.symbol(expr)) as.character(expr) else NULL
    if (!is.null(sym_name) && exists(sym_name, envir = globalenv(), inherits = FALSE)) {
      payload <- as.character(jsonlite::toJSON(list(name = sym_name, title = as.character(title)[1L], source = "global"), auto_unbox = TRUE))
    } else {
      e$.rcs_view_seq <- e$.rcs_view_seq + 1L
      cid <- paste0(".view_", e$.rcs_view_seq)
      assign(cid, e$.rcs_to_df(x), envir = e$.rcs_view_cache)
      payload <- as.character(jsonlite::toJSON(list(name = cid, title = as.character(title)[1L], source = "cache"), auto_unbox = TRUE))
    }
    cat("\\n__RCS_VIEW__", payload, "__RCS_VIEW_END__\\n", sep = "")
    flush.console()
    invisible(NULL)
  }
  assign("View", studio_view, envir = e)
  assign("patch_view", function() invisible(NULL), envir = e)
  for (env in Filter(Negate(is.null), list(asNamespace("utils"), if ("package:utils" %in% search()) as.environment("package:utils")))) {
    try({
      locked <- bindingIsLocked("View", env)
      if (locked) unlockBinding("View", env)
      assign("View", studio_view, envir = env)
      if (locked) lockBinding("View", env)
    }, silent = TRUE)
  }
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

    const defaultBrowser =
      process.env.R_BROWSER ||
      process.env.BROWSER ||
      (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open');
    const proc = spawn(bin, ['--vanilla', harnessPath], {
      cwd: this.cwd,
      env: {
        ...process.env,
        LC_ALL: 'C.UTF-8',
        R_BROWSER: defaultBrowser,
        R_DEFAULT_PACKAGES: 'datasets,utils,grDevices,graphics,stats,methods'
      },
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

  _extractViewEvents(text) {
    return text
      .replace(/\r?\n?__RCS_VIEW__([\s\S]*?)__RCS_VIEW_END__\r?\n?/g, (_match, jsonStr) => {
        try {
          const payload = JSON.parse(jsonStr);
          this.emit('viewTable', payload);
        } catch {
          // ignore malformed view payload
        }
        return '';
      })
      .replace(/\r?\n?__RCS_BROWSE__([^\r\n]*?)__RCS_BROWSE_END__\r?\n?/g, (_match, urlStr) => {
        const cleanUrl = String(urlStr || '').trim();
        if (cleanUrl) this.emit('browseUrl', cleanUrl);
        return '';
      });
  }

  _handleStdout(text) {
    this._stdoutBuf += text;
    if (!this._activeJob) return;
    const marker = `__RCS_DONE__${this._activeJob.token}`;
    const idx = this._stdoutBuf.indexOf(marker);
    if (idx !== -1) {
      const before = this._extractViewEvents(this._stdoutBuf.slice(0, idx));
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
      const viewStart = this._stdoutBuf.indexOf('__RCS_VIEW__');
      if (viewStart !== -1 && !this._stdoutBuf.includes('__RCS_VIEW_END__', viewStart)) {
        return;
      }
      let safeLen = Math.max(0, this._stdoutBuf.length - (marker.length + 24));
      if (viewStart !== -1 && safeLen > viewStart) {
        const viewEnd = this._stdoutBuf.indexOf('__RCS_VIEW_END__', viewStart);
        safeLen = viewEnd !== -1 ? viewEnd + '__RCS_VIEW_END__'.length : viewStart;
      }
      // Only flush up to the last complete line (\n) so streaming chunks never split words or ANSI codes mid-line.
      if (safeLen > 0) {
        const lastNl = this._stdoutBuf.lastIndexOf('\n', safeLen - 1);
        safeLen = lastNl >= 0 ? lastNl + 1 : 0;
      }
      if (safeLen > 0) {
        const emitChunk = this._extractViewEvents(this._stdoutBuf.slice(0, safeLen));
        this._stdoutBuf = this._stdoutBuf.slice(safeLen);
        this._activeJob.stdout += emitChunk;
        if (emitChunk && this._activeJob.stream) {
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
      maxOutputItems = 24,
      skipHelp = true,
      skipCommands = [],
      syntaxColors = true,
      fixedNotation = false,
      loadRcmdrFunctions = true,
      rcmdrPlugins = [],
      quiet = true,
      timeoutMs = 120000
    } = {}
  ) {
    const start = Date.now();
    const plotDir = capturePlots ? fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-plots-')) : null;
    const wIn = Math.max(1.5, Number(plotWidth || 640) / 72).toFixed(3);
    const hIn = Math.max(1.5, Number(plotHeight || 440) / 72).toFixed(3);
    const pkgsVec = reqPkgs.length ? `c(${reqPkgs.map((p) => JSON.stringify(p)).join(', ')})` : 'character()';
    const skipVec =
      Array.isArray(skipCommands) && skipCommands.length
        ? `c(${skipCommands.map((c) => JSON.stringify(String(c))).join(', ')})`
        : 'character()';
    const pluginsVec =
      Array.isArray(rcmdrPlugins) && rcmdrPlugins.length
        ? `c(${rcmdrPlugins.map((p) => JSON.stringify(String(p))).join(', ')})`
        : 'character()';
    const namesPath = JSON.stringify(this.rcmdrNamesPath);
    const maxItems = Math.max(1, Math.min(1000000, Number.isInteger(Number(maxOutputItems)) ? Number(maxOutputItems) : 24));

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

    const attachSnippet = loadRcmdrFunctions
      ? `if (exists("attach_rcmdr_if_used")) {
    tryCatch(attach_rcmdr_if_used(.rcs_code, ${namesPath}, ${pluginsVec}), error = function(e) NULL)
  }`
      : '';

    const jobScript = `
local({
  ${openDeviceSnippet}
  .rcs_code <- ${rawRString(code)}
  ${attachSnippet}
  if (exists("run_code")) {
    run_code(
      .rcs_code,
      skip_help = ${skipHelp ? 'TRUE' : 'FALSE'},
      skip_commands = ${skipVec},
      limit_output = ${limitOutput ? 'TRUE' : 'FALSE'},
      max_output_items = ${maxItems}L,
      require = ${pkgsVec},
      quiet = ${quiet ? 'TRUE' : 'FALSE'},
      syntax_colors = ${syntaxColors ? 'TRUE' : 'FALSE'},
      fixed_notation = ${fixedNotation ? 'TRUE' : 'FALSE'}
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

  async _jsonRpc(rExpr, timeoutMs = 15000) {
    const outFile = path.join(os.tmpdir(), `rcs-json-${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`);
    const jobScript = `
local({
  .res <- tryCatch(${rExpr}, error = function(e) list(ok = FALSE, error = conditionMessage(e)))
  writeLines(enc2utf8(jsonlite::toJSON(.res, auto_unbox = TRUE, null = "null", na = "null")), ${JSON.stringify(outFile)}, useBytes = TRUE)
})
`;
    try {
      await this._enqueueJob(jobScript, { timeoutMs, stream: false });
      if (!fs.existsSync(outFile)) return { ok: false, error: 'No response from R session' };
      return JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      try {
        fs.unlinkSync(outFile);
      } catch {
        // ignore
      }
    }
  }

  async getTablePage({ name, source = 'global', page = 1, pageSize = 100, sortCol = '', sortDir = 'asc', filter = '' } = {}) {
    const expr = `.rcs_table_page(${JSON.stringify(String(name || ''))}, ${JSON.stringify(String(source || 'global'))}, ${Number(page) || 1}L, ${Number(pageSize) || 100}L, ${JSON.stringify(String(sortCol || ''))}, ${JSON.stringify(sortDir === 'desc' ? 'desc' : 'asc')}, ${rawRString(filter || '')})`;
    return this._jsonRpc(expr, 15000);
  }

  async getColumnSummary({ name, source = 'global', col } = {}) {
    const expr = `.rcs_col_summary(${JSON.stringify(String(name || ''))}, ${JSON.stringify(String(source || 'global'))}, ${JSON.stringify(String(col || ''))})`;
    return this._jsonRpc(expr, 15000);
  }

  async editTableCell({ name, rowIndex, colName, value } = {}) {
    const valArg = value === null || value === undefined ? 'NULL' : rawRString(String(value));
    const expr = `.rcs_edit_cell(${JSON.stringify(String(name || ''))}, ${Number(rowIndex) || 1}L, ${JSON.stringify(String(colName || ''))}, ${valArg})`;
    return this._jsonRpc(expr, 15000);
  }

  async addTableRow({ name } = {}) {
    const expr = `.rcs_add_row(${JSON.stringify(String(name || ''))})`;
    return this._jsonRpc(expr, 15000);
  }

  async addTableCol({ name, colName, defaultValue = 'NA' } = {}) {
    const expr = `.rcs_add_col(${JSON.stringify(String(name || ''))}, ${JSON.stringify(String(colName || ''))}, ${rawRString(String(defaultValue ?? 'NA'))})`;
    return this._jsonRpc(expr, 15000);
  }

  async exportTableCsv({ name, source = 'global' } = {}) {
    const outFile = path.join(os.tmpdir(), `rcs-csv-${process.pid}-${crypto.randomBytes(6).toString('hex')}.csv`);
    const jobScript = `
local({
  df <- .rcs_resolve_table(${JSON.stringify(String(name || ''))}, ${JSON.stringify(String(source || 'global'))})
  utils::write.csv(df, file = ${JSON.stringify(outFile)}, row.names = FALSE, fileEncoding = "UTF-8")
})
`;
    try {
      await this._enqueueJob(jobScript, { timeoutMs: 20000, stream: false });
      if (!fs.existsSync(outFile)) return { ok: false, error: 'Failed to export CSV' };
      return { ok: true, csv: fs.readFileSync(outFile, 'utf8') };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      try {
        fs.unlinkSync(outFile);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Loads .RData, .rda, .rds, .csv, .tsv, or .xlsx/.xls directly into the persistent R session,
   * returning loaded object names, newly available data frames, and refreshed workspace snapshot.
   */
  async loadDataFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: `File not found: ${filePath}` };
    }
    const ext = path.extname(filePath).toLowerCase();
    const rawStem = path.basename(filePath, ext).replace(/[^A-Za-z0-9._]/g, '_');
    const objName = /^[A-Za-z.]/.test(rawStem) ? rawStem : `data_${rawStem}`;

    let expr;
    if (ext === '.rdata' || ext === '.rda') {
      expr = `local({ .loaded <- load(${JSON.stringify(filePath)}, envir = globalenv()); list(ok = TRUE, objects = as.character(.loaded)) })`;
    } else if (ext === '.rds') {
      expr = `local({ assign(${JSON.stringify(objName)}, readRDS(${JSON.stringify(filePath)}), envir = globalenv()); list(ok = TRUE, objects = ${JSON.stringify(objName)}) })`;
    } else if (ext === '.csv') {
      expr = `local({ assign(${JSON.stringify(objName)}, utils::read.csv(${JSON.stringify(filePath)}, stringsAsFactors = TRUE, check.names = TRUE), envir = globalenv()); list(ok = TRUE, objects = ${JSON.stringify(objName)}) })`;
    } else if (ext === '.tsv' || ext === '.tab') {
      expr = `local({ assign(${JSON.stringify(objName)}, utils::read.delim(${JSON.stringify(filePath)}, stringsAsFactors = TRUE, check.names = TRUE), envir = globalenv()); list(ok = TRUE, objects = ${JSON.stringify(objName)}) })`;
    } else if (ext === '.xlsx' || ext === '.xls') {
      expr = `local({
        if (requireNamespace("readxl", quietly = TRUE)) {
          .d <- as.data.frame(readxl::read_excel(${JSON.stringify(filePath)}))
        } else if (requireNamespace("openxlsx", quietly = TRUE)) {
          .d <- openxlsx::read.xlsx(${JSON.stringify(filePath)})
        } else {
          stop("Install package 'readxl' or 'openxlsx' to import Excel files.")
        }
        assign(${JSON.stringify(objName)}, .d, envir = globalenv())
        list(ok = TRUE, objects = ${JSON.stringify(objName)})
      })`;
    } else {
      return { ok: false, error: `Unsupported R data file extension: ${ext}` };
    }

    const res = await this._jsonRpc(expr, 30000);
    if (!res.ok) return res;
    const objects = Array.isArray(res.objects) ? res.objects : res.objects ? [res.objects] : [];
    const snapshot = await this.snapshot();
    const loadedDatasets = objects.filter((n) => Boolean(snapshot.datasets?.[n]));
    return {
      ok: true,
      filePath,
      objects,
      loadedDatasets,
      snapshot
    };
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

  /**
   * Fast cached R function usage, parameters, summary, and full Rd documentation lookup
   * for Monaco Hover, Signature Help, and the Help tab.
   */
  async getFunctionHelp(fnName, pkg = '') {
    const cleanFn = String(fnName || '').trim();
    const cleanPkg = String(pkg || '').trim();
    if (!cleanFn || !/^[A-Za-z._][A-Za-z0-9._]*$/.test(cleanFn)) {
      return { ok: false, error: 'Invalid function name' };
    }
    const cacheKey = `${cleanPkg}::${cleanFn}`;
    if (this._fnHelpCache.has(cacheKey)) {
      return this._fnHelpCache.get(cacheKey);
    }

    const expr = `local({
      fn_name <- ${JSON.stringify(cleanFn)}
      pkg_name <- ${JSON.stringify(cleanPkg)}
      res <- list(ok = FALSE, fn = fn_name, package = pkg_name, title = "", usage = "", description = "", arguments = "", examples = "", params = character(), fullText = "")

      # 1. Try retrieving function signature via args()
      fn_obj <- tryCatch({
        if (nzchar(pkg_name) && requireNamespace(pkg_name, quietly = TRUE)) {
          getExportedValue(pkg_name, fn_name)
        } else if (exists(fn_name, envir = globalenv(), mode = "function")) {
          get(fn_name, envir = globalenv(), mode = "function")
        } else {
          NULL
        }
      }, error = function(e) NULL)

      if (is.function(fn_obj)) {
        a <- tryCatch(capture.output(args(fn_obj)), error = function(e) character())
        if (length(a) > 1L) a <- a[-length(a)]
        sig <- trimws(paste(a, collapse = " "))
        sig <- sub("^function[[:space:]]*\\\\(", paste0(fn_name, "("), sig)
        res$usage <- sig
        res$params <- names(formals(fn_obj))
        env_name <- environmentName(environment(fn_obj))
        if (nzchar(env_name) && !nzchar(res$package)) res$package <- sub("^package:", "", env_name)
        res$ok <- TRUE
      }

      # 2. Try Rd help page via utils::help()
      h <- tryCatch({
        if (nzchar(pkg_name)) utils::help(topic = (fn_name), package = (pkg_name))
        else utils::help(topic = (fn_name))
      }, error = function(e) character())

      if (length(h)) {
        rd <- tryCatch(utils:::.getHelpFile(h[1L]), error = function(e) NULL)
        if (!is.null(rd)) {
          full <- paste(utils::capture.output(tools::Rd2txt(rd, out = stdout(), options = list(underline_titles = FALSE))), collapse = "\\n")
          full <- gsub(".\\b", "", full)
          res$fullText <- full
          res$ok <- TRUE

          # Extract package from path if empty
          if (!nzchar(res$package)) {
            res$package <- basename(dirname(dirname(as.character(h[1L]))))
          }

          # Extract sections cleanly from plain Rd text
          lines <- strsplit(full, "\\n", fixed = TRUE)[[1L]]
          if (length(lines)) res$title <- trimws(lines[1L])

          extract_sec <- function(sec_name) {
            idx <- which(trimws(lines) == paste0(sec_name, ":"))
            if (!length(idx)) return("")
            start <- idx[1L] + 1L
            if (start > length(lines)) return("")
            out <- character()
            for (k in seq.int(start, length(lines))) {
              if (grepl("^[A-Z][A-Za-z ]+:$", trimws(lines[k])) && !grepl("^[[:space:]]", lines[k])) break
              out <- c(out, lines[k])
            }
            trimws(paste(out, collapse = "\\n"))
          }

          desc <- extract_sec("Description")
          if (nzchar(desc)) res$description <- desc
          usg <- extract_sec("Usage")
          if (nzchar(usg) && !nzchar(res$usage)) res$usage <- usg
          args_sec <- extract_sec("Arguments")
          if (nzchar(args_sec)) res$arguments <- args_sec
          ex_sec <- extract_sec("Examples")
          if (nzchar(ex_sec)) {
            ex_lines <- strsplit(ex_sec, "\\n", fixed = TRUE)[[1L]]
            ex_lines <- ex_lines[nzchar(trimws(ex_lines))]
            res$examples <- paste(head(ex_lines, 8L), collapse = "\\n")
          }
        }
      }
      res
    })`;

    const result = await this._jsonRpc(expr, 10000);
    if (result && result.ok) {
      if (!Array.isArray(result.params)) {
        result.params = result.params ? [String(result.params)] : [];
      }
      this._fnHelpCache.set(cacheKey, result);
    }
    return result;
  }

  interrupt() {
    if (!this._proc) return false;
    try {
      this._proc.kill('SIGINT');
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
