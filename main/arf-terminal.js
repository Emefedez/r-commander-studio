'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { findArf } = require('./r-runtime');

/**
 * Strips OSC / terminal title / cursor-positioning control sequences while keeping
 * ANSI SGR color codes (\x1b[...m) so the renderer renders Dracula colors cleanly.
 */
function sanitizePtyOutput(chunk) {
  return String(chunk ?? '')
    // Strip OSC sequences (\x1b]...BEL or ST)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Strip 2-byte DEC save/restore cursor & keypad mode escapes (\x1b7, \x1b8, \x1b=, \x1b>)
    .replace(/\x1b[78=>]/g, '')
    // Strip charset selection escapes (\x1b(B, \x1b)0, etc.)
    .replace(/\x1b[()][A-Z0-9]/g, '')
    // Strip CSI sequences that are NOT SGR color ('m')
    .replace(/\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g, '')
    // Normalize CRLF -> LF and strip lone CR
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '');
}

/**
 * Interactive `arf` terminal runner using a lightweight Python3 PTY bridge (zero native npm deps),
 * with graceful fallback if `arf` or Python3 PTY is unavailable.
 */
class ArfTerminal extends EventEmitter {
  constructor(options = {}) {
    super();
    this.arfPath = options.arfPath || findArf();
    this.cwd = options.cwd || process.cwd();
    this._proc = null;
    this._running = false;
  }

  get available() {
    return Boolean(this.arfPath);
  }

  get running() {
    return Boolean(this._proc && this._running);
  }

  start() {
    if (this._proc && this._running) return true;
    this.arfPath = this.arfPath || findArf();
    if (!this.arfPath) {
      this.emit('status', 'unavailable');
      return false;
    }

    // Spawn arf inside a real PTY using python3's stdlib pty module so arf runs interactively with full VT100/colors/resize
    const pyBridge = `
import os, pty, re, select, signal, sys, termios, struct, fcntl
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], [sys.argv[1]])
else:
    def set_winsize(rows, cols):
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(4, rows), max(20, cols), 0, 0))
            os.kill(pid, signal.SIGWINCH)
        except Exception:
            pass
    set_winsize(24, 100)
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    resize_re = re.compile(rb"\\x1b\\]9999;(\\d+);(\\d+)\\x07")
    while True:
        try:
            r, _, _ = select.select([fd, stdin_fd], [], [], 0.25)
        except Exception:
            break
        if fd in r:
            try:
                data = os.read(fd, 8192)
                if not data:
                    break
                os.write(stdout_fd, data)
            except OSError:
                break
        if stdin_fd in r:
            try:
                inp = os.read(stdin_fd, 8192)
                if not inp:
                    break
                for m in resize_re.finditer(inp):
                    set_winsize(int(m.group(2)), int(m.group(1)))
                inp = resize_re.sub(b"", inp)
                if inp:
                    os.write(fd, inp)
            except OSError:
                break
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        pass
`;

    try {
      const defaultBrowser =
        process.env.R_BROWSER ||
        process.env.BROWSER ||
        (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open');
      const proc = spawn('python3', ['-u', '-c', pyBridge, this.arfPath], {
        cwd: this.cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LC_ALL: 'C.UTF-8', R_BROWSER: defaultBrowser },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this._proc = proc;
      this._running = true;
      this.emit('status', 'ready');

      proc.stdout.on('data', (buf) => {
        const raw = buf.toString('utf8');
        const clean = sanitizePtyOutput(raw);
        if (raw) this.emit('output', { stream: 'stdout', raw, text: clean });
      });
      proc.stderr.on('data', (buf) => {
        const raw = buf.toString('utf8');
        const clean = sanitizePtyOutput(raw);
        if (raw) this.emit('output', { stream: 'stderr', raw, text: clean });
      });
      proc.on('error', (err) => {
        this._running = false;
        this._proc = null;
        this.emit('output', { stream: 'stderr', text: `arf error: ${err.message}\n` });
        this.emit('status', 'error');
      });
      proc.on('exit', () => {
        this._running = false;
        this._proc = null;
        this.emit('status', 'stopped');
      });
      return true;
    } catch {
      this.emit('status', 'unavailable');
      return false;
    }
  }

  writeRaw(data) {
    if (!this._proc || !this._running) {
      if (!this.start()) return false;
    }
    try {
      this._proc.stdin.write(String(data ?? ''), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  resize(cols, rows) {
    if (!this._proc || !this._running) return false;
    const c = Math.max(20, Math.min(400, Math.round(Number(cols) || 100)));
    const r = Math.max(4, Math.min(200, Math.round(Number(rows) || 24)));
    try {
      this._proc.stdin.write(`\x1b]9999;${c};${r}\x07`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  send(code) {
    if (!this._proc || !this._running) {
      if (!this.start()) return false;
    }
    try {
      const text = String(code ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
      if (!text.trim()) return true;
      const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~\r` : `${text}\r`;
      this._proc.stdin.write(payload, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  interrupt() {
    if (!this._proc || !this._running) return false;
    try {
      this._proc.stdin.write('\x03');
      return true;
    } catch {
      return false;
    }
  }

  restart() {
    this.stop();
    return this.start();
  }

  stop() {
    if (this._proc) {
      try {
        this._proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      this._proc = null;
    }
    this._running = false;
  }
}

module.exports = { ArfTerminal, sanitizePtyOutput };
