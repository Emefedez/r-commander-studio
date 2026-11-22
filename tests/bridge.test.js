'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NoteCompleteBridge, getBridgeFilePath } = require('../main/bridge');
const { RRuntime } = require('../main/r-runtime');
const { RcmdrService } = require('../main/rcmdr-service');

test('getBridgeFilePath resolves standard OS discovery paths', () => {
  assert.equal(
    getBridgeFilePath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/tmp/xdg' }, homedir: '/home/u' }),
    '/tmp/xdg/notecomplete/r-bridge.json'
  );
  assert.equal(
    getBridgeFilePath({ platform: 'linux', env: {}, homedir: '/home/u' }),
    '/home/u/.config/notecomplete/r-bridge.json'
  );
  assert.equal(
    getBridgeFilePath({ platform: 'darwin', env: {}, homedir: '/Users/u' }),
    '/Users/u/Library/Application Support/notecomplete/r-bridge.json'
  );
  assert.equal(
    getBridgeFilePath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, homedir: 'C:\\Users\\u' }),
    path.join('C:\\Users\\u\\AppData\\Roaming', 'notecomplete', 'r-bridge.json')
  );
});

test('NoteCompleteBridge auth, discovery file (0600), health, catalog, live eval-figure, eval-code, open-script, and cleanup', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-bridge-test-'));
  const bridgeFilePath = path.join(tmpDir, 'notecomplete', 'r-bridge.json');
  const runtime = new RRuntime();
  const rcmdr = new RcmdrService();
  const openedScripts = [];

  const bridge = new NoteCompleteBridge({
    runtime,
    rcmdr,
    bridgeFilePath,
    getDatasets: () => ['mtcars', 'iris'],
    onOpenScript: (payload) => openedScripts.push(payload)
  });

  try {
    const info = await bridge.start();
    assert.ok(info.port > 0);
    assert.match(info.token, /^[0-9a-f]{64}$/);

    // Verify discovery file contents and 0600 permissions
    assert.ok(fs.existsSync(bridgeFilePath));
    if (process.platform !== 'win32') {
      const mode = fs.statSync(bridgeFilePath).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600 mode, got ${mode.toString(8)}`);
    }
    const disk = JSON.parse(fs.readFileSync(bridgeFilePath, 'utf8'));
    assert.equal(disk.protocolVersion, 1);
    assert.equal(disk.app, 'r-commander-studio');
    assert.equal(disk.version, '0.1.0');
    assert.equal(disk.port, info.port);
    assert.equal(disk.token, info.token);
    assert.equal(disk.pid, process.pid);
    assert.ok(disk.startedAt);

    const baseUrl = `http://127.0.0.1:${info.port}`;
    const authHeaders = {
      Authorization: `Bearer ${info.token}`,
      'Content-Type': 'application/json'
    };

    // 1. Reject missing token (401) & never send wildcard CORS
    const noAuth = await fetch(`${baseUrl}/health`);
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers.get('access-control-allow-origin'), null);

    // 2. Reject wrong token (401)
    const badAuth = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: 'Bearer 0000000000000000000000000000000000000000000000000000000000000000' }
    });
    assert.equal(badAuth.status, 401);

    // 3. GET /health
    const healthRes = await fetch(`${baseUrl}/health`, { headers: authHeaders });
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('access-control-allow-origin'), null);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.protocolVersion, 1);
    assert.equal(health.app, 'r-commander-studio');
    assert.equal(health.version, '0.1.0');
    assert.ok(typeof health.rVersion === 'string' && health.rVersion.length > 0, `unexpected rVersion: ${health.rVersion}`);
    assert.equal(typeof health.arfAvailable, 'boolean');
    assert.equal(typeof health.packages.ggplot2, 'boolean');
    assert.equal(typeof health.packages.svglite, 'boolean');
    assert.deepEqual(health.datasets, ['mtcars', 'iris']);

    // 4. GET /catalog
    const catRes = await fetch(`${baseUrl}/catalog`, { headers: authHeaders });
    assert.equal(catRes.status, 200);
    const cat = await catRes.json();
    assert.equal(cat.ok, true);
    assert.equal(cat.count, 371);
    assert.ok(Array.isArray(cat.menus) && cat.menus.length > 0);
    assert.equal(cat.commands.length, 371);

    // 5. POST /eval-figure (base R plot -> valid <svg via grDevices::svg fallback)
    const figRes = await fetch(`${baseUrl}/eval-figure`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        rCode: 'plot(1:10, (1:10)^2, type = "b", col = "#245dc4", main = "Bridge Test")',
        width: 480,
        height: 320,
        bg: '#ffffff'
      })
    });
    assert.equal(figRes.status, 200);
    const fig = await figRes.json();
    assert.equal(fig.ok, true, `eval-figure failed: ${fig.error}`);
    assert.ok(fig.svg.includes('<svg'), 'SVG output must contain <svg');
    assert.ok(fig.svg.includes('</svg>'), 'SVG output must contain </svg>');
    assert.ok(fig.elapsedMs >= 0);
    assert.equal(fig.rVersion, health.rVersion);

    // 6. POST /eval-figure with ggplot2 (auto-prints returned ggplot object)
    if (health.packages.ggplot2) {
      const ggRes = await fetch(`${baseUrl}/eval-figure`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          rCode: 'library(ggplot2)\nggplot(mtcars, aes(wt, mpg)) + geom_point()',
          width: 480,
          height: 320,
          require: ['ggplot2']
        })
      });
      const gg = await ggRes.json();
      assert.equal(gg.ok, true, `ggplot eval-figure failed: ${gg.error}`);
      assert.ok(gg.svg.includes('<svg'));
    }

    // 7. POST /eval-figure error handling
    const badFigRes = await fetch(`${baseUrl}/eval-figure`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ rCode: 'stop("deliberate boom")' })
    });
    const badFig = await badFigRes.json();
    assert.equal(badFig.ok, false);
    assert.match(badFig.error, /deliberate boom/);

    // 8. POST /eval-code with stdout + warning
    const codeRes = await fetch(`${baseUrl}/eval-code`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ rCode: 'warning("watch out")\ncat("sum =", sum(1:5), "\\n")' })
    });
    assert.equal(codeRes.status, 200);
    const codeOut = await codeRes.json();
    assert.equal(codeOut.ok, true);
    assert.match(codeOut.stdout, /sum = 15/);
    assert.ok(codeOut.warnings.some((w) => w.includes('watch out')));

    // 9. POST /open-script
    const openRes = await fetch(`${baseUrl}/open-script`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title: 'Figure 1', code: 'plot(cars)', kind: 'r' })
    });
    assert.equal(openRes.status, 200);
    const openJson = await openRes.json();
    assert.equal(openJson.ok, true);
    assert.equal(openedScripts.length, 1);
    assert.deepEqual(openedScripts[0], { title: 'Figure 1', code: 'plot(cars)', kind: 'r' });

    // 10. Clean close removes discovery file
    await bridge.close();
    assert.equal(fs.existsSync(bridgeFilePath), false, 'bridge discovery file should be removed on close');
  } finally {
    await bridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('NoteCompleteBridge close does NOT remove discovery file owned by another PID', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-bridge-pid-'));
  const bridgeFilePath = path.join(tmpDir, 'r-bridge.json');
  const bridge = new NoteCompleteBridge({ bridgeFilePath });
  try {
    await bridge.start();
    // Simulate a newer instance writing its own PID
    const content = JSON.parse(fs.readFileSync(bridgeFilePath, 'utf8'));
    content.pid = process.pid + 99999;
    fs.writeFileSync(bridgeFilePath, JSON.stringify(content), 'utf8');

    await bridge.close();
    assert.equal(fs.existsSync(bridgeFilePath), true, 'must preserve file owned by another PID');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
