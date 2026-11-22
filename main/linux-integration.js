'use strict';

// Linux desktop integration & local device installer for R Commander Studio.
// Registers ~/.local/share/applications/r-commander-studio.desktop, icons, and MIME associations
// for .R, .Rmd, .qmd, .RData, .rda, .rds so R Commander Studio appears in the desktop launcher
// (Hyprland / Omarchy / GNOME / KDE) and "Open With" menus.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const execQuote = (p) => `"${String(p).replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`;

function buildDesktopEntry({ execPath, iconPath = 'r-commander-studio' }) {
  return `[Desktop Entry]
Version=1.0
Name=R Commander Studio
GenericName=R & R Markdown IDE
Comment=VS Code-style R & R Markdown IDE with 371 bilingual R Commander dialogs, Table Viewer, arf & R terminals
Exec=env ELECTRON_OZONE_PLATFORM_HINT=auto ${execQuote(execPath)} %U
StartupNotify=true
StartupWMClass=r-commander-studio
Terminal=false
Icon=${iconPath}
Type=Application
Categories=Development;Science;Education;Math;
MimeType=text/x-r-source;text/x-rmarkdown;text/markdown;application/x-r-data;text/csv;
Keywords=R;Rcmdr;R Commander;Statistics;RMarkdown;Data;NoteComplete;
`;
}

function buildMimeXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="text/x-r-source">
    <comment>R script</comment>
    <glob pattern="*.R"/>
    <glob pattern="*.r"/>
    <icon name="r-commander-studio"/>
  </mime-type>
  <mime-type type="text/x-rmarkdown">
    <comment>R Markdown document</comment>
    <glob pattern="*.Rmd"/>
    <glob pattern="*.rmd"/>
    <glob pattern="*.qmd"/>
    <icon name="r-commander-studio"/>
  </mime-type>
  <mime-type type="application/x-r-data">
    <comment>R workspace or dataset</comment>
    <glob pattern="*.RData"/>
    <glob pattern="*.rda"/>
    <glob pattern="*.rds"/>
    <icon name="r-commander-studio"/>
  </mime-type>
</mime-info>
`;
}

const runCmd = (file, args) =>
  new Promise((resolve) =>
    execFile(file, args, { timeout: 10000 }, (err, stdout) => resolve(err ? null : String(stdout)))
  );

async function writeIfChanged(file, content) {
  try {
    if ((await fsp.readFile(file, 'utf8')) === content) return false;
  } catch {
    // file does not exist yet
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
  return true;
}

function isStudioAppImage(appImage) {
  if (!appImage || !path.isAbsolute(appImage) || !fs.existsSync(appImage)) return false;
  return /r[-_\s]*commander[-_\s]*studio/i.test(path.basename(appImage));
}

async function ensureLocalLauncher({ appImage = process.env.APPIMAGE, appRoot = path.join(__dirname, '..'), home = os.homedir() } = {}) {
  if (isStudioAppImage(appImage)) {
    return appImage;
  }
  const binDir = path.join(home, '.local', 'bin');
  const localBin = path.join(binDir, 'r-commander-studio');
  await fsp.mkdir(binDir, { recursive: true });

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
unset APPIMAGE APPDIR ARGV0 OWD ELECTRON_RUN_AS_NODE
APP_ROOT="${appRoot}"
if [ -x "$HOME/.local/share/r-commander-studio/r-commander-studio" ]; then
  exec "$HOME/.local/share/r-commander-studio/r-commander-studio" "$@"
elif [ -x "$APP_ROOT/dist/linux-arm64-unpacked/r-commander-studio" ]; then
  exec "$APP_ROOT/dist/linux-arm64-unpacked/r-commander-studio" "$@"
elif [ -x "$APP_ROOT/dist/linux-unpacked/r-commander-studio" ]; then
  exec "$APP_ROOT/dist/linux-unpacked/r-commander-studio" "$@"
elif [ -x "$APP_ROOT/node_modules/electron/dist/electron" ]; then
  exec "$APP_ROOT/node_modules/electron/dist/electron" "$APP_ROOT" "$@"
else
  exec electron "$APP_ROOT" "$@"
fi
`;
  await writeIfChanged(localBin, launcher);
  await fsp.chmod(localBin, 0o755);
  return localBin;
}

async function integrateLinuxDesktop({
  appImage = process.env.APPIMAGE,
  appRoot = path.join(__dirname, '..'),
  platform = process.platform,
  home = os.homedir(),
  createDesktopShortcut = false
} = {}) {
  if (platform !== 'linux') return { ok: false, reason: 'not-linux' };

  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const execTarget = await ensureLocalLauncher({ appImage, appRoot, home });

  // Copy SVG and PNG icons into ~/.local/share/icons/hicolor/
  const svgSrc = path.join(appRoot, 'assets', 'icon.svg');
  const pngSrc = path.join(appRoot, 'assets', 'icon.png');
  const svgDest = path.join(dataHome, 'icons', 'hicolor', 'scalable', 'apps', 'r-commander-studio.svg');
  const pngDest = path.join(dataHome, 'icons', 'hicolor', '512x512', 'apps', 'r-commander-studio.png');

  if (fs.existsSync(svgSrc)) {
    await fsp.mkdir(path.dirname(svgDest), { recursive: true });
    await fsp.copyFile(svgSrc, svgDest);
  }
  if (fs.existsSync(pngSrc)) {
    await fsp.mkdir(path.dirname(pngDest), { recursive: true });
    await fsp.copyFile(pngSrc, pngDest);
  }

  const iconRef = fs.existsSync(pngDest) ? pngDest : fs.existsSync(svgDest) ? svgDest : 'r-commander-studio';
  const entryText = buildDesktopEntry({ execPath: execTarget, iconPath: iconRef });
  const desktopFile = path.join(dataHome, 'applications', 'r-commander-studio.desktop');
  const mimeFile = path.join(dataHome, 'mime', 'packages', 'r-commander-studio.xml');

  const entryChanged = await writeIfChanged(desktopFile, entryText);
  await fsp.chmod(desktopFile, 0o755).catch(() => {});
  const mimeChanged = await writeIfChanged(mimeFile, buildMimeXml());

  if (createDesktopShortcut) {
    const userDesktopDir = path.join(home, 'Desktop');
    if (fs.existsSync(userDesktopDir)) {
      const shortcutPath = path.join(userDesktopDir, 'r-commander-studio.desktop');
      await writeIfChanged(shortcutPath, entryText);
      await fsp.chmod(shortcutPath, 0o755).catch(() => {});
    }
  }

  if (mimeChanged) await runCmd('update-mime-database', [path.join(dataHome, 'mime')]);
  if (entryChanged) await runCmd('update-desktop-database', [path.join(dataHome, 'applications')]);

  return {
    ok: true,
    desktopFile,
    execTarget,
    iconRef,
    updated: entryChanged || mimeChanged
  };
}

module.exports = {
  buildDesktopEntry,
  buildMimeXml,
  integrateLinuxDesktop
};
