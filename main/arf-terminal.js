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

    // Spawn arf inside a real PTY using python3's stdlib pty module so arf runs interactively with colors
    const pyBridge = `
import os, pty, select, signal, sys, termios, struct, fcntl
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], [sys.argv[1]])
else:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
    except Exception:
        pass
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    while True:
        try:
            r, _, _ = select.select([fd, stdin_fd], [], [], 0.25)
        except Exception:
            break
        if fd in r:
            try:
                data = os.read(fd, 4096)
                if not data:
                    break
                os.write(stdout_fd, data)
            except OSError:
                break
        if stdin_fd in r:
            try:
                inp = os.read(stdin_fd, 4096)
                if not inp:
                    break
                os.write(fd, inp)
            except OSError:
                break
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        pass
`;

    try {
      const proc = spawn('python3', ['-u', '-c', pyBridge, this.arfPath], {
        cwd: this.cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LC_ALL: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this._proc = proc;
      this._running = true;
      this.emit('status', 'ready');

      proc.stdout.on('data', (buf) => {
        const clean = sanitizePtyOutput(buf.toString('utf8'));
        if (clean) this.emit('output', { stream: 'stdout', text: clean });
      });
      proc.stderr.on('data', (buf) => {
        const clean = sanitizePtyOutput(buf.toString('utf8'));
        if (clean) this.emit('output', { stream: 'stderr', text: clean });
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

  send(code) {
    if (!this._proc || !this._running) {
      if (!this.start()) return false;
    }
    try {
      const text = String(code ?? '');
      const line = text.endsWith('\n') ? text : `${text}\n`;
      this._proc.stdin.write(line, 'utf8');
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
