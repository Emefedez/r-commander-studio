'use strict';

// Version checks against GitHub Releases (Emefedez/r-commander-studio), modeled after NoteComplete's updater.js.
// Nothing is installed without the user's confirmation. On Linux an AppImage can self-update
// (download, verify against SHA256SUMS.txt, swap, keep .previous); otherwise opens the release page.

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn: spawnProcess } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const REPOSITORY = 'Emefedez/r-commander-studio';
const CHECK_EVERY = 60 * 60 * 1000; // 1 hour

function parseVersion(text) {
  const m = String(text || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/);
  return m ? { parts: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null;
}

function newer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i];
  }
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;
  if (!b.pre) return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

function latestRelease(releases) {
  return (
    (releases || [])
      .filter((r) => !r.draft && parseVersion(r.tag_name))
      .sort((x, y) => (newer(x.tag_name, y.tag_name) ? -1 : newer(y.tag_name, x.tag_name) ? 1 : 0))[0] || null
  );
}

function pickAsset(release, platform = process.platform, arch = process.arch) {
  const assets = release?.assets || [];
  if (platform === 'linux') {
    const archPat = arch === 'x64' ? '(x64|x86_64)' : arch;
    return (
      assets.find((a) => new RegExp(`-linux-${archPat}\\.AppImage$`, 'i').test(a.name)) ||
      assets.find((a) => new RegExp(`-linux-${archPat}\\.tar\\.gz$`, 'i').test(a.name)) ||
      null
    );
  }
  if (platform === 'darwin') {
    return (
      assets.find((a) => new RegExp(`-mac-${arch}\\.dmg$`, 'i').test(a.name)) ||
      assets.find((a) => new RegExp(`-mac-${arch}\\.zip$`, 'i').test(a.name)) ||
      null
    );
  }
  if (platform === 'win32') {
    return (
      assets.find((a) => /-setup\.exe$/i.test(a.name)) ||
      assets.find((a) => /\.exe$/i.test(a.name)) ||
      null
    );
  }
  return null;
}

function parseSums(text) {
  const sums = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(?:\.\/)?(.+)$/i);
    if (m) sums.set(m[2].trim(), m[1].toLowerCase());
  }
  return sums;
}

function isStudioAppImage(p) {
  return Boolean(p && /r[-_.\s]*commander[-_.\s]*studio/i.test(path.basename(String(p))));
}

// The AppImage this process was started from. The AppImage runtime sets APPIMAGE (the .AppImage file)
// and APPDIR (its mount point); when our own executable lives inside APPDIR, APPIMAGE is ours no
// matter what the user renamed the file to (Gear Lever, AppImageLauncher, ~/Applications/rcs.AppImage...).
function resolveAppImage(env = process.env, execPath = process.execPath) {
  const file = env.APPIMAGE;
  if (!file || !path.isAbsolute(file)) return '';
  try {
    if (!fs.statSync(file).isFile()) return '';
  } catch {
    return '';
  }
  const dir = env.APPDIR;
  const insideMount = Boolean(dir && execPath && path.resolve(execPath).startsWith(path.resolve(dir) + path.sep));
  return insideMount || isStudioAppImage(file) ? file : '';
}

function canReplace(file) {
  if (!file) return false;
  try {
    fs.accessSync(path.dirname(file), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// GitHub turns spaces in uploaded asset names into dots, while SHA256SUMS.txt is generated from the
// original file names ("R Commander Studio-0.1.9-..."), so compare both spellings.
function expectedSum(sums, name) {
  const norm = (n) => String(n).replace(/[\s.]+/g, '.');
  if (sums.has(name)) return sums.get(name);
  for (const [file, sum] of sums) if (norm(file) === norm(name)) return sum;
  return null;
}

function createUpdater({
  app,
  fetch = globalThis.fetch,
  stateFile,
  appImage = resolveAppImage(),
  platform = process.platform,
  arch = process.arch,
  now = () => Date.now(),
  spawn = spawnProcess,
  pid = process.pid,
  env = process.env
}) {
  let found = null;
  const resolvedStateFile = stateFile || path.join(app.getPath('userData'), 'updater.json');

  const readState = async () => {
    try {
      return JSON.parse(await fsp.readFile(resolvedStateFile, 'utf8'));
    } catch {
      return {};
    }
  };

  const remember = async (patch) => {
    try {
      await fsp.mkdir(path.dirname(resolvedStateFile), { recursive: true });
      const cur = await readState();
      await fsp.writeFile(resolvedStateFile, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8');
    } catch {
      // ignore
    }
  };

  const api = async (subpath) => {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${subpath}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'R-Commander-Studio'
      }
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.json();
  };

  async function webReleases() {
    const atom = await fetch(`https://github.com/${REPOSITORY}/releases.atom`, {
      headers: {
        Accept: 'application/atom+xml, text/xml',
        'User-Agent': 'R-Commander-Studio'
      }
    });
    if (!atom.ok) throw new Error(`GitHub answered ${atom.status}`);
    const xml = await atom.text();
    const tags = [];
    const seen = new Set();
    for (const m of xml.matchAll(/\/releases\/tag\/([^"<\s/&]+)/g)) {
      const tag = decodeURIComponent(m[1]);
      if (!seen.has(tag) && parseVersion(tag)) {
        seen.add(tag);
        tags.push({
          tag_name: tag,
          html_url: `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`,
          draft: false,
          assets: []
        });
      }
    }
    const top = latestRelease(tags);
    if (!top) return [];
    const page = await fetch(`https://github.com/${REPOSITORY}/releases/expanded_assets/${encodeURIComponent(top.tag_name)}`, {
      headers: { 'User-Agent': 'R-Commander-Studio' }
    });
    if (page.ok) {
      const html = await page.text();
      const assets = [];
      for (const m of html.matchAll(/href="(\/[^"]+\/releases\/download\/[^"/]+\/([^"?#]+))"/g)) {
        assets.push({
          name: decodeURIComponent(m[2]),
          browser_download_url: `https://github.com${m[1]}`,
          size: 0
        });
      }
      top.assets = assets;
    }
    return [top];
  }

  const fetchReleases = () =>
    api('releases?per_page=10').catch(async (err) => {
      try {
        return await webReleases();
      } catch {
        throw err;
      }
    });

  async function check({ manual = false } = {}) {
    const s = await readState();
    const current = app.getVersion();
    if (!manual && s.checkOnOpen === false) return { current, disabled: true };
    if (!manual && s.lastCheck && now() - s.lastCheck < CHECK_EVERY && !s.available) {
      return { current, recent: true };
    }
    const release = latestRelease(await fetchReleases());
    await remember({ lastCheck: now() });
    if (!release || !newer(release.tag_name, current)) {
      found = null;
      await remember({ available: null });
      return { current, upToDate: true };
    }
    const asset = pickAsset(release, platform, arch);
    const version = release.tag_name.replace(/^v/i, '');
    found = { release, asset };
    await remember({ available: version });
    return {
      current,
      version,
      page: release.html_url,
      assetName: asset?.name || null,
      assetUrl: asset?.browser_download_url || release.html_url,
      skipped: !manual && s.skip === version,
      install:
        platform === 'linux' && canReplace(appImage) && Boolean(asset) && /\.AppImage$/i.test(asset.name) ? 'appimage' : 'page'
    };
  }

  async function install(progress = () => {}) {
    if (!found?.asset || !appImage) {
      throw new Error('This copy cannot self-update in place; opening the release download page instead.');
    }
    const { release, asset } = found;
    const sumsAsset = (release.assets || []).find((a) => a.name === 'SHA256SUMS.txt');
    let expected = null;
    if (sumsAsset) {
      const sumsRes = await fetch(sumsAsset.browser_download_url, {
        headers: { 'User-Agent': 'R-Commander-Studio' }
      });
      if (sumsRes.ok) expected = expectedSum(parseSums(await sumsRes.text()), asset.name);
    }
    const response = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'R-Commander-Studio' }
    });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
    const total = Number(response.headers.get('content-length')) || asset.size || 0;
    const next = `${appImage}.download`;
    const previous = `${appImage}.previous`;
    const hash = createHash('sha256');
    let received = 0;
    const out = await fsp.open(next, 'w', 0o755);
    try {
      for await (const chunk of response.body) {
        hash.update(chunk);
        await out.write(chunk);
        received += chunk.length;
        progress(total ? received / total : 0);
      }
    } catch (err) {
      await out.close().catch(() => {});
      await fsp.rm(next, { force: true });
      throw err;
    }
    await out.close();
    if (expected && hash.digest('hex') !== expected) {
      await fsp.rm(next, { force: true });
      throw new Error('Downloaded file checksum does not match SHA256SUMS.txt; aborting update.');
    }
    const st = fs.existsSync(appImage) ? await fsp.stat(appImage) : { mode: 0o755 };
    await fsp.chmod(next, (st.mode & 0o7777) | 0o755);
    // Swap: current -> .previous, download -> current. The running copy keeps working from its
    // FUSE mount (the inode stays alive as .previous), so the restart picks up the new file.
    await fsp.rm(previous, { force: true });
    await fsp.rename(appImage, previous);
    try {
      await fsp.rename(next, appImage);
    } catch (err) {
      await fsp.rename(previous, appImage).catch(() => {});
      throw err;
    }
    await remember({ available: null, installed: release.tag_name });
    return { version: release.tag_name.replace(/^v/i, ''), path: appImage };
  }

  return {
    check,
    install,
    // Recent published builds for Help > Builds (newest first).
    listReleases: async () => {
      const list = await fetchReleases();
      return (list || [])
        .filter((r) => !r.draft && parseVersion(r.tag_name))
        .sort((a, b) => (newer(a.tag_name, b.tag_name) ? -1 : newer(b.tag_name, a.tag_name) ? 1 : 0))
        .slice(0, 10)
        .map((r) => ({
          tag: r.tag_name,
          name: r.name || r.tag_name,
          date: r.published_at || r.created_at || null,
          url: r.html_url,
          prerelease: Boolean(r.prerelease)
        }));
    },
    skip: (version) => remember({ skip: version }),
    setCheckOnOpen: (on) => remember({ checkOnOpen: Boolean(on) }),
    settings: async () => {
      const s = await readState();
      return {
        checkOnOpen: s.checkOnOpen !== false,
        current: app.getVersion(),
        available: s.available || null
      };
    },
    restart: () => {
      app.releaseSingleInstanceLock?.();
      if (platform === 'linux' && appImage) {
        const clean = { ...env };
        for (const name of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete clean[name];
        const wait = 'i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.2; i=$((i+1)); done; exec "$0"';
        spawn('/bin/sh', ['-c', wait, appImage, String(pid)], {
          detached: true,
          stdio: 'ignore',
          env: clean,
          cwd: os.homedir()
        }).unref();
      } else {
        app.relaunch();
      }
      app.exit(0);
    }
  };
}

module.exports = {
  REPOSITORY,
  CHECK_EVERY,
  parseVersion,
  newer,
  latestRelease,
  pickAsset,
  parseSums,
  expectedSum,
  resolveAppImage,
  createUpdater
};
