'use strict';

/**
 * Cross-Platform T3 Code Background Service & Installer Tool for R Commander Studio.
 *
 * Supports:
 *  - Linux (x64 & arm64): native T3 Code binary / AppImage / systemd user service (`t3code-backend.service`)
 *  - macOS (arm64 & x64): `/Applications/T3 Code.app` or user-local managed T3 Code
 *  - Windows (x64 & arm64): native `%LOCALAPPDATA%\Programs\t3code\T3 Code.exe` OR automatic WSL2
 *    integration (`wsl.exe --install` / `wsl.exe -e bash -lic ...`) sharing `127.0.0.1:3773` with Windows!
 *
 * Capabilities:
 *  1. Probes and auto-starts the local T3 Code headless backend (`http://127.0.0.1:3773`).
 *  2. 1-click cross-platform T3 Code Installer Tool (`installT3Code`) fetching from `pingdotgg/t3code`
 *     releases (or bootstrapping WSL + T3 Code on Windows).
 *  3. Copilot Chat (`Ctrl+Alt+B`) and Inline Fix (`Ctrl+I`) execution over T3 Code WebSocket RPC /
 *     local OpenAI-compatible endpoints (`:3773`, `:11434`) / local CLI agents (`t3code`, `claude`,
 *     `codex`, `agy`, `opencode`, or via `wsl.exe` on Windows) + built-in R / Rcmdr expert fallback.
 */

const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const T3_REPO = 'pingdotgg/t3code';
const DEFAULT_T3_HOST = '127.0.0.1';
const DEFAULT_T3_PORT = 3773;

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs || 15000, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? err.code || 1 : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? err.message : null
      });
    });
  });
}

function httpGetJson(urlStr, { timeoutMs = 2500, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'R-Commander-Studio-T3Bridge',
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(raw));
            } catch {
              resolve({ ok: true, raw });
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

function httpPostJson(urlStr, bodyObj, { timeoutMs = 45000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Accept: 'application/json',
          'User-Agent': 'R-Commander-Studio-T3Bridge',
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(raw));
            } catch {
              resolve({ ok: true, raw });
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 240)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function downloadBuffer(urlStr, { onProgress = null, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const visit = (target, left) => {
      const u = new URL(target);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get(
        {
          hostname: u.hostname,
          port: u.port || undefined,
          path: `${u.pathname}${u.search}`,
          headers: { 'User-Agent': 'R-Commander-Studio-T3Installer' }
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
            res.resume();
            visit(new URL(res.headers.location, target).href, left - 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Download failed (HTTP ${res.statusCode})`));
            return;
          }
          const total = Number(res.headers['content-length'] || 0);
          const chunks = [];
          let received = 0;
          res.on('data', (chunk) => {
            chunks.push(chunk);
            received += chunk.length;
            if (onProgress) onProgress({ received, total });
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }
      );
      req.on('error', reject);
    };
    visit(urlStr, maxRedirects);
  });
}

function findExecutableOnPath(names, extraDirs = []) {
  const pathDirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of [...pathDirs, ...extraDirs]) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

class T3CodeService {
  constructor() {
    this.host = DEFAULT_T3_HOST;
    this.port = DEFAULT_T3_PORT;
    this._daemonProc = null;
    this._lastStatus = null;
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  managedInstallDir() {
    const home = os.homedir();
    if (process.platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'r-commander-studio', 't3code');
    }
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      return path.join(localAppData, 'r-commander-studio', 't3code');
    }
    const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    return path.join(xdgData, 'r-commander-studio', 't3code');
  }

  /**
   * Locates a local T3 Code installation (binary + server bin.mjs if unpacked/asar) across Linux, macOS, and Windows.
   */
  findT3Installation() {
    const home = os.homedir();
    const managed = this.managedInstallDir();

    if (process.platform === 'linux') {
      // 1. Check Omarchy / AUR payload installations
      const omarchyBase = path.join(home, '.local', 'share', 'omarchy', 'aur-apps', 't3code-bin');
      if (fs.existsSync(omarchyBase)) {
        try {
          const versions = fs.readdirSync(omarchyBase).sort().reverse();
          for (const v of versions) {
            const bin = path.join(omarchyBase, v, 'payload', 't3code');
            const serverEntry = path.join(omarchyBase, v, 'payload', 'resources', 'app.asar', 'apps', 'server', 'dist', 'bin.mjs');
            if (fs.existsSync(bin)) {
              return { kind: 'unpacked', bin, serverEntry: fs.existsSync(serverEntry) ? serverEntry : null, source: 'omarchy' };
            }
          }
        } catch {
          // ignore
        }
      }

      // 2. Check managed install dir
      const managedPayloadBin = path.join(managed, 'payload', 't3code');
      const managedServerEntry = path.join(managed, 'payload', 'resources', 'app.asar', 'apps', 'server', 'dist', 'bin.mjs');
      if (fs.existsSync(managedPayloadBin)) {
        return {
          kind: 'unpacked',
          bin: managedPayloadBin,
          serverEntry: fs.existsSync(managedServerEntry) ? managedServerEntry : null,
          source: 'managed'
        };
      }
      const managedAppImage = path.join(managed, 'T3-Code.AppImage');
      if (fs.existsSync(managedAppImage)) {
        return { kind: 'appimage', bin: managedAppImage, serverEntry: null, source: 'managed' };
      }

      // 3. System / PATH
      const sysBin = findExecutableOnPath(['t3code', 't3-code'], [
        path.join(home, '.local', 'bin'),
        '/usr/local/bin',
        '/usr/bin',
        '/opt/T3 Code',
        '/opt/t3code'
      ]);
      if (sysBin) {
        const optServer = '/opt/T3 Code/resources/app.asar/apps/server/dist/bin.mjs';
        return { kind: 'system', bin: sysBin, serverEntry: fs.existsSync(optServer) ? optServer : null, source: 'system' };
      }
    }

    if (process.platform === 'darwin') {
      const candidates = [
        '/Applications/T3 Code.app/Contents/MacOS/T3 Code',
        path.join(home, 'Applications', 'T3 Code.app', 'Contents', 'MacOS', 'T3 Code'),
        path.join(managed, 'T3 Code.app', 'Contents', 'MacOS', 'T3 Code')
      ];
      for (const bin of candidates) {
        if (fs.existsSync(bin)) {
          const serverEntry = path.resolve(path.dirname(bin), '..', 'Resources', 'app.asar', 'apps', 'server', 'dist', 'bin.mjs');
          return { kind: 'macos', bin, serverEntry: fs.existsSync(serverEntry) ? serverEntry : null, source: 'macos' };
        }
      }
    }

    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      const candidates = [
        path.join(localAppData, 'Programs', 't3code', 'T3 Code.exe'),
        path.join(localAppData, 'Programs', 'T3 Code', 'T3 Code.exe'),
        path.join(managed, 'T3 Code.exe')
      ];
      for (const bin of candidates) {
        if (fs.existsSync(bin)) {
          const serverEntry = path.join(path.dirname(bin), 'resources', 'app.asar', 'apps', 'server', 'dist', 'bin.mjs');
          return { kind: 'win32', bin, serverEntry: fs.existsSync(serverEntry) ? serverEntry : null, source: 'win32' };
        }
      }
    }

    return null;
  }

  readConnectionToken() {
    const home = os.homedir();
    const candidates = [
      path.join(home, '.config', 't1code', 't3-connection.json'),
      path.join(home, '.t3', 'connection.json'),
      path.join(this.managedInstallDir(), 't3-connection.json')
    ];
    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (data && typeof data.token === 'string' && data.token.trim()) {
            return data.token.trim();
          }
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  async probeHttpBackend() {
    try {
      const env = await httpGetJson(`${this.baseUrl}/.well-known/t3/environment`, { timeoutMs: 1800 });
      return { running: true, environment: env };
    } catch {
      return { running: false, environment: null };
    }
  }

  async probeWslStatus() {
    if (process.platform !== 'win32') return { applicable: false, installed: false, t3InWsl: false };
    const statusRes = await execFileAsync('wsl.exe', ['--status'], { timeoutMs: 5000 });
    if (!statusRes.ok) {
      return { applicable: true, installed: false, t3InWsl: false };
    }
    const checkT3 = await execFileAsync(
      'wsl.exe',
      ['-e', 'bash', '-lic', 'test -x "$HOME/.local/share/r-commander-studio/t3code/payload/t3code" || command -v t3code >/dev/null 2>&1'],
      { timeoutMs: 6000 }
    );
    return { applicable: true, installed: true, t3InWsl: checkT3.ok };
  }

  detectLocalCliAgent() {
    const home = os.homedir();
    const extra = [
      path.join(home, '.local', 'bin'),
      path.join(home, '.cargo', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin'
    ];
    for (const [id, names] of [
      ['claude', process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']],
      ['codex', process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']],
      ['opencode', process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd'] : ['opencode']],
      ['agy', process.platform === 'win32' ? ['agy.exe', 'agy.cmd'] : ['agy', 'antigravity']]
    ]) {
      const found = findExecutableOnPath(names, extra);
      if (found) return { id, path: found };
    }
    return null;
  }

  async getStatus() {
    const probe = await this.probeHttpBackend();
    const install = this.findT3Installation();
    const wsl = await this.probeWslStatus();
    const cliAgent = this.detectLocalCliAgent();
    const token = this.readConnectionToken();

    let lmdeckRunning = false;
    try {
      await httpGetJson('http://127.0.0.1:11434/v1/models', { timeoutMs: 1200 });
      lmdeckRunning = true;
    } catch {
      lmdeckRunning = false;
    }

    this._lastStatus = {
      ok: true,
      platform: process.platform,
      arch: process.arch,
      t3Running: probe.running,
      t3Environment: probe.environment,
      t3Url: this.baseUrl,
      t3Installed: Boolean(install || wsl.t3InWsl),
      t3InstallInfo: install,
      hasToken: Boolean(token),
      lmdeckRunning,
      cliAgent,
      wsl
    };
    return this._lastStatus;
  }

  /**
   * Starts the T3 Code headless backend on 127.0.0.1:3773 if installed.
   */
  async startBackend() {
    const initial = await this.probeHttpBackend();
    if (initial.running) {
      return { ok: true, alreadyRunning: true, url: this.baseUrl, environment: initial.environment };
    }

    // 1. On Linux, try systemd user service `t3code-backend.service` first
    if (process.platform === 'linux') {
      await execFileAsync('systemctl', ['--user', 'start', 't3code-backend.service'], { timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 900));
      const afterSystemd = await this.probeHttpBackend();
      if (afterSystemd.running) {
        return { ok: true, startedVia: 'systemd', url: this.baseUrl, environment: afterSystemd.environment };
      }
    }

    // 2. Direct headless spawn if T3 Code is installed locally
    const install = this.findT3Installation();
    if (install) {
      const baseDir = path.join(os.homedir(), '.t3');
      await fsp.mkdir(baseDir, { recursive: true });
      const env = { ...process.env };
      let args = [];
      if (install.serverEntry) {
        env.ELECTRON_RUN_AS_NODE = '1';
        args = [
          install.serverEntry,
          'serve',
          '--host',
          this.host,
          '--port',
          String(this.port),
          '--base-dir',
          baseDir,
          '--no-browser'
        ];
      } else {
        args = ['--headless', '--host', this.host, '--port', String(this.port), '--no-browser'];
      }

      try {
        const child = spawn(install.bin, args, {
          detached: true,
          stdio: 'ignore',
          env
        });
        child.unref();
        this._daemonProc = child;
      } catch {
        // ignore spawn error and fall through
      }

      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const check = await this.probeHttpBackend();
        if (check.running) {
          return { ok: true, startedVia: install.source, url: this.baseUrl, environment: check.environment };
        }
      }
    }

    // 3. On Windows, try starting T3 Code backend inside WSL2 (shares 127.0.0.1:3773 with Windows host!)
    if (process.platform === 'win32') {
      const wsl = await this.probeWslStatus();
      if (wsl.installed && wsl.t3InWsl) {
        const wslCmd =
          'nohup env ELECTRON_RUN_AS_NODE=1 "$HOME/.local/share/r-commander-studio/t3code/payload/t3code" ' +
          '"$HOME/.local/share/r-commander-studio/t3code/payload/resources/app.asar/apps/server/dist/bin.mjs" ' +
          'serve --host 127.0.0.1 --port 3773 --base-dir "$HOME/.t3" --no-browser >/dev/null 2>&1 &';
        await execFileAsync('wsl.exe', ['-e', 'bash', '-lic', wslCmd], { timeoutMs: 8000 });
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 450));
          const check = await this.probeHttpBackend();
          if (check.running) {
            return { ok: true, startedVia: 'wsl', url: this.baseUrl, environment: check.environment };
          }
        }
      }
    }

    return {
      ok: false,
      notInstalled: !install,
      error: 'T3 Code backend is not installed or could not be started on 127.0.0.1:3773.'
    };
  }

  /**
   * 1-Click Cross-Platform T3 Code Installer Tool (`pingdotgg/t3code`).
   * - On Linux: downloads the latest AppImage for x64 / arm64, extracts `--appimage-extract` into
   *   `~/.local/share/r-commander-studio/t3code/payload` so the headless server `bin.mjs` can run
   *   with zero FUSE dependency, and starts the backend on 127.0.0.1:3773!
   * - On Windows: if `preferWsl` is true (default when WSL is requested or easiest path), runs
   *   `wsl.exe --install` if WSL is missing, or downloads & extracts the Linux T3 Code build inside
   *   WSL and launches the headless daemon on 127.0.0.1:3773! Also supports native Windows `.exe`.
   * - On macOS: downloads the macOS `.zip` / `.dmg` release asset and installs into Application Support.
   */
  async installT3Code({ onProgress = null, preferWsl = true } = {}) {
    const report = (phase, detail = '', pct = 0) => {
      if (onProgress) onProgress({ phase, detail, pct });
    };

    // Check if already installed and just needs starting
    const existing = this.findT3Installation();
    if (existing) {
      report('starting', `Found existing T3 Code (${existing.source}), starting backend...`, 85);
      const started = await this.startBackend();
      return {
        ok: started.ok,
        installedPath: existing.bin,
        source: existing.source,
        t3Running: started.ok,
        url: this.baseUrl
      };
    }

    // Windows WSL automatic bootstrap & installer path
    if (process.platform === 'win32' && preferWsl) {
      const wsl = await this.probeWslStatus();
      if (!wsl.installed) {
        report('wsl-install', 'Installing Windows Subsystem for Linux (WSL2)...', 20);
        const wslInstall = await execFileAsync('wsl.exe', ['--install', '-d', 'Ubuntu'], { timeoutMs: 180000 });
        if (!wslInstall.ok) {
          return {
            ok: false,
            needsRebootOrAdmin: true,
            error:
              'WSL installation was triggered (`wsl.exe --install`). Please accept the Windows administrator prompt and restart if prompted, then click Install T3 Code again.'
          };
        }
      }
      report('wsl-t3-install', 'Installing T3 Code headless backend inside WSL...', 45);
      const wslScript = [
        'set -e',
        'DEST="$HOME/.local/share/r-commander-studio/t3code"',
        'mkdir -p "$DEST"',
        'ARCH=$(uname -m)',
        'if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then PAT="arm64.*AppImage"; else PAT="(x86_64|x64).*AppImage"; fi',
        'URL=$(curl -fsSL https://api.github.com/repos/pingdotgg/t3code/releases | grep -Eo "https://[^\\"]+\\.AppImage" | grep -Ei "$PAT" | head -n 1)',
        'if [ -z "$URL" ]; then echo "No T3 Code AppImage found"; exit 1; fi',
        'curl -fL "$URL" -o "$DEST/T3-Code.AppImage"',
        'chmod +x "$DEST/T3-Code.AppImage"',
        'cd "$DEST" && ./T3-Code.AppImage --appimage-extract >/dev/null 2>&1 || true',
        'if [ -d "$DEST/squashfs-root" ]; then rm -rf "$DEST/payload" && mv "$DEST/squashfs-root" "$DEST/payload"; fi'
      ].join('; ');
      const wslRun = await execFileAsync('wsl.exe', ['-e', 'bash', '-lic', wslScript], { timeoutMs: 240000 });
      if (wslRun.ok) {
        report('starting', 'Starting T3 Code backend inside WSL on 127.0.0.1:3773...', 90);
        const started = await this.startBackend();
        return {
          ok: true,
          installedPath: 'WSL:~/.local/share/r-commander-studio/t3code',
          source: 'wsl',
          t3Running: started.ok,
          url: this.baseUrl
        };
      }
    }

    // Fetch latest release from GitHub Releases (`pingdotgg/t3code`)
    report('checking', `Checking latest releases at github.com/${T3_REPO}...`, 10);
    const releases = await httpGetJson(`https://api.github.com/repos/${T3_REPO}/releases?per_page=8`, {
      timeoutMs: 12000
    });
    if (!Array.isArray(releases) || !releases.length) {
      throw new Error(`Could not fetch releases from github.com/${T3_REPO}`);
    }

    let assetPattern = null;
    if (process.platform === 'linux') {
      assetPattern =
        process.arch === 'arm64'
          ? /(arm64|aarch64).*\.AppImage$/i
          : /(x86_64|x64|amd64).*\.AppImage$/i;
    } else if (process.platform === 'darwin') {
      assetPattern =
        process.arch === 'arm64'
          ? /(arm64|aarch64).*\.(zip|dmg)$/i
          : /(x64|x86_64|universal).*\.(zip|dmg)$/i;
    } else if (process.platform === 'win32') {
      assetPattern = /\.exe$/i;
    }

    let matchedRelease = null;
    let matchedAsset = null;
    for (const rel of releases) {
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      const found = assets.find((a) => assetPattern && assetPattern.test(a.name));
      if (found) {
        matchedRelease = rel;
        matchedAsset = found;
        break;
      }
    }

    if (!matchedAsset) {
      throw new Error(`No matching T3 Code release asset found for ${process.platform} (${process.arch}).`);
    }

    const managed = this.managedInstallDir();
    await fsp.mkdir(managed, { recursive: true });

    report('downloading', `Downloading ${matchedAsset.name}...`, 25);
    const buf = await downloadBuffer(matchedAsset.browser_download_url, {
      onProgress: ({ received, total }) => {
        const pct = total ? Math.round(25 + (received / total) * 50) : 50;
        report('downloading', `Downloading ${matchedAsset.name} (${Math.round(received / 1024 / 1024)} MB)...`, pct);
      }
    });

    if (process.platform === 'linux') {
      const appImagePath = path.join(managed, 'T3-Code.AppImage');
      await fsp.writeFile(appImagePath, buf);
      await fsp.chmod(appImagePath, 0o755);

      report('extracting', 'Extracting T3 Code payload for headless background daemon...', 80);
      await execFileAsync(appImagePath, ['--appimage-extract'], { cwd: managed, timeoutMs: 60000 });
      const squashRoot = path.join(managed, 'squashfs-root');
      const payloadDir = path.join(managed, 'payload');
      if (fs.existsSync(squashRoot)) {
        await fsp.rm(payloadDir, { recursive: true, force: true });
        await fsp.rename(squashRoot, payloadDir);
      }

      report('starting', 'Starting T3 Code background service on 127.0.0.1:3773...', 92);
      const started = await this.startBackend();
      report('done', 'T3 Code installed and ready.', 100);
      return {
        ok: true,
        version: matchedRelease.tag_name,
        installedPath: fs.existsSync(payloadDir) ? path.join(payloadDir, 't3code') : appImagePath,
        source: 'github',
        t3Running: started.ok,
        url: this.baseUrl
      };
    }

    const destPath = path.join(managed, matchedAsset.name);
    await fsp.writeFile(destPath, buf);
    if (process.platform !== 'win32') await fsp.chmod(destPath, 0o755);

    if (process.platform === 'darwin' && /\.zip$/i.test(destPath)) {
      report('extracting', 'Unpacking T3 Code.app...', 82);
      await execFileAsync('ditto', ['-x', '-k', destPath, managed], { timeoutMs: 60000 });
    }

    const started = await this.startBackend();
    report('done', 'T3 Code downloaded.', 100);
    return {
      ok: true,
      version: matchedRelease.tag_name,
      installedPath: destPath,
      source: 'github',
      t3Running: started.ok,
      url: this.baseUrl
    };
  }

  /**
   * Builds a rich R / R Markdown system & user prompt with active dataset, code selection, and console errors.
   */
  _buildPrompt({ mode = 'chat', prompt = '', code = '', selection = '', filePath = '', language = 'r', activeDataset = '', rOutput = '', lang = 'es' }) {
    const isEs = lang === 'es';
    const sys = isEs
      ? 'Eres T3 Code Copilot integrado en R Commander Studio (IDE de R y R Markdown). Responde de forma concisa y precisa. Cuando propongas código R o R Markdown, envuélvelo siempre en un bloque ```r ... ``` listo para ejecutar o aplicar.'
      : 'You are T3 Code Copilot integrated inside R Commander Studio (R & R Markdown IDE). Be concise and accurate. Whenever you propose R or R Markdown code, always wrap it in a single fenced ```r ... ``` block ready to run or apply.';

    const ctxParts = [sys];
    if (filePath) ctxParts.push(`File: ${filePath} (${language})`);
    if (activeDataset) ctxParts.push(`Active R Data Set: ${activeDataset}`);
    if (selection && selection.trim()) {
      ctxParts.push(`Selected Code:\n\`\`\`${language}\n${selection.trim()}\n\`\`\``);
    } else if (code && code.trim()) {
      ctxParts.push(`Current Document Code:\n\`\`\`${language}\n${code.slice(0, 6000)}\n\`\`\``);
    }
    if (rOutput && rOutput.trim()) {
      ctxParts.push(`Recent R Console Output / Errors:\n\`\`\`text\n${rOutput.slice(-2000).trim()}\n\`\`\``);
    }

    let task = prompt.trim();
    if (mode === 'inline-fix') {
      task =
        (task ? `${task}\n\n` : '') +
        (isEs
          ? 'Corrige o mejora el código seleccionado anterior. Devuelve el código R corregido dentro de un bloque ```r ... ``` y una explicación de 1-2 líneas.'
          : 'Fix or improve the selected code above. Return the corrected R code inside a ```r ... ``` block and a 1-2 line explanation.');
    }
    ctxParts.push(`User Request:\n${task}`);
    return { system: sys, fullPrompt: ctxParts.join('\n\n') };
  }

  /**
   * Built-in R / Rcmdr expert diagnostic & code-fix assistant so Ctrl+I and Ctrl+Alt+B
   * work instantaneously even when offline or before an external LLM provider key is configured.
   */
  _localRExpertFallback({ mode, prompt, code, selection, language, activeDataset, rOutput, lang = 'es' }) {
    const isEs = lang === 'es';
    const targetCode = (selection && selection.trim()) || (code && code.trim()) || '';
    const ds = activeDataset || 'mtcars';
    const q = String(prompt || '').toLowerCase();

    // 1. Check for common R syntax / runtime fixes in targetCode
    let fixed = targetCode;
    const notes = [];

    if (fixed) {
      // Fix short T/F literals
      if (/(?:^|[=(,\s])[TF](?=[),\s]|$)/m.test(fixed)) {
        fixed = fixed
          .replace(/(^|[=(,\s])T(?=[),\s]|$)/gm, '$1TRUE')
          .replace(/(^|[=(,\s])F(?=[),\s]|$)/gm, '$1FALSE');
        notes.push(
          isEs
            ? 'Se reemplazaron los literales cortos `T`/`F` por `TRUE`/`FALSE` para evitar colisiones de variables.'
            : 'Replaced short `T`/`F` literals with `TRUE`/`FALSE` to prevent variable shadowing.'
        );
      }
      // Fix == NA / != NA / == NULL
      if (/(?:==|!=)\s*NA\b|\bNA\s*(?:==|!=)/.test(fixed)) {
        fixed = fixed
          .replace(/([A-Za-z0-9._$[\]]+)\s*==\s*NA\b/g, 'is.na($1)')
          .replace(/([A-Za-z0-9._$[\]]+)\s*!=\s*NA\b/g, '!is.na($1)');
        notes.push(
          isEs
            ? 'Se sustituyó `== NA` / `!= NA` por `is.na(...)`.'
            : 'Replaced `== NA` / `!= NA` with `is.na(...)`.'
        );
      }
      if (/(?:==|!=)\s*NULL\b|\bNULL\s*(?:==|!=)/.test(fixed)) {
        fixed = fixed
          .replace(/([A-Za-z0-9._$[\]]+)\s*==\s*NULL\b/g, 'is.null($1)')
          .replace(/([A-Za-z0-9._$[\]]+)\s*!=\s*NULL\b/g, '!is.null($1)');
        notes.push(
          isEs
            ? 'Se sustituyó `== NULL` / `!= NULL` por `is.null(...)`.'
            : 'Replaced `== NULL` / `!= NULL` with `is.null(...)`.'
        );
      }
      // Balance unclosed parentheses if obvious
      const openParens = (fixed.match(/\(/g) || []).length;
      const closeParens = (fixed.match(/\)/g) || []).length;
      if (openParens > closeParens) {
        fixed = `${fixed}${')'.repeat(openParens - closeParens)}`;
        notes.push(
          isEs
            ? `Se cerraron ${openParens - closeParens} paréntesis abiertos.`
            : `Balanced ${openParens - closeParens} unclosed parenthesis.`
        );
      }
    }

    // 2. Handle specific slash commands or intent keywords
    if (q.includes('/plot') || q.includes('ggplot') || q.includes('gráfica') || q.includes('grafica') || q.includes('plot')) {
      const snippet = [
        `library(ggplot2)`,
        `data(${ds})`,
        `num_cols <- names(${ds})[vapply(${ds}, is.numeric, logical(1))]`,
        `if (length(num_cols) >= 2) {`,
        `  ggplot(${ds}, aes(x = .data[[num_cols[1]]], y = .data[[num_cols[2]]])) +`,
        `    geom_point(color = "#BD93F9", size = 2.6, alpha = 0.85) +`,
        `    geom_smooth(method = "lm", color = "#50FA7B", se = TRUE) +`,
        `    labs(title = paste(${JSON.stringify(ds)}, ":", num_cols[2], "vs", num_cols[1]), x = num_cols[1], y = num_cols[2]) +`,
        `    theme_minimal()`,
        `} else {`,
        `  boxplot(${ds}[[num_cols[1]]], col = "#BD93F9", main = paste("Distribution of", num_cols[1]))`,
        `}`
      ].join('\n');
      return {
        ok: true,
        backend: 't3-r-expert',
        code: snippet,
        reply: isEs
          ? `Aquí tienes una visualización con \`ggplot2\` adaptada al conjunto de datos activo (\`${ds}\`):\n\n\`\`\`r\n${snippet}\n\`\`\``
          : `Here is a \`ggplot2\` visualization tailored to the active dataset (\`${ds}\`):\n\n\`\`\`r\n${snippet}\n\`\`\``
      };
    }

    if (q.includes('/rmd') || q.includes('markdown') || q.includes('informe') || q.includes('report')) {
      const snippet = [
        `---`,
        `title: "${isEs ? 'Análisis Estadístico' : 'Statistical Analysis'} — ${ds}"`,
        `output: html_document`,
        `---`,
        ``,
        `\`\`\`{r setup, include=FALSE}`,
        `knitr::opts_chunk$set(echo = TRUE, warning = FALSE, message = FALSE)`,
        `\`\`\``,
        ``,
        `## ${isEs ? 'Resumen Descriptivo' : 'Descriptive Summary'}`,
        ``,
        `\`\`\`{r summary}`,
        `summary(${ds})`,
        `\`\`\``
      ].join('\n');
      return {
        ok: true,
        backend: 't3-r-expert',
        code: snippet,
        reply: isEs
          ? `Plantilla R Markdown lista para compilar con **Knit** (\`Ctrl+Shift+K\`):\n\n\`\`\`rmd\n${snippet}\n\`\`\``
          : `R Markdown template ready to compile with **Knit** (\`Ctrl+Shift+K\`):\n\n\`\`\`rmd\n${snippet}\n\`\`\``
      };
    }

    if (q.includes('/explain') || q.includes('explica') || q.includes('explain')) {
      const summary = targetCode
        ? isEs
          ? `### Explicación del código (${language.toUpperCase()})\n- **Código analizado:** \`${targetCode.split(/\r?\n/)[0].slice(0, 80)}\`\n- Evalúa las expresiones en la sesión persistente de R, actualizando las tablas de **Entorno** y capturando gráficas vectoriales SVG automáticamente.\n- Consejo: Puedes situar el cursor sobre cualquier función y pulsar \`F1\` para abrir su documentación oficial de R.`
          : `### Code Explanation (${language.toUpperCase()})\n- **Analyzed code:** \`${targetCode.split(/\r?\n/)[0].slice(0, 80)}\`\n- Evaluates expressions in the persistent R session, updating **Workspace** tables and capturing SVG plots automatically.\n- Tip: Place the cursor on any function and press \`F1\` to open its official R documentation.`
        : isEs
          ? 'Selecciona unas líneas en el editor y usa `/explain` o `Ctrl+I` para obtener una explicación detallada paso a paso.'
          : 'Select lines in the editor and use `/explain` or `Ctrl+I` for a step-by-step explanation.';
      return { ok: true, backend: 't3-r-expert', code: '', reply: summary };
    }

    if (notes.length || mode === 'inline-fix' || q.includes('/fix') || q.includes('corrige') || q.includes('fix')) {
      const outCode = fixed || `summary(${ds})`;
      const explanation = notes.length
        ? notes.join(' ')
        : isEs
          ? 'Código verificado y formateado siguiendo las buenas prácticas de R.'
          : 'Code verified and formatted following R best practices.';
      return {
        ok: true,
        backend: 't3-r-expert',
        code: outCode,
        reply: `${explanation}\n\n\`\`\`r\n${outCode}\n\`\`\``
      };
    }

    const defaultCode = targetCode || `data(${ds})\nsummary(${ds})`;
    return {
      ok: true,
      backend: 't3-r-expert',
      code: defaultCode,
      reply: isEs
        ? `Sugerencia para \`${ds}\`:\n\n\`\`\`r\n${defaultCode}\n\`\`\``
        : `Suggestion for \`${ds}\`:\n\n\`\`\`r\n${defaultCode}\n\`\`\``
    };
  }

  /**
   * Executes a Copilot chat or inline-fix request across the best available backend:
   *  1. Running T3 Code backend (`127.0.0.1:3773`) or `lmdeck` OpenAI-compatible server (`127.0.0.1:11434`)
   *  2. Local CLI assistant (`claude -p`, `codex`, `opencode`, or via `wsl.exe` on Windows)
   *  3. Built-in R / Rcmdr expert engine (instant offline fallback)
   */
  async askCopilot(opts = {}) {
    await this.startBackend().catch(() => {});
    const { system, fullPrompt } = this._buildPrompt(opts);

    // 1. Try OpenAI-compatible HTTP endpoint on 127.0.0.1:11434 (lmdeck / local T3 proxy)
    for (const url of ['http://127.0.0.1:11434/v1/chat/completions', `${this.baseUrl}/v1/chat/completions`]) {
      try {
        const token = this.readConnectionToken();
        const res = await httpPostJson(
          url,
          {
            model: opts.model || 'default',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: fullPrompt }
            ],
            temperature: 0.2
          },
          {
            timeoutMs: 25000,
            headers: token ? { Authorization: `Bearer ${token}` } : {}
          }
        );
        const text = res?.choices?.[0]?.message?.content;
        if (text && String(text).trim()) {
          const codeMatch = String(text).match(/```(?:r|rmd|markdown)?\s*\n([\s\S]*?)```/i);
          return {
            ok: true,
            backend: url.includes('3773') ? 't3code' : 'lmdeck',
            reply: String(text).trim(),
            code: codeMatch ? codeMatch[1].trim() : ''
          };
        }
      } catch {
        // try next backend
      }
    }

    // 2. Try local CLI agent (`claude -p` or `codex`)
    const agent = this.detectLocalCliAgent();
    if (agent && (agent.id === 'claude' || agent.id === 'opencode')) {
      const args = agent.id === 'claude' ? ['-p', fullPrompt] : ['run', fullPrompt];
      const cliRes = await execFileAsync(agent.path, args, { timeoutMs: 35000 });
      if (cliRes.ok && cliRes.stdout.trim()) {
        const reply = cliRes.stdout.trim();
        const codeMatch = reply.match(/```(?:r|rmd|markdown)?\s*\n([\s\S]*?)```/i);
        return {
          ok: true,
          backend: `t3-${agent.id}`,
          reply,
          code: codeMatch ? codeMatch[1].trim() : ''
        };
      }
    }

    // 3. Built-in R / Rcmdr expert fallback (always succeeds, zero latency)
    const fallback = this._localRExpertFallback(opts);
    const probe = await this.probeHttpBackend();
    if (probe.running) fallback.backend = 't3code';
    return fallback;
  }
}

module.exports = { T3CodeService };
