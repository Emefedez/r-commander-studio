'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_NAME = 'r-commander-studio';
const APP_VERSION = '0.1.0';
const PROTOCOL_VERSION = 1;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB

function getBridgeFilePath({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'notecomplete', 'r-bridge.json');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
    return path.join(appData, 'notecomplete', 'r-bridge.json');
  }
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(homedir, '.config');
  return path.join(xdgConfig, 'notecomplete', 'r-bridge.json');
}

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  // Explicitly never emit wildcard CORS headers
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

class NoteCompleteBridge {
  constructor({
    runtime,
    rcmdr,
    onOpenScript,
    getDatasets,
    bridgeFilePath,
    version = APP_VERSION
  } = {}) {
    this.runtime = runtime;
    this.rcmdr = rcmdr;
    this.onOpenScript = onOpenScript || (() => {});
    this.getDatasets = getDatasets || (() => []);
    this.bridgeFilePath = bridgeFilePath || getBridgeFilePath();
    this.version = version;

    this.token = crypto.randomBytes(32).toString('hex');
    this.port = null;
    this.startedAt = null;
    this._server = null;
  }

  _isAuthorized(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return false;
    const supplied = header.slice('Bearer '.length).trim();
    return constantTimeEquals(supplied, this.token);
  }

  async _handleRequest(req, res) {
    if (!this._isAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const method = (req.method || 'GET').toUpperCase();

    try {
      if (method === 'GET' && url.pathname === '/health') {
        const env = this.runtime ? await this.runtime.probeEnvironment() : { rVersion: null, arfAvailable: false, packages: {} };
        const datasets = await Promise.resolve(this.getDatasets());
        return sendJson(res, 200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          app: APP_NAME,
          version: this.version,
          rVersion: env.rVersion,
          arfAvailable: Boolean(env.arfAvailable),
          packages: env.packages,
          datasets: Array.isArray(datasets) ? datasets : []
        });
      }

      if (method === 'GET' && url.pathname === '/catalog') {
        const summary = this.rcmdr
          ? this.rcmdr.getCatalogSummary()
          : { count: 0, menus: [], commands: [] };
        return sendJson(res, 200, {
          ok: true,
          count: summary.count,
          menus: summary.menus,
          commands: summary.commands
        });
      }

      if (method === 'POST' && url.pathname === '/eval-figure') {
        const body = await readJsonBody(req);
        if (!body || typeof body.rCode !== 'string' || !body.rCode.trim()) {
          return sendJson(res, 400, { ok: false, error: 'rCode string is required', stdout: '' });
        }
        const result = await this.runtime.evalFigure({
          rCode: body.rCode,
          width: body.width ?? 480,
          height: body.height ?? 320,
          bg: body.bg ?? '#ffffff',
          timeoutMs: body.timeoutMs ?? 10000,
          require: body.require ?? []
        });
        return sendJson(res, 200, result);
      }

      if (method === 'POST' && url.pathname === '/eval-code') {
        const body = await readJsonBody(req);
        if (!body || typeof body.rCode !== 'string' || !body.rCode.trim()) {
          return sendJson(res, 400, { ok: false, error: 'rCode string is required', stdout: '' });
        }
        const result = await this.runtime.evalCode({
          rCode: body.rCode,
          timeoutMs: body.timeoutMs ?? 10000,
          require: body.require ?? []
        });
        return sendJson(res, 200, result);
      }

      if (method === 'POST' && url.pathname === '/open-script') {
        const body = await readJsonBody(req);
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'NoteComplete Script';
        const code = typeof body.code === 'string' ? body.code : '';
        const kind = body.kind === 'rmd' ? 'rmd' : 'r';
        await Promise.resolve(this.onOpenScript({ title, code, kind }));
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { ok: false, error: `Not found: ${method} ${url.pathname}` });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message || 'Bad request' });
    }
  }

  _writeDiscoveryFile() {
    const dir = path.dirname(this.bridgeFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      protocolVersion: PROTOCOL_VERSION,
      app: APP_NAME,
      version: this.version,
      port: this.port,
      token: this.token,
      pid: process.pid,
      startedAt: this.startedAt
    };
    const tmp = `${this.bridgeFilePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // chmod may be a no-op on Windows
    }
    fs.renameSync(tmp, this.bridgeFilePath);
    try {
      fs.chmodSync(this.bridgeFilePath, 0o600);
    } catch {
      // ignore
    }
  }

  _removeDiscoveryFile() {
    try {
      if (!fs.existsSync(this.bridgeFilePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.bridgeFilePath, 'utf8'));
      if (raw && raw.pid === process.pid) {
        fs.unlinkSync(this.bridgeFilePath);
      }
    } catch {
      // never delete if we can't verify pid ownership
    }
  }

  async start() {
    if (this._server) return this.info();
    this._server = http.createServer((req, res) => {
      this._handleRequest(req, res);
    });

    await new Promise((resolve, reject) => {
      this._server.once('error', reject);
      this._server.listen(0, '127.0.0.1', () => {
        this._server.off('error', reject);
        resolve();
      });
    });

    const addr = this._server.address();
    this.port = addr.port;
    this.startedAt = new Date().toISOString();
    this._writeDiscoveryFile();
    return this.info();
  }

  info() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      app: APP_NAME,
      version: this.version,
      port: this.port,
      token: this.token,
      pid: process.pid,
      startedAt: this.startedAt,
      bridgeFilePath: this.bridgeFilePath
    };
  }

  async close() {
    this._removeDiscoveryFile();
    if (!this._server) return;
    const srv = this._server;
    this._server = null;
    await new Promise((resolve) => {
      srv.close(() => resolve());
    });
    this.port = null;
  }
}

module.exports = {
  NoteCompleteBridge,
  getBridgeFilePath,
  APP_NAME,
  APP_VERSION,
  PROTOCOL_VERSION
};
